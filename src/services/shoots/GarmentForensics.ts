import { OpenAITextService } from '../openai/OpenAITextService'
import { ProductSpec } from '../../types/shoots'

export class GarmentForensics {
  constructor(private openai: OpenAITextService) {}

  async analyze(base64Image: string, mimeType: string, productHint?: string): Promise<ProductSpec> {
    const hintBlock = productHint
      ? `\n\nCRITICAL PRODUCT CLASSIFICATION: The seller has identified this product as "${productHint}". You MUST accept this classification — do not reclassify it into a different product type. Your "productType" field must be a technically precise description of a ${productHint}. Focus only on accurately describing its physical attributes.`
      : ''

    const system = `You are a Senior Computer Vision Analyst, Metrology Engineer, and Industrial Fabric Forensic Expert.

Your sole function is to deconstruct any raw product asset photograph with cold, mathematical precision. Completely ignore all background noise, warehouse storage conditions, studio clutter, unwanted hand shadows, mobile screen reflections, styling props, garnishes, ingredients, surfaces, and any decorative objects placed around the product.

CRITICAL — PRIMARY PRODUCT ONLY: Identify the single PRIMARY MANUFACTURED AND BRANDED PRODUCT in the image — the object that was physically produced, labeled, and sold. Everything else is a prop. If you see a beverage can styled with ice cubes, chili garnishes, or liquid, describe ONLY the can. If you see an apparel item on a surface with flowers or books, describe ONLY the apparel item. If you see a skincare bottle on a marble surface with greenery, describe ONLY the bottle. Props and styling around the product are completely irrelevant — omit them entirely from every field.

Focus exclusively on extracting the core commercial product asset's literal geometry, material reflections, and proportional boundaries.

Your output feeds directly into an advanced AI image editing pipeline as non-negotiable structural constraints. Accuracy here determines whether the final rendering preserves the true brand identity or distorts. Be absolutely literal, industrial, and technical. Completely ban all vague marketing or artistic language like "sleek," "elegant," or "beautiful" — replace with cold industrial descriptors.${hintBlock}`

    const userText = `Analyze this D2C product image using the Universal Product Identity & Geometric Fidelity schema.

Return a JSON object with this exact structure (raw JSON only, no markdown blocks, no formatting backticks):
{
  "productType": "uncompromisingly specific name, e.g., '8 oz cylindrical matte aluminum beverage can', '450gsm heavyweight loopback cotton boxy hoodie', 'quilted cotton canvas bedsheet set'",
  "category": "one of: apparel, footwear, beauty, skincare, electronics, tableware, furniture, food, jewellery, accessories, bags, homeware, other",

  "formGeometry": "CRITICAL GEOMETRY LOCK: Define the exact mathematical primitives, shapes, grid patterns, and structural bounds. E.g., 'Perfect flat rectangular canvas plane with orthogonal 90-degree parallel matrix coordinates. Must lock horizontal-to-vertical pattern diameter ratio to prevent any geometric warping or oval motif skewing under wide aspect ratio transformations.'",

  "materials": ["array of exact raw materials and light-absorption profiles — e.g., '100% organic long-staple open-end slub cotton texturized knit', 'matte powder-coated low-sheen vinyl wrap'"],
  "finish": "precise micro-surface texture descriptor and tactile quality — e.g., 'matte anti-glare woven powder finish', 'high-gloss reflective specular glazing', 'raised embroidery thread relief lines'",

  "colorProfile": {
    "primary": "exact color tone and light-absorption behavior — e.g., 'flat high-absorption matte ivory cream', 'specular high-gloss obsidian black'",
    "secondary": "secondary color accents or pattern graphics if clearly present, otherwise omit field",
    "pattern": "one of: solid, gradient, striped, printed, textured, multicolor, clear"
  },

  "dimensions": "strict height-to-width spatial aspect ratio to act as a hard mathematical guard against wide-canvas or cinematic stretching, e.g., 'strict 1.6:1 horizontal width-to-height ratio for the pillow face panel layout'.",

  "spatialAnchor": "CRITICAL BOUNDARY ANCHOR — The non-negotiable physical grounding rule that prevents perspective distortion. E.g., 'Sits perfectly flat on a horizontal level plane; vertical grid axes must remain perfectly parallel with zero taper; seams define the absolute spatial boundary lines.'",

  "keyDetails": ["ALL visible structural details of the PRIMARY PRODUCT ONLY — exact text strings, specific typography fonts, print layouts, seams, folds, ridges, buttons, pull-tabs, warning icons, micro-stitching patterns. DO NOT include props, garnishes, or styling elements."],
  "premiumDetails": ["standout craft quality markers that ground the item in high-end reality — e.g., 'raised directional embroidery yarn grain along border lines', 'contrast double lock-stitching along panel joints'. Empty array [] if none."],

  "contrastBoundary": "optical boundary rule for edge detection — e.g., 'must be placed on dark texturized volcanic stone or weathered dark wood to cleanly isolate and define the light-colored base silhouettes.'",

  "brandMarkings": "exact case-sensitive brand text strings, placement coordinates, and font weight interaction on the package layout. Omit if none.",
  "functionalElements": "mechanical or interactive parts that must remain mathematically sound: pull-tab on top center, spray nozzle head, zipper tracks, lace eyelets. Omit if not applicable."
}

Rules for Analysis:
1. FORM GEOMETRY and SPATIAL ANCHOR are your highest-priority fields. If you fail to accurately define the geometric boundaries here, the downstream image generation will warp the asset.
2. Replace all subjective adjectives with cold industrial descriptors. Never write 'clean lines', write 'straight parallel edges with zero taper'.
3. keyDetails must list every visible detail however small.
4. Output raw JSON only. Do not wrap in markdown code blocks.`

    const text = await this.openai.chatWithImage(system, userText, base64Image, mimeType, true)
    if (!text) throw new Error('GarmentForensics: no response from model')

    console.log('[ALLORE_DEBUG][forensics]', text)
    return JSON.parse(text) as ProductSpec
  }
}
