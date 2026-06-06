import { TextService } from '../gemini/TextService'
import { ShootPackage, ShootPrompt } from '../../types/shoots'

// @ts-ignore — text module via wrangler rules
import nanobananaSkill from './skills/image-gen-prompt.md'

export class PromptMaker {
  constructor(private textService: TextService) {}

  async make(pkg: ShootPackage): Promise<ShootPrompt> {
    const spec = pkg.asset.productSpec

    const userMessage = `Generate a high-performance, production-ready Nano Banana prompt that forces absolute product fidelity and cinematic realism.

SHOOT DETAILS:
- Shoot ${pkg.shootIndex + 1}: ${pkg.theme}
- Concept: ${pkg.concept}
- Angle: ${pkg.angle}
- Background: ${pkg.background}
- Lighting: ${pkg.lighting}
- Shot type: ${pkg.modelType}
- Mood: ${pkg.mood}

PRODUCT DESIGN DNA (from Universal Forensics):
- Product: ${spec.productType} | Category: ${spec.category}
- FORM GEOMETRY (Hard Lock): ${spec.formGeometry}
- Materials: ${spec.materials.join(', ')} | Finish: ${spec.finish}
- Color/Texture Profile: ${spec.colorProfile.primary}${spec.colorProfile.secondary ? ` / ${spec.colorProfile.secondary}` : ''} | Pattern: ${spec.colorProfile.pattern}
- Dimensions & Proportions: ${spec.dimensions}
- SPATIAL ANCHOR (Non-negotiable): ${spec.spatialAnchor}
- Key details to render: ${spec.keyDetails.join(', ')}
- Premium elements: ${spec.premiumDetails.join(', ') || 'none'}
- Contrast boundary rule: ${spec.contrastBoundary}
${spec.brandMarkings ? `- Brand markings: ${spec.brandMarkings}` : ''}
${spec.functionalElements ? `- Functional elements: ${spec.functionalElements}` : ''}

CRITICAL LENS & REALISM CONSTRAINTS (MANDATORY INJECTION):
1. GEOMETRY PROTECTION: The camera lens handles the aspect ratio via wide optical composition, background elements, and foreground layers. The product itself must remain completely unwarped and undistorted. Cylinders must retain their true diameter ratios; circles must never flatten into ovals.
2. HYPER-REAL REALISM PLUGINS: Force the model to render physical imperfections — subtle textile micro-creases, fine structural seams, real-world light refraction through glass/water, micro-droplets of condensation, microscopic fabric fuzz, and natural surface dust particles dancing in light beams.
3. NO DIGITAL LOOK: Explicitly mandate analog film stock emulsion profiles to completely kill the flat, polished, glossy CGI/AI render look.

A reference image of the product will be passed alongside this prompt to the image model.

Write the complete production prompt following the single-shot framework from your system instructions. Raw prompt text only — no preamble, no explanation, no code block backticks.`

    const response = await this.textService.generate({
      model: 'gemini-3-flash-preview',
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
