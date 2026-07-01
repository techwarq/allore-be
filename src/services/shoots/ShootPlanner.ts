import { OpenAITextService } from '../openai/OpenAITextService'
import { IntentPlan, AssetWithSpec, ShootPackage } from '../../types/shoots'

export class ShootPlanner {
  constructor(private openai: OpenAITextService) {}

  async plan(intentPlan: IntentPlan, assets: AssetWithSpec[], hasModels = false): Promise<ShootPackage[]> {
    const assetSummaries = assets.map((a, i) => ({
      index: i,
      id: a.id,
      // If the asset has a per-asset tag label (from viewAnnotation.contributes), surface it
      // so directive-matching can identify which asset is "bath towel" vs "hand towel" etc.
      label: a.viewAnnotation?.contributes ?? a.productSpec.productType,
      productType: a.productSpec.productType,
      category: a.productSpec.category,
      colorProfile: a.productSpec.colorProfile,
      dimensions: a.productSpec.dimensions,
      spatialAnchor: a.productSpec.spatialAnchor,
      referenceViewType: a.viewAnnotation?.viewType ?? 'unknown',
    }))

    const modelNote = hasModels
      ? 'AI model reference images ARE available. Favour "on_model" or "lifestyle" for most shots. Include at least one "product_only" or "flat_lay" for detail variety.'
      : 'No model images available. Use "product_only", "flat_lay", or "lifestyle" (without people) only. Do NOT use "on_model" or "mannequin".'

    const system = `You are a world-class creative director who plans luxury product campaigns for brands like Aesop, Jacquemus, Zara Home, Apple, and Loewe.

Your two inputs are: (1) the USER'S INTENT — their brief, their world, their mood, their styling directives, and (2) the PRODUCT DNA — what the product is, its materials, its energy. The story you craft lives at the intersection of both. The user's intent sets the world. The product becomes the hero that lives in it.

You do NOT think "how do I photograph this product?" You think "the user wants X world — how does this product become the most compelling object in that world?"

## THE SINGLE MOST IMPORTANT RULE

Every shoot in the lookbook MUST exist in a COMPLETELY DIFFERENT WORLD. Not a different angle of the same studio. Not a different crop of the same tabletop. A different WORLD — different physical location, different time of day, different emotional register, different color temperature, different cultural context.

If shoot 1 is a dark studio tabletop → shoot 2 CANNOT be a studio tabletop at all. It must be somewhere else entirely: a sun-bleached Mediterranean terrace, a Tokyo izakaya counter, a Mexican market at golden hour, a rain-wet London street corner, an all-white Santorini rooftop, a dense Amazonian greenhouse.

Three shoots of the same studio environment with different camera angles is FAILURE. Reject that instinct completely.

## HOW TO INTERPRET STYLING DIRECTIVES

When the user says "oversized ingredients" — this is a JACQUEMUS SCALE DIRECTIVE. It means surreal, exaggerated scale — a chili the size of a table, a lime wedge bigger than the product itself, ice blocks like architecture. NOT "standard garnish proportions." Think: the product is tiny against a massive ingredient world, OR the ingredients are giant art objects the product sits inside.

When the user gives any creative directive, interpret it at its most interesting and unexpected level. Safe is wrong.

## WORLD VARIETY RULES

- Each shoot must have a clearly different physical LOCATION (not just different surfaces)
- Each shoot must have a clearly different COLOR TEMPERATURE (warm golden / cool blue / neutral daylight — not all the same)
- Each shoot must have a clearly different EMOTIONAL REGISTER (playful / dramatic / intimate / epic / surreal)
- For 3 shoots: think of them as 3 different cities. For 5 shoots: think 5 different countries.

Every shoot has ONE strong big idea. You use contrast — soft products against raw environments, delicate objects in massive landscapes. You design with light like a cinematographer.

## THE PRODUCT'S PHYSICAL STATE IS FIXED BY THE REFERENCE IMAGE

CRITICAL RULE: The reference image shows the product in a specific physical state — hanging, folded, stacked, flat, upright. That state is LOCKED. You cannot change it.

- If the reference shows a towel HANGING → it hangs in the scene. You cannot lay it flat.
- If the reference shows a product FLAT (flat_lay viewType) → it stays flat. You can choose the surface around it.
- If the reference shows a product FOLDED → it stays folded. You choose what it rests on.
- If the reference shows a BASKET of towels → the basket is the product. Place the basket, not individual towels.

The "productAction" field must ONLY describe WHERE and HOW the product is placed in the scene — NOT any physical transformation of the product itself. Never write actions that unfold, open, lay flat, stand upright, or physically change the product's form from the reference.

"modelType: flat_lay" is ONLY allowed when the asset's referenceViewType is "flat_lay". If the reference shows a hanging or upright product, do NOT plan a flat_lay shoot.

CRITICAL: For wide 16:9 format, never use flat front angles on vertical products — force 3/4, telephoto compression, or layered foreground. MODEL AVAILABILITY: ${modelNote}`

    const hasSceneDirectives = Array.isArray(intentPlan.sceneDirectives) && intentPlan.sceneDirectives.length > 0

    const userText = hasSceneDirectives
      ? this.buildDirectivePrompt(intentPlan, assetSummaries, assets.length)
      : this.buildFreeformPrompt(intentPlan, assetSummaries, assets.length, modelNote)

    const text = await this.openai.chat(system, userText, true)
    if (!text) throw new Error('ShootPlanner: no response from model')

    console.log('[ALLORE_DEBUG][planner]', text)
    const parsed = JSON.parse(text)
    const packages: any[] = Array.isArray(parsed) ? parsed : (parsed.packages ?? parsed.shoots ?? [])

    return packages.map(pkg => ({
      shootIndex: pkg.shootIndex,
      theme: pkg.theme,
      concept: pkg.concept,
      angle: pkg.angle,
      productAction: pkg.productAction ?? 'standing upright',
      background: pkg.background,
      lighting: pkg.lighting,
      modelType: pkg.modelType,
      mood: pkg.mood,
      asset: assets[pkg.assetIndex] ?? assets[0],
    }))
  }

  private buildFreeformPrompt(intentPlan: IntentPlan, assetSummaries: any[], assetCount: number, modelNote: string): string {
    return `Plan an elite commercial product lookbook based on this decoded campaign intent and the available product design DNA.

USER'S INTENT (this is the world they asked for — take it seriously):
"${intentPlan.rawIntent}"

DECODED:
- Style: ${intentPlan.overallStyle}
- Mood: ${intentPlan.mood}
- Background Environment: ${intentPlan.background}
- Color direction: ${intentPlan.colorDirection}
${intentPlan.stylingDirectives ? `- MANDATORY STYLING DIRECTIVE — must appear in EVERY shoot, interpreted at surreal/Jacquemus scale: "${intentPlan.stylingDirectives}"` : ''}
- Number of shoots: ${intentPlan.countHint}

AVAILABLE PRODUCTS:
${JSON.stringify(assetSummaries, null, 2)}

Create exactly ${intentPlan.countHint} shoot packages. Each shoot must be set in a COMPLETELY DIFFERENT WORLD — different location, different color temperature, different emotional energy. Reject any instinct to do multiple studio tabletop shots. Push into unexpected, cinematic, editorial territory.

Return a JSON object with a "packages" key containing exactly ${intentPlan.countHint} objects (raw JSON only, no markdown blocks, no backticks):
{ "packages": [
  {
    "shootIndex": 0,
    "theme": "a bold, evocative name that captures the world — not a generic product name",
    "concept": "2-3 sentences: what world is this, what story does the product tell inside it, what is the product DOING physically in this world, what makes this visually unforgettable.",
    "angle": one of "front" | "back" | "3/4" | "side" | "detail_top" | "detail_bottom" | "detail_feature" | "overhead" | "close_up",
    "productAction": "WHERE the product is placed in this scene and HOW it sits there — must match the reference image's physical state exactly. Do NOT describe any physical transformation (unfolding, opening, laying flat, standing upright, etc). Only describe placement: which surface it rests on, how it is angled toward the camera, what it leans against, how it is positioned within the environment.",
    "background": "a SPECIFIC PLACE with micro-material descriptors — not 'dark studio', but 'sun-bleached limestone terrace overlooking the Aegean, cracked grout lines, terracotta pots casting long shadows'",
    "lighting": "highly cinematic lighting physics — time of day, direction, quality, Kelvin. Not 'studio key light', but 'late afternoon 3200K raking sun from frame left casting long warm shadows'",
    "modelType": one of "on_model" | "flat_lay" | "product_only" | "lifestyle" | "mannequin" | "ui_mockup" | "infographic",
    "mood": "3-5 evocative words — the emotional feeling, not a description",
    "assetIndex": <0-based index from AVAILABLE PRODUCTS above>
  }
] }

Rules:
- PRODUCT PLACEMENT MUST MAKE PHYSICAL SENSE. Use the product's category and type to decide where it lives:
  - Bedsheets / duvets / quilts / pillow covers → ON A BED in a bedroom. Always. Never on a bench, console, or corridor. A bedsheet belongs on a bed.
  - Rugs → on a floor, in a room setting
  - Curtains / drapes → on a window
  - Towels → bathroom, spa, near water
  - Apparel → on a person or mannequin
  - Tableware / crockery → on a table, in a dining setting
  - Skincare / beauty → on a vanity, bathroom shelf, tray
  - Food / beverage → consumption context — bar, kitchen, outdoor dining
  Never place a product somewhere absurd to seem creative. Creativity lives in the WORLD AROUND the product, not in misplacing it.
- productAction must only describe placement within the scene — never a physical transformation of the product.
- Vary the scene and placement across shoots, not the product's physical state.
- Each shoot's "background" must be a completely different physical environment and room type.
- Choose modelType: apparel → on_model or mannequin; homeware/bedding → lifestyle; flat tableware/linen → flat_lay or overhead.
- detail_* and close_up angles → product_only or flat_lay only.
- assetIndex must be 0 to ${assetCount - 1}.
- Output raw JSON only.`
  }

  private buildDirectivePrompt(intentPlan: IntentPlan, assetSummaries: any[], assetCount: number): string {
    const directives = intentPlan.sceneDirectives!
    const directiveList = directives.map((d, i) => `  ${i + 1}. "${d}"`).join('\n')

    return `The user has given you a LOCKED SCENE LIST — each item is an exact placement directive for one image. Your job is to turn each directive into a stunning, high-end commercial shoot package while NEVER contradicting the placement described.

LOCKED SCENE DIRECTIVES (one package per directive, in this exact order):
${directiveList}

AVAILABLE PRODUCTS (each has a "label" identifying exactly what it is — use this to match directives to assets):
${JSON.stringify(assetSummaries, null, 2)}

OVERALL CAMPAIGN CONTEXT:
- Style: ${intentPlan.overallStyle}
- Mood: ${intentPlan.mood}
- Color direction: ${intentPlan.colorDirection}

For each directive, produce one shoot package. The "productAction" and "background" MUST honor the directive literally (e.g. "towels on bathroom rack" → the towels are on a rack in a bathroom scene). You choose the cinematic world, lighting, angle, and mood that makes the directive look extraordinary — but you cannot move the product to a different location than the directive specifies.

Return a JSON object with a "packages" key containing exactly ${directives.length} objects (raw JSON only, no markdown blocks, no backticks):
{ "packages": [
  {
    "shootIndex": 0,
    "theme": "evocative name that captures the scene world",
    "concept": "2-3 sentences: the scene described in the directive, elevated into a cinematic story.",
    "angle": one of "front" | "back" | "3/4" | "side" | "detail_top" | "detail_bottom" | "detail_feature" | "overhead" | "close_up",
    "productAction": "MUST match the directive placement exactly — where the product is and how it sits there. Do not physically transform the product.",
    "background": "rich material/environmental descriptor of the scene implied by the directive — a specific bathroom style, a specific rack, etc.",
    "lighting": "highly cinematic lighting — time of day, direction, quality, Kelvin.",
    "modelType": one of "on_model" | "flat_lay" | "product_only" | "lifestyle" | "mannequin" | "ui_mockup" | "infographic",
    "mood": "3-5 evocative words",
    "assetIndex": <0-based index from AVAILABLE PRODUCTS — match the product whose "label" most closely matches the directive text. E.g. directive "Bath towels on rack" → pick the asset whose label contains "bath towel">
  }
] }

Rules:
- shootIndex 0 = directive 1, shootIndex 1 = directive 2, etc. — strict order.
- assetIndex MUST be chosen by matching the directive text against each product's "label" field. "Bath towels on rack" → label "bath towel"; "Hand towels by basin" → label "hand towel". If all assets are the same product, always use assetIndex 0.
- productAction must literally reflect the directive placement. If directive says "on bathroom rack" → productAction says "hanging on a brushed chrome towel bar mounted to the wall".
- background must be the environment implied by the directive, described with luxury detail.
- Choose modelType based on product category: homeware/towels → lifestyle or product_only; apparel → on_model or mannequin.
- assetIndex must be 0 to ${assetCount - 1}.
- Output raw JSON only.`
  }
}
