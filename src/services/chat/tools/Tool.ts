import { ToolResponse } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";

export interface ToolContext {
  memory: any;
  brandContext: any;
  history: any[];
  attachments?: any[];
  userId?: string;
  sessionId?: string;
  textService: TextService;
}

export interface Tool {
  name: string;
  description: string;
  // One-line routing hint for the IntentEngine: WHEN to pick this tool over
  // alternatives. Simple, unambiguous primitives can rely on `description` alone.
  whenToUse?: string;
  // Cross-tool sequencing/deprecation/auto-chaining caveats relevant only to
  // routing — kept next to the tool's implementation instead of a separate
  // hand-maintained prompt file, so it can't drift from the tool's real behavior.
  routingNotes?: string;
  run(input: any, ctx: ToolContext): Promise<ToolResponse>;
}
