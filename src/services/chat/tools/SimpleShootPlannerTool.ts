import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { getDb } from "../../../db";
import { assets, privateAssets } from "../../../db/schema";
import { eq, desc, inArray, and, isNotNull } from "drizzle-orm";
import { fetchPinterestVibes, VibeOption } from "../../pinterest-vibe.service";
// @ts-ignore — text module via wrangler rules
import shootEnginePlannerSkillRaw from "../../../core/skills/shoot-engine-planner.md";
import { parseSkill } from "../../../core/skills/loadSkill";

const SHOOT_ENGINE_PLANNER_SKILL = parseSkill(shootEnginePlannerSkillRaw);

const UPLOAD_NEW_OPTION_ID = "__upload_new__";

export interface SimpleShootPlannerEnv {
  DATABASE_URL: string;
  ASSETS_BUCKET: any;
  API_URL?: string;
  // Vibe-picker gate (product-only shoots) — real Pinterest reference images,
  // not AI-generated and not the internal pinterest_assets Qdrant collection.
  PINTEREST_COOKIE?: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  STAGEHAND_ENV?: "BROWSERBASE" | "LOCAL";
  PINTEREST_EMAIL?: string;
  PINTEREST_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  VERTEX_PROJECT_ID?: string;
  VERTEX_LOCATION?: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}

interface AssetOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * Gates a chat-driven photoshoot request, then hands off to the "simple_shoot_engine"
 * queued task (SimpleShootEngine — creative direction + Seedream generation, no
 * forensics). Mirrors the old ShootEngineTool's gate shape (asset → avatar y/n →
 * avatar generation) but adds an explicit asset-picker gate instead of silently
 * auto-locking to whatever resolveAttachments() found, and a shoot-brief gate
 * (vibe picker + mood/setting question) that runs regardless of avatar choice,
 * so the user gets to steer the concept instead of the creative-director stage
 * improvising from a bare chat message alone.
 *
 * Registered as "shoot_engine_planner" (via PhotoshootAgent) — keep this identity;
 * it's hardcoded into the intent-classifier prompt and every nextTasks chain that
 * hands off to this capability.
 */
export class SimpleShootPlannerTool implements Tool {
  name = "shoot_engine_planner";
  description =
    "Plans and triggers a product photoshoot: gates on product assets (offers existing project assets or upload), model preference (AI avatars or product-only), and the creative brief (mood/setting/vibe), then generates the shots.";
  whenToUse = SHOOT_ENGINE_PLANNER_SKILL.whenToUse;
  routingNotes = SHOOT_ENGINE_PLANNER_SKILL.routingNotes;

  constructor(private env: SimpleShootPlannerEnv) {}

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    // ── Guard: prevent double-queuing when this re-runs after avatar generation ─
    if (ctx.memory?.campaign?.shootEngineQueued) {
      return { visible: [] };
    }

    const answeredQuestions: string[] = ctx.memory?.conversation?.answeredQuestions ?? [];
    const projectId = ctx.memory?.projectId || ctx.memory?.campaign?.projectId;

    // ── Gate 0: product assets ───────────────────────────────────────────────
    // resolveAttachments() already ran this turn and may have silently locked a
    // product from prior assetRefs or a DB fallback — but only this-turn
    // attachments or an already-confirmed prior reference count as "already
    // decided" here. Anything else, ask explicitly instead of guessing.
    const hasThisTurnAttachment = (ctx.attachments?.length ?? 0) > 0;
    const hasConfirmedProductRef = (ctx.memory?.conversation?.assetRefs ?? []).some(
      (r: any) => r.role === "product"
    );
    const hasDescribedProduct = ctx.memory?.product?.source === "describe" && !!ctx.memory?.product?.productLocked;
    const askedAssetGate = answeredQuestions.includes("asset_selection");

    if (!hasThisTurnAttachment && !hasConfirmedProductRef && !hasDescribedProduct && !askedAssetGate) {
      // Already asked once (no existing assets to pick from, so the prior ask
      // was a plain "go ahead and upload, or describe it" prompt — not a
      // button). Still no attachment this turn means they replied with a
      // description instead of uploading — take that reply as the product
      // description rather than re-asking forever.
      if (ctx.memory?.campaign?.awaitingProduct && input.message?.trim()) {
        return {
          visible: [{ type: "status", content: "Got it — using your description for the product." }],
          memoryUpdate: {
            product: { ...ctx.memory?.product, source: "describe", description: input.message.trim(), productLocked: true },
            campaign: { ...ctx.memory?.campaign, awaitingProduct: false },
          },
        };
      }
      return this.askForAssets(projectId, ctx);
    }

    // ── Gate 1: shoot vibe/setting — runs BEFORE model casting, avatar or
    // product-only alike. Deliberately ahead of avatar_choice: the setting the
    // user picks here (Pinterest reference or text brief) is what the FINAL
    // composite (model + product + setting) uses — casting a model first and
    // asking about setting after made the model gate's own generation blind to
    // what scene it'd actually end up in, so avatar_generator had to guess a
    // background/lighting from the brand story instead. Settling the vibe here
    // first also means avatar_generator can now render a neutral studio
    // reference (see buildAvatarPrompt) instead of a scene-specific one.
    {
      // NOTE: deliberately NOT gating any of gates 3a/3b/3c on `answeredQuestions`
      // (unlike the one-time gates above, e.g. avatar_choice). answeredQuestions is
      // a lifetime log that never clears for the life of the session (see Gate 4's
      // shootConfirmed comment) — brief/vibe are per-SHOOT, reset to undefined
      // whenever a shoot job completes (see the memoryUpdate at job completion in
      // Orchestrator/index.ts). Co-gating on the lifetime log meant that once a
      // user answered these ONCE in a session, every subsequent shoot request —
      // "give it a new setting", "make another one", etc. — silently skipped
      // asking again and reused/ignored stale state instead of capturing what the
      // user actually just asked for. The resettable value alone (vibeChoice,
      // shootBriefChoice, shootBrief) is sufficient to prevent re-asking within
      // the SAME shoot, since extractAnswer sets it the moment it's answered.
      let vibeChoice = ctx.memory?.campaign?.vibeChoice;
      const pinterestConfigured = !!(this.env.PINTEREST_COOKIE || this.env.BROWSERBASE_API_KEY);

      // ── Gate 1a: vibe picker — real Pinterest reference images (not
      // AI-generated, not the internal moodboard collection). Runs before the
      // plain-text brief question so the user has something concrete to react
      // to instead of writing a brief from a blank page. Any failure/empty
      // result here just falls through to the text-only gate below — never
      // blocks the shoot on Pinterest being reachable.
      if (pinterestConfigured && vibeChoice === undefined) {
        const query = this.buildVibeQuery(ctx, input);
        let candidates: VibeOption[] = [];
        try {
          candidates = await fetchPinterestVibes(this.env, query, 4);
        } catch (err: any) {
          console.warn("[SimpleShootPlannerTool] Vibe search failed, falling back to text brief:", err.message);
        }

        if (candidates.length > 0) {
          return {
            pauseForUserInput: true,
            memoryUpdate: { campaign: { ...ctx.memory?.campaign, vibeCandidates: candidates } },
            visible: [
              { type: "shoot_images", items: candidates.map((c) => ({ url: c.imageUrl, concept: c.title })) },
              {
                type: "choice_questionnaire",
                questionId: "vibe_choice",
                content: {
                  title: "Pick a vibe",
                  question: "Real references for this shoot — pick a direction, or describe your own.",
                  options: [
                    ...candidates.map((c) => ({ id: c.id, label: c.title, description: c.description?.slice(0, 120) })),
                    { id: "custom", label: "None of these", description: "I'll describe the mood/setting myself." },
                  ],
                },
              },
            ],
          };
        }
        // No usable results this turn — treat like the user picked "describe it
        // myself" so we don't retry a live Pinterest fetch on every subsequent
        // turn of this same shoot.
        vibeChoice = "custom";
      }

      const shootBriefChoice = ctx.memory?.campaign?.shootBriefChoice;
      // Vibe picker already resolved a real reference and folded it into
      // shootBrief (Responser's vibe_choice extractor) — no need to also ask
      // the ai_decide/custom question. Only "custom" (explicit or via a failed
      // search) still needs the ai_decide-vs-custom fork.
      const vibeResolved = vibeChoice !== undefined && vibeChoice !== "custom";

      if (!vibeResolved && !shootBriefChoice) {
        return {
          pauseForUserInput: true,
          memoryUpdate: vibeChoice === "custom" ? { campaign: { ...ctx.memory?.campaign, vibeChoice: "custom" } } : undefined,
          visible: [{
            type: "choice_questionnaire",
            questionId: "shoot_brief_choice",
            content: {
              title: "Shoot direction",
              question: "Any specific mood, setting, or style for this shoot?",
              options: [
                { id: "ai_decide", label: "Let AI decide", description: "Develop a creative concept from your brief and brand style." },
                { id: "custom", label: "I'll describe it", description: "Tell me the mood, setting, or style you want." },
              ],
            },
          }],
        };
      }

      if (!vibeResolved && shootBriefChoice === "custom" && !ctx.memory?.campaign?.shootBrief) {
        return {
          pauseForUserInput: true,
          visible: [{
            type: "choice_questionnaire",
            questionId: "shoot_brief_custom",
            content: {
              title: "Describe the shoot",
              question: "What mood, setting, or style do you want for this shoot?",
              options: [],
            },
          }],
        };
      }
    }

    // ── Gate 2: avatar preference — asked after the setting is locked in, not
    // before ─────────────────────────────────────────────────────────────────
    const useAvatar = ctx.memory?.campaign?.useAvatar;
    const answeredAvatarChoice = answeredQuestions.includes("avatar_choice");

    if (useAvatar === undefined && !answeredAvatarChoice) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "avatar_choice",
          content: {
            title: "Model direction",
            question: "Do you want human models (AI avatars) in these shots, or product-only?",
            options: [
              { id: "use_avatar", label: "Yes, add AI models", description: "We'll generate AI avatars styled to your brand." },
              { id: "product_only", label: "Product only", description: "Clean product shots — no models." },
            ],
          },
        }],
      };
    }

    // ── Gate 3: avatar requested but not yet generated → reuse saved, ask which,
    // or generate a brand new one. avatar_generator now casts a neutral studio
    // reference (see AvatarGeneratorTool.buildAvatarPrompt) rather than one
    // baked into this shoot's scene — the scene/setting from Gate 1 above gets
    // composited in at final generation instead, so the same cast model stays
    // reusable across shoots with completely different settings. ─────────────
    const avatarImages: any[] = ctx.memory?.campaign?.avatarImages ?? [];
    if (useAvatar && avatarImages.length === 0) {
      // User already explicitly said "create a new one" at the avatar_reuse picker
      // (avatar_reuse extractor sets this) — go straight to generating instead of
      // re-fetching saved avatars and re-asking the identical reuse-or-new question.
      if (ctx.memory?.campaign?.avatarForShoot) {
        return {
          visible: [{ type: "status", content: "Casting a new AI model for this shoot." }],
          nextTasks: [
            { id: "gen_avatars", tool: "avatar_generator" as any, input: {} },
            { id: "resume_shoot_planner", tool: "shoot_engine_planner" as any, input: {} },
          ],
        };
      }

      // An "@Name" mention in the user's message resolves directly to a saved
      // avatar, skipping the picker entirely.
      const mention = (input.message || "").match(/@(\w+)/)?.[1]?.toLowerCase();
      const savedAvatars = ctx.userId && ctx.userId !== "anon"
        ? await this.listSavedAvatars(ctx.userId)
        : [];

      if (mention) {
        const matched = savedAvatars.find((a) => a.name.toLowerCase() === mention);
        if (matched) {
          return {
            visible: [{ type: "status", content: `Using ${matched.name} from your avatar library.` }],
            memoryUpdate: {
              campaign: { ...ctx.memory?.campaign, avatarImages: matched.images, useAvatar: true },
            },
          };
        }
      }

      if (savedAvatars.length === 1) {
        return {
          visible: [{ type: "status", content: `Using ${savedAvatars[0].name} from your avatar library.` }],
          memoryUpdate: {
            campaign: { ...ctx.memory?.campaign, avatarImages: savedAvatars[0].images, useAvatar: true },
          },
        };
      }

      if (savedAvatars.length > 1) {
        return {
          pauseForUserInput: true,
          memoryUpdate: {
            campaign: { ...ctx.memory?.campaign, savedAvatarsChoice: savedAvatars },
          },
          visible: [{
            type: "choice_questionnaire",
            questionId: "avatar_reuse",
            content: {
              title: "Which model?",
              question: "You've got saved AI models — want to shoot with one of them, or create a new one? (You can also just say \"use @Name\" next time.)",
              options: [
                ...savedAvatars.map((a) => ({ id: a.id, label: a.name, description: "Saved model" })),
                { id: "__new__", label: "Create a new one", description: "Cast a fresh model for this shoot." },
              ],
            },
          }],
          // Deterministic resume — the answer only updates memory, this queued
          // task actually continues the shoot once it's answered.
          nextTasks: [{ id: "resume_shoot_planner_after_avatar_choice", tool: "shoot_engine_planner" as any, input: {} }],
        };
      }

      return {
        visible: [{ type: "status", content: "Let's create your AI models first — then we'll shoot with them." }],
        memoryUpdate: { campaign: { ...ctx.memory?.campaign, avatarForShoot: true } },
        nextTasks: [
          { id: "gen_avatars", tool: "avatar_generator" as any, input: {} },
          { id: "resume_shoot_planner", tool: "shoot_engine_planner" as any, input: {} },
        ],
      };
    }

    // ── Asset verification: a memory reference isn't proof the R2 object still
    // exists (e.g. stale DB rows from a wiped local bucket). Check before handing
    // off to generation rather than let SimpleShootEngine silently fall back to a
    // referenceless shoot — if nothing resolves, ask again instead.
    const assetIds: string[] = ctx.memory?.product?.assetIds?.length
      ? ctx.memory.product.assetIds
      : ctx.memory?.product?.primaryAssetId
        ? [ctx.memory.product.primaryAssetId]
        : [];

    if (assetIds.length > 0 && !(await this.anyAssetExists(assetIds))) {
      console.warn("[SimpleShootPlannerTool] None of the referenced assets exist in R2 — re-asking:", assetIds);
      return this.askForAssets(projectId, ctx, assetIds);
    }

    // ── Gate 4: confirm assets + shot count — ALWAYS ask, every time, even within
    // an already-running session. `answeredQuestions` never clears (it's a
    // lifetime log), so it can't gate a "confirm this every request" step —
    // `shootConfirmed` is a resettable flag instead (cleared once the shoot job
    // actually finishes, alongside shootEngineQueued). Without this, a second
    // "make me a shoot" later in the same session would silently reuse whatever
    // assets/count happened to be in memory from the first one, with zero
    // generation actually starting before the user has seen or confirmed them.
    if (!ctx.memory?.campaign?.shootConfirmed) {
      const assetLabels = assetIds.length > 0 ? await this.describeAssets(assetIds) : [];
      const usingText = assetLabels.length > 0
        ? `Using: ${assetLabels.join(", ")}.`
        : "No product reference — this will be a text-to-image shoot.";

      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "shoot_confirm",
          content: {
            title: "Ready to generate",
            question: `${usingText} How many shots do you want?`,
            options: [
              { id: "1", label: "1 shot" },
              { id: "2", label: "2 shots" },
              { id: "3", label: "3 shots" },
              { id: "change_assets", label: "Use different assets", description: "Pick or upload a different product image" },
            ],
          },
        }],
      };
    }

    // ── All gates cleared: build query and queue simple_shoot_engine ──────────
    const briefParts = [
      ctx.memory?.campaign?.shootBrief,
      ctx.memory?.creative?.story,
      useAvatar ? "Include the AI model wearing/using the product." : "",
      input.message,
    ].filter(Boolean);
    const query = briefParts.join(". ") || "Professional product photoshoot";

    const resolvedProjectId = projectId || input.projectId || "default";
    const userId = ctx.userId || "anon";
    const count = ctx.memory?.campaign?.shootCount ?? 1;
    const vibeChoice = ctx.memory?.campaign?.vibeChoice;
    const vibeImageUrl = vibeChoice && typeof vibeChoice === "object" ? vibeChoice.imageUrl : undefined;

    return {
      visible: [{
        type: "status",
        content: `Shoot ready — generating${useAvatar ? " with your AI model" : ""}...`,
      }],
      memoryUpdate: { campaign: { ...ctx.memory?.campaign, shootEngineQueued: true } },
      nextTasks: [{
        id: `simple_shoot_engine_${Date.now()}`,
        tool: "simple_shoot_engine" as any,
        input: {
          query, assetIds, projectId: resolvedProjectId, userId, count,
          // Cast avatar's reference image(s) — without this the engine only
          // gets a text hint ("include the AI model") with nothing to
          // actually render the model's likeness from.
          modelR2Keys: useAvatar
            ? avatarImages.map((a: any) => a.r2Key).filter(Boolean)
            : undefined,
          // Real Pinterest reference the user picked in the vibe-picker gate —
          // fed to the Creative Director as an actual mood image, not just the
          // text description already folded into shootBrief above.
          vibeImageUrl,
        },
      }],
    };
  }

  // Query for the vibe-picker's live Pinterest search. When a story/creative
  // direction already exists (StorytellerTool ran first), its background_queries
  // (pure setting/atmosphere — "summer evening nyc rooftop", no product/garment
  // terms) are what should drive this. Deliberately NOT search_queries — those
  // are StorytellerTool's own internal moodboard-DB lookup field and always
  // include the product type by design, which just re-searches the product
  // itself instead of the shoot's background/setting. Only fall back to a
  // product-description query when there's no story yet (shoot-only flow, no
  // storyteller run this session).
  private buildVibeQuery(ctx: ToolContext, input: any): string {
    const backgroundQueries: string[] = ctx.memory?.creative?.canvasInfo?.moodboard?.background_queries || [];
    if (backgroundQueries.length > 0) {
      return backgroundQueries.slice(0, 2).join(" ").trim();
    }

    const parts = [
      ctx.memory?.product?.name,
      ctx.memory?.product?.tags?.join(" "),
      ctx.memory?.creative?.style?.aesthetic,
      ctx.brandContext?.industry,
      input?.message,
    ].filter(Boolean);
    return parts.join(" ").trim() || "product photography editorial";
  }

  // Saved avatars aren't a separate table — they're privateAssets rows (type:
  // "avatar") that got labeled with a name when the user approved them
  // (AvatarGeneratorTool.finalizeApprovedAvatar). Unlabeled avatar rows are
  // unapproved/rejected generation attempts and are excluded here.
  private async listSavedAvatars(userId: string): Promise<Array<{ id: string; name: string; images: any[] }>> {
    try {
      const db = getDb(this.env.DATABASE_URL);
      const rows = await db.select().from(privateAssets).where(and(
        eq(privateAssets.userId, userId),
        eq(privateAssets.type, "avatar"),
        isNotNull(privateAssets.label),
      )).orderBy(desc(privateAssets.createdAt));

      // Permanent proxy URL, not a signed one — a 2-hour signed URL goes dead
      // (broken image icon) the moment a user takes longer than that to answer
      // the "which model?" picker, or if this list gets cached/reused anywhere
      // client-side. Generation itself uses r2Key directly, not this URL — it's
      // display-only, same fix as GET /assets/avatars.
      return rows.map((r) => ({
        id: r.id,
        name: r.label as string,
        images: [{
          angleId: (r.metadata as any)?.angleId || "front",
          r2Key: r.r2Key,
          signedUrl: `${this.env.API_URL || ""}/assets/download?key=${encodeURIComponent(r.r2Key)}`,
        }],
      }));
    } catch (err) {
      console.warn("[SimpleShootPlannerTool] Failed to load saved avatars:", err);
      return [];
    }
  }

  private async describeAssets(assetIds: string[]): Promise<string[]> {
    try {
      const db = getDb(this.env.DATABASE_URL);
      const [publicRows, privateRows] = await Promise.all([
        db.select().from(assets).where(inArray(assets.id, assetIds)),
        db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds)),
      ]);
      return [...publicRows, ...privateRows].map(
        (a: any) => a.parsedData?.name || a.type || "product image"
      );
    } catch (err) {
      console.warn("[SimpleShootPlannerTool] Failed to describe assets:", err);
      return [];
    }
  }

  // Checks whether at least one of the given asset ids still has a real R2 object
  // behind it. Cheap — HEAD only, no body download.
  private async anyAssetExists(assetIds: string[]): Promise<boolean> {
    try {
      const db = getDb(this.env.DATABASE_URL);
      const [publicRows, privateRows] = await Promise.all([
        db.select().from(assets).where(inArray(assets.id, assetIds)),
        db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds)),
      ]);
      const r2Keys = [...publicRows.map((a) => a.url), ...privateRows.map((a) => a.r2Key)];

      const heads = await Promise.all(r2Keys.map((key) => this.env.ASSETS_BUCKET.head(key)));
      return heads.some((h) => h !== null);
    } catch (err) {
      // Non-fatal — if the check itself fails, don't block the shoot over it.
      console.warn("[SimpleShootPlannerTool] Asset existence check failed, proceeding anyway:", err);
      return true;
    }
  }

  private async askForAssets(projectId: string | undefined, ctx: ToolContext, excludeIds: string[] = []): Promise<ToolResponse> {
    let existingAssets: AssetOption[] = [];

    if (projectId) {
      try {
        const db = getDb(this.env.DATABASE_URL);
        const rows = await db
          .select()
          .from(assets)
          .where(eq(assets.projectId, projectId))
          .orderBy(desc(assets.createdAt))
          .limit(5 + excludeIds.length);
        existingAssets = rows
          .filter((a) => !excludeIds.includes(a.id))
          .slice(0, 5)
          .map((a) => ({
            id: a.id,
            label: (a.parsedData as any)?.name || a.type || "Uploaded asset",
            description: Array.isArray(a.tags) && a.tags.length ? (a.tags as string[]).join(", ") : undefined,
          }));
      } catch (err) {
        // Non-fatal — fall through to the plain upload/describe prompt.
        console.warn("[SimpleShootPlannerTool] Failed to load existing project assets:", err);
      }
    }

    // Existing assets are a real choice worth buttons for (which one?).
    if (existingAssets.length > 0) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "asset_selection",
          content: {
            title: "Which product?",
            question: excludeIds.length > 0
              ? "That asset couldn't be found — want to use a different one, or add a new one?"
              : "Want to use one of your existing assets, or add a new one?",
            options: [
              ...existingAssets.map((a) => ({ id: a.id, label: a.label, description: a.description })),
              { id: UPLOAD_NEW_OPTION_ID, label: "Upload something new", description: "Share a new product photo." },
            ],
          },
        }],
      };
    }

    // No existing assets — nothing to actually choose between, so don't gate
    // this behind a button. Uploading is just the user's turn to act (via the
    // input's own upload control); a plain prompt covers it, and they can
    // reply with a description instead if they don't have a photo.
    return {
      memoryUpdate: { campaign: { ...ctx.memory?.campaign, awaitingProduct: true } },
      visible: [{
        type: "chat_text",
        ai: excludeIds.length > 0
          ? "That asset couldn't be found — go ahead and upload your product image, or describe it here if you don't have one handy."
          : "I need a product image to generate the shoot — go ahead and upload one, or just describe it here if you don't have a photo handy.",
      }],
    };
  }
}
