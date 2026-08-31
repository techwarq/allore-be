import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { ITextService } from "../ITextService";
import { StorytellingEngineService } from "../../storytellingEngine.service";
import { AssetSearchService } from "../../assetSearch.service";
import { getDb } from "../../../db";
import { privateAssets } from "../../../db/schema";
import { inArray } from "drizzle-orm";

// ─── Prompt builder — conditional on whether product is already locked ────────
function buildSystemPrompt(productLocked: boolean): string {
  const questionnaireRule = productLocked
    ? `CRITICAL: Do NOT include a questionnaire in your output under any circumstance.
The product and brand context are already confirmed. Your only job is the narrative.
Do NOT ask questions. Do NOT request more information.`
    : `ONLY include a questionnaire if product information is genuinely missing from the payload.
If product data is present, do not ask for it again.
The questionnaire MUST follow the exact structure in the output format.`;

  return `
You are the Storytelling Engine of Allore AI.

Allore AI believes:
→ People don't buy products, they buy stories
→ Every brand must have a clear narrative, emotional hook, and visual world
→ Outputs must feel like a real creative strategist, not generic AI

---

## Your Role

You are given:
1. Brand context (tone, audience, positioning)
2. Product information
3. Retrieved storytelling patterns (from vector database)
4. userBrief — the user's OWN stated direction for this story, when they gave one
5. userContext — free-text notes the user gave when they otherwise delegated the
   story to you: target audience, campaign goal, mood/tone words, and/or anything
   they explicitly want included or avoided. May be absent (they skipped it).

Your job is to:
- Synthesize all inputs
- Create ONE cohesive brand narrative system
- Translate that into marketing + visual directions

CRITICAL: if "userBrief" is present, it is the user's own words about the story/
tone/angle they want — treat it as the source of truth and build the narrative
around it. Do NOT override or "improve" on the direction they actually gave. Only
when userBrief is absent should you develop the direction freely from the product/
brand context alone.

If "userContext" is present, it is real signal, not filler — ground audience framing,
positioning, and any "must include/avoid" constraints in it explicitly. Never
fabricate an audience/goal/mood if userContext or brandProfile already state one.

---

## Thinking Framework (MANDATORY)

Always think in this order:
1. Core Story (emotion + narrative)
2. Brand Strategy (positioning + differentiation)
3. Style (visual identity)
4. Moodboard (reference direction)
5. Execution Ideas (content + ads)

---

## Rules

- Do NOT repeat inputs
- Do NOT output generic marketing lines
- Make it feel intentional and specific to THIS brand — not "elevated" by default
- Every section must connect to the same story
- Use retrieved insights as inspiration, not copy

---

## Moodboard & Visual Match Rules (CRITICAL)

- search_queries MUST be extremely specific to the brand DNA
- If the brand is Urban/Gritty/Rave/Disruptive: include words like "dirty", "raw", "grainy", "high-flash", "motion-blur"
- Always include the product type in search queries (e.g. "baggy hoodie streetwear", "serum bottle macro")

---

## Output Format (STRICT JSON)

{
  "visible": [
    {
      "type": "chat_text",
      "ai": "Full narrative story (emotional, cinematic, brand-defining)"
    },
    {
      "type": "chat_text",
      "info": {
        "branding_strategy": {
          "positioning": "",
          "core_emotion": "",
          "target_perception": "",
          "unique_angle": ""
        },
        "style": {
          "aesthetic": "",
          "lighting": "",
          "color_palette": [],
          "composition": ""
        },
        "moodboard": {
          "keywords": [],
          "search_queries": [],
          "notes": ""
        },
        "execution_blueprint": {
          "photoshoots": [],
          "instagram_posts": [],
          "videos": [],
          "ads": []
        }
      }
    }
  ],
  "hidden": {
    "style_tags": [],
    "narrative_tokens": []
  }
}

---

## Tone

Match THIS brand — do not default to cinematic/intense/luxury language unless the
brand actually is that. A playful, affordable, or everyday-essentials brand should
read warm, direct, or fun instead. The constant across every brand is specificity
and strategic clarity, not a particular register. Sharp and no-fluff always; moody
and cinematic only when the brand calls for it.

## Example Thinking

Bad (any brand): "A premium skincare brand with luxury feel" — generic, could
describe anything.

Good (an intense/premium brand): "A ritual of slowing down — where skincare
becomes a moment of quiet control in a chaotic world."

Good (a playful/affordable brand): "Skincare that doesn't take itself too
seriously — glow without the ritual."

The point in both is specificity to the actual brand, not intensity.

---

${questionnaireRule}

Return ONLY the JSON above. No markdown. No preamble. No extra keys.
`.trim();
}

export class StorytellerTool implements Tool {
  name = "storyteller";
  description =
    "Establishes the brand's core narrative — emotional hook, positioning, and product essence — that every other creative tool builds on. Run this first for any new brand/campaign direction; skip it if a story already exists in memory unless the user explicitly wants to change direction.";
  private textService: ITextService;
  private storytellingEngine: StorytellingEngineService;
  private assetSearchService: AssetSearchService;
  private env: any;

  // Duck-type generateText rather than `instanceof TextService` so an injected
  // non-Gemini engine (OpenRouter qwen, from the Orchestrator) is kept instead
  // of being silently replaced by a Gemini fallback. Note: storytellingEngine
  // below is Qdrant vector *search* only, not text generation.
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
    this.storytellingEngine = new StorytellingEngineService(
      this.env.GEMINI_API_KEY,
      this.env.VERTEX_PROJECT_ID,
      this.env.VERTEX_LOCATION,
      this.env.QDRANT_URL,
      this.env.QDRANT_API_KEY,
      this.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      this.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
    this.assetSearchService = new AssetSearchService(
      this.env.GEMINI_API_KEY,
      this.env.VERTEX_PROJECT_ID,
      this.env.VERTEX_LOCATION,
      this.env.QDRANT_URL,
      this.env.QDRANT_API_KEY,
      this.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      this.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    const productLocked = ctx.memory?.product?.productLocked === true;

    // ── Gate: never generate a narrative without a real, locked product ──────
    // Responser.resolveAttachments() is the single source of truth for
    // attachments — by the time this runs it has already checked: this turn's
    // attachments → memory → DB. If productLocked is still false here, nothing
    // exists anywhere yet, so we must not proceed no matter how many turns
    // have passed — otherwise this ends up inventing a full brand narrative
    // from an empty product object the moment the user merely picks "Upload
    // an image" (intent, not the actual file) instead of waiting for it.
    if (!productLocked) {
      // They already answered "I'll describe it" — this message IS the
      // description. Capture it and lock, rather than re-asking.
      if (ctx.memory?.campaign?.awaitingProduct && input.message?.trim()) {
        return {
          visible: [{ type: "status", content: "Got it — using your description for the product." }],
          memoryUpdate: {
            product: { ...ctx.memory?.product, source: "describe", description: input.message.trim(), productLocked: true },
            campaign: { ...ctx.memory?.campaign, awaitingProduct: false },
          },
        };
      }

      const alreadyAskedProduct = ctx.memory?.conversation?.answeredQuestions?.includes("product_source");
      if (!alreadyAskedProduct) {
        return {
          pauseForUserInput: true,
          visible: [{
            type: "choice_questionnaire",
            questionId: "product_source",
            content: {
              title: "Let's get your product",
              question: "I couldn't find a product in your project. How would you like to add it?",
              options: [
                { id: "upload", label: "Upload an image", description: "Share a photo of your product." },
                { id: "describe", label: "I'll describe it", description: "Tell me what it looks like." },
              ]
            }
          }]
        };
      }

      // Already asked, still no real product — they picked "upload" but
      // haven't attached anything yet (or "describe" but this message was
      // empty/attachment-only). Wait instead of generating from nothing.
      return {
        visible: [{ type: "chat_text", ai: "Still waiting on that product — go ahead and upload the image, or tell me what it looks like." }],
      };
    }

    // ── Gate: ask for creative direction before inventing one ────────────────
    // Product being locked is not the same as knowing what story to tell.
    // Without this, the tool jumped straight from "product exists" to a full
    // invented narrative (specific mood, setting, tagline language) with zero
    // input from the user on tone/angle — exactly the "didn't even ask first"
    // complaint. Orchestrator.extractAnswer already had working extractors
    // for story_brief_choice/story_brief_custom (creative.userBriefChoice/
    // userBrief) — nothing ever actually asked the question until now.
    const briefChoice = ctx.memory?.creative?.userBriefChoice;
    const answeredBriefChoice = ctx.memory?.conversation?.answeredQuestions?.includes("story_brief_choice");

    if (!briefChoice && !answeredBriefChoice) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "story_brief_choice",
          content: {
            title: "Brand direction",
            question: "Any specific story, tone, or angle you want for this brand — or should I develop one from the product/brand info?",
            options: [
              { id: "ai_decide", label: "Develop it for me", description: "Craft a narrative from the product and brand context." },
              { id: "custom", label: "I'll describe it", description: "Tell me the story, tone, or angle you want." },
            ]
          }
        }]
      };
    }

    const answeredBriefCustom = ctx.memory?.conversation?.answeredQuestions?.includes("story_brief_custom");
    if (briefChoice === "custom" && !ctx.memory?.creative?.userBrief && !answeredBriefCustom) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "story_brief_custom",
          content: {
            title: "Describe the direction",
            question: "What story, tone, or angle do you want for this brand?",
            options: []
          }
        }]
      };
    }

    // ── Gate: even when delegated ("Develop it for me"), still gather the few
    // things that actually change the narrative before inventing one from
    // nothing but the product/brand payload. Free-text (options: []) so one
    // reply can cover all of it — "skip" is a legitimate answer, not a retry
    // loop, so this only ever gates on answeredQuestions, never on the value.
    const answeredContextGate = ctx.memory?.conversation?.answeredQuestions?.includes("story_context_gate");
    if (briefChoice === "ai_decide" && !answeredContextGate) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "story_context_gate",
          content: {
            title: "A few quick things",
            question: "Before I write this — who's it for (audience), what's the goal (launch, awareness, a sale, evergreen content), a couple of mood/tone words, and anything you definitely want included or avoided? Answer what you know, or just say \"skip\".",
            options: []
          }
        }]
      };
    }

    // ── Qdrant search — use brand DNA, not raw message ────────────────────
    // Raw message ("yes go ahead", "make it urban") produces useless vector hits.
    // Build a semantic query from what we actually know about the brand.
    const searchQuery = [
      ctx.memory?.product?.name,
      ctx.memory?.product?.tags?.join(' '),
      ctx.brandContext?.industry,
      ctx.memory?.creative?.style?.vibe,
      ctx.brandContext?.targetAudience,
    ].filter(Boolean).join(' ') || input.message || "fashion brand narrative";

    let retrievedInsights: string[] = [];
    try {
      const insights = await this.storytellingEngine.search(searchQuery, 5);
      retrievedInsights = insights.map((i: any) => i.payload.text);
    } catch (err) {
      // Non-fatal — proceed without insights if Qdrant is down
      console.error("[StorytellerTool] Qdrant search failed — continuing without insights:", err);
    }

    // ── Build prompt — with hard prohibition since product is locked ───────
    const systemInstruction = buildSystemPrompt(productLocked);

    const promptPayload = {
      userQuery: input.message || "Generate a creative narrative",
      // The user's own stated direction, if they gave one via the brief gate
      // above — ground the narrative in this rather than inventing freely.
      userBrief: ctx.memory?.creative?.userBrief,
      // Audience/goal/mood/must-include-or-avoid gathered via story_context_gate
      // when the user delegated ("Develop it for me") — empty string if skipped.
      userContext: ctx.memory?.creative?.userContext || undefined,
      brandProfile: ctx.brandContext || {},
      product: ctx.memory?.product || {},
      retrievedInsights,
      // Only last 10 turns — not the full history array
      recentHistory: (ctx.history || []).slice(-10),
    };

    // ── Call Gemini ───────────────────────────────────────────────────────
    const responseText = await this.textService.generateText({
      systemInstruction,
      contents: [{ role: "user", parts: [{ text: JSON.stringify(promptPayload) }] }]
    });

    // ── Parse ─────────────────────────────────────────────────────────────
    let parsed: any;
    try {
      const clean = responseText
        .replace(/^```json\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();
      parsed = JSON.parse(clean);
    } catch (err) {
      console.error("[StorytellerTool] JSON parse error. Raw response:", responseText, err);
      throw new Error("Storyteller failed to output valid structured JSON.");
    }

    // ── Strip any questionnaires the LLM hallucinated ─────────────────────
    // The prompt forbids them when productLocked, but Gemini can be inconsistent.
    // This is the safety net — never let a hallucinated question reach the client.
    const visible = (parsed.visible || []).filter((v: any) =>
      productLocked
        ? !(v.type === 'chat_text' && v.questionnaire)
        : true  // not locked — allow questionnaires through (but gate above returns early anyway)
    );

    // ── Moodboard image fetch ─────────────────────────────────────────────
    const searchQueries: string[] = parsed.visible?.[1]?.info?.moodboard?.search_queries || [];
    let moodboardImages: string[] = [];

    if (searchQueries.length > 0) {
      try {
        // Cap at 3 combined queries to avoid over-fetching
        const combinedQuery = searchQueries.slice(0, 3).join(' ');
        const searchResults = await this.assetSearchService.searchPinterestAssets(combinedQuery, 6);
        const assetIds = searchResults.map((r: any) => r.assetId).filter(Boolean);

        if (assetIds.length > 0) {
          const db = getDb(this.env.DATABASE_URL);
          const dbResults = await db.select().from(privateAssets)
            .where(inArray(privateAssets.id, assetIds));

          moodboardImages = searchResults
            .map((qRes: any) => dbResults.find(dbRes => dbRes.id === qRes.assetId))
            .filter((match): match is NonNullable<typeof match> => !!match?.r2Key)
            .map(match =>
              `${this.env.API_URL}/assets/download?key=${encodeURIComponent(match.r2Key)}`
            );

          if (moodboardImages.length > 0) {
            visible.push({
              type: "chat_text",
              info: {
                moodboard: {
                  images: moodboardImages,
                  notes: parsed.visible?.[1]?.info?.moodboard?.notes
                    || "Visual references pulled from the brand database."
                }
              }
            });
          }
        }
      } catch (err) {
        // Non-fatal — narrative is still valid without moodboard images
        console.error("[StorytellerTool] Moodboard fetch failed — continuing without images:", err);
      }
    }

    // ── Return ────────────────────────────────────────────────────────────
    return {
      visible,
      // Single source of truth for memory updates — Responser.handleToolResult merges this
      memoryUpdate: {
        creative: {
          story: parsed.visible?.[0]?.ai || "",
          style: parsed.visible?.[1]?.info?.style || {},
          canvasInfo: parsed.visible?.[1]?.info || {},
          moodboardImages,
        }
      },
      hidden: {
        ...parsed.hidden,
      },
      // nextInput feeds into PhotoshootPlanner and downstream tools
      nextInput: {
        ...input,
        story: parsed.visible?.[0]?.ai || "",
        style: parsed.visible?.[1]?.info?.style || {},
        executionBlueprint: parsed.visible?.[1]?.info?.execution_blueprint || {},
        moodboardImages,
      }
    };
  }
}