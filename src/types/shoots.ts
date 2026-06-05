export type IntentPlan = {
  overallStyle: 'editorial' | 'lifestyle' | 'detail' | 'mixed'
  mood: string
  background: string
  countHint: number
  colorDirection: string
  rawIntent: string
  assetIds: string[]
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

export type AssetWithSpec = {
  id: string
  r2Key: string
  mimeType: string
  base64: string
  productSpec: ProductSpec
}

export type ShootPackage = {
  shootIndex: number
  theme: string
  concept: string
  angle: 'front' | 'back' | '3/4' | 'side' | 'detail_top' | 'detail_bottom' | 'detail_feature' | 'overhead' | 'close_up'
  background: string
  lighting: string
  modelType: 'on_model' | 'flat_lay' | 'product_only' | 'lifestyle' | 'mannequin'
  mood: string
  asset: AssetWithSpec
}

export type ShootPrompt = {
  shootIndex: number
  prompt: string
  concept: string
}

export type GeneratedShot = {
  shootIndex: number
  r2Key: string
  assetId: string
  concept: string
  theme: string
  url: string
}

export type ShootEngineInput = {
  intent: string
  assetIds: string[]
  projectId: string
  userId: string
}
