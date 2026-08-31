# Seedream 5.0 Pro — Prompt Engineering Guide

You are writing prompts for **Seedream 5.0 Pro** (`fal-ai/bytedance/seedream/v5/...`), an
image-editing/generation model that takes one or more reference images plus a natural-language
prompt. This guide is how to get the best, most reliable results out of it for product
photoshoot / ad-campaign generation.

---

## 1. How Seedream reads a prompt

Seedream responds best to **plain, specific, physically-grounded natural language** — not
keyword-soup. Structure every prompt in this order, the same way a real campaign brief reads:

1. **What stays the same** — the product, locked to the reference image exactly as-is.
2. **What changes** — the new scene/environment/context around it.
3. **How it's shot** — lighting, camera angle, composition, mood.

A prompt that only describes the scene and never anchors the product tends to let the model
drift the product's shape/color/label. Always open by re-grounding the product before directing
the scene.

**Template:**
```
Keep the product in Image 1 exactly as shown — same shape, color, materials, proportions,
and label/text. [Scene/environment description]. [Lighting]. [Camera angle/composition]. [Mood].
```

---

## 2. Multi-image referencing

When more than one reference image is sent, Seedream numbers them in call order: **Image 1**,
**Image 2**, etc. Always refer to images by this exact label — "Image 1", "Image 2" — never
"the first photo" or "the product image", since the model resolves references by the numbered
label.

- Single reference image (most common case here): call it `Image 1`.
- Multiple reference images of the *same* product (front/back/detail crops): still just `Image 1`,
  `Image 2`... but tell the model they're the same subject: `"Image 1 and Image 2 show the same
  product from different angles — use both to understand its full form, keep it identical."`
- Cross-image compositing (e.g. placing a product into a separate mood/style reference image):
  `"Place the product from Image 1 into the scene shown in Image 2, keeping Image 1's product
  unchanged and adapting only the lighting to match Image 2."`

---

## 3. Coordinate-based editing (`<point>` / `<bbox>`)

Seedream 5.0 Pro supports **normalized coordinate markers** in the prompt for precise,
position-anchored edits. Coordinates are on a **0–999 scale** per image, top-left = `0 0`,
bottom-right = `999 999`, regardless of the image's actual pixel size.

- **Point:** `<point>x y</point>` — marks a location; the model infers the affected region.
- **Bounding box:** `<bbox>x1 y1 x2 y2</bbox>` — top-left + bottom-right corners; precisely
  scopes the edit area.

Usage inside a prompt: `Image 1<bbox>118 331 933 871</bbox>`.

**When to use this here:**
- If a caller already knows the product's bounding box in the reference image (e.g. from a
  vision pre-pass or user-drawn selection), use `<bbox>` to explicitly lock that region:
  `"Keep the area Image 1<bbox>x1 y1 x2 y2</bbox> completely unchanged. Replace everything
  outside it with [new scene]."` This is the single most reliable way to stop Seedream from
  altering the product — far stronger than a text-only "keep the product unchanged" instruction.
- If no bounding box is available, skip coordinates entirely and rely on natural-language
  product-lock instructions (Section 1). Do not invent coordinates — a wrong `<bbox>` is worse
  than none.
- For object replacement / repositioning within a scene (e.g. swapping a prop, moving the
  product to a specific spot in a background reference), use `<point>` or `<bbox>` on the
  *target* location, not the product itself.

**Scenario reference:**

| Scenario | Prompt pattern |
|---|---|
| Lock the product, regenerate everything else | `Keep the area Image 1<bbox>x1 y1 x2 y2</bbox> unchanged. Replace the rest with [scene].` |
| Edit near a specific point | `Replace the object at Image 1<point>x y</point> with [new element].` |
| Edit a specific region | `Replace the area Image 1<bbox>x1 y1 x2 y2</bbox> with [new content].` |
| Cross-image placement | `Place the subject from Image 1<bbox>...</bbox> at the position of Image 2<bbox>...</bbox>.` |

---

## 4. Multi-subject disambiguation

If a bounding box or scene contains more than one subject, name the target explicitly instead
of relying on position alone: `"the bottle on the left"`, `"the person wearing the red jacket"`,
`"the product in the foreground"`. This applies both inside and outside `<bbox>`/`<point>` usage.

To protect something from being touched, say so explicitly and, if you have its coordinates,
wrap it: `"...and keep Image 1<bbox>700 120 920 360</bbox> unchanged."`

---

## 5. Product-fidelity hard constraints

Bake these into every generation prompt, same as the rest of the shoot pipeline enforces for
gpt-image-2 (see `image-gen-prompt.md`):

- **Geometry lock** — cylinders stay cylindrical, straight edges stay straight, no warping to
  fill a new aspect ratio.
- **Label/text fidelity — quote the exact copy, don't just say "keep it as shown".** A vague
  instruction like "keep the label text as shown" is unreliable — diffusion models cannot
  faithfully copy small reference-image text by inspection alone and will hallucinate
  plausible-looking gibberish (`RHODIOLA ROSEA` → `RNODICLA ROSEA`). Instead: transcribe every
  visible word on the product first, then embed it in the prompt as an explicit quoted string —
  `the label reads exactly "FUEL YOUR FOCUS", "PANAX GINSENG"... — zero misspelling, zero
  reflow`. Models render an explicitly quoted string far more reliably than a "copy this" visual
  reference. If a bounding box for the label region is known, reinforce with a `<bbox>` lock
  (Section 3) on top of the quoted text — don't rely on `<bbox>` alone for text fidelity.
- **No re-scaling** — the product keeps its real-world proportions relative to the new scene;
  don't let it balloon to fill the frame or shrink to a prop.
- **Physical realism** — real shadows, real material response to the new lighting (fabric drape,
  metal reflections, condensation), not a flat cutout pasted onto a background.

---

## 6. Common failure modes to avoid

- **Vague scene descriptions** ("nice background", "professional look") — always name the
  actual physical setting, materials, and light source.
- **Missing the product lock** — a prompt that jumps straight into scene description without
  first anchoring the product tends to lose product fidelity.
- **Inventing coordinates** — never fabricate `<point>`/`<bbox>` values; only use them when
  real coordinates are known. A malformed or guessed box can make edits worse, not better.
- **Overloading one prompt with too many changes** — one clear scene + lighting + angle beats
  five stacked, conflicting instructions.
