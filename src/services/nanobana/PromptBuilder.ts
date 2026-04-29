import { TextService } from "../gemini/TextService";

export interface ProductLock {
  name: string;
  colors: string[];
  material: string;
  texture: string;
  fit: string;
  structure: string[];
  doNotChange: string[];
}

export interface PlannedShot {
  id: string;
  type: "hero" | "lifestyle" | "detail" | "experimental";
  concept: string;
  scene: string;
  composition: string;
  lighting: string;
  background: string;
  emotion: string;
  focus: "product" | "model" | "detail";
  model_id?: string;
  camera: {
    angle: string;
    lens: string;
  };
  prompt: string; // final NanoBana prompt — built by the PromptBuilder
}

/**
 * NanoBanaPromptBuilder
 * Converts a structured PlannedShot + ProductLock into a final, grounded generation prompt.
 * This is the LAST layer before the image queue — the product must NEVER change.
 */
export class NanoBanaPromptBuilder {
  private textService: TextService;

  constructor(env: any) {
    this.textService = new TextService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async buildPrompt(
    shot: Omit<PlannedShot, 'prompt'>,
    productLock: ProductLock,
    model?: any,
    moodboardContext?: { lighting: string; palette: string[]; composition: string }
  ): Promise<string> {
    const systemInstruction = `
You are the Prompt Builder for NanoBana image generation inside Allore AI.

Your ONLY job is to convert a structured photoshoot plan into ONE perfect image generation prompt.

---

## Product Preservation (HARD CONSTRAINT — DO NOT VIOLATE)

The product is FIXED. It is the source of truth. You MUST:
- Preserve exact color, material, and texture as provided
- Include exact structure description (straps, neckline, silhouette, fit)
- NEVER hallucinate variations, patterns, or design changes
- NEVER stylize or modify the garment itself

The scene, lighting, and model adapt — the garment NEVER changes.

---

## Product Integrity Words

Always start with explicit product grounding. Use this structure:

"[Adjective] editorial photoshoot of [EXACT PRODUCT DESCRIPTION], 
featuring [material] with [texture], [fit description], [structural details]."

---

## Visibility Rule

- Product must be clearly visible
- Do NOT use extreme shadows that hide key design elements
- Do NOT use abstract compositions that obscure the garment
- Product is the hero — scene supports it

---

## Prompt Structure (ALL sections required)

1. Product grounding (exact name, material, color, structure)
2. Scene setup (environment, studio/outdoor)
3. Lighting (type, direction, mood)
4. Composition (framing, placement, rule of thirds etc.)
5. Model description (if applicable — exact look, pose, angle)
6. Camera style (lens, style)
7. Quality descriptors (always end with these)

---

## Quality Descriptors (always append these)

"Ultra realistic, high detail, premium fashion photography, 
professional campaign quality, sharp focus on product, 
cinematic color grading."

---

## Output Format (STRICT JSON)

{
  "prompt": "single string — the complete generation prompt"
}

---

Return ONLY JSON.
    `.trim();

    const payload = {
      shot,
      productLock,
      model: model || null,
      moodboardContext: moodboardContext || null
    };

    const responseText = await this.textService.generateText({
      systemInstruction,
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(payload) }]
        }
      ]
    });

    const cleanJson = responseText.replace(/^```json/m, '').replace(/```$/m, '').trim();
    const parsed = JSON.parse(cleanJson);
    return parsed.prompt as string;
  }
}
