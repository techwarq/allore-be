import { OpenAITextService } from '../openai/OpenAITextService'
import { ShootPackage, ShootPrompt, ImageManifestEntry, AssetWithSpec, ViewType } from '../../types/shoots'

// @ts-ignore — text module via wrangler rules
import systemSkill from './skills/image-gen-prompt.md'

export type ZoneWithDescription = { name: string; description: string }

const SCENE_EMBEDDED_CATEGORIES = new Set(['homeware', 'furniture'])
const SCENE_EMBEDDED_KEYWORDS = ['sheet', 'duvet', 'bedspread', 'blanket', 'rug', 'curtain', 'pillow', 'linen', 'quilt', 'throw', 'towel', 'cover']

function isSceneEmbedded(spec: { category: string; productType: string }): boolean {
  if (SCENE_EMBEDDED_CATEGORIES.has(spec.category)) return true
  const lower = spec.productType.toLowerCase()
  return SCENE_EMBEDDED_KEYWORDS.some(k => lower.includes(k))
}

const DETAIL_ANGLES = new Set(['detail_top', 'detail_bottom', 'detail_feature', 'close_up'])

function isDetailShoot(angle: string): boolean {
  return DETAIL_ANGLES.has(angle)
}

// Human-readable label for each view type used in the manifest
const VIEW_TYPE_LABEL: Record<ViewType, string> = {
  full_front:      'full front view',
  full_back:       'full back view',
  three_quarter:   '3/4 angle',
  side:            'side view',
  detail_top:      'detail — top/collar zone',
  detail_bottom:   'detail — hem/base zone',
  detail_center:   'detail — center/label zone',
  detail_texture:  'detail — fabric/material texture',
  flat_lay:        'flat lay',
  lifestyle:       'lifestyle/on-model',
  packaging:       'packaging',
  unknown:         'product view',
}

// Per-category generation rules that flow into every prompt.
// GPT-image-2 must respect these as hard physical constraints.
function getCategoryDirective(category: string, productType: string): string {
  const cat = category.toLowerCase()
  const type = productType.toLowerCase()

  if (cat === 'apparel' || /dress|shirt|blouse|jacket|coat|trouser|skirt|top|knitwear|sweater|suit|saree|lehenga|kurta|hoodie/.test(type)) {
    return `APPAREL PHYSICS — hard constraints:
This is a fabric garment. It MUST obey gravity and textile physics at all times.
On a person: it follows body curves, drapes naturally, falls with its own weight.
On a flat surface: it lies flat with natural fabric weight and soft creases — never rigid.
NEVER show this garment floating, hovering, or standing upright unsupported.
NEVER make it rigid like a cardboard cutout. Fabric has weight, drape, and movement.`
  }

  if (cat === 'homeware' || /towel|sheet|duvet|pillow|blanket|rug|curtain|linen|quilt|throw|cover|placemat|napkin/.test(type)) {
    return `HOME TEXTILE PHYSICS — hard constraints:
This is a soft home textile. It MUST appear in a contextually correct domestic environment.
Towel → bathroom, spa, pool area, near water. NEVER in a void, floating, or in an outdoor non-water setting.
Bedding (sheets, duvet, pillow) → on a bed in a bedroom. NEVER draped over furniture that isn't a bed.
Rug → on a floor inside a room. NEVER hanging or floating.
The textile drapes and falls with natural fabric weight. NEVER stiff or rigid.
The ENVIRONMENT around it fills the canvas — the textile is styled naturally within that environment.`
  }

  if (cat === 'furniture') {
    return `FURNITURE SCALE — hard constraints:
This is a furniture piece. It MUST appear at human-scale in a complete room environment.
Show floor contact, wall/room context, and spatial depth. NEVER show furniture floating or isolated.
All proportions must match the source image exactly — do not resize or rescale the piece.`
  }

  if (/can|bottle|glass|jar|carton|cup|mug|tumbler/.test(type) || cat === 'food' || cat === 'beverage') {
    return `BEVERAGE/FOOD CONTAINER GEOMETRY — hard constraints:
The container's structural geometry is an absolute mathematical lock:
Cylinders MUST stay cylindrical — circles cannot become ovals under any aspect ratio transformation.
Rectangular containers MUST keep all right-angle corners — no perspective warping.
Label text and brand graphics must appear VERBATIM and legible — zero reflow, zero letter alteration.
Condensation, ice, or liquid are appropriate context props for beverages.`
  }

  if (cat === 'beauty' || cat === 'skincare') {
    return `BEAUTY/SKINCARE PACKAGING — hard constraints:
Label text, ingredient lists, and brand markings must appear VERBATIM with zero alteration.
The packaging geometry is an absolute constraint — bottle shape, cap, dispenser must match source exactly.
Place on vanity surfaces, marble, tray, or held in hand. NEVER floating in abstract space.`
  }

  if (cat === 'jewellery' || cat === 'accessories') {
    return `JEWELLERY/ACCESSORIES SCALE — hard constraints:
This is a small, delicate item. It must appear at human-proportional scale — do NOT make it oversized.
Show on skin, on a surface, or as a macro detail shot. Material and finish (gold, silver, gemstone facets) must be physically accurate.
NEVER floating or scaled up to fill the frame.`
  }

  if (cat === 'footwear') {
    return `FOOTWEAR PHYSICS — hard constraints:
Shoes rest on surfaces or appear on feet. The sole MUST touch a ground plane. NEVER floating.
If showing a pair, left and right shoes must be correctly mirrored — not two right feet.
The shoe's structural geometry (sole thickness, heel height, toe box) must match source exactly.`
  }

  return ''
}

// Absolute size and geometry lock block — the main fix for proportion distortion
function getSizeLockBlock(spec: { dimensions: string; spatialAnchor: string; formGeometry: string; productType: string }): string {
  return `ABSOLUTE SIZE & GEOMETRY LOCK — non-negotiable hard constraints:
DIMENSIONS: ${spec.dimensions}. The product appears at this natural, real-world scale. Do NOT upscale it.
GEOMETRY: ${spec.formGeometry}. Every geometric constraint here is absolute — do NOT warp, stretch, or distort these proportions.
SPATIAL ANCHOR: ${spec.spatialAnchor}. This is the physical grounding rule. The product cannot violate this.
WIDE CANVAS RULE: Output is 1536×1024 (16:9 landscape). If the product is portrait-shaped or square, it sits in the CENTER of the frame. The environment — walls, floor, props, sky — fills the horizontal margins left and right. NEVER stretch or dilate the product horizontally to fill the wide canvas. NEVER upscale the product to be bigger than it would be in real life. The product is a real object in a real scene.`
}

export class PromptMaker {
  constructor(private openai: OpenAITextService) {}

  async make(
    pkg: ShootPackage,
    allAssets: AssetWithSpec[],
    availableZones: ZoneWithDescription[],
    stylingDirectives?: string
  ): Promise<ShootPrompt> {
    const spec = pkg.asset.productSpec
    const sceneEmbedded = isSceneEmbedded(spec)
    const isDetail = isDetailShoot(pkg.angle)

    // ── Order assets for this shoot ────────────────────────────────────────
    // For detail shots: prefer detail-view images first
    // For all other shots: sort by viewAnnotation priority (best full-front = 0)
    const sortedAssets = [...allAssets].sort((a, b) => {
      const pa = a.viewAnnotation?.priority ?? 99
      const pb = b.viewAnnotation?.priority ?? 99
      if (isDetail) {
        const aIsDetail = (a.viewAnnotation?.viewType ?? '').startsWith('detail_')
        const bIsDetail = (b.viewAnnotation?.viewType ?? '').startsWith('detail_')
        if (aIsDetail !== bIsDetail) return aIsDetail ? -1 : 1
      }
      return pa - pb
    })

    // ── Build annotated manifest ───────────────────────────────────────────
    // Each entry tells GPT-image-2 exactly what role this image plays and what to use it for
    const manifest: ImageManifestEntry[] = []
    let imgIdx = 0

    for (const asset of sortedAssets) {
      const va = asset.viewAnnotation
      const viewLabel = va ? VIEW_TYPE_LABEL[va.viewType] : 'product view'
      const isPrimary = imgIdx === 0

      let role: ImageManifestEntry['role'] = isPrimary ? 'primary_product' : `zone_${asset.id}`
      let label: string
      let description: string

      if (isPrimary) {
        label = `Image ${imgIdx} [${viewLabel}]: PRIMARY PRODUCT REFERENCE — GEOMETRY SOURCE`
        description = `Extract this product's exact shape, proportions, colors, materials, and all visible details. This image is the single source of truth for the product's geometry — every proportion in the generated image must match this exactly. Discard this image's background entirely.`
      } else {
        label = `Image ${imgIdx} [${viewLabel}]: SUPPLEMENTARY REFERENCE`
        description = va
          ? `Use ONLY for: ${va.contributes}. Do NOT use this image's background or environment. Do NOT override Image 0's geometry with this image's proportions.`
          : 'Additional product reference. Do not use background. Do not override Image 0 geometry.'
      }

      manifest.push({ index: imgIdx, role, label, description })
      imgIdx++

      // Add this asset's detail crops to the manifest immediately after the full view
      if (asset.crops && asset.crops.length > 0) {
        for (const crop of asset.crops) {
          manifest.push({
            index: imgIdx,
            role: `zone_${crop.name}`,
            label: `Image ${imgIdx} [detail crop — ${crop.name}]: DETAIL LOCK`,
            description: `${crop.description}. Replicate this exact detail at the corresponding zone on the product. This is a hard visual constraint — the pattern, texture, or construction shown here must appear faithfully in the generated image.`,
          })
          imgIdx++
        }
      }
    }

    const zoneLocksBlock = availableZones.length > 0
      ? `PRODUCT DETAIL LOCKS — preserve these exactly:\n${availableZones.map(z => `- ${z.name}: ${z.description}`).join('\n')}`
      : ''

    const canvasNote = 'Wide 16:9 canvas (1536×1024): fill canvas margins with the actual environment — NEVER stretch or dilate the product horizontally to fill the frame.'

    const directiveBlock = sceneEmbedded
      ? `APPROACH — SCENE-FIRST (this product lives INSIDE the environment, not placed on top of it):
The reference image is a COLOR, PATTERN, and TEXTURE REFERENCE ONLY. Do NOT extract or cut out the product.
Instead: design the entire new environment from scratch. Within that environment, the ${spec.productType} is naturally styled exactly as it would be in real life — on a bed, draped on furniture, laid on a surface, etc.
The product's exact colors (${spec.colorProfile.primary}${spec.colorProfile.secondary ? `, ${spec.colorProfile.secondary}` : ''}), exact pattern (${spec.colorProfile.pattern}: ${spec.keyDetails.slice(0, 3).join('; ')}), and exact materials must appear faithfully in the new scene.
DO NOT reproduce the source image's existing room or setting. Build an entirely new luxury environment.`
      : `APPROACH — EXTRACT AND PLACE:
Extract only the ${spec.productType} from Image 0 — use it solely for the product's physical form, colors, materials, and text. Discard the source image's existing background, props, and styling entirely. Place the product into the world described below.`

    const actionBlock = sceneEmbedded
      ? `PRODUCT STYLING IN THIS SCENE:\n${pkg.productAction}\nStyle the product exactly this way within the environment.`
      : `PRODUCT PLACEMENT IN THIS SCENE:
The product appears in the generated image EXACTLY as shown in Image 0 — same physical form, same orientation, same folding/state. Do NOT unfold it, refold it, lay it flat, stand it up, open it, or change its physical configuration in any way.
Placement: ${pkg.productAction}`

    const categoryDirective = getCategoryDirective(spec.category, spec.productType)
    const sizeLockBlock = getSizeLockBlock(spec)

    const userText = `Generate a gpt-image-2 production prompt for this shoot. Follow your creative direction system.

USER'S INTENT — THE WORLD THEY ASKED FOR:
${stylingDirectives ? `"${stylingDirectives}" — interpret at the most unexpected, visually bold level. Make it the centerpiece.` : 'No specific styling directive.'}
Mood: ${pkg.mood}

THIS SHOOT:
Theme: "${pkg.theme}"
Environment: ${pkg.background}
Concept: ${pkg.concept}
Lighting: ${pkg.lighting}
Camera angle: ${pkg.angle} | Shot type: ${pkg.modelType}

${directiveBlock}

${actionBlock}

THIS IS NOT A STUDIO SHOT. Every prop, surface, texture, and light source belongs to the specific physical environment described above.

PRODUCT DNA — what must be preserved exactly:
- Type: ${spec.productType} | Category: ${spec.category}
- Form: ${spec.formGeometry}
- Materials: ${spec.materials.join(', ')}
- Finish: ${spec.finish}
- Color: ${spec.colorProfile.primary}${spec.colorProfile.secondary ? ` / ${spec.colorProfile.secondary}` : ''} | pattern: ${spec.colorProfile.pattern}
- Key details: ${spec.keyDetails.join(', ')}
- Premium: ${spec.premiumDetails?.join(', ') || 'none'}
${spec.brandMarkings ? `- Brand markings: ${spec.brandMarkings}` : ''}
${zoneLocksBlock ? `\n${zoneLocksBlock}` : ''}

${sizeLockBlock}

${categoryDirective ? `${categoryDirective}\n` : ''}
REFERENCE IMAGES IN THIS CALL — read each role carefully before generating:
${manifest.map(e => `- ${e.label}: ${e.description}`).join('\n')}

${canvasNote}

Write the prompt now. Lead with the size lock and category constraints, then build the world, then integrate the product. Raw text only.`

    const prompt = await this.openai.chat(systemSkill, userText, false)
    if (!prompt) throw new Error(`PromptMaker: no response for shoot ${pkg.shootIndex}`)

    console.log(`[ALLORE_DEBUG][prompt_shoot_${pkg.shootIndex}]`, JSON.stringify({
      theme: pkg.theme,
      angle: pkg.angle,
      zones: availableZones.map(z => z.name),
      manifest,
      prompt,
    }, null, 2))

    return {
      shootIndex: pkg.shootIndex,
      prompt: prompt.trim(),
      concept: pkg.theme,
      selectedZones: availableZones.map(z => z.name),
      imageManifest: manifest,
      orderedAssetIds: sortedAssets.map(a => a.id),
    }
  }
}
