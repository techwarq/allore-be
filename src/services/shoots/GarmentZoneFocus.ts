import { ProductSpec } from '../../types/shoots'

export type ZoneName = 'macro' | 'neckline' | 'cuff' | 'hem'

/**
 * Decides which garment zones to request from the preprocessor.
 * Uses productSpec (from forensics) + user intent text.
 * No LLM call — pure rule matching, zero latency.
 */
export function selectFocusZones(productSpec: ProductSpec, intent: string): ZoneName[] {
  const zones = new Set<ZoneName>(['macro']) // always include full garment crop

  const combined = [
    intent,
    ...(productSpec.keyDetails ?? []),
    ...(productSpec.premiumDetails ?? []),
    productSpec.productType ?? '',
    productSpec.category ?? '',
    productSpec.finish ?? '',
  ].join(' ').toLowerCase()

  // Neckline / collar / shoulder area
  if (/collar|neckline|neck|shoulder|lapel|v.?neck|crew|scoop|décolleté|decollete|yoke/.test(combined)) {
    zones.add('neckline')
  }

  // Sleeve / cuff / wrist detail
  if (/cuff|sleeve|wrist|arm|bell sleeve|puff sleeve|ruffle sleeve/.test(combined)) {
    zones.add('cuff')
  }

  // Hem / bottom / trim / waist
  if (/hem|bottom|trim|border|waist|flare|midi|maxi|mini|length|fringe|ruffle hem/.test(combined)) {
    zones.add('hem')
  }

  // Intricate details → all zones
  if (/embroidery|embroidered|bead|sequin|lace|appliqué|applique|hand.?stitch|smocking|cutwork|eyelet|jacquard/.test(combined)) {
    zones.add('neckline')
    zones.add('cuff')
    zones.add('hem')
  }

  // Category defaults — always show neckline + hem for any apparel
  const isApparel = /apparel|dress|shirt|blouse|top|jacket|coat|suit|knitwear|sweater|skirt|trouser|pant/.test(combined)
  if (isApparel) {
    zones.add('neckline')
    zones.add('hem')
  }

  return Array.from(zones)
}

/**
 * Builds the zone-preservation clause to append to the prompt.
 */
export function buildZonePromptClause(zoneNames: ZoneName[]): string {
  if (zoneNames.length === 0) return ''
  const listed = zoneNames.filter(z => z !== 'macro').join(', ')
  if (!listed) return ''
  return `\n\nZONE REFERENCE IMAGES (${listed}) are included showing zoomed-in crops of the actual garment. ` +
    `You MUST preserve every detail in those crops exactly as shown — embroidery, stitching, fabric texture, ` +
    `trim lines, patterns, and colours are non-negotiable. The generated shoot image must match these zones perfectly.`
}
