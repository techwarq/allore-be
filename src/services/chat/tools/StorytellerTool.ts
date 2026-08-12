import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { StorytellingEngineService } from "../../storytellingEngine.service";
import { AssetSearchService } from "../../assetSearch.service";
import { getDb } from "../../../db";
import { privateAssets } from "../../../db/schema";
import { inArray } from "drizzle-orm";
// @ts-ignore — text module via wrangler rules
import storytellerSkillRaw from "../../../core/skills/storyteller.md";
import { parseSkill } from "../../../core/skills/loadSkill";

const STORYTELLER_SKILL = parseSkill(storytellerSkillRaw);

// ─── Prompt builder — conditional on whether product is already locked ────────
function buildSystemPrompt(productLocked: boolean, hasUserBrief: boolean): string {
  const questionnaireRule = productLocked
    ? `CRITICAL: Do NOT include a questionnaire in your output under any circumstance.
The product and brand context are already confirmed. Your only job is the narrative.
Do NOT ask questions. Do NOT request more information.`
    : `ONLY include a questionnaire if product information is genuinely missing from the payload.
If product data is present, do not ask for it again.
The questionnaire MUST follow the exact structure in the output format.`;

  const briefRule = hasUserBrief
    ? `CRITICAL: The payload includes "userBrief" — the user's own words on tone, vibe, or references
they want. Treat it as the primary creative direction, not a suggestion to riff past. Every
section (story, style, moodboard) must visibly trace back to what they described.`
    : `No brief was given — the user asked you to propose the direction. Derive it from THIS
brand's specific product, industry, and audience. Do not default to a generic "gritty
streetwear / neon underground / New Noise" aesthetic regardless of category — that same
template showing up for every brand is a failure mode, not a style.`;

  return STORYTELLER_SKILL.body
    .replace("{{briefRule}}", briefRule)
    .replace("{{questionnaireRule}}", questionnaireRule);
}

export class StorytellerTool implements Tool {
  name = "storyteller";
  description =
    "Establishes the brand's core narrative — emotional hook, positioning, and product essence — that every other creative tool builds on.";
  whenToUse = STORYTELLER_SKILL.whenToUse;
  routingNotes = STORYTELLER_SKILL.routingNotes;
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

    // ── Gate: creative brief — ask once before inventing the narrative ──────
    // Without this, the LLM improvises the whole direction from brand context
    // alone every time, which converges on the same default aesthetic regardless
    // of what the user actually wants. "ai_decide" skips straight to generation;
    // "custom" collects a brief that gets woven into the prompt as the primary
    // direction instead of the model's own guess.
    const userBriefChoice = ctx.memory?.creative?.userBriefChoice;
    const answeredBriefChoice = ctx.memory?.conversation?.answeredQuestions?.includes("story_brief_choice");

    if (!userBriefChoice && !answeredBriefChoice) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "story_brief_choice",
          content: {
            title: "Creative direction",
            question: "Do you have a tone, vibe, or story direction in mind for this, or want me to propose one?",
            options: [
              { id: "custom", label: "I have a direction", description: "Tell me the tone, vibe, or references you want." },
              { id: "ai_decide", label: "Suggest one for me", description: "Build the narrative from the brand and product alone." },
            ]
          }
        }]
      };
    }

    const answeredBriefCustom = ctx.memory?.conversation?.answeredQuestions?.includes("story_brief_custom");
    if (userBriefChoice === "custom" && !ctx.memory?.creative?.userBrief && !answeredBriefCustom) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "story_brief_custom",
          content: {
            title: "Tell me the direction",
            question: "What tone, vibe, or references do you want this to lean into?",
            options: []
          }
        }]
      };
    }

    const userBrief = ctx.memory?.creative?.userBrief;

    // ── Qdrant search — use brand DNA, not raw message ────────────────────
    // Raw message ("yes go ahead", "make it urban") produces useless vector hits.
    // Build a semantic query from what we actually know about the brand.
    const searchQuery = [
      ctx.memory?.product?.name,
      ctx.memory?.product?.tags?.join(' '),
      ctx.brandContext?.industry,
      ctx.memory?.creative?.style?.vibe,
      ctx.brandContext?.targetAudience,
      userBrief,
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
    const systemInstruction = buildSystemPrompt(productLocked, !!userBrief);

    const promptPayload = {
      userQuery: input.message || "Generate a creative narrative",
      userBrief: userBrief || undefined,
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