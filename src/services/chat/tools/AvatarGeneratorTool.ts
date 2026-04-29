import { Tool, ToolContext } from "./Tool";
import { ToolResponse, AvatarImage } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { getDb } from "../../../db";
import { privateAssets } from "../../../db/schema";
import { fetchR2AsBase64, getSignedR2Url, base64ToArrayBuffer } from "../../../lib/r2";

const AVATAR_BLUEPRINT_PROMPT = `
You are a casting director for a high-end AI fashion brand. 
Generate a detailed model persona blueprint based on the brand story and style.

Return STRICT JSON only:
{
  "models": [
    {
      "id": "model_1",
      "look": "hyper-detailed physical description — height, build, face structure, hair, skin tone",
      "vibe": "one clear mood (e.g. confident authority, quiet luxury)",
      "ethnicity": "specific ethnicity",
      "gender": "male|female|other"
    }
  ]
}
`.trim();

const ANGLES = [
  { id: "front",        pose: "front-facing hero pose, direct eye contact, weight balanced" },
  { id: "side",         pose: "side profile, chin slightly raised, composed expression" },
  { id: "threequarter", pose: "three-quarter turn, dynamic, slight lean forward" },
  { id: "walking",      pose: "mid-stride walking shot, natural confident movement" },
  { id: "seated",       pose: "seated editorial pose, relaxed but composed, leaning slightly back" },
];

export class AvatarGeneratorTool implements Tool {
  name = "avatar_generator";
  description = "Generating human models, personas, or characters for your brand.";
  private textService: TextService;
  private env: any;

  constructor(textServiceOrEnv: any, env?: any) {
    if (textServiceOrEnv instanceof TextService) {
      this.textService = textServiceOrEnv;
      this.env = env;
    } else {
      this.env = textServiceOrEnv;
      this.textService = new TextService(
        this.env.GEMINI_API_KEY,
        this.env.VERTEX_PROJECT_ID,
        this.env.VERTEX_LOCATION,
        this.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
        this.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
      );
    }
  }

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    const memory = ctx.memory || {};
    const projectId = memory.campaign?.projectId || memory.projectId;

    console.log("[AvatarGenerator] run() — avatarPrefs:", memory.campaign?.avatarPrefs, "projectId:", projectId);

    // ── Gate 1: need persona preference first ─────────────────────────────
    if (!memory.campaign?.avatarPrefs) {
      const story = memory.creative?.story || "";
      const style = memory.creative?.style || {};

      let discoveryContent = {
        title: "Define your AI model DNA",
        question: "What kind of personas should front this campaign?",
        options: [
          { id: "diverse_urban", label: "Diverse & Urban",       description: "Mix of ethnicities, city energy." },
          { id: "edgy_alt",      label: "Edgy & Alternative",    description: "Bold, raw, unconventional." },
          { id: "high_fashion",  label: "High-Fashion",          description: "Sharp, editorial, regal." },
          { id: "custom",        label: "I'll describe them",    description: "Tell me exactly who you want." }
        ]
      };

      // Try to generate brand-specific options via LLM — fallback to defaults above if it fails
      try {
        const discoveryResponse = await this.textService.generateText({
          systemInstruction: `You are a casting director. Based on the brand story and style, suggest 3 distinct Persona DNAs.
Return ONLY JSON — no markdown:
{ "title": "...", "question": "...", "options": [{"id": "...", "label": "...", "description": "..."}] }
Add a 4th option: { "id": "custom", "label": "I'll describe them", "description": "Tell me exactly who you want." }`,
          contents: [{ role: "user", parts: [{ text: JSON.stringify({ story, style }) }] }]
        });
        const parsed = this.parseJson(discoveryResponse, null);
        if (parsed?.options?.length) discoveryContent = parsed;
      } catch (err) {
        console.warn("[AvatarGenerator] Discovery LLM failed, using defaults:", err);
      }

      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "avatar_prefs",
          content: discoveryContent
        }]
      };
    }

    // ── Gate 2: custom description needed ────────────────────────────────
    if (memory.campaign.avatarPrefs === "custom" && !memory.campaign.avatarCustomDesc) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "avatar_custom_desc",
          content: {
            title: "Describe your model",
            question: "Describe exactly who you want for this campaign — ethnicity, build, vibe, style.",
            options: []
          }
        }]
      };
    }

    // ── Step 1: Generate model blueprint ─────────────────────────────────
    console.log("[AvatarGenerator] Generating model blueprint...");
    const blueprintResponse = await this.textService.generateText({
      systemInstruction: AVATAR_BLUEPRINT_PROMPT,
      contents: [{
        role: "user",
        parts: [{ text: JSON.stringify({
          brandProfile:     ctx.brandContext,
          story:            memory.creative?.story,
          style:            memory.creative?.style,
          avatarPrefs:      memory.campaign.avatarPrefs,
          avatarCustomDesc: memory.campaign.avatarCustomDesc,
        }) }]
      }]
    });

    const blueprint = this.parseJson(blueprintResponse, { models: [] });
    const model = blueprint.models?.[0];

    if (!model) {
      console.error("[AvatarGenerator] Blueprint parse failed. Raw:", blueprintResponse);
      throw new Error("Avatar blueprint generation failed — no model returned.");
    }

    console.log("[AvatarGenerator] Model blueprint ready:", model.look?.slice(0, 60));

    // ── Step 2: Fetch garment bytes for reference ─────────────────────────
    let garmentBytes: { data: string; mimeType: string } | null = null;
    if (memory.product?.primaryAssetKey) {
      try {
        garmentBytes = await fetchR2AsBase64(this.env.ASSETS_BUCKET, memory.product.primaryAssetKey);
        console.log("[AvatarGenerator] Garment reference loaded from R2.");
      } catch (err) {
        console.warn("[AvatarGenerator] Could not fetch garment from R2 — generating without reference:", err);
      }
    } else {
      console.warn("[AvatarGenerator] No primaryAssetKey in memory.product — generating without garment reference.");
    }

    // ── Step 3: Generate all 5 angles in parallel ─────────────────────────
    console.log("[AvatarGenerator] Generating", ANGLES.length, "avatar angles in parallel...");

    const avatarJobs = ANGLES.map(angle =>
      this.generateAndStoreAvatarAngle({ model, angle, style: memory.creative?.style, garmentBytes, ctx, projectId })
    );

    const results = await Promise.allSettled(avatarJobs);

    // Log every failure so you can see exactly what went wrong
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[AvatarGenerator] Angle "${ANGLES[i].id}" failed:`, r.reason);
      }
    });

    const avatarImages: AvatarImage[] = results
      .filter((r): r is PromiseFulfilledResult<AvatarImage> => r.status === "fulfilled")
      .map(r => r.value);

    console.log(`[AvatarGenerator] ${avatarImages.length}/${ANGLES.length} angles succeeded.`);

    if (avatarImages.length === 0) {
      throw new Error("All 5 avatar angle generation attempts failed. Check logs above for per-angle errors.");
    }

    // ── Step 4: Return results ─────────────────────────────────────────────
    return {
      memoryUpdate: {
        campaign: {
          ...memory.campaign,
          avatarImages,
          models: [{ ...model, images: avatarImages }],
          useAvatar: true,
        }
      },
      visible: [
        {
          type: "status",
          content: `Generated ${avatarImages.length} avatar angles.`
        },
        {
          type: "canvas_info",
          data: {
            title: "Your AI model is ready",
            avatarImages: avatarImages.map(a => ({ angle: a.angleId, url: a.signedUrl }))
          }
        }
      ],
      // Dynamically chain to planner — only after avatars are confirmed
      nextTasks: [{ id: "photoshoot_planner", tool: "photoshoot_planner", input: {} }]
    };
  }

  private async generateAndStoreAvatarAngle({
    model, angle, style, garmentBytes, ctx, projectId
  }: {
    model: any;
    angle: { id: string; pose: string };
    style: any;
    garmentBytes: { data: string; mimeType: string } | null;
    ctx: ToolContext;
    projectId: string;
  }): Promise<AvatarImage> {

    const prompt = this.buildAvatarPrompt(model, angle, style, !!garmentBytes);

    const parts: any[] = [{ text: prompt }];
    if (garmentBytes) {
      parts.push({ inlineData: { mimeType: garmentBytes.mimeType, data: garmentBytes.data } });
      parts.push({ text: "REFERENCE: The above image shows the exact garment. The model must wear this garment faithfully — same color, cut, and design. Do not modify it." });
    }

    // ── Image generation ───────────────────────────────────────────────
    // IMPORTANT: verify your TextService has a .generate() method that handles
    // responseModalities: ["IMAGE"]. If it only has generateText(), this will fail.
    const response = await this.textService.generate({
      model: "gemini-3.1-flash-image-preview",
      contents: [{ role: "user", parts }],
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "2:3", imageSize: "2K" }
      }
    });

    const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part?.inlineData?.data) {
      throw new Error(`Gemini returned no image data for angle "${angle.id}". Response: ${JSON.stringify(response?.candidates?.[0])}`);
    }

    // ── Store to R2 ────────────────────────────────────────────────────
    const key = `avatars/${ctx.userId || 'anon'}/${projectId || 'default'}/${Date.now()}-${angle.id}.jpg`;

    await this.env.ASSETS_BUCKET.put(
      key,
      base64ToArrayBuffer(part.inlineData.data),
      { httpMetadata: { contentType: part.inlineData.mimeType || "image/jpeg" } }
    );

    // ── Generate signed URL ────────────────────────────────────────────
    // NOTE: createSignedUrl requires R2 custom domain or public bucket.
    // If this throws, your bucket may not support presigned URLs.
    // Alternative: use your /assets/download?key= proxy endpoint instead.
    let signedUrl: string;
    try {
      signedUrl = await getSignedR2Url(this.env.ASSETS_BUCKET, key, 7200);
    } catch (err) {
      console.warn("[AvatarGenerator] getSignedR2Url failed, falling back to proxy URL:", err);
      signedUrl = `${this.env.API_URL}/assets/download?key=${encodeURIComponent(key)}`;
    }

    // ── Save to DB ─────────────────────────────────────────────────────
    const db = getDb(this.env.DATABASE_URL);
    await db.insert(privateAssets).values({
      id:        crypto.randomUUID(),
      userId:    ctx.userId && ctx.userId !== 'anon' ? ctx.userId : null,
      projectId: projectId || null,
      r2Key:     key,
      type:      "avatar",
      metadata:  { angleId: angle.id, modelId: model.id }
    });

    console.log(`[AvatarGenerator] Stored angle "${angle.id}" → ${key}`);

    return { angleId: angle.id, r2Key: key, signedUrl };
  }

  private buildAvatarPrompt(
    model: any,
    angle: { id: string; pose: string },
    style: any,
    hasGarment: boolean
  ): string {
    return [
      `Professional fashion editorial photograph of ${model.look}.`,
      `Ethnicity: ${model.ethnicity}. Vibe: ${model.vibe}.`,
      `Pose: ${angle.pose}.`,
      hasGarment
        ? `Wearing the exact garment from the reference image — preserve color, cut, silhouette exactly.`
        : `Wearing stylish fashion-forward clothing matching the brand aesthetic.`,
      `Lighting: ${style?.lighting || "soft natural directional light"}.`,
      `Aesthetic: ${style?.aesthetic || "premium fashion editorial"}.`,
      `Color palette: ${(style?.color_palette || []).join(", ") || "neutral tones"}.`,
      `Lens: ${["front", "side"].includes(angle.id) ? "85mm portrait" : "50mm"}.`,
      `Full body visible. Garment clearly shown. Ultra high quality, 2K resolution.`,
    ].filter(p => typeof p === "string").join(" ");
  }

  private parseJson(raw: string, fallback: any): any {
    try {
      return JSON.parse(
        raw.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
      );
    } catch {
      return fallback;
    }
  }
}
