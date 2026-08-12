import { Tool, ToolContext } from "../../services/chat/tools/Tool";
import { ToolResponse } from "../../types/chat";
// @ts-ignore — text module via wrangler rules
import generateTextSkillRaw from "../skills/generate-text.md";
import { parseSkill } from "../skills/loadSkill";

const GENERATE_TEXT_SKILL = parseSkill(generateTextSkillRaw);

export interface GenerateTextInput {
  prompt: string;
  systemInstruction?: string;
  json?: boolean;
  temperature?: number;
  model?: string;
}

/**
 * Generic single-shot text generation primitive. Unlike StorytellerTool/CreativeStudioTool
 * (which own a specific prompt + memory contract), this is the raw building block agents
 * reach for when they just need an LLM call — copywriting, captions, summaries, JSON extraction.
 */
export class GenerateTextTool implements Tool {
  name = "generate_text";
  description =
    "Generates free-form or JSON text from a prompt using the LLM.";
  whenToUse = GENERATE_TEXT_SKILL.whenToUse;
  routingNotes = GENERATE_TEXT_SKILL.routingNotes;

  async run(input: GenerateTextInput, ctx: ToolContext): Promise<ToolResponse> {
    if (!input?.prompt) {
      return { visible: [{ type: "error", message: "generate_text requires a prompt." }] };
    }

    const text = await ctx.textService.generateText({
      model: input.model || "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      systemInstruction: input.systemInstruction,
      generationConfig: {
        temperature: input.temperature ?? 0.4,
        responseMimeType: input.json ? "application/json" : "text/plain",
      },
    });

    return { visible: [], hidden: { text } };
  }
}
