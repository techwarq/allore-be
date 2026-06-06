import { TextService } from '../gemini/TextService'
import { ProductSpec } from '../../types/shoots'

export class GarmentForensics {
  constructor(private textService: TextService) {}

  async analyze(base64Image: string, mimeType: string): Promise<ProductSpec> {
    const response = await this.textService.generate({
      model: 'gemini-3-flash-preview',
      systemInstruction: `You are a Senior Computer Vision Product Design Analyst and Industrial Fabric Forensic Expert.

Analyze any raw product asset with absolute technical precision. Strip away the background clutter. Your job is to extract the literal structural architecture, geometric primitives, and micro-texture markers of the product. This data will be used to freeze the product's identity so it never distorts, warps, or stretches under any canvas manipulation.`,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Image } },
          {
            text: `Analyze this D2C product image using the Hyper-Realistic Product DNA schema.

Return a JSON object with this exact structure (raw JSON, no markdown):
{
  "productType": "uncompromisingly specific name, e.g., '8 oz matte aluminum beverage can', 'heavyweight 450gsm loopback cotton hoodie'",
  "category": "one of: apparel, footwear, beauty, skincare, electronics, tableware, furniture, food, jewellery, accessories, bags, homeware, other",

  "formGeometry": "CRITICAL: Define the mathematical shapes, primitives, and curves to lock down perspective. E.g., 'Perfect cylinder with unbending right-angle top lip and flat tapered base block. Must lock horizontal-to-vertical ratio to prevent oval distortion under 16:9 framing.'",

  "materials": ["exact structural materials, e.g., 'brushed raw silver aluminum', '100% organic open-end slub cotton texturized knit'"],
  "finish": "precise micro-surface texture descriptor, e.g., 'powder-coated matte with fine tactile grain', 'high-gloss reflective glazing'",

  "colorProfile": {
    "primary": "exact tone and light interaction, e.g., 'matte desaturated sky-blue', 'flat high-absorption obsidian black'",
    "secondary": "secondary color accents if present, otherwise omit",
    "pattern": "one of: solid, gradient, striped, printed, textured, multicolor, clear"
  },

  "dimensions": "structural height-to-width spatial ratio to act as a strict aspect guard against wide-canvas stretching.",

  "spatialAnchor": "NON-NEGOTIABLE CORE ANCHOR: The absolute physical grounding property. E.g., 'Sits perfectly flat on a level plane; vertical center axis must remain perfectly 90-degrees straight, cap/lip defines the top horizontal boundary.'",

  "keyDetails": ["array of every single micro-element: sharp sans-serif black print typography, specific text strings, tiny warning symbols, ridges, stitches, pull-tabs, seams, etc."],
  "premiumDetails": ["quality indicators that give the asset high-end reality: brushed metal grain, embossed textures, raw fiber fraying, contrast lock-stitching. Empty array [] if none."],

  "contrastBoundary": "optical separation rule, e.g., 'must be placed on a raw texturized dark stone or organic surface to crisply isolate and bounce light off the light-colored base silhouettes.'",

  "brandMarkings": "exact case-sensitive brand text strings, locations, font weight behavior on the package. Omit if none.",
  "functionalElements": "mechanical or usable parts: pull-tab on top center, pump nozzle, zipper tracks. Omit if none."
}

Rules:
- You must be fiercely objective. Ban words like 'sleek', 'beautiful', 'premium', 'clean'. Replace them with industrial descriptors like 'matte powder-coated', 'tactile', 'unvarnished', 'brushed'.
- formGeometry and spatialAnchor are the most critical fields — be precise
- keyDetails must list every visible detail however small
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
