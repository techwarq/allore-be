import { OpenAITextService } from '../openai/OpenAITextService'
import { IntentPlan } from '../../types/shoots'

// Detects a numbered placement list (≥2 items) and extracts each directive.
// Handles both newline-separated and inline formats.
function parseSceneDirectives(intent: string): string[] | null {
  const text = intent.replace(/\\n/g, '\n')
  if (!/\b1[\.\)]\s/.test(text) || !/\b2[\.\)]\s/.test(text)) return null
  const items = text
    .split(/\s*\b\d+[\.\)]\s+/)
    .map(s => s.trim())
    .filter(Boolean)
  return items.length >= 2 ? items : null
}

export class IntentDecoder {
  constructor(private openai: OpenAITextService) {}

  async decode(intent: string, assetIds: string[]): Promise<IntentPlan> {
    const system = `You are an avant-garde commercial Campaign Director and luxury lifestyle trend forecaster. Your role is to decode raw user inputs and elevate them into multi-million dollar high-fashion campaign concepts. You must fiercely protect the user's explicit setting, location, and macro mood constraints while injecting advanced photographic and cinematic texture vocabularies. Be decisive.`

    const userText = `Parse this luxury photoshoot request into a highly structured campaign layout blueprint.

CRITICAL PIPELINE RULE: Extract and lock the user's explicit location, environmental setting, and core mood coordinates first. Every creative variable must stay strictly bounded inside those user constraints. Never impose gothic, dark, or moody aesthetics unless specifically demanded by the input string.

User intent: "${intent}"
Number of assets provided: ${assetIds.length}

Return this exact JSON structure (raw JSON only, no markdown backticks, no markdown blocks):
{
  "overallStyle": "editorial" or "lifestyle" or "detail" or "mixed" or "infographic" or "ui_mockup",
  "mood": "3-5 high-end visual mood adjectives matching both the user's request and structural product energy",
  "background": "the EXACT location and environment the user requested with rich sensory material descriptors — never substitute a different setting",
  "stylingDirectives": "CRITICAL — extract any explicit prop, ingredient, object, or styling instructions the user mentioned (e.g. 'oversized ingredients', 'floating flowers', 'neon lights'). These MUST appear visually in every shot. Empty string if none.",
  "countHint": <number — exactly what user asked for, or sensible default: 2-3 per asset if unspecified>,
  "colorDirection": "cinematic analog film stock color profile matching the product, lighting setup, and setting",
  "rawIntent": "${intent.replace(/"/g, '\\"')}"
}

Definitions for Styles:
- editorial: Avant-garde high-fashion framing, distinct shadow geometry, product/model-centric layouts.
- lifestyle: Richly narrative, unposed, organic contextual settings that evoke high-end editorial storytelling.
- detail: Macro abstract texture tracking, material grain, and heavy macro focal compression.
- mixed: A curated hybrid of cinematic architectural scale and hyper-focused tactile vignettes.
- infographic: Product system overview with flat layouts, clean annotated text paths, and visual hierarchy.
- ui_mockup: Product cleanly composited inside an interface context — e-commerce grid view containers, mobile app layouts.

Output raw JSON only.`

    const sceneDirectives = parseSceneDirectives(intent)

    const text = await this.openai.chat(system, userText, true)
    if (!text) throw new Error('IntentDecoder: no response from model')

    console.log('[ALLORE_DEBUG][intent]', text)
    const raw = JSON.parse(text)

    // Normalize — model sometimes returns snake_case
    const plan: IntentPlan = {
      overallStyle: raw.overallStyle ?? raw.overall_style ?? 'mixed',
      mood:         raw.mood ?? 'refined elegant',
      background:   raw.background ?? intent,
      stylingDirectives: raw.stylingDirectives ?? raw.styling_directives ?? '',
      // Scene-list inputs: countHint = number of directives, never trust the LLM count
      countHint:    sceneDirectives ? sceneDirectives.length : (raw.countHint ?? raw.count_hint ?? 3),
      colorDirection: raw.colorDirection ?? raw.color_direction ?? 'natural tones',
      rawIntent:    raw.rawIntent ?? raw.raw_intent ?? intent,
      assetIds,
      ...(sceneDirectives ? { sceneDirectives } : {}),
    }
    return plan
  }
}
