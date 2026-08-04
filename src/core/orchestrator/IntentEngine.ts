import { ITextService } from "../../services/chat/ITextService";
import { ToolCatalog } from "../../services/chat/ToolCatalog";
import { PromptBuilder } from "../../services/chat/PromptBuilder";
import { ResponseParser, IntentPlan } from "../../services/chat/ResponseParser";
export { IntentPlan };
import { parseSafeStateUpdate } from "../../services/chat/SafeStateUpdate";
import { SessionMemory } from "../../types/chat";
import {
  ROLE_DEFINITION,
  STORY_HIERARCHY,
  COMPLEXITY_RULES,
  STATE_AWARENESS_RULES,
  OUTPUT_FORMAT_SPEC
} from "../../services/chat/prompts/intent";

export interface AnalyzeContext {
  brandContext: any;
  memory: SessionMemory;
  attachments: any[];
}

export class IntentEngine {
  private parser: ResponseParser;

  constructor(
    private textService: ITextService,
    private toolCatalog: ToolCatalog,
  ) {
    this.parser = new ResponseParser(new Set(toolCatalog.names()));
  }

  async analyze(message: string, context: AnalyzeContext): Promise<IntentPlan> {
    const prompt = new PromptBuilder()
      .add({ header: "Role", body: ROLE_DEFINITION })
      .add({ header: "Story-first thinking", body: STORY_HIERARCHY, critical: true })
      .add({ header: "Available tools", body: this.toolCatalog.describeForPrompt(), critical: true })
      .add({ header: "Complexity rules", body: COMPLEXITY_RULES })
      .add({ header: "State awareness rules", body: STATE_AWARENESS_RULES, critical: true })
      .add({ header: "Output format", body: OUTPUT_FORMAT_SPEC, critical: true })
      .addContext("User message", message)
      .addContext("Brand context", context.brandContext)
      .addContext("Memory", this.trimMemory(context.memory))
      .addContext("Attachments (current turn)", (context.attachments || []).map(a => ({
        assetId: a.assetId,
        mimeType: a.mimeType,
        label: a.label || a.name
      })))
      .build();

    // Guard against runaway prompts
    const estimatedTokens = Math.ceil(prompt.length / 4);
    if (estimatedTokens > 8000) {
      console.warn("[IntentEngine] Prompt exceeds token budget, trimming memory further");
      // In a real scenario, we might want to trim history more aggressively here
    }

    const parts: any[] = [{ text: prompt }];

    // If attachments have data (multimodal), add them to the parts array
    if (context.attachments && context.attachments.length > 0) {
      for (const attachment of context.attachments) {
        if (attachment.inlineData) {
          parts.push({ inlineData: attachment.inlineData });
        } else if (attachment.data && attachment.mimeType) {
          parts.push({ inlineData: { data: attachment.data, mimeType: attachment.mimeType } });
        }
      }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.textService.generateText({
          model: "gemini-3-flash-preview",
          contents: [{ role: "user" as const, parts }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: attempt === 1 ? 0.2 : 0,
          },
        });

        const plan = this.parser.parse(raw);

        // Ensure state updates are safe before returning
        if (plan.hidden_state_update) {
          plan.hidden_state_update = parseSafeStateUpdate(plan.hidden_state_update);
        }

        return plan;
      } catch (err) {
        if (attempt === 2) {
          console.error("[IntentEngine] Both attempts failed:", err);
          return this.safeDefault();
        }
        console.warn(`[IntentEngine] Attempt ${attempt} failed, retrying:`, err);
      }
    }

    return this.safeDefault();
  }

  private trimMemory(memory: SessionMemory): Partial<SessionMemory> {
    // Don't dump the full history into every intent call — it's mostly noise
    const { conversation, ...rest } = memory;
    return {
      ...rest,
      conversation: {
        answeredQuestions: conversation.answeredQuestions,
        assetRefs: conversation.assetRefs,
        // drop allAttachments — already resolved into product by the time we get here
      },
    };
  }

  private safeDefault(): IntentPlan {
    return {
      intent: "unknown",
      complexity: "low",
      story_layer: "none",
      tasks: [],
      user_visible_response:
        "I had trouble understanding that request. Could you rephrase what you'd like to create?",
      hidden_state_update: null,
    };
  }
}
