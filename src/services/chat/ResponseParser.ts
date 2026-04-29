import { z } from "zod";

export const IntentTaskSchema = z.object({
  tool: z.string(),
  reason: z.string(),
  id: z.string().optional(),
  input: z.any().optional(),
});

export const IntentPlanSchema = z.object({
  intent: z.string(),
  complexity: z.enum(["low", "high"]),
  story_layer: z.enum(["none", "light", "full"]),
  tasks: z.array(IntentTaskSchema),
  user_visible_response: z.string(),
  hidden_state_update: z.unknown().optional(),
});

export type IntentPlan = z.infer<typeof IntentPlanSchema>;

export class ResponseParser {
  constructor(private knownTools: Set<string>) {}

  parse(raw: string): IntentPlan {
    const json = this.extractJson(raw);
    const parsed = IntentPlanSchema.parse(json); // throws ZodError with path info

    // Validate tool names against the real registry
    for (const task of parsed.tasks) {
      if (!this.knownTools.has(task.tool)) {
        throw new Error(
          `LLM returned unknown tool: "${task.tool}". ` +
          `Known tools: ${[...this.knownTools].join(", ")}`
        );
      }
    }

    return parsed;
  }

  private extractJson(raw: string): unknown {
    // 1. Try the whole string first (fastest path — model returned pure JSON)
    try { return JSON.parse(raw); } catch {}

    // 2. Extract from a \`\`\`json ... \`\`\` block
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch {}
    }

    // 3. Find the outermost { ... } — handles trailing commentary
    const brace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (brace !== -1 && lastBrace > brace) {
      try { return JSON.parse(raw.slice(brace, lastBrace + 1)); } catch {}
    }

    throw new Error(`No parseable JSON found in model response: ${raw.slice(0, 200)}`);
  }
}
