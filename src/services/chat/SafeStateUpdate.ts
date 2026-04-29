import { z } from "zod";

// Only these paths can be written by the LLM. 
// product.* is never on this list to prevent overwriting Responser's logic.
const SafeStateUpdateSchema = z.object({
  photoshootConfig: z.object({
    useAvatar: z.boolean(),
  }).partial().optional(),
  creative: z.object({
    style: z.object({
      vibe: z.string(),
    }).partial(),
  }).partial().optional(),
  campaign: z.object({
    avatarChoice: z.string(),
    useAvatar: z.boolean(),
  }).partial().optional(),
}).strict(); // .strict() rejects unknown keys entirely

export type SafeStateUpdate = z.infer<typeof SafeStateUpdateSchema>;

export function parseSafeStateUpdate(raw: unknown): SafeStateUpdate | null {
  if (!raw) return null;
  
  // Clean up raw data — sometimes LLM returns extra wrappers
  const data = (raw as any).hidden_state_update || raw;
  
  const result = SafeStateUpdateSchema.safeParse(data);
  if (!result.success) {
    console.warn("[IntentEngine] Rejected unsafe state update:", result.error.flatten());
    return null;
  }
  return result.data;
}
