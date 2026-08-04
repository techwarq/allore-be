import { Tool, ToolContext } from "./Tool";
import { ToolResponse, AvatarImage } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { getDb } from "../../../db";
import { privateAssets } from "../../../db/schema";
import { inArray, eq, and } from "drizzle-orm";
import { fetchR2AsBase64, getSignedR2Url, base64ToArrayBuffer } from "../../../lib/r2";

const AVATAR_BLUEPRINT_PROMPT = `
You are a casting director for a high-end AI fashion brand.
Generate a detailed model persona blueprint based on the brand story and style.

CRITICAL: if "userDescription" is present in the input, it is the user's own words describing exactly
who they want — treat it as the source of truth and honor every detail in it literally (ethnicity, build,
vibe, styling, age, etc.). Do NOT substitute, override, or "improve" on anything the user actually stated.
Only invent/infer attributes the user description left unspecified, and when inferring, take the cue from
brand story/style — never default to a specific ethnicity or look the user didn't ask for.

Return STRICT JSON only:
{
  "models": [
    {
      "id": "model_1",
      "name": "a single short first name for this model, fitting their vibe (e.g. 'Aria', 'Kai')",
      "look": "hyper-detailed physical description — height, build, face structure, hair, skin tone",
      "vibe": "one clear mood (e.g. confident authority, quiet luxury)",
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
      // If the user already described who they want in their own words (e.g.
      // "soft looking boy in Swiss Alps"), don't make them click through a
      // preset-persona menu and then retype the same thing at Gate 2 — use it
      // directly. Without this, that freeform description never reached the
      // blueprint prompt at all (it only ever received avatarPrefs/
      // avatarCustomDesc, and avatarCustomDesc only gets set by explicitly
      // answering the Gate 2 "describe them" question), so specific requests
      // like ethnicity/vibe were silently dropped and the LLM improvised.
      const freeform = this.getFreeformAvatarDescription(input, ctx);
      if (freeform) {
        memory.campaign = { ...memory.campaign, avatarPrefs: "custom", avatarCustomDesc: freeform };
        // Also fold it into shootBrief — it's very likely to contain scene/
        // setting context (e.g. "...in Swiss Alps") alongside the persona
        // description, and shoot_engine_planner's product-only brief gate
        // won't run for avatar shoots, so this is the one place that context
        // can still reach the final shoot query explicitly.
        if (!memory.campaign.shootBrief) {
          memory.campaign.shootBrief = freeform;
        }
      }
    }

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
          // Duplicate of avatarCustomDesc under the name the prompt actually
          // instructs the model to treat as source-of-truth — keeps this call
          // correct even if avatarPrefs isn't literally "custom".
          userDescription:  memory.campaign.avatarPrefs === "custom" ? memory.campaign.avatarCustomDesc : undefined,
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

    // ── Step 2: Fetch garment bytes for reference ──────────────────────────
    // Only when this avatar is being generated FOR a shoot (chained in by
    // shoot_engine_planner, which sets campaign.avatarForShoot). A standalone
    // "make me an avatar" request should just cast the model — no garment
    // to dress them in yet.
    let garmentBytes: { data: string; mimeType: string } | null = null;
    if (memory.campaign?.avatarForShoot && memory.product?.primaryAssetKey) {
      try {
        garmentBytes = await fetchR2AsBase64(this.env.ASSETS_BUCKET, memory.product.primaryAssetKey);
        console.log("[AvatarGenerator] Garment reference loaded from R2.");
      } catch (err) {
        console.warn("[AvatarGenerator] Could not fetch garment from R2 — generating without reference:", err);
      }
    }

    // ── Step 3: Generate all angles in parallel ────────────────────────────
    console.log("[AvatarGenerator] Generating", ANGLES.length, "avatar angle(s) in parallel...");

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

  // Looks for a real freeform avatar description: prefer this turn's message,
  // fall back to the last user turn in history (covers the common case where
  // this tool is chained in from shoot_engine_planner with input: {} — the
  // description the user actually typed is a turn or two back, not in this
  // call's input at all).
  private getFreeformAvatarDescription(input: any, ctx: ToolContext): string | null {
    const fromInput = typeof input?.message === "string" ? input.message.trim() : "";
    if (fromInput && !this.isTrivialTrigger(fromInput)) return fromInput;

    const lastUser = [...(ctx.history || [])].reverse().find((h: any) => h.role === "user");
    const fromHistory = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
    if (fromHistory && !this.isTrivialTrigger(fromHistory)) return fromHistory;

    return null;
  }

  // Short acknowledgements/generic triggers aren't a description — don't treat
  // them as one (would otherwise skip the persona menu with nothing useful to
  // hand the blueprint prompt).
  private isTrivialTrigger(text: string): boolean {
    const normalized = text.toLowerCase().trim().replace(/[.!?]+$/, "");
    const trivialPhrases = new Set([
      "yes", "yes please", "go ahead", "sure", "ok", "okay", "sounds good",
      "do it", "make it", "let's go", "proceed", "continue",
      "make an avatar", "create an avatar", "make a model", "create a model",
      "1", "2", "3",
    ]);
    return normalized.length < 8 || trivialPhrases.has(normalized);
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
