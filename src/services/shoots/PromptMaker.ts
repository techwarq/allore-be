import { TextService } from '../gemini/TextService'
import { ShootPackage, ShootPrompt } from '../../types/shoots'

// @ts-ignore — text module via wrangler rules
import nanobananaSkill from './skills/image-gen-prompt.md'

export class PromptMaker {
  constructor(private textService: TextService) {}

  async make(pkg: ShootPackage): Promise<ShootPrompt> {
    const spec = pkg.asset.productSpec

    const userMessage = `Generate a production-ready Nano Banana 2 (Gemini 3.1 Flash Image) prompt for this commercial product shoot.

SHOOT DETAILS:
- Shoot ${pkg.shootIndex + 1}: ${pkg.theme}
- Concept: ${pkg.concept}
- Angle: ${pkg.angle}
- Background: ${pkg.background}
- Lighting: ${pkg.lighting}
- Shot type: ${pkg.modelType}
- Mood: ${pkg.mood}

PRODUCT FORENSICS SPEC:
- Product: ${spec.productType}
- Category: ${spec.category}
- Materials: ${spec.materials.join(', ')}
- Finish: ${spec.finish}
- Color: ${spec.colorProfile.primary}${spec.colorProfile.secondary ? ` / ${spec.colorProfile.secondary}` : ''}, ${spec.colorProfile.pattern}
- Dimensions: ${spec.dimensions}
- SPATIAL ANCHOR: ${spec.spatialAnchor}
- Key details: ${spec.keyDetails.join(', ')}
- Premium details: ${spec.premiumDetails.join(', ') || 'none'}
- Contrast boundary: ${spec.contrastBoundary}
${spec.brandMarkings ? `- Brand markings: ${spec.brandMarkings}` : ''}
${spec.functionalElements ? `- Functional elements: ${spec.functionalElements}` : ''}

A reference image of the product will be passed alongside this prompt to the image model.

Using the Nano Banana Creative Director framework, write the complete production prompt following the OUTPUT FORMAT TEMPLATE exactly. Apply Framework A (Single Shot). Apply Section 5 Product Fidelity Rules — the spatial anchor and all product details are non-negotiable.

Output the prompt block only — no preamble, no explanation.`

    const response = await this.textService.generate({
      model: 'gemini-3.5-flash',
      systemInstruction: nanobananaSkill,
      contents: [{
        role: 'user',
        parts: [{ text: userMessage }]
      }]
    })

    const prompt = response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!prompt) throw new Error(`PromptMaker: no response for shoot ${pkg.shootIndex}`)

    return {
      shootIndex: pkg.shootIndex,
      prompt,
      concept: pkg.theme,
    }
  }
}
