import { OpenAITextService } from '../openai/OpenAITextService'
import { ShootPackage } from '../../types/shoots'

export type ReviewResult = {
  hasIssues: boolean
  issue?: string
  correctedPrompt?: string
}

export class ImageQualityReviewer {
  constructor(private openai: OpenAITextService) {}

  async review(
    generatedBase64: string,
    originalBase64: string,
    originalMimeType: string,
    prompt: string,
    pkg: ShootPackage
  ): Promise<ReviewResult> {
    const system = `You are a quality control inspector for AI-generated product photography.

You receive two images:
- Image 0: The ORIGINAL product reference (what the real product looks like)
- Image 1: The AI-GENERATED photoshoot result

Your ONLY job: check for SEVERE product identity failures only.

FLAG ONLY these failures (the bar is very high):
- Completely wrong product TYPE — a shirt generated when the product is a mug, a shoe generated when the product is a towel
- Product is completely missing from the image — nothing resembling the product exists in the frame
- Completely wrong color FAMILY — a red product where the reference is clearly white/blue/green (not just a different shade of the same color family)

DO NOT FLAG — these are normal and expected:
- Different shades of the same color (olive green vs sage green, both are green — do NOT flag)
- Lighting making the color look different (same color under different light — do NOT flag)
- Background, environment, styling, props (intentionally different — do NOT flag)
- Composition, framing, camera angle
- Artistic quality, sharpness, realism
- Minor proportion differences

The DEFAULT answer is hasIssues: false. Only return true for severe, obvious failures.

Return raw JSON only:
{
  "hasIssues": false
}
OR only for severe failures:
{
  "hasIssues": true,
  "issue": "one sentence — e.g. 'a coffee mug was generated instead of a towel'",
  "promptCorrection": "CRITICAL CORRECTION — [hard constraint prepended to prompt, e.g. 'This product is a green hand towel. The generated image must show a TOWEL, not any other object.']"
}`

    const userText = `PRODUCT: ${pkg.asset.productSpec.productType}

Image 0 = original product reference
Image 1 = generated photoshoot result

Does Image 1 correctly feature the product shown in Image 0? Return JSON.`

    try {
      const text = await this.openai.chatWithMultipleImages(
        system,
        userText,
        [
          { base64: originalBase64, mimeType: originalMimeType },
          { base64: generatedBase64, mimeType: 'image/png' },
        ],
        true
      )

      if (!text) return { hasIssues: false }

      console.log(`[ALLORE_DEBUG][quality_reviewer_shoot_${pkg.shootIndex}]`, text)

      const parsed = JSON.parse(text)
      if (!parsed.hasIssues) return { hasIssues: false }

      // Prepend the correction so it leads the prompt — appending buries it
      const correctedPrompt = parsed.promptCorrection
        ? `${parsed.promptCorrection}\n\n${prompt}`
        : undefined

      return {
        hasIssues: true,
        issue: parsed.issue,
        correctedPrompt,
      }
    } catch (err: any) {
      console.warn(`[ImageQualityReviewer] Review failed for shoot ${pkg.shootIndex}:`, err.message)
      return { hasIssues: false }
    }
  }
}
