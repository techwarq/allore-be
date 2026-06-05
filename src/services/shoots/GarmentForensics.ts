import { TextService } from '../gemini/TextService'
import { ProductSpec } from '../../types/shoots'

export class GarmentForensics {
  constructor(private textService: TextService) {}

  async analyze(base64Image: string, mimeType: string): Promise<ProductSpec> {
    const response = await this.textService.generate({
      model: 'gemini-3-flash-preview',
      systemInstruction: `You are a product forensics specialist for commercial photography.
You analyze any product — apparel, electronics, beauty, tableware, footwear, furniture, food, anything —
with extreme technical precision, as if writing a production spec sheet for a photo studio.
Never use vague language. Be exact with materials, dimensions, and construction details.`,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Image } },
          {
            text: `Analyze this product image with technical precision for commercial AI photography.

First identify what the product is and its category. Then extract all visual and physical details that matter for reproducing it accurately in an image.

Return a JSON object with this exact structure (raw JSON, no markdown):
{
  "productType": "specific product name, e.g. 'ceramic pour-over coffee mug', 'wireless over-ear headphones', 'midi A-line dress', 'leather Chelsea boot'",
  "category": "one of: apparel, footwear, beauty, skincare, electronics, tableware, furniture, food, jewellery, accessories, bags, homeware, other",

  "materials": ["array of materials/fabrics/finishes, e.g. '100% cotton voile' or 'matte ceramic body' or 'polycarbonate shell'"],
  "finish": "surface finish descriptor, e.g. 'matte', 'glossy', 'brushed metal', 'textured knit', 'smooth leather'",

  "colorProfile": {
    "primary": "exact primary color name",
    "secondary": "secondary color if clearly present, omit if solid",
    "pattern": "one of: solid, gradient, striped, printed, textured, multicolor, clear"
  },

  "dimensions": "approximate size/proportions, e.g. '~12cm height x 9cm diameter' or '~44 inches from shoulder to hem' or 'full-size over-ear cups'",

  "spatialAnchor": "CRITICAL — the key spatial reference that defines the product's orientation and prevents proportion distortion. Examples: apparel → 'hem terminates exactly 3 inches above the ankle bone'; mug → 'sits upright on flat base, handle projects to the right, open rim at top'; headphones → 'ear cups hang at bottom, headband arches above, cushions face forward'; shoe → 'heel elevated, toe box pointing left, sole flat on surface'",

  "keyDetails": ["ALL visible product details verbatim — every seam, logo, button, port, label, texture, stitching, hardware, etc."],
  "premiumDetails": ["standout quality or craft details, e.g. 'hand-stitched welt', 'gold-plated rim', 'custom woven label', 'engraved serial number'"],

  "contrastBoundary": "what to place around or beneath the product to clearly define its edges in a photo. e.g. 'place on dark wood surface to define light ceramic base' or 'shoot over bare skin to define hem line' or 'dark background to define white product silhouette'",

  "brandMarkings": "any visible brand names, logos, or text on the product — exact position and appearance. Omit if none.",
  "functionalElements": "key functional parts that must be visible/accurate, e.g. 'USB-C port on bottom edge', 'flip-top lid with hinge', 'lace-up closure with 7 eyelets'. Omit if not applicable."
}

Rules:
- spatialAnchor is the most critical field — be precise about how the product sits in space
- keyDetails must be an array, list every visible detail however small
- premiumDetails must be an array, empty array [] if none
- Return raw JSON only, no markdown code blocks`
          }
        ]
      }],
      config: { responseMimeType: 'application/json' }
    })

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('ProductForensics: no response from model')

    return JSON.parse(text) as ProductSpec
  }
}
