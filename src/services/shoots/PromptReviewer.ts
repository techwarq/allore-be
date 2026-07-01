import { OpenAITextService } from '../openai/OpenAITextService'
import { ShootPackage } from '../../types/shoots'

export class PromptReviewer {
  constructor(private openai: OpenAITextService) {}

  async review(prompt: string, pkg: ShootPackage): Promise<string> {
    const spec = pkg.asset.productSpec

    const system = `You are a physical realism validator for AI product photography prompts.
Your ONLY job: check and fix scale, proportion, and placement errors in the prompt.
You do NOT touch creative direction, storytelling, color grading, lighting aesthetics, or world-building.

WHAT YOU CHECK:
1. PRODUCT SCALE — Is the product at its correct real-world size relative to the environment and any human or furniture elements?
   Examples of errors to fix:
   - "a cushion resting on a tiny loveseat" — a standard cushion (45-60cm) means the sofa must be full-size furniture
   - "the can dwarfs the kitchen counter" — a beverage can is ~12cm tall, a kitchen counter is 90cm high
   - "the ring fills the entire hand" — jewellery must be proportional to fingers/wrist
   - "the dress flows across a vast ballroom floor" — a midi dress hem is at mid-calf, not floor-length unless spec says so

2. ENVIRONMENT SCALE — Do the surrounding elements (furniture, architecture, props) correctly size themselves relative to the product?
   - A product placed on a coffee table → the table is a normal coffee table, not a dining table unless described
   - A rug in a room → the room has walls, the rug does not fill the entire visible space unless it's a full-room rug

3. PHYSICAL PLACEMENT — Is the product in a physically possible position?
   - Products on surfaces must visually contact that surface (no floating above)
   - Soft textiles obey gravity unless a dynamic/action shot is described (e.g., "thrown mid-air")
   - A product "on a shelf" → the shelf supports it from below, not the side

IF EVERYTHING IS CORRECT → return the prompt word-for-word, unchanged.
IF THERE ARE SCALE OR PLACEMENT ERRORS → fix only those specific phrases or sentences. Do not rewrite the creative vision, do not change environment choice, do not alter lighting or mood.

Return the corrected prompt only. No preamble, no explanation, no markdown.`

    const userText = `PRODUCT: ${spec.productType} (${spec.category})
DIMENSIONS: ${spec.dimensions}
SPATIAL ANCHOR: ${spec.spatialAnchor}
SHOT TYPE: ${pkg.modelType} | ANGLE: ${pkg.angle}

PROMPT TO REVIEW:
${prompt}`

    const reviewed = await this.openai.chat(system, userText, false)
    if (!reviewed || reviewed.trim().length < 50) {
      // If reviewer returns something too short or empty, keep original
      return prompt
    }

    console.log(`[ALLORE_DEBUG][prompt_reviewer_shoot_${pkg.shootIndex}]`, JSON.stringify({
      original_length: prompt.length,
      reviewed_length: reviewed.trim().length,
      changed: reviewed.trim() !== prompt.trim(),
    }))

    return reviewed.trim()
  }
}
