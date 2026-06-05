import { ToolRegistry } from "./ToolRegistry";
import { ToolCatalog } from "./ToolCatalog";
import { StorytellerTool } from "./tools/StorytellerTool";
import { CreativeStudioTool } from "./tools/CreativeStudioTool";
import { PhotoshootPlannerTool } from "./tools/PhotoshootPlannerTool";
import { PhotoshootGeneratorTool } from "./tools/PhotoshootGeneratorTool";
import { AvatarGeneratorTool } from "./tools/AvatarGeneratorTool";
import { MemoryRecallTool } from "./tools/MemoryRecallTool";
import { Tool, ToolContext } from "./tools/Tool";
import { ToolResponse } from "../../types/chat";
import { TextService } from "../gemini/TextService";

/**
 * A stub tool for capabilities handled by async queues rather than direct execution.
 */
class QueueTool implements Tool {
  constructor(public name: string, public description: string) {}
  async run(_input: any, _ctx: ToolContext): Promise<ToolResponse> {
    throw new Error(`Tool ${this.name} is handled via queue, not direct execution.`);
  }
}

export function getStandardToolCatalog(env: any, textService?: TextService): ToolCatalog {
  const registry = new ToolRegistry()
    .register(new MemoryRecallTool(env))
    .register(new StorytellerTool(textService || env, textService ? env : undefined))
    .register(new CreativeStudioTool(textService || env, textService ? env : undefined))
    .register(new PhotoshootPlannerTool(textService || env, textService ? env : undefined))
    .register(new PhotoshootGeneratorTool(env, textService))
    .register(new AvatarGeneratorTool(textService || env, textService ? env : undefined))
    // Tools that exist in the prompt but are handled by external queues
    .register(new QueueTool("video_generator", "Generates motion and video content from visual assets."))
    .register(new QueueTool("instapost_generator", "Creates social media posts and captions for Instagram."))
    .register(new QueueTool("pinterest_style_analyser", "Analyses visual references and styles from Pinterest-like moodboards."));

  return new ToolCatalog(registry);
}
