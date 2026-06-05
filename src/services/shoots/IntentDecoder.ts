import { TextService } from '../gemini/TextService'
import { IntentPlan } from '../../types/shoots'

export class IntentDecoder {
  constructor(private textService: TextService) {}

  async decode(intent: string, assetIds: string[]): Promise<IntentPlan> {
    const response = await this.textService.generate({
      model: 'gemini-3.5-flash',
      systemInstruction: 'You are a fashion creative director. Parse photoshoot requests into structured plans. Be decisive — if count is unspecified, choose what makes creative sense for the number of assets.',
      contents: [{
        role: 'user',
        parts: [{
          text: `Parse this photoshoot request into a structured JSON plan.

User intent: "${intent}"
Number of assets/garments provided: ${assetIds.length}

Return this exact JSON structure (no markdown, raw JSON only):
{
  "overallStyle": "editorial" or "lifestyle" or "detail" or "mixed",
  "mood": "3-5 word mood description, e.g. 'minimal clean premium' or 'warm natural approachable'",
  "background": "specific background, e.g. 'clean white studio cyclorama' or 'natural outdoor warm light'",
  "countHint": <number — exactly what user asked for, or sensible default: 2-3 per garment if unspecified>,
  "colorDirection": "color palette direction, e.g. 'muted neutrals' or 'bold saturated contrast'",
  "rawIntent": "${intent.replace(/"/g, '\\"')}"
}

Definitions:
- editorial: clean studio, fashion-forward, model-focused
- lifestyle: contextual, natural, relatable, in real settings
- detail: close-up construction and texture shots
- mixed: combination of the above

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
