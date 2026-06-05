#!/usr/bin/env python3
"""
Garment Preprocessor
====================
Crops and zooms a garment image into 4 zone assets ready for the shoot engine.

Outputs per image:
  {stem}_macro.jpg      Full garment crop, 1024x1024  (token ~765)
  {stem}_neckline.jpg   Neckline/collar zone, 512x512 (token ~255)
  {stem}_cuff.jpg       Cuff/sleeve zone,     512x512 (token ~255)
  {stem}_hem.jpg        Hem/bottom zone,      512x512 (token ~255)

Usage (CLI):
  python garment_preprocessor.py --image dress.jpg --output ./crops
  python garment_preprocessor.py --image dress.jpg --output ./crops --no-yolo

Usage (FastAPI server):
  python garment_preprocessor.py --server --port 8001

Server endpoint:
  POST /preprocess
  Body: multipart/form-data  { file: <image> }
  Returns: JSON { macro, neckline, cuff, hem } with base64 data
"""

import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# ── Zone proportion constants ──────────────────────────────────────────────────
# Tuned for full-body fashion photography.
# All values are fractions of the detected garment bounding box height/width.
NECKLINE_HEIGHT_FRAC = 0.22   # top 22% → shoulders + collar + neckline
CUFF_TOP_FRAC        = 0.28   # cuff zone starts at 28% from top
CUFF_BOT_FRAC        = 0.56   # cuff zone ends at 56% from top (captures wrists)
HEM_HEIGHT_FRAC      = 0.20   # bottom 20% → hem line + a little above
MACRO_PAD_FRAC       = 0.04   # 4% padding added around the macro bbox


# ──────────────────────────────────────────────────────────────────────────────
# DETECTION
# ──────────────────────────────────────────────────────────────────────────────

def detect_garment_bbox(image: Image.Image, use_yolo: bool) -> tuple[int, int, int, int]:
    """
    Returns (x1, y1, x2, y2) bounding box of the garment subject.
    Falls back gracefully at each level:
      1. YOLOv8 person detection (if use_yolo=True and ultralytics installed)
      2. Centre-weighted smart crop (removes 10% border all around)
      3. Full image
    """
    if use_yolo:
        bbox = _yolo_detect(image)
        if bbox:
            return bbox
        print("[warn] YOLOv8 detected nothing — falling back to smart crop", file=sys.stderr)

    return _smart_crop_fallback(image)


def _yolo_detect(image: Image.Image) -> tuple[int, int, int, int] | None:
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[warn] ultralytics not installed — skipping YOLOv8", file=sys.stderr)
        return None

    model = YOLO("yolov8n.pt")          # downloads on first run, ~6MB
    results = model(image, classes=[0], verbose=False)   # class 0 = person

    if not results or len(results[0].boxes) == 0:
        return None

    boxes = results[0].boxes
    best = boxes.conf.argmax().item()
    x1, y1, x2, y2 = boxes.xyxy[best].tolist()
    return int(x1), int(y1), int(x2), int(y2)


def _smart_crop_fallback(image: Image.Image) -> tuple[int, int, int, int]:
    """
    For flat-lays, product-on-white, or images where no person is detected.
    Strips the outer 8% of the frame (usually dead background) to focus on subject.
    """
    w, h = image.size
    margin_x = int(w * 0.08)
    margin_y = int(h * 0.08)
    return (margin_x, margin_y, w - margin_x, h - margin_y)


# ──────────────────────────────────────────────────────────────────────────────
# ZONE COMPUTATION
# ──────────────────────────────────────────────────────────────────────────────

def compute_zones(macro_bbox: tuple[int, int, int, int]) -> dict[str, tuple[int, int, int, int]]:
    """
    Given the macro bounding box, return sub-crop bboxes for each zone.
    All zones are computed as offsets within the macro bbox.
    """
    x1, y1, x2, y2 = macro_bbox
    W = x2 - x1
    H = y2 - y1

    neckline_bot = y1 + int(H * NECKLINE_HEIGHT_FRAC)
    cuff_top     = y1 + int(H * CUFF_TOP_FRAC)
    cuff_bot     = y1 + int(H * CUFF_BOT_FRAC)
    hem_top      = y2 - int(H * HEM_HEIGHT_FRAC)

    return {
        # Full width for neckline — captures both shoulder lines
        "neckline": (x1, y1, x2, neckline_bot),

        # Full width for cuffs — both sleeves visible in mid-body region
        "cuff": (x1, cuff_top, x2, cuff_bot),

        # Full width for hem — captures exact termination line
        "hem": (x1, hem_top, x2, y2),
    }


def pad_bbox(
    bbox: tuple[int, int, int, int],
    image_wh: tuple[int, int],
    pad_frac: float = MACRO_PAD_FRAC
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    W, H = image_wh
    px = int((x2 - x1) * pad_frac)
    py = int((y2 - y1) * pad_frac)
    return (max(0, x1 - px), max(0, y1 - py), min(W, x2 + px), min(H, y2 + py))


# ──────────────────────────────────────────────────────────────────────────────
# CROP + RESIZE
# ──────────────────────────────────────────────────────────────────────────────

def crop_and_resize(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    target_px: int,
    bg_color: tuple[int, int, int] = (255, 255, 255)
) -> Image.Image:
    """
    Crop to bbox, maintain aspect ratio inside target_px × target_px square,
    pad the remainder with bg_color.
    """
    x1, y1, x2, y2 = bbox

    # Guard against degenerate boxes
    if x2 <= x1 or y2 <= y1:
        return Image.new('RGB', (target_px, target_px), bg_color)

    cropped = image.crop((x1, y1, x2, y2))

    # Scale down to fit inside target square, never upscale
    ratio = min(target_px / cropped.width, target_px / cropped.height, 1.0)
    new_w = int(cropped.width  * ratio)
    new_h = int(cropped.height * ratio)

    if ratio < 1.0:
        cropped = cropped.resize((new_w, new_h), Image.LANCZOS)
    else:
        new_w, new_h = cropped.width, cropped.height

    # Centre-paste onto white square
    canvas = Image.new('RGB', (target_px, target_px), bg_color)
    offset_x = (target_px - new_w) // 2
    offset_y = (target_px - new_h) // 2
    canvas.paste(cropped, (offset_x, offset_y))
    return canvas


# ──────────────────────────────────────────────────────────────────────────────
# MAIN PIPELINE
# ──────────────────────────────────────────────────────────────────────────────

def preprocess(
    image: Image.Image,
    use_yolo: bool = True
) -> dict[str, Image.Image]:
    """
    Run the full preprocessing pipeline on a PIL Image.
    Returns a dict: { 'macro': Image, 'neckline': Image, 'cuff': Image, 'hem': Image }
    """
    raw_bbox = detect_garment_bbox(image, use_yolo)
    macro_bbox = pad_bbox(raw_bbox, image.size)
    zones = compute_zones(macro_bbox)

    results = {
        "macro": crop_and_resize(image, macro_bbox, 1024),
    }
    for name, bbox in zones.items():
        results[name] = crop_and_resize(image, bbox, 512)

    return results


def images_to_b64(crops: dict[str, Image.Image]) -> dict[str, dict]:
    """Converts PIL images to base64 strings for API responses."""
    out = {}
    for name, img in crops.items():
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=92)
        out[name] = {
            "data": base64.b64encode(buf.getvalue()).decode('utf-8'),
            "mimeType": "image/jpeg",
            "size": img.size[0],  # square, so width == height
        }
    return out


def save_crops(crops: dict[str, Image.Image], output_dir: str, stem: str) -> dict[str, str]:
    """Saves crops to disk. Returns { zone_name: file_path }."""
    os.makedirs(output_dir, exist_ok=True)
    paths = {}
    for name, img in crops.items():
        path = os.path.join(output_dir, f"{stem}_{name}.jpg")
        img.save(path, 'JPEG', quality=92)
        paths[name] = path
        print(f"  ✓  {name:10s}  →  {path}  ({img.size[0]}px)", file=sys.stderr)
    return paths


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def cli_main():
    parser = argparse.ArgumentParser(description="Garment zone preprocessor")
    parser.add_argument("--image",   required=True, help="Input garment image path")
    parser.add_argument("--output",  default="./crops", help="Output directory (default: ./crops)")
    parser.add_argument("--no-yolo", action="store_true", help="Skip YOLOv8, use smart crop fallback")
    parser.add_argument("--json",    action="store_true", help="Print manifest as JSON to stdout")
    args = parser.parse_args()

    image = Image.open(args.image).convert('RGB')
    stem  = Path(args.image).stem

    print(f"[garment_preprocessor] Processing: {args.image}", file=sys.stderr)
    crops = preprocess(image, use_yolo=not args.no_yolo)
    paths = save_crops(crops, args.output, stem)

    manifest = {
        name: {"path": path, "size": crops[name].size[0]}
        for name, path in paths.items()
    }

    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(f"\n[garment_preprocessor] Done. {len(crops)} crops saved to {args.output}/", file=sys.stderr)


# ──────────────────────────────────────────────────────────────────────────────
# FASTAPI SERVER (optional — for integration with Cloudflare Worker)
# ──────────────────────────────────────────────────────────────────────────────

def server_main(host: str = "0.0.0.0", port: int = 8001):
    try:
        from fastapi import FastAPI, File, UploadFile, HTTPException
        from fastapi.responses import JSONResponse
        import uvicorn
    except ImportError:
        print("ERROR: FastAPI/uvicorn not installed. Run: pip install fastapi uvicorn", file=sys.stderr)
        sys.exit(1)

    app = FastAPI(title="Garment Preprocessor")

    @app.post("/preprocess")
    async def preprocess_endpoint(
        file: UploadFile = File(...),
        use_yolo: bool = True
    ):
        if not file.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="File must be an image")

        try:
            image_bytes = await file.read()
            image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
            crops = preprocess(image, use_yolo=use_yolo)
            return JSONResponse(images_to_b64(crops))

        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/health")
    def health():
        return {"status": "ok"}

    print(f"[garment_preprocessor] Server running at http://{host}:{port}", file=sys.stderr)
    uvicorn.run(app, host=host, port=port)


# ──────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Check if --server flag is present before full argparse so we can branch cleanly
    if "--server" in sys.argv:
        port = 8001
        host = "0.0.0.0"
        for i, arg in enumerate(sys.argv):
            if arg == "--port" and i + 1 < len(sys.argv):
                port = int(sys.argv[i + 1])
            if arg == "--host" and i + 1 < len(sys.argv):
                host = sys.argv[i + 1]
        server_main(host=host, port=port)
    else:
        cli_main()
