import { Tool, ToolContext } from "./Tool";
import { ToolResponse, AvatarImage } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { ITextService } from "../ITextService";
import { getDb } from "../../../db";
import { privateAssets } from "../../../db/schema";
import { inArray, eq, and } from "drizzle-orm";
import { getSignedR2Url, base64ToArrayBuffer } from "../../../lib/r2";

const AVATAR_BLUEPRINT_PROMPT = `
You are a casting director. Generate a detailed model persona blueprint for THIS shoot.

Ground the casting in, in priority order:
1. avatarCustomDesc / avatarPrefs, if given — the user's own choice for who this model is.
2. shootBrief, if given — the specific mood/setting for THIS shoot (e.g. an athletic or
   sporty brief calls for an athletic build and active energy — do not default to
   high-fashion/editorial styling when the brief asks for something else).
3. Brand story/style — supporting context only, not the primary driver.

CRITICAL: if "avatarCustomDesc" is present, it is the user's own words describing
exactly who they want — treat it as the source of truth and honor every detail in it
literally (ethnicity, build, vibe, styling, age, etc.). Do NOT substitute, override,
or "improve" on anything the user actually stated. Only invent/infer attributes the
user left unspecified, and when inferring, take the cue from the shoot brief/brand
story — never default to a specific ethnicity or look nothing here asked for.

Return STRICT JSON only:
{
  "models": [
    {
      "id": "model_1",
      "name": "a single short first name for this model, fitting their vibe (e.g. 'Aria', 'Kai')",
      "look": "hyper-detailed PHYSICAL description only — height, build, face structure, hair, skin tone. Do NOT describe clothing/outfit here, that goes in the separate 'outfit' field below.",
      "outfit": "what this model is wearing. If avatarCustomDesc describes an outfit, use that description verbatim — do not substitute a different one. Otherwise infer something fitting the shoot brief (e.g. athletic wear for a sporty brief), not a generic 'brand aesthetic' default.",
      "vibe": "one clear mood grounded in the shoot brief/brand (e.g. 'confident athlete', 'quiet luxury')",
      "ethnicity": "specific ethnicity",
      "gender": "male|female|other"
    }
  ]
}
`.trim();

// Trimmed to 1 angle for now (was 5) — faster/cheaper while iterating on the chat flow.
const ANGLES = [
  { id: "front", pose: "front-facing hero pose, direct eye contact, weight balanced" },
];

// Fallback pool if the blueprint LLM call ever still omits "name" despite JSON
// mode — a real (if generic) name is far more usable/@-mentionable than a
// "Model 837"-style placeholder.
const FALLBACK_NAMES = [
  "Aria", "Kai", "Nova", "Rhea", "Zaid", "Mira", "Ora", "Jax", "Lena", "Rio",
  "Vera", "Silas", "Kira", "Theo", "Nyla", "Ezra", "Suri", "Milo", "Anya", "Dax",
];

export class AvatarGeneratorTool implements Tool {
  name = "avatar_generator";
  description =
    "Casts and generates AI human model personas (multi-angle reference images) to wear/use products in shoots. Needs brand story/style in memory. Usually chained in automatically by shoot_engine_planner when the user wants models — call directly only when the user asks to create or preview avatars on their own, outside a shoot.";
  // Casting reasoning (discovery options, model blueprint) runs on this — the
  // injected chat engine (OpenRouter qwen). Text-only; typed ITextService.
  private textService: ITextService;
  // Avatar IMAGE generation is Gemini-only (responseModalities:["IMAGE"] via
  // .generate()). qwen can't do this, so we always keep a dedicated Gemini
  // service for it, independent of whatever text engine was injected.
  private imageService: TextService;
  private env: any;

  // Duck-type generateText so an injected non-Gemini text engine is preserved
  // (not swapped for Gemini). The Gemini imageService is built from env
  // regardless — env is the 2nd arg when an engine is injected, the 1st when not.
  constructor(textServiceOrEnv: any, env?: any) {
    if (typeof textServiceOrEnv?.generateText === "function") {
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
    this.imageService = new TextService(
      this.env.GEMINI_API_KEY,
      this.env.VERTEX_PROJECT_ID,
      this.env.VERTEX_LOCATION,
      this.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      this.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    const memory = ctx.memory || {};
    const projectId = memory.campaign?.projectId || memory.projectId;

    console.log("[AvatarGenerator] run() — avatarPrefs:", memory.campaign?.avatarPrefs, "avatarApproved:", memory.campaign?.avatarApproved, "projectId:", projectId);

    // ── Gate 0a: a generated avatar is pending approval — handle the answer ───
    if (memory.campaign?.pendingAvatarImages?.length) {
      if (memory.campaign.avatarApproved === true) {
        return this.finalizeApprovedAvatar(memory, ctx);
      }
      if (memory.campaign.avatarApproved === false) {
        // Regenerate — clear the rejected attempt and fall through to generation below.
        memory.campaign = {
          ...memory.campaign,
          pendingAvatarImages: undefined,
          pendingAvatarModel: undefined,
          avatarApproved: undefined,
        };
      }
    }

    // ── Gate 1: need persona preference first ─────────────────────────────
    if (!memory.campaign?.avatarPrefs) {
      const story = memory.creative?.story || "";
      const style = memory.creative?.style || {};
      // The user's own shoot brief (e.g. "workout style campaign for athletes
      // playing tennis, sporty") — without this, casting options were only
      // grounded in the brand's narrative/aesthetic and ignored what the user
      // actually just asked for this specific shoot.
      const shootBrief = memory.campaign?.shootBrief || "";

      let discoveryContent = {
        title: "Define your AI model DNA",
        question: "What kind of models should front this campaign?",
        options: [
          { id: "diverse_urban", label: "Diverse & Urban",       description: "Mixed ethnicities, everyday build, confident city energy." },
          { id: "edgy_alt",      label: "Edgy & Alternative",    description: "Lean/athletic build, tattoos or piercings, unconventional look." },
          { id: "high_fashion",  label: "High-Fashion",          description: "Tall, sharp features, editorial poise." },
          { id: "custom",        label: "I'll describe them",    description: "Tell me exactly who you want." }
        ]
      };

      // Try to generate brief-specific options via LLM — fallback to defaults above if it fails
      try {
        const discoveryResponse = await this.textService.generateText({
          systemInstruction: `You are a casting director putting together options for a real shoot.

Based on the brand story/style AND the shoot brief below, suggest 3 distinct casting
options for the human model(s) in this shoot.

Each option describes an actual PERSON to cast: physical build, general look, and
energy/vibe. It is NOT brand-aesthetic copy — do not describe the campaign's mood,
color palette, or "energy of the brand." Describe who would physically be cast.
Ground it in the shoot brief specifically — e.g. a sporty/athletic brief calls for
athletic builds and active energy, not runway-editorial types the brief never asked
for. If no shoot brief is given, fall back to the brand story/style only.

Keep descriptions plain and concrete — a real casting note, not a tagline.

Return ONLY JSON — no markdown:
{ "title": "...", "question": "...", "options": [{"id": "...", "label": "short casting label, e.g. 'Athletic & Energetic'", "description": "1 sentence: build, look, energy"}] }
Add a 4th option: { "id": "custom", "label": "I'll describe them", "description": "Tell me exactly who you want." }`,
          contents: [{ role: "user", parts: [{ text: JSON.stringify({ story, style, shootBrief }) }] }]
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
          shootBrief:       memory.campaign?.shootBrief,
          avatarPrefs:      memory.campaign.avatarPrefsLabel || memory.campaign.avatarPrefs,
          avatarCustomDesc: memory.campaign.avatarCustomDesc,
        }) }]
      }],
      // Enforced JSON mode — without this the model sometimes drops the
      // "name" field even though the prompt asks for strict JSON, leaving
      // finalizeApprovedAvatar() to fall back to a meaningless "Model NNN"
      // label instead of a real, memorable, @-mentionable name.
      generationConfig: { responseMimeType: "application/json" },
    });

    const blueprint = this.parseJson(blueprintResponse, { models: [] });
    const model = blueprint.models?.[0];

    if (!model) {
      console.error("[AvatarGenerator] Blueprint parse failed. Raw:", blueprintResponse);
      throw new Error("Avatar blueprint generation failed — no model returned.");
    }

    console.log("[AvatarGenerator] Model blueprint ready:", model.look?.slice(0, 60));

    // ── Step 2: Generate all angles in parallel ────────────────────────────
    // Deliberately never references the product image, worn or otherwise —
    // this tool's only job is casting a good, reusable model. Compositing the
    // model with the actual product (worn, held, or placed) is SimpleShootEngine's
    // job at real shoot-generation time, which already reasons properly about
    // what the product is and how it belongs in frame. Avatar generation trying
    // to do that too just produces wrong results for anything that isn't
    // literally apparel (e.g. a drink can's label printed onto a tank top).
    console.log("[AvatarGenerator] Generating", ANGLES.length, "avatar angle(s) in parallel...");

    const avatarJobs = ANGLES.map(angle =>
      this.generateAndStoreAvatarAngle({ model, angle, ctx, projectId })
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
      throw new Error(`All ${ANGLES.length} avatar angle generation attempts failed. Check logs above for per-angle errors.`);
    }

    // ── Step 4: Show it and wait for approval — nothing is saved yet ──────
    // Queues its own resume (re-enters this tool once the user answers). If this
    // generation was chained in from shoot_engine_planner, its own
    // "resume_shoot_planner" follow-up task is already queued right behind this
    // one in flowControl.pendingTasks and will run automatically once the
    // avatar is approved and finalized below — no need to re-chain it here.
    return {
      memoryUpdate: {
        campaign: {
          ...memory.campaign,
          pendingAvatarImages: avatarImages,
          pendingAvatarModel: model,
          avatarApproved: undefined,
        }
      },
      pauseForUserInput: true,
      visible: [
        {
          type: "social_images",
          items: avatarImages.map(a => ({ url: a.signedUrl, caption: model.name || a.angleId }))
        },
        {
          type: "choice_questionnaire",
          questionId: "avatar_approval",
          content: {
            title: model.name ? `Meet ${model.name}` : "Meet your model",
            question: "Approve this model? Once approved, they're saved to your avatar library and stay consistent across future shoots.",
            options: [
              { id: "approve", label: "Approve", description: "Save this model and use them." },
              { id: "regenerate", label: "Regenerate", description: "Try a different take on this persona." },
            ]
          }
        }
      ],
      nextTasks: [{ id: "avatar_finalize", tool: "avatar_generator" as any, input: {} }]
    };
  }

  // Called on resume once the user has answered the approval questionnaire.
  // Avatars don't get their own table — the per-angle images already landed in
  // privateAssets (type: "avatar") during generation; approving just labels
  // those rows with the model's name so they're queryable as a reusable,
  // named, user-scoped avatar going forward (unlabeled rows are unapproved/
  // rejected generation attempts).
  private async finalizeApprovedAvatar(memory: any, ctx: ToolContext): Promise<ToolResponse> {
    const avatarImages: AvatarImage[] = memory.campaign.pendingAvatarImages;
    const model = memory.campaign.pendingAvatarModel;
    const name = (model?.name && String(model.name).trim())
      || FALLBACK_NAMES[Math.floor(Math.random() * FALLBACK_NAMES.length)];

    if (ctx.userId && ctx.userId !== "anon" && avatarImages.length > 0) {
      try {
        const db = getDb(this.env.DATABASE_URL);
        await db.update(privateAssets)
          .set({ label: name })
          .where(and(
            eq(privateAssets.userId, ctx.userId),
            inArray(privateAssets.r2Key, avatarImages.map(a => a.r2Key)),
          ));
        console.log(`[AvatarGenerator] Labeled "${name}" as a saved avatar for user ${ctx.userId}`);
      } catch (err) {
        console.error("[AvatarGenerator] Failed to label avatar as saved:", err);
      }
    }

    return {
      memoryUpdate: {
        campaign: {
          ...memory.campaign,
          avatarImages,
          models: [{ ...model, images: avatarImages }],
          useAvatar: true,
          pendingAvatarImages: undefined,
          pendingAvatarModel: undefined,
          avatarApproved: undefined,
        }
      },
      visible: [{
        type: "chat_text",
        status: `${name} saved to your avatar library.`
      }]
    };
  }

  private async generateAndStoreAvatarAngle({
    model, angle, ctx, projectId
  }: {
    model: any;
    angle: { id: string; pose: string };
    ctx: ToolContext;
    projectId: string;
  }): Promise<AvatarImage> {

    const prompt = this.buildAvatarPrompt(model, angle);
    const parts: any[] = [{ text: prompt }];

    // ── Image generation ───────────────────────────────────────────────
    // Gemini-only path (responseModalities: ["IMAGE"]) — uses the dedicated
    // imageService, NOT the injected chat text engine (qwen can't generate images).
    const response = await this.imageService.generate({
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

    // ── Save to DB (project-scoped asset record, separate from the
    // user-level avatar library which is only written on approval) ──────
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

  // Deliberately does NOT pull in the brand's creative style (lighting/
  // aesthetic/color palette meant for the actual campaign shoot) — an avatar
  // is a reusable model reference, not a finished campaign photo. Baking a
  // specific scene/mood into it here means every future shoot with this same
  // model inherits whatever scene happened to be active when they were cast,
  // and defeats the point of casting once and reusing across different
  // shoots. The real shoot's scene/setting gets composited in later
  // (SimpleShootEngine), not here.
  private buildAvatarPrompt(
    model: any,
    angle: { id: string; pose: string }
  ): string {
    return [
      `Professional studio photograph of ${model.look}.`,
      `Ethnicity: ${model.ethnicity}. Vibe: ${model.vibe}.`,
      `Pose: ${angle.pose}.`,
      `Wearing: ${model.outfit || "stylish, neutral clothing fitting their vibe"}.`,
      `Lighting: soft, even studio lighting.`,
      `Background: plain, seamless neutral studio backdrop (light gray) — no props, no location, no scene elements. This is a clean model reference shot, not a styled campaign photo.`,
      `Lens: ${["front", "side"].includes(angle.id) ? "85mm portrait" : "50mm"}.`,
      `Full body visible. Ultra high quality, 2K resolution.`,
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
