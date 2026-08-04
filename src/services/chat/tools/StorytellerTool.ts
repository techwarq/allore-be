import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
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

Your job is to:
- Synthesize all inputs
- Create ONE cohesive brand narrative system
- Translate that into marketing + visual directions

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
- Make it feel premium, intentional, and specific
- Every section must connect to the same story
- Use retrieved insights as inspiration, not copy

---

## Moodboard & Visual Match Rules (CRITICAL)

- search_queries MUST be extremely specific to the brand DNA — derive the mood words from what THIS
  brand/product/audience actually is, not from a default aesthetic. E.g. Urban/Gritty/Rave/Disruptive ->
  "dirty", "raw", "grainy", "high-flash", "motion-blur"; but a soft/organic skincare brand -> "sun-warmed",
  "airy", "linen", "diffused light"; a playful kids' brand -> "bright", "pastel", "soft-focus", "candid".
  Do not default to dark/moody/gritty language when the brand doesn't call for it.
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
- Cinematic
- Sharp
- Strategic
- No fluff

## Example Thinking

Bad:  "A premium skincare brand with luxury feel"
Good: "A ritual of slowing down — where skincare becomes a moment of quiet control in a chaotic world"

---

${questionnaireRule}

Return ONLY the JSON above. No markdown. No preamble. No extra keys.
`.trim();
}

export class StorytellerTool implements Tool {
  name = "storyteller";
  description =
    "Establishes the brand's core narrative — emotional hook, positioning, and product essence — that every other creative tool builds on. Run this first for any new brand/campaign direction; skip it if a story already exists in memory unless the user explicitly wants to change direction.";
  private textService: TextService;
  private storytellingEngine: StorytellingEngineService;
  private assetSearchService: AssetSearchService;
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
    const alreadyAskedProduct = ctx.memory?.conversation?.answeredQuestions?.includes("product_source");

    // ── Gate: if product not locked AND not already asked, ask once and stop ──
    // Responser.resolveAttachments() is the single source of truth.
    // By the time this runs, it has already checked: this turn's attachments
    // → memory → DB. If productLocked is still false, nothing exists anywhere.
    // Check answeredQuestions to prevent asking the same question repeatedly.
    if (!productLocked && !alreadyAskedProduct) {
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