import { Tool, ToolContext } from "./Tool";
import { ToolResponse, ChatEvent } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
// @ts-ignore — text module via wrangler rules
import creativeStudioSkillRaw from "../../../core/skills/creative-studio.md";
import { parseSkill } from "../../../core/skills/loadSkill";

const CREATIVE_STUDIO_SKILL = parseSkill(creativeStudioSkillRaw);

export class CreativeStudioTool implements Tool {
  name = "creative_studio";
  description =
    "Turns an existing brand story into concrete campaign/marketing direction and strategic recommendations. Requires a locked product (asks for one if missing).";
  whenToUse = CREATIVE_STUDIO_SKILL.whenToUse;
  routingNotes = CREATIVE_STUDIO_SKILL.routingNotes;
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
          type: "chat_text",
          questionnaire: {
            questionId: "product_source",
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

    const systemInstruction = CREATIVE_STUDIO_SKILL.body;

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

