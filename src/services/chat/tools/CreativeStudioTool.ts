import { Tool, ToolContext } from "./Tool";
import { ToolResponse, ChatEvent } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { ITextService } from "../ITextService";

export class CreativeStudioTool implements Tool {
  name = "creative_studio";
  description =
    "Turns an existing brand story into concrete campaign/marketing direction and strategic recommendations. Requires a locked product (asks for one if missing). Use for 'what should we do' strategy questions, not for inventing the story itself (that's storyteller) or for generating the actual assets.";
  private textService: ITextService;
  private env: any;

  // First arg is either an injected text engine (anything implementing
  // ITextService — currently OpenRouter qwen from the Orchestrator) or, in
  // legacy call sites, the env from which a Gemini fallback is built. Detect by
  // duck-typing generateText rather than `instanceof TextService`, so an
  // injected non-Gemini engine isn't silently discarded and replaced with Gemini.
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
  }

  async run(input: { message: string }, ctx: ToolContext): Promise<ToolResponse> {
    // Product is guaranteed to be in memory if it exists anywhere
    // Responser.resolveAttachments() already checked attachments → memory → DB
    const productLocked = ctx.memory?.product?.productLocked === true;

    // Never proceed without a real, locked product — see StorytellerTool's gate
    // for why (answering "upload" is intent, not the product itself; force-
    // locking on that answer used to let this generate a plan from nothing).
    if (!productLocked) {
      if (ctx.memory?.campaign?.awaitingProduct && input.message?.trim()) {
        return {
          visible: [{ type: "chat_text", ai: "Got it — using your description for the product." }],
          memoryUpdate: {
            product: { ...ctx.memory?.product, source: "describe", description: input.message.trim(), productLocked: true },
            campaign: { ...ctx.memory?.campaign, awaitingProduct: false },
          },
        };
      }

      const alreadyAskedProduct = ctx.memory?.conversation?.answeredQuestions?.includes("product_source");
      if (!alreadyAskedProduct) {
        // Only ask if Responser genuinely found nothing anywhere AND we haven't asked before
        return {
          pauseForUserInput: true,
          visible: [{
            type: "chat_text",
            questionnaire: {
              questionId: "product_source",
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

      return {
        visible: [{ type: "chat_text", ai: "Still waiting on that product — go ahead and upload the image, or tell me what it looks like." }],
      };
    }

    // Product is locked — proceed directly
    // ctx.memory.product has: name, colors, tags, primaryAssetKey, primaryAssetId

    const systemInstruction = `
You are Creative Studio — the Creative Director of Allore AI.

Allore AI believes:
→ Great brands are built on strong stories
→ Every output (shoots, posts, videos) must feel intentional
→ Users often don’t fully know what they need — you guide them

---

## Your Role

You DO NOT generate final content. You ONLY:
1. Understand the user's intent.
2. Ask the right questions (if needed).
3. Design a clear creative plan.
4. Ask for approval before execution.

---

## Question Strategy (STRICT SCHEMA)

- Ask only what is missing. Never ask more than 1–2 questions.
- Use the RICH QUESTIONNAIRE format:
{
  "visible": [
    {
      "type": "chat_text",
      "questionnaire": {
        "title": "...", "question": "...",
        "options": [{ "id": "...", "label": "...", "description": "..." }]
      }
    }
  ]
}

---

## Planning Rules

If clarity is sufficient, return a 'plan':
{
  "visible": [{ "type": "chat_text", "plan": { "summary": "...", "steps": ["..."] } }],
  "hidden": { "executionPlan": [{ "tool": "..." }] }
}

---

## Tone
Sharp, confident, no fluff — but match the brand's own register (playful brands
get playful direction, not forced luxury framing).

Return ONLY JSON.
    `.trim();

    // Only include history turns that actually carry text. A blank/undefined
    // content (e.g. a persisted chat row with empty content, loaded by
    // loadProjectHistory) would serialize to an empty `{}` part, which Gemini
    // rejects with "contents[..].parts[0].data: required oneof field 'data'
    // must have one initialized field" — and is just noise for any provider.
    const contents = ctx.history
      .filter(h => typeof h.content === 'string' && h.content.trim().length > 0)
      .map(h => ({
        role: (h.role === 'user' ? 'user' : 'model') as "user" | "model",
        parts: [{ text: h.content }]
      }));
    contents.push({ role: 'user' as const, parts: [{ text: input.message }] });

    // No model pinned — uses the injected engine's default (OpenRouter qwen).
    const responseText = await this.textService.generateText({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] }
    });

    try {
      const jsonStr = responseText.replace(/^```json/m, '').replace(/```$/m, '').trim();
      const parsedResponse = JSON.parse(jsonStr);

      const memoryUpdate: any = {
        creative: {
          style: parsedResponse.hidden?.style || {}
        }
      };

      if (parsedResponse.hidden?.story) {
        memoryUpdate.creative.story = parsedResponse.hidden.story;
      }

      return {
        visible: parsedResponse.visible || [],
        memoryUpdate,
        hidden: {
          projectId: (ctx as any).projectId || ctx.brandContext?.id || ctx.memory?.projectId,
          activePlan: parsedResponse.visible?.find((v: any) => v.type === 'chat_text' && v.plan)?.plan || null
        }
      };
    } catch (e) {
      console.error("[CreativeStudioTool] Failed to parse JSON:", responseText, e);
      return {
        visible: [{ type: "chat_text", ai: "I'm having trouble formulating a plan. Could you clarify your vision?" }]
      };
    }
  }
}

