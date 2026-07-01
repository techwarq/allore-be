import { OpenAITextService } from '../openai/OpenAITextService'
import { AssetWithSpec, IntentPlan } from '../../types/shoots'

export type CropRegion =
  | 'full'
  | { top: number; left: number; width: number; height: number }

export type CropInstruction = {
  name: string        // unique key e.g. "texture_detail", "pillow_cluster", "embroidery_zone"
  description: string // what this crop shows and why it matters for the shoot
  region: CropRegion  // "full" or fractional bbox (all values 0–1, origin top-left)
  outputSize: 512 | 1024
}

export type AssetLabel = {
  assetId: string
  role: 'hero_product' | 'detail_candidate' | 'supporting_prop'
  label: string              // human-readable label e.g. "Primary bedding ensemble — hero shot"
  requestedCrops: CropInstruction[]
}

export class AssetLabeler {
  constructor(private openai: OpenAITextService) {}

  async label(assets: AssetWithSpec[], intentPlan: IntentPlan): Promise<AssetLabel[]> {
    const labels: AssetLabel[] = []

    for (const asset of assets) {
      const spec = asset.productSpec

      const system = `You are a Product Photography Art Director and Computer Vision specialist.
You analyze product images to identify the key visual zones that will make the most compelling reference crops for an AI image generation model.
Your crop region coordinates are always precise fractions of the image dimensions (0.0 to 1.0), origin top-left.
You understand that the image generation model will use these crops as targeted reference images to preserve specific product details.`

      const userText = `Analyze this product image and plan detail crops for the AI image generator.

PRODUCT SPEC:
- Type: ${spec.productType}
- Category: ${spec.category}
- Key Details: ${spec.keyDetails.join(', ')}
- Premium Details: ${spec.premiumDetails?.join(', ') || 'none'}
${spec.brandMarkings ? `- Brand Markings: ${spec.brandMarkings}` : ''}

SHOOT INTENT:
- Style: ${intentPlan.overallStyle}
- Mood: ${intentPlan.mood}

STEP 1 — SPATIAL ANALYSIS (reason before giving coordinates):
Look at the actual image carefully. For each important visual feature, describe:
- Where in the IMAGE FRAME it appears: is it top/middle/bottom of the frame? left/center/right? Is the product centered or offset? Is there background/prop around it?
- How large is it relative to the full image?

This step is critical — crop coordinates are relative to the FULL IMAGE FRAME, not relative to the product.

STEP 2 — REQUEST CROPS:
Based on your spatial analysis, request 2–4 crops. Rules:
- Always include one "full" crop (the whole image) as the primary reference.
- For targeted detail crops, give fractional bbox (top, left, width, height all 0.0–1.0) based on WHERE IN THE IMAGE FRAME the feature actually is.
- Corner/edge features: use a generous region (minimum 0.3 wide × 0.3 tall) to ensure the feature is captured even if positioning is slightly off.
- If a feature is at the very edge of the image, extend the crop box to reach that edge (width or height all the way to 1.0).
- outputSize: 1024 for full/macro crops, 512 for detail crops.

Return raw JSON only:
{
  "role": "hero_product" | "detail_candidate" | "supporting_prop",
  "label": "concise human label for this asset",
  "spatialNotes": "brief description of product position in frame and where key features appear",
  "requestedCrops": [
    {
      "name": "snake_case_unique_name",
      "description": "what this crop shows and why it helps the image generator",
      "region": "full" or { "top": 0.0, "left": 0.0, "width": 1.0, "height": 1.0 },
      "outputSize": 512 or 1024
    }
  ]
}

Examples:
- Towel on rack with embroidery at bottom-right corner: request "full_towel" (full), "fabric_texture" (center patch of product in frame, ~0.3×0.3), "embroidery_detail" (generous bottom-right region reaching to image edges: top≈0.55, left≈0.55, width=0.45, height=0.45)
- Dress on hanger, centered: request "full_garment" (full), "neckline" (top 0.3 of frame), "hem_finish" (bottom 0.25 of frame), "fabric_drape" (center 0.4×0.4)
- Beverage can, centered: request "full_can" (full), "label_artwork" (center height band: top=0.3, left=0.1, width=0.8, height=0.4), "top_rim" (top of frame: top=0, left=0.2, width=0.6, height=0.2)

Return raw JSON only.`

      try {
        const text = await this.openai.chatWithImage(system, userText, asset.base64, asset.mimeType, true)
        if (!text) throw new Error('no response')

        console.log(`[ALLORE_DEBUG][asset_labeler][${asset.id}]`, text)

        const parsed = JSON.parse(text)
        labels.push({
          assetId: asset.id,
          role: parsed.role ?? 'hero_product',
          label: parsed.label ?? spec.productType,
          requestedCrops: (parsed.requestedCrops ?? []).slice(0, 5), // cap at 5 crops
        })
      } catch (err: any) {
        console.warn(`[AssetLabeler] Failed to label asset ${asset.id}:`, err.message)
        // Fallback: request a basic macro crop
        labels.push({
          assetId: asset.id,
          role: 'hero_product',
          label: spec.productType,
          requestedCrops: [{ name: 'macro', description: 'Full product reference', region: 'full', outputSize: 1024 }],
        })
      }
    }

    return labels
  }
}
