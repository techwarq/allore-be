import { TextService } from '../gemini/TextService'
import { IntentPlan, AssetWithSpec, ShootPackage } from '../../types/shoots'

export class ShootPlanner {
  constructor(private textService: TextService) {}

  async plan(intentPlan: IntentPlan, assets: AssetWithSpec[]): Promise<ShootPackage[]> {
    const assetSummaries = assets.map((a, i) => ({
      index: i,
      id: a.id,
      productType: a.productSpec.productType,
      category: a.productSpec.category,
      colorProfile: a.productSpec.colorProfile,
      dimensions: a.productSpec.dimensions,
      spatialAnchor: a.productSpec.spatialAnchor,
    }))

    const response = await this.textService.generate({
      model: 'gemini-3-flash-preview',
      systemInstruction: 'You are a senior commercial photography creative director. You plan product shoots for any type of product — apparel, electronics, beauty, food, furniture, anything. Create shoot plans that showcase the product accurately and attractively.',
      contents: [{
        role: 'user',
        parts: [{
          text: `Plan a product photoshoot based on this intent and the available products.

INTENT:
- Style: ${intentPlan.overallStyle}
- Mood: ${intentPlan.mood}
- Background: ${intentPlan.background}
- Number of shoots requested: ${intentPlan.countHint}
- Color direction: ${intentPlan.colorDirection}
- Original request: "${intentPlan.rawIntent}"

AVAILABLE PRODUCTS:
${JSON.stringify(assetSummaries, null, 2)}

Create exactly ${intentPlan.countHint} shoot packages. If there is 1 product, show it from different angles. If multiple products, distribute thoughtfully.

Return a JSON array of exactly ${intentPlan.countHint} objects (raw JSON, no markdown):
[
  {
    "shootIndex": 0,
    "theme": "short descriptive name, e.g. 'Hero Front Shot' or 'Detail Handle Close-Up' or 'Lifestyle In Use'",
    "concept": "2-3 sentence creative concept",
    "angle": one of "front" | "back" | "3/4" | "side" | "detail_top" | "detail_bottom" | "detail_feature" | "overhead" | "close_up",
    "background": "specific background for this shot",
    "lighting": "specific lighting, e.g. 'soft three-point softbox' or 'natural window sidelight'",
    "modelType": one of "on_model" | "flat_lay" | "product_only" | "lifestyle" | "mannequin",
    "mood": "mood in 3-5 words",
    "assetIndex": <0-based index from AVAILABLE PRODUCTS above>
  }
]

Rules:
- Choose modelType based on product category: apparel → on_model or mannequin; products → product_only or lifestyle; flat items → flat_lay
- Vary angles — do not repeat the same angle for the same product unless count demands it
- detail_* and close_up angles should use product_only or flat_lay
- overhead works well for tableware, food, flat items
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
