import { Tool, ToolContext } from "./Tool";
import { ToolResponse, ChatEvent } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";

export class CreativeStudioTool implements Tool {
  name = "creative_studio";
  description = "Shaping brand direction, campaign thinking, and high-level creative planning.";
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

  async run(input: { message: string }, ctx: ToolContext): Promise<ToolResponse> {
    // Product is guaranteed to be in memory if it exists anywhere
    // Responser.resolveAttachments() already checked attachments → memory → DB
    const productLocked = ctx.memory?.product?.productLocked === true;
    const alreadyAskedProduct = ctx.memory?.conversation?.answeredQuestions?.includes("product_source");

    if (!productLocked && !alreadyAskedProduct) {
      // Only ask if Responser genuinely found nothing anywhere AND we haven't asked before
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "product_source",
          content: {
            title: "Let's get your product",
            question: "I couldn't find a product in your project. How would you like to add it?",
            options: [
              { id: "uploaded", label: "Upload an image", description: "Share a photo of your product." },
              { id: "describe", label: "I'll describe it", description: "Tell me what it looks like." },
            ]
          }
        }]
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

## Question Strategy (STRICT SCHEMA)

- Ask only what is missing. Never ask more than 1–2 questions.
- Use the RICH QUESTIONNAIRE format:
{
  "visible": [
    {
      "type": "choice_questionnaire",
      "content": {
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
  "visible": [{ "type": "plan", "summary": "...", "steps": ["..."], "needsApproval": true }],
  "hidden": { "executionPlan": [{ "tool": "..." }] }
}

---

## Tone
Sharp, confident, creative. No fluff.

Return ONLY JSON.
    `.trim();

    const contents = ctx.history.map(h => ({
      role: (h.role === 'user' ? 'user' : 'model') as "user" | "model",
      parts: [{ text: h.content }]
    }));
    contents.push({ role: 'user' as const, parts: [{ text: input.message }] });

    const responseText = await this.textService.generateText({
      model: "gemini-3-flash-preview",
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
          activePlan: parsedResponse.visible?.find((v: any) => v.type === 'plan') || null
        }
      };
    } catch (e) {
      console.error("[CreativeStudioTool] Failed to parse JSON:", responseText, e);
      return {
        visible: [{ type: "text", content: "I'm having trouble formulating a plan. Could you clarify your vision?" }]
      };
    }
  }
}

