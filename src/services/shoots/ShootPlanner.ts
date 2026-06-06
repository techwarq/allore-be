import { TextService } from '../gemini/TextService'
import { IntentPlan, AssetWithSpec, ShootPackage } from '../../types/shoots'

export class ShootPlanner {
  constructor(private textService: TextService) {}

  async plan(intentPlan: IntentPlan, assets: AssetWithSpec[], hasModels = false): Promise<ShootPackage[]> {
    const assetSummaries = assets.map((a, i) => ({
      index: i,
      id: a.id,
      productType: a.productSpec.productType,
      category: a.productSpec.category,
      colorProfile: a.productSpec.colorProfile,
      dimensions: a.productSpec.dimensions,
      spatialAnchor: a.productSpec.spatialAnchor,
    }))

    const modelNote = hasModels
      ? 'AI model reference images ARE available. Favour "on_model" or "lifestyle" for most shots to showcase how the product is worn. Include at least one "product_only" or "flat_lay" for detail variety.'
      : 'No model images available. Use "product_only", "flat_lay", or "lifestyle" (without people) shot types only. Do NOT use "on_model" or "mannequin".';

    const response = await this.textService.generate({
      model: 'gemini-3-flash-preview',
      systemInstruction: `You are a multi-award-winning commercial Campaign Director. You construct cinematic scenes and artistic narratives that look like high-end print advertisements. CRITICAL RULE: You must match the creative energy to the product. A soft, romantic, floral dress gets warm golden garden scenes — not dark forests or gothic settings. A bold streetwear piece gets urban edge. Always read the product DNA and set the scene accordingly. The user's explicit location and mood are non-negotiable constraints — you elevate within them, never override them. MODEL AVAILABILITY: ${modelNote}`,
      contents: [{
        role: 'user',
        parts: [{
          text: `Plan an elite product lookbook based on this intent and the available product DNA.

INTENT:
- Style: ${intentPlan.overallStyle}
- Mood: ${intentPlan.mood}
- Background: ${intentPlan.background}
- Number of shoots requested: ${intentPlan.countHint}
- Color direction: ${intentPlan.colorDirection}
- Original request: "${intentPlan.rawIntent}"

AVAILABLE PRODUCTS:
${JSON.stringify(assetSummaries, null, 2)}

Create exactly ${intentPlan.countHint} campaign packages. Vary the camera setups radically to maximize visual drama across the lookbook.

Return a JSON array of exactly ${intentPlan.countHint} objects (raw JSON, no markdown):
[
  {
    "shootIndex": 0,
    "theme": "evocative but appropriate commercial name that matches the product energy — e.g., 'Golden Hour Garden Hero' for a floral dress, 'The Concrete Edge' for a minimal sneaker. NEVER use gothic, horror, or dark names for soft/romantic products.",
    "concept": "2-3 sentences of editorial narrative that matches the product and user's requested setting. Soft products in gardens get warm romantic descriptions. Bold products get dynamic descriptions.",
    "angle": one of "front" | "back" | "3/4" | "side" | "detail_top" | "detail_bottom" | "detail_feature" | "overhead" | "close_up",
    "background": "highly specific environmental backdrop featuring micro-material descriptors (e.g., weathered Italian travertine stone, raw terracotta, damp volcanic ash flooring)",
    "lighting": "highly cinematic lighting physics, e.g., 'hard low-angle evening sun creating 4-foot long dramatic shadows' or 'dappled Rembrandt light filtering through an overhead grapevine canopy'",
    "modelType": one of "on_model" | "flat_lay" | "product_only" | "lifestyle" | "mannequin",
    "mood": "evocative mood tags, 3-5 words max",
    "assetIndex": <0-based index from AVAILABLE PRODUCTS above>
  }
]

Rules:
- MATCH ENERGY: Soft/romantic/floral products → warm, bright, natural settings. Bold/minimal products → clean, architectural, high-contrast settings. Dark/moody products → dramatic settings. Never mismatch.
- HONOR THE USER'S LOCATION: If user said "garden", every shot background must be a garden or garden-adjacent. Never substitute a dungeon, dark forest, or gothic setting.
- For wide formats like 16:9, if the product is a vertical cylinder/box, force a "3/4" angle or foreground foliage to fill the canvas without stretching the product.
- Vary angles — do not repeat the same angle for the same product unless count demands it
- detail_* and close_up angles should use product_only or flat_lay
- on_model for apparel when the user asks for a model
- assetIndex must be 0 to ${assets.length - 1}
- Return raw JSON array only`
        }]
      }],
      config: { responseMimeType: 'application/json' }
    })

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('ShootPlanner: no response from model')

    const packages: any[] = JSON.parse(text)

    return packages.map(pkg => ({
      shootIndex: pkg.shootIndex,
      theme: pkg.theme,
      concept: pkg.concept,
      angle: pkg.angle,
      background: pkg.background,
      lighting: pkg.lighting,
      modelType: pkg.modelType,
      mood: pkg.mood,
      asset: assets[pkg.assetIndex] ?? assets[0],
    }))
  }
}
