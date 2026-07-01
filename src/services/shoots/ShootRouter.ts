import { OpenAITextService } from '../openai/OpenAITextService'
import { ProductGroup, IntentPlan, AssetTag } from '../../types/shoots'

export type RawAsset = {
  id: string
  r2Key: string
  base64: string
  mimeType: string
  tag?: AssetTag
}

export type RouterResult = {
  groups: ProductGroup[]
}

// Detects a numbered placement list (≥2 items) and extracts each directive.
// Handles both newline-separated ("1.\nX\n2.\nY") and inline ("1. X  2. Y  3. Z") formats.
function parseSceneDirectives(intent: string): string[] | null {
  const text = intent.replace(/\\n/g, '\n')

  // Must contain at least "1." and "2." markers to be a list
  if (!/\b1[\.\)]\s/.test(text) || !/\b2[\.\)]\s/.test(text)) return null

  // Split on numbered markers — works inline or multi-line
  const items = text
    .split(/\s*\b\d+[\.\)]\s+/)
    .map(s => s.trim())
    .filter(Boolean)

  return items.length >= 2 ? items : null
}

export class ShootRouter {
  constructor(private openai: OpenAITextService) {}

  async route(rawAssets: RawAsset[], rawIntent: string): Promise<RouterResult> {
    // If all assets have tags — group by product family via LLM text call (no vision)
    if (rawAssets.every(a => a.tag?.productLabel)) {
      return await this.routeByTags(rawAssets, rawIntent)
    }

    // Single asset — skip the vision call, return one group directly
    if (rawAssets.length === 1) {
      const singleDirectives = parseSceneDirectives(rawIntent)
      const countHint = singleDirectives
        ? singleDirectives.length
        : (this.parseExplicitCountPerProduct(rawIntent) ?? 3)
      return {
        groups: [{
          groupId: 'group_0',
          productLabel: 'product',
          assetIds: [rawAssets[0].id],
          intentPlan: {
            ...this.fallbackIntentPlan(rawIntent, [rawAssets[0].id]),
            countHint,
            ...(singleDirectives ? { sceneDirectives: singleDirectives } : {}),
          },
        }],
      }
    }

    // Scene list + multiple untagged assets: skip grouping, one group, directive prompt picks the right asset per shoot
    const multiDirectives = parseSceneDirectives(rawIntent)
    if (multiDirectives) {
      return {
        groups: [{
          groupId: 'group_0',
          productLabel: 'product collection',
          assetIds: rawAssets.map(a => a.id),
          intentPlan: {
            ...this.fallbackIntentPlan(rawIntent, rawAssets.map(a => a.id)),
            countHint: multiDirectives.length,
            sceneDirectives: multiDirectives,
          },
        }]
      }
    }

    const system = `You are a product photography shoot planner and router.

You receive multiple product images and the user's shoot brief.

Your job:
1. Group the images by DISTINCT PRODUCT IDENTITY
2. For each group, extract the shoot descriptions that apply to it from the user's brief
3. Produce a structured routing plan that drives the shoot engine

WHAT IS A DISTINCT PRODUCT GROUP:

SAME GROUP (merge these — do NOT split):
- Same physical product from different angles: front view, back view, side view, folded view, hanging view, flat lay → ONE group
- Same product in different compositions or styling setups (on a sofa, on a hanger, draped on a table) → ONE group
- Close-up / detail / macro shots of a product that appears in other images → ONE group with the full shots
- Multiple units of the same product (a pair of cushions, a set of 3 towels) → ONE group
- WHEN IN DOUBT → keep in the same group. Over-merging is always better than over-splitting.

DIFFERENT GROUP (only split when ALL of these are true):
1. The products are visually and physically different objects (a cushion and a blanket are different; a bath towel and a hand towel are different)
2. AND the user's brief explicitly names or describes them as separate items
3. AND they have clearly different product specs (different shape, different size category, different function)

NEVER split a group just because:
- Images show different angles of the same item
- Images show the product in different settings or compositions
- One image is a close-up and another is a full shot
- The lighting or background differs between images

FOR EACH GROUP:
- productLabel: a precise, human-readable label — "ivory cotton bath towels", "block-print decorative cushions"
- assetIds: EXACTLY the IDs of the images belonging to this group — every image must be in exactly one group
- intentPlan: per-group intent derived from the brief
  - rawIntent: ONLY the portion of the user's text that applies to this specific product
  - countHint: number of shoots for this product — see COUNT RULE below
  - background: the specific environments/locations mentioned for this product
  - stylingDirectives: any props, styling elements, or visual directives mentioned for this product specifically
  - overallStyle: "editorial" | "lifestyle" | "detail" | "mixed" — derive from the described shots
  - mood: emotional adjectives derived from the described environments and shots
  - colorDirection: appropriate film stock / color aesthetic for this product's described shoots

COUNT RULE — this is critical:
Any number of shoots the user specifies applies PER PRODUCT, not as a total.
- "4 shoots" with 3 products → every product gets countHint: 4 (total = 12)
- "4 shoots each" → every product gets countHint: 4
- "3 shots per product" → every product gets countHint: 3
- No count specified → count the distinct shoot scenarios described for that product in the brief`

    const userText = `Analyze these ${rawAssets.length} product images and the user's brief below.

ASSET ID MAP — use these exact IDs in your response:
${rawAssets.map((a, i) => `Image ${i} → assetId: "${a.id}"`).join('\n')}

USER'S BRIEF:
"${rawIntent}"

Instructions:
- Your PRIMARY goal is to identify the minimum number of truly distinct physical products. Start with one group and only add more when you are certain images show genuinely different products.
- Same product, different angle/composition/styling/lighting → same group. Always.
- A close-up or detail shot of a product that appears in other images → merge into that product's group.
- Only create a new group when the product is physically and visually a different object.
- Read the brief to map shoot descriptions to product groups. If the user explicitly names different products, use those names to guide grouping.
- If the user specifies a number of shoots, apply that number to EVERY product group (not split across them).
- Every image must be assigned to exactly one group.
- If you are unsure whether two images show the same or different products → put them in the same group.

Return raw JSON only — no markdown, no backticks:
{
  "groups": [
    {
      "groupId": "group_0",
      "productLabel": "precise label for this product variant",
      "assetIds": ["exact-uuid-here"],
      "intentPlan": {
        "overallStyle": "lifestyle",
        "mood": "calm, domestic, fresh, natural",
        "background": "tiled bathroom with chrome fixtures, wash basin with wooden shelf",
        "stylingDirectives": "",
        "countHint": 3,
        "colorDirection": "warm neutral daylight, soft shadows, crisp whites",
        "rawIntent": "only the part of the brief that applies to this product"
      }
    }
  ]
}`

    let text: string
    try {
      text = await this.openai.chatWithMultipleImages(
        system,
        userText,
        rawAssets.map(a => ({ base64: a.base64, mimeType: a.mimeType })),
        true
      )
    } catch (err: any) {
      console.warn('[ShootRouter] Vision call failed, falling back to single group:', err.message)
      return this.fallbackSingleGroup(rawAssets, rawIntent)
    }

    if (!text) return this.fallbackSingleGroup(rawAssets, rawIntent)

    console.log('[ALLORE_DEBUG][shoot_router]', text)

    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      console.warn('[ShootRouter] JSON parse failed, falling back to single group')
      return this.fallbackSingleGroup(rawAssets, rawIntent)
    }

    const groups: ProductGroup[] = (parsed.groups ?? []).map((g: any, i: number) => ({
      groupId: g.groupId ?? `group_${i}`,
      productLabel: g.productLabel ?? 'product',
      assetIds: (g.assetIds ?? []).filter((id: string) => rawAssets.some(a => a.id === id)),
      intentPlan: this.normalizeIntentPlan(g.intentPlan, g.assetIds ?? []),
    })).filter((g: ProductGroup) => g.assetIds.length > 0)

    // Safety: any image not assigned to a group goes into a fallback group
    const assignedIds = new Set(groups.flatMap(g => g.assetIds))
    const unassigned = rawAssets.filter(a => !assignedIds.has(a.id))
    if (unassigned.length > 0) {
      groups.push({
        groupId: `group_fallback`,
        productLabel: 'additional products',
        assetIds: unassigned.map(a => a.id),
        intentPlan: this.fallbackIntentPlan(rawIntent, unassigned.map(a => a.id)),
      })
    }

    const explicitCount = this.parseExplicitCountPerProduct(rawIntent)
    if (explicitCount) {
      for (const g of groups) {
        g.intentPlan = { ...g.intentPlan, countHint: explicitCount }
      }
      console.log(`[ALLORE_DEBUG][shoot_router] explicit count per product: ${explicitCount}`)
    }

    return { groups }
  }

  private async routeByTags(rawAssets: RawAsset[], rawIntent: string): Promise<RouterResult> {
    const sceneDirectives = parseSceneDirectives(rawIntent)

    // Scene list: skip product grouping entirely — all assets go into one group.
    // The ShootPlanner directive prompt picks the right asset per shoot using each asset's label.
    if (sceneDirectives) {
      return {
        groups: [{
          groupId: 'group_0',
          productLabel: rawAssets.map(a => a.tag!.productLabel).join(' / '),
          assetIds: rawAssets.map(a => a.id),
          intentPlan: {
            ...this.fallbackIntentPlan(rawIntent, rawAssets.map(a => a.id)),
            countHint: sceneDirectives.length,
            sceneDirectives,
          },
        }]
      }
    }

    const explicitCount = this.parseExplicitCountPerProduct(rawIntent) ?? 3

    if (rawAssets.length === 1) {
      return {
        groups: [{
          groupId: 'group_0',
          productLabel: rawAssets[0].tag!.productLabel,
          assetIds: [rawAssets[0].id],
          intentPlan: {
            ...this.fallbackIntentPlan(rawIntent, [rawAssets[0].id]),
            countHint: explicitCount,
          },
        }],
      }
    }

    // Use a text-only LLM call to group labels by product family.
    // This handles cases like "hand towel" + "bath towel" + "face towel" → one towel collection.
    const system = `You are a product grouping assistant for a photoshoot pipeline.

Given labeled product images and a user's shoot brief, group images that belong to the same product or product collection.

SAME GROUP — merge these:
- Size/type variants of the same product: hand towel + bath towel + face towel → "towel collection"
- Same product, different angles: front + back + side view → one group
- Same product, different styling or composition → one group
- Color variants or fabric variants of the same SKU → one group
- WHEN IN DOUBT → merge into one group. Over-merging is always correct; over-splitting ruins shoots.

DIFFERENT GROUPS — only split when ALL of these are true:
- Completely different product categories (a dress AND a pair of shoes)
- AND the user's brief explicitly names them as separate items to shoot independently

For each group provide a concise productLabel describing the collection (e.g. "green embroidered towel collection").

Return raw JSON only:
{
  "groups": [
    { "groupId": "group_0", "productLabel": "concise label", "assetIndices": [0, 1, 2] }
  ]
}`

    const userText = `USER'S BRIEF: "${rawIntent}"

LABELED IMAGES:
${rawAssets.map((a, i) => `Image ${i}: "${a.tag!.productLabel}" (view: ${a.tag!.viewType})`).join('\n')}

Group by distinct product or collection. Return JSON.`

    try {
      const text = await this.openai.chat(system, userText, true)
      if (!text) throw new Error('empty response')

      console.log('[ALLORE_DEBUG][shoot_router_tag_grouping]', text)
      const parsed = JSON.parse(text)

      const groups: ProductGroup[] = ((parsed.groups ?? []) as any[])
        .map((g: any, i: number) => {
          const indices: number[] = g.assetIndices ?? []
          const groupAssets = indices.map((idx: number) => rawAssets[idx]).filter(Boolean)
          if (groupAssets.length === 0) return null
          return {
            groupId: g.groupId ?? `group_${i}`,
            productLabel: g.productLabel ?? groupAssets[0].tag!.productLabel,
            assetIds: groupAssets.map(a => a.id),
            intentPlan: { ...this.fallbackIntentPlan(rawIntent, groupAssets.map(a => a.id)), countHint: explicitCount },
          }
        })
        .filter((g): g is ProductGroup => g !== null)

      // Any unassigned assets go into the first group
      const assignedIds = new Set(groups.flatMap(g => g.assetIds))
      const unassigned = rawAssets.filter(a => !assignedIds.has(a.id))
      if (unassigned.length > 0 && groups.length > 0) {
        groups[0].assetIds.push(...unassigned.map(a => a.id))
      } else if (unassigned.length > 0) {
        groups.push({
          groupId: 'group_fallback',
          productLabel: unassigned[0].tag!.productLabel,
          assetIds: unassigned.map(a => a.id),
          intentPlan: { ...this.fallbackIntentPlan(rawIntent, unassigned.map(a => a.id)), countHint: explicitCount },
        })
      }

      console.log('[ALLORE_DEBUG][shoot_router_by_tags]', groups.map(g => ({ groupId: g.groupId, productLabel: g.productLabel, assetCount: g.assetIds.length })))
      return { groups }
    } catch (err: any) {
      console.warn('[ShootRouter] Tag grouping failed, falling back to single group:', err.message)
      return {
        groups: [{
          groupId: 'group_0',
          productLabel: rawAssets[0].tag!.productLabel,
          assetIds: rawAssets.map(a => a.id),
          intentPlan: {
            ...this.fallbackIntentPlan(rawIntent, rawAssets.map(a => a.id)),
            countHint: explicitCount,
          },
        }],
      }
    }
  }

  // Detect any explicit shoot count the user specified.
  // In a multi-product context, any stated count = per product.
  private parseExplicitCountPerProduct(intent: string): number | null {
    const patterns = [
      // Most explicit: "4 shoots each", "3 shots per product", "each product 5 shots"
      /\b(\d+)\s*(?:shoots?|shots?|images?|photos?)\s*(?:each|per\s*product|for\s*each|each\s*product)\b/i,
      /\beach\s*(?:product\s*)?(?:gets?|should\s*have|needs?|with)?\s*(\d+)\s*(?:shoots?|shots?|images?|photos?)\b/i,
      /\b(\d+)\s*(?:shoots?|shots?)\s*each\b/i,
      /\b(\d+)\s*each\b/i,
      // Plain count: "4 shoots", "3 shots" — in multi-product context means per product
      /\b(\d+)\s*shoots?\b/i,
      /\b(\d+)\s*shots?\b/i,
    ]
    for (const pattern of patterns) {
      const match = intent.match(pattern)
      if (match) {
        const count = parseInt(match[1])
        if (count >= 1 && count <= 20) return count
      }
    }
    return null
  }

  private normalizeIntentPlan(raw: any, assetIds: string[]): IntentPlan {
    return {
      overallStyle: raw?.overallStyle ?? 'lifestyle',
      mood: raw?.mood ?? 'natural, authentic',
      background: raw?.background ?? '',
      stylingDirectives: raw?.stylingDirectives ?? '',
      countHint: Math.max(1, parseInt(raw?.countHint) || 3),
      colorDirection: raw?.colorDirection ?? 'natural daylight tones',
      rawIntent: raw?.rawIntent ?? '',
      assetIds,
    }
  }

  private fallbackIntentPlan(rawIntent: string, assetIds: string[]): IntentPlan {
    return {
      overallStyle: 'lifestyle',
      mood: 'natural, authentic',
      background: rawIntent,
      stylingDirectives: '',
      countHint: 3,
      colorDirection: 'natural daylight',
      rawIntent,
      assetIds,
    }
  }

  private fallbackSingleGroup(rawAssets: RawAsset[], rawIntent: string): RouterResult {
    return {
      groups: [{
        groupId: 'group_0',
        productLabel: 'product',
        assetIds: rawAssets.map(a => a.id),
        intentPlan: this.fallbackIntentPlan(rawIntent, rawAssets.map(a => a.id)),
      }],
    }
  }
}
