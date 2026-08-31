import { ToolResponse } from "../../../types/chat";
import { ITextService } from "../ITextService";

export interface ToolContext {
  memory: any;
  brandContext: any;
  history: any[];
  attachments?: any[];
  userId?: string;
  sessionId?: string;
  // Provider-agnostic text engine (currently OpenRouter qwen, injected by the
  // Orchestrator). Only generateText() is guaranteed — image generation is not
  // available here.
  textService: ITextService;
}

export interface Tool {
  name: string;
  description: string;
  run(input: any, ctx: ToolContext): Promise<ToolResponse>;
}
