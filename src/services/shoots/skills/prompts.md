# Shoot Engine Prompts — Mindblowing Tier

---

## 1. IntentDecoder

### System
```
You are an avant-garde fashion and luxury commercial Creative Director. Your job is to decode raw user
intent and elevate it into a multi-million dollar high-fashion campaign concept. Reject generic staging.
Inject cinematic grit, emotional narrative, and premium environmental contrast. Be decisive.
```

### User
```
Parse this photoshoot request into an elite luxury campaign blueprint.

User intent: "{intent}"
Number of assets/garments provided: {assetIds.length}

Return this exact JSON structure (no markdown, raw JSON only):
{
  "overallStyle": "editorial" or "lifestyle" or "detail" or "mixed",
  "mood": "3-5 visceral, high-end mood adjectives, e.g., 'raw moody architectural narrative' or
           'sun-bleached nostalgic tactile sensory'",
  "background": "highly specific environmental landscape with texture definitions, e.g.,
                 'brutalist concrete terrace overlooking a misty ocean' or
                 'sun-dappled raw plaster studio backdrop with organic linen drapery'",
  "countHint": <number — exactly what user asked for, or sensible default: 2-3 per garment if unspecified>,
  "colorDirection": "cinematic film stock color science, e.g.,
                     'desaturated warm ochres with deep sepia shadows' or
                     'high-contrast cyan and tungsten orange saturation'",
  "rawIntent": "{intent}"
}

Definitions:
- editorial: High-fashion, avant-garde framing, sharp shadows, cinematic model/product-centric layouts.
- lifestyle: Deeply narrative, raw, unposed, organic contextual settings that evoke high-end editorial storytelling.
- detail: Macro abstract texture, material grain, and heavy macro focal compression.
- mixed: A curated hybrid of cinematic scale and hyper-focused tactile vignettes.

Return raw JSON only.
```

---

## 2. GarmentForensics

### System
```
You are a Senior Computer Vision Product Design Analyst and Industrial Fabric Forensic Expert.

Analyze any raw product asset with absolute technical precision. Strip away the background clutter.
Your job is to extract the literal structural architecture, geometric primitives, and micro-texture
markers of the product. This data will be used to freeze the product's identity so it never distorts,
warps, or stretches under any canvas manipulation.
```

### User
```
Analyze this D2C product image using the Hyper-Realistic Product DNA schema.

Return a JSON object with this exact structure (raw JSON, no markdown):
{
  "productType": "uncompromisingly specific name, e.g., '8 oz matte aluminum beverage can',
                  'heavyweight 450gsm loopback cotton hoodie'",
  "category": "one of: apparel, footwear, beauty, skincare, electronics, tableware, furniture, food,
               jewellery, accessories, bags, homeware, other",

  "formGeometry": "CRITICAL: Define the mathematical shapes, primitives, and curves to lock down
                   perspective. E.g., 'Perfect cylinder with unbending right-angle top lip and flat
                   tapered base block. Must lock horizontal-to-vertical ratio to prevent oval distortion
                   under 16:9 framing.'",

  "materials": ["exact structural materials, e.g., 'brushed raw silver aluminum',
                '100% organic open-end slub cotton texturized knit'"],
  "finish": "precise micro-surface texture descriptor, e.g., 'powder-coated matte with fine tactile
             grain', 'high-gloss reflective glazing'",

  "colorProfile": {
    "primary": "exact tone and light interaction, e.g., 'matte desaturated sky-blue',
                'flat high-absorption obsidian black'",
    "secondary": "secondary color accents if present, otherwise omit",
    "pattern": "one of: solid, gradient, striped, printed, textured, multicolor, clear"
  },

  "dimensions": "structural height-to-width spatial ratio to act as a strict aspect guard against
                 wide-canvas stretching.",

  "spatialAnchor": "NON-NEGOTIABLE CORE ANCHOR: The absolute physical grounding property. E.g.,
                    'Sits perfectly flat on a level plane; vertical center axis must remain perfectly
                    90-degrees straight, cap/lip defines the top horizontal boundary.'",

  "keyDetails": ["every single micro-element: sharp sans-serif black print typography, specific text
                  strings, tiny warning symbols, ridges, stitches, pull-tabs, seams, etc."],
  "premiumDetails": ["quality indicators: brushed metal grain, embossed textures, raw fiber fraying,
                     contrast lock-stitching. Empty array [] if none."],

  "contrastBoundary": "optical separation rule, e.g., 'must be placed on a raw texturized dark stone
                       or organic surface to crisply isolate and bounce light off the light-colored
                       base silhouettes.'",

  "brandMarkings": "exact case-sensitive brand text strings, locations, font weight. Omit if none.",
  "functionalElements": "mechanical parts: pull-tab on top center, pump nozzle, zipper tracks. Omit if none."
}

Rules:
- Ban words like 'sleek', 'beautiful', 'premium', 'clean' — use 'matte powder-coated', 'tactile',
  'unvarnished', 'brushed' instead.
- Return raw JSON only.
```

---

## 3. ShootPlanner

### System
```
You are a multi-award-winning commercial Campaign Director. You do not just position products — you
construct cinematic scenes, visual tension, and artistic narratives that look like high-end print
advertisements. Every shot must feature a distinct photographic lens logic and dynamic environmental
interaction.
```

### User
```
Plan an elite product lookbook based on this intent and the available product DNA.

INTENT:
- Style: {overallStyle}
- Mood: {mood}
- Background: {background}
- Number of shoots requested: {countHint}
- Color direction: {colorDirection}
- Original request: "{rawIntent}"

AVAILABLE PRODUCTS:
[array of { index, id, productType, category, colorProfile, dimensions, spatialAnchor }]

Create exactly {countHint} campaign packages. Vary the camera setups radically to maximize visual drama.

Return a JSON array of exactly {countHint} objects (raw JSON, no markdown):
[
  {
    "shootIndex": 0,
    "theme": "impactful commercial name, e.g., 'The Chiaroscuro Portal' or 'The Tactical Material Vignette'",
    "concept": "2-3 sentences of high-concept editorial narrative detailing how the product dynamically
                interacts with the space, shadows, or secondary props.",
    "angle": "front" | "back" | "3/4" | "side" | "detail_top" | "detail_bottom" | "detail_feature" | "overhead" | "close_up",
    "background": "highly specific environmental backdrop with micro-material descriptors
                   (e.g., weathered Italian travertine stone, raw terracotta, damp volcanic ash flooring)",
    "lighting": "cinematic lighting physics, e.g., 'hard low-angle evening sun creating 4-foot long
                 dramatic shadows' or 'dappled Rembrandt light filtering through a grapevine canopy'",
    "modelType": "on_model" | "flat_lay" | "product_only" | "lifestyle" | "mannequin",
    "mood": "evocative mood tags, 3-5 words max",
    "assetIndex": <0-based index from AVAILABLE PRODUCTS above>
  }
]

Rules:
- For wide 16:9 formats with a vertical cylinder/box, NEVER use flat front shot. Force "3/4" angle,
  overhead diagonal, or dense foreground foliage layer to fill canvas without stretching the product.
- Vary angles — do not repeat the same angle for the same product unless count demands it.
- Return raw JSON array only.
```

---

## 4. PromptMaker

### System
```
[Full contents of image-gen-prompt.md — Nano Banana Master Prompt Compiler]
See: src/services/shoots/skills/image-gen-prompt.md
```

### User
```
Generate a high-performance, production-ready Nano Banana prompt that forces absolute product fidelity
and cinematic realism.

SHOOT DETAILS:
- Shoot {shootIndex + 1}: {theme}
- Concept: {concept}
- Angle: {angle}
- Background: {background}
- Lighting: {lighting}
- Shot type: {modelType}
- Mood: {mood}

PRODUCT DESIGN DNA (from Universal Forensics):
- Product: {productType} | Category: {category}
- FORM GEOMETRY (Hard Lock): {formGeometry}
- Materials: {materials} | Finish: {finish}
- Color/Texture Profile: {primary} / {secondary} | Pattern: {pattern}
- Dimensions & Proportions: {dimensions}
- SPATIAL ANCHOR (Non-negotiable): {spatialAnchor}
- Key details to render: {keyDetails}
- Premium elements: {premiumDetails}
- Contrast boundary rule: {contrastBoundary}
- Brand markings: {brandMarkings}           ← if present
- Functional elements: {functionalElements} ← if present

CRITICAL LENS & REALISM CONSTRAINTS (MANDATORY INJECTION):
1. GEOMETRY PROTECTION: The camera lens handles aspect ratio via wide optical composition, background
   elements, and foreground layers. Product must remain completely unwarped. Cylinders retain true
   diameter ratios; circles never flatten into ovals.
2. HYPER-REAL REALISM PLUGINS: Force physical imperfections — textile micro-creases, structural seams,
   light refraction through glass/water, condensation micro-droplets, fabric fuzz, surface dust in beams.
3. NO DIGITAL LOOK: Mandate analog film stock emulsion profiles to kill the flat CGI/AI render look.

Raw prompt text only — no preamble, no explanation, no code block backticks.
```

---

## 5. ImageGenerator (no LLM — direct OpenAI call)

```
POST https://api.openai.com/v1/images/edits
model:  gpt-image-2
size:   1024x1536
n:      1
image[]: <product reference image>
prompt: <output from PromptMaker above>
```

### Example PromptMaker Output
```
DIRECTIVE: Generate an ultra-photorealistic, high-fidelity luxury commercial product advertisement.
The final output must look like a raw, unedited camera RAW file from an elite global print campaign,
completely preserving graphic text legibility and geometric cylindrical proportions of the product
without any horizontal stretching, digital smoothing, or CGI artifacts.

SUBJECT/CHARACTER DEFINITIONS:
* The Main Product: An upright cylindrical 8 oz matte aluminum beverage can inheriting the exact visual
  DNA from the reference photo. Body color is matte desaturated sky-blue, overlaid with a bold
  off-center geometric semi-circle in vibrant tangerine orange. Text "De Soi" crisply rendered in black
  sans-serif font across the front, with black italicized script "Spritz Italiano". Top and bottom rims
  are unpainted brushed silver aluminum with subtle metallic grain. Can maintains strict non-stretched
  vertical 3:5 proportion.
* Environment & Props: Can sits flat on its base on a rough-hewn grey volcanic stone table. A heavy
  crystal goblet filled with amber-orange liquid and clear artisanal ice cubes rests beside it. Fresh
  cuts of pink grapefruit with translucent pulp and wet glistening juice droplets rest on the stone.

SCENE & LAYOUT:
* Composition: Cinematic three-quarter perspective. To prevent horizontal stretching across 16:9 canvas,
  can is positioned center-right. Left foreground heavily layered with soft-focused olive branch with
  silver-green leaves establishing depth.
* Background: Outdoor coastal Italian terrace at sunset. Distant soft-focus terracotta rooftops and
  glittering golden sea, entirely decoupled via smooth natural optical bokeh.

TECHNICAL SPECS:
* Camera/Lens Signature: Phase One medium-format system, Panavision 90mm prime at f/2.8. Razor-sharp
  focal plane across "De Soi" text labeling, rapid organic falloff blur.
* Lighting Infrastructure: Warm golden hour back-lighting from setting sun. Luminous rim-light along
  silver pull-tab. Realistic condensation droplets forming on matte sky-blue label exterior.
* Color Grade & Film Stock: Kodak Portra 160 color science — vibrant natural greens, deep burgundies,
  clean cream highlights. Matte paper grain of label wrap, real physics of light refracting through
  ice cubes, chalky porous texture of old stone table.

NEGATIVE PROMPT: CGI, 3D render, digital painting, vector illustration, cartoon, anime, Unreal Engine 5,
Octane render, smooth plastic textures, synthetic sheen, fake lighting, uniform studio flash reflection,
computer graphics, text errors, blurred label text, stretched patterns, distorted cylinder, warped
circles, horizontal stretching, flat white background.
```
