export type IntentPlan = {
  overallStyle: 'editorial' | 'lifestyle' | 'detail' | 'mixed' | 'infographic' | 'ui_mockup'
  mood: string
  background: string
  stylingDirectives: string
  countHint: number
  colorDirection: string
  rawIntent: string
  assetIds: string[]
  // Present when intent is a numbered placement list — each item locks one shoot's scene placement
  sceneDirectives?: string[]
}

export type ProductSpec = {
  // What it is
  productType: string        // "ceramic mug", "wireless headphones", "midi dress", "running shoes"
  category: string           // "tableware", "electronics", "apparel", "footwear", "beauty", "furniture", etc.

  // Materials & finish
  materials: string[]        // ["matte ceramic", "bamboo handle"] or ["100% cotton voile"]
  finish: string             // "matte", "glossy", "brushed metal", "textured fabric"

  // Color
  colorProfile: {
    primary: string
    secondary?: string
    pattern: string          // "solid", "gradient", "printed", "striped", "textured"
  }

  // Shape & geometry
  formGeometry: string       // literal physical shape, lines, contours, silhouette — e.g. "cylindrical with hard right-angle shoulders"

  // Dimensions & spatial grounding
  dimensions: string         // "approx 12cm height x 9cm diameter" or "midi length ~44in from shoulder"
  spatialAnchor: string      // key spatial reference to prevent proportion hallucination
                             // apparel: "hem terminates 3 inches above ankle"
                             // product: "mug rests on flat base, handle projects right, rim at top"

  // Visible details
  keyDetails: string[]       // ALL visible product details verbatim
  premiumDetails: string[]   // standout craft or premium details

  // Scene grounding
  contrastBoundary: string   // what to show around/beneath product to define its edges

  // Optional category-specific
  brandMarkings?: string     // "Nike swoosh embossed on heel", "Apple logo on lid"
  functionalElements?: string // "flip-top lid", "adjustable strap", "touch sensor strip"
}

export type ViewType =
  | 'full_front'
  | 'full_back'
  | 'three_quarter'
  | 'side'
  | 'detail_top'
  | 'detail_bottom'
  | 'detail_center'
  | 'detail_texture'
  | 'flat_lay'
  | 'lifestyle'
  | 'packaging'
  | 'unknown'

export type ViewAnnotation = {
  assetId: string
  viewType: ViewType
  contributes: string  // what unique info this view adds — e.g. "back construction and zip closure"
  priority: number     // 0 = best full reference; lower = sent as earlier image to GPT-image-2
}

export type AssetCrop = {
  name: string
  description: string
  data: string        // base64
  mimeType: string
}

export type AssetWithSpec = {
  id: string
  r2Key: string
  mimeType: string
  base64: string
  productSpec: ProductSpec
  viewAnnotation?: ViewAnnotation
  crops?: AssetCrop[]
}

export type ShootPackage = {
  shootIndex: number
  theme: string
  concept: string
  angle: 'front' | 'back' | '3/4' | 'side' | 'detail_top' | 'detail_bottom' | 'detail_feature' | 'overhead' | 'close_up'
  productAction: string  // dynamic product state — "being poured at 45°", "lying on its side", "mid-air drop", "submerged in ice", "hand gripping mid-body", etc.
  background: string
  lighting: string
  modelType: 'on_model' | 'flat_lay' | 'product_only' | 'lifestyle' | 'mannequin' | 'ui_mockup' | 'infographic'
  mood: string
  asset: AssetWithSpec
}

export type ImageManifestEntry = {
  index: number
  role: 'primary_product' | 'model_reference' | `zone_${string}`
  label: string       // e.g. "Image 0: Primary Product Asset"
  description: string // what this image shows
}

export type ShootPrompt = {
  shootIndex: number
  prompt: string
  concept: string
  selectedZones: string[]
  imageManifest: ImageManifestEntry[]
  orderedAssetIds: string[]  // full-image assets in the order they'll appear in the FormData (Image 0, 1, ...)
}

export type GeneratedShot = {
  shootIndex: number
  r2Key: string
  assetId: string
  concept: string
  theme: string
  url: string
  generatedBase64?: string  // available temporarily for quality review, not persisted
}

export type ProductGroup = {
  groupId: string
  productLabel: string   // "white cotton bath towels", "navy hand towels", "decorative cushions"
  assetIds: string[]     // which uploaded images belong to this product
  intentPlan: IntentPlan // per-group decoded intent with the right shoots for this product
}

export type AssetTag = {
  productLabel: string  // what the product is, e.g. "navy cotton t-shirt"
  viewType: ViewType    // angle/view the image shows
}

export type ShootEngineInput = {
  intent: string
  assetIds: string[]
  projectId: string
  userId: string
  modelR2Keys?: string[]  // avatar R2 keys to use as model references in on_model shots
  assetTags?: Record<string, AssetTag>  // assetId → tag (product + angle), replaces AI classification
  dryRun?: boolean  // if true, stop after prompt generation — no image calls
}

// Direct query + reference images → shots, no forensics/routing/multi-stage analysis.
export type SimpleShootInput = {
  query: string
  assetIds: string[]
  projectId: string
  userId: string
  count?: number  // number of shots to generate, default 1
  modelR2Keys?: string[]  // approved avatar R2 keys — model reference images, not product assets
  vibeImageUrl?: string  // Pinterest reference the user picked in the vibe-picker gate — analyzed
                          // for a full visual description (world/mood/lighting/color), not used as
                          // a literal Seedream composition reference
}
