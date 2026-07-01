import { OpenAITextService } from '../openai/OpenAITextService'
import { ProductSpec, ViewAnnotation, ViewType } from '../../types/shoots'

export type RawAssetInput = {
  id: string
  base64: string
  mimeType: string
}

export type FusionResult = {
  isSameProduct: boolean
  canonicalSpec: ProductSpec
  viewAnnotations: ViewAnnotation[]
}

export class MultiViewSynthesizer {
  constructor(private openai: OpenAITextService) {}

  async analyze(assets: RawAssetInput[], productHint?: string): Promise<FusionResult> {
    const hintBlock = productHint
      ? `\n\nCRITICAL PRODUCT CLASSIFICATION: The seller has identified this product as "${productHint}". You MUST accept this classification — do not reclassify it. Your "canonicalSpec.productType" must be a technically precise description of a ${productHint}. Focus only on its physical attributes.`
      : ''

    const system = `You are a multi-view product analysis specialist and industrial computer vision expert.
You receive multiple product images from different angles and viewpoints of what may be the same product or different products.
Your job: synthesize a single, complete, authoritative product identity by combining what ALL views show together.
Each view reveals something the others don't — one shows the front silhouette, one shows the back construction, one shows embroidery or label detail.
Your canonical spec is RICHER than any single-view analysis alone.
Output feeds directly into an AI image generation pipeline — be technically precise and industrial, zero artistic language.${hintBlock}`

    const userText = `Analyze these ${assets.length} product images.

TASKS:
1. Classify the VIEW TYPE of each image (Image 0 through Image ${assets.length - 1})
2. Determine: are ALL images views of the SAME single product? (true/false)
3. Synthesize ONE canonical ProductSpec capturing the COMPLETE product identity from all views combined.

VIEW TYPE OPTIONS (pick the closest):
full_front | full_back | three_quarter | side | detail_top | detail_bottom | detail_center | detail_texture | flat_lay | lifestyle | packaging | unknown

For viewAnnotations:
- "contributes": what UNIQUE structural or detail information this specific view provides that others don't
- "priority": 0 = the single best full-product reference (will be Image 0 in generation), 1 = second-best full view, 2+ = supplementary or detail-only

CANONICAL SPEC SYNTHESIS RULES:
- productType: maximally specific technical name — "450gsm heavyweight loopback cotton boxy hoodie", "8oz matte-finish cylindrical aluminum beverage can". Never generic like "t-shirt" or "bottle".
- formGeometry: from the BEST full-front view — exact mathematical shape constraints, parallel lines, aspect ratios, structural proportions. This prevents distortion in generation.
- dimensions: derive from whichever view gives the clearest proportional read
- spatialAnchor: CRITICAL for size preservation — define the non-negotiable physical grounding rule, e.g. "rests on flat horizontal surface, vertical seams perfectly parallel with zero taper, hem terminates 3 inches above ankle". This prevents the generation model from scaling or warping the product.
- keyDetails: COMBINE details from ALL views — embroidery from the detail view, stitching from the back view, label text VERBATIM from front, construction details from every view
- premiumDetails: combine all high-craft observations across all views
- materials: combine material observations from all views (different angles reveal different surface properties)
- contrastBoundary: what surface/environment best defines the product's edges for clean isolation

ASSET ID MAP (use these EXACT IDs in viewAnnotations):
${assets.map((a, i) => `Image ${i} → assetId: "${a.id}"`).join('\n')}

Return raw JSON only — no markdown blocks, no backticks:
{
  "isSameProduct": true,
  "canonicalSpec": {
    "productType": "...",
    "category": "apparel|footwear|beauty|skincare|electronics|tableware|furniture|food|jewellery|accessories|bags|homeware|other",
    "formGeometry": "...",
    "materials": ["..."],
    "finish": "...",
    "colorProfile": { "primary": "...", "secondary": "...", "pattern": "solid|gradient|striped|printed|textured|multicolor|clear" },
    "dimensions": "...",
    "spatialAnchor": "...",
    "keyDetails": ["..."],
    "premiumDetails": ["..."],
    "contrastBoundary": "...",
    "brandMarkings": "...",
    "functionalElements": "..."
  },
  "viewAnnotations": [
    { "assetId": "...", "viewType": "full_front", "contributes": "primary silhouette, front panel design, primary color and material surface", "priority": 0 },
    { "assetId": "...", "viewType": "full_back", "contributes": "back construction, closure type, back panel details", "priority": 1 },
    { "assetId": "...", "viewType": "detail_bottom", "contributes": "exact hem embroidery pattern, stitch construction, border trim", "priority": 2 }
  ]
}`

    const text = await this.openai.chatWithMultipleImages(
      system,
      userText,
      assets.map(a => ({ base64: a.base64, mimeType: a.mimeType })),
      true
    )
    if (!text) throw new Error('MultiViewSynthesizer: no response from model')

    console.log('[ALLORE_DEBUG][multi_view_synthesis]', text)
    const parsed = JSON.parse(text)

    const annotations: ViewAnnotation[] = (
      parsed.viewAnnotations ?? assets.map((a, i) => ({
        assetId: a.id,
        viewType: 'full_front' as ViewType,
        contributes: 'Product reference',
        priority: i,
      }))
    ).sort((a: ViewAnnotation, b: ViewAnnotation) => a.priority - b.priority)

    return {
      isSameProduct: parsed.isSameProduct ?? true,
      canonicalSpec: parsed.canonicalSpec,
      viewAnnotations: annotations,
    }
  }
}
