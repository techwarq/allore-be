import { TextService } from '../gemini/TextService'
import { IntentPlan } from '../../types/shoots'

export class IntentDecoder {
  constructor(private textService: TextService) {}

  async decode(intent: string, assetIds: string[]): Promise<IntentPlan> {
    const response = await this.textService.generate({
      model: 'gemini-3-flash-preview',
      systemInstruction: 'You are a luxury commercial Creative Director. Your job is to decode raw user intent and elevate it into a high-end campaign concept — but you MUST honor the user\'s explicit setting, location, and mood first. If the user says garden, you shoot in a garden. If they say bright and sunny, it is bright and sunny. You elevate the aesthetic WITHIN the user\'s constraints — you never override them. Match the creative energy to the product: soft romantic products get soft romantic settings, bold products get bold settings.',
      contents: [{
        role: 'user',
        parts: [{
          text: `Parse this photoshoot request into a luxury campaign blueprint.

CRITICAL RULE: Extract and lock the user's explicit location, setting, and mood FIRST. All creative decisions must stay within those constraints. Never impose dark, moody, or gothic aesthetics unless the user explicitly asked for them.

User intent: "${intent}"
Number of assets/garments provided: ${assetIds.length}

Return this exact JSON structure (no markdown, raw JSON only):
{
  "overallStyle": "editorial" or "lifestyle" or "detail" or "mixed",
  "mood": "3-5 mood adjectives that match BOTH the user's request AND the product energy — e.g., 'soft romantic golden ethereal' for a floral dress in a garden, 'bold clean architectural' for a minimal sneaker in a studio",
  "background": "the EXACT setting the user requested, described with rich sensory texture — e.g., if user said 'garden': 'sun-dappled English garden with blooming rose hedges and soft dew on grass' — never substitute a different location",
  "countHint": <number — exactly what user asked for, or sensible default: 2-3 per garment if unspecified>,
  "colorDirection": "cinematic color science that matches the product and setting, e.g., 'warm Kodak Portra pastels with soft golden highlights' or 'cool clean Fuji 400H tones'",
  "rawIntent": "${intent.replace(/"/g, '\\"')}"
}

Definitions:
- editorial: High-fashion framing, clean or dramatic, model/product-centric layouts.
- lifestyle: Natural, contextual, narrative — real settings the target customer inhabits.
- detail: Macro texture, material grain, heavy focal compression.
- mixed: Curated combination of the above.

Return raw JSON only.`
        }]
      }],
      config: { responseMimeType: 'application/json' }
    })

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('IntentDecoder: no response from model')

    const parsed = JSON.parse(text)
    return { ...parsed, assetIds } as IntentPlan
  }
}
