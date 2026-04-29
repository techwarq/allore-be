import { ToolResponse } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";

export interface ToolContext {
  memory: any;
  brandContext: any;
  history: any[];
  attachments?: any[];
  userId?: string;
  textService: TextService;
}

export interface Tool {
  name: string;
  description: string;
  run(input: any, ctx: ToolContext): Promise<ToolResponse>;
}
