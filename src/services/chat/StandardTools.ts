import { ToolRegistry } from "./ToolRegistry";
import { ToolCatalog } from "./ToolCatalog";
import { StorytellerTool } from "./tools/StorytellerTool";
import { CreativeStudioTool } from "./tools/CreativeStudioTool";
import { AvatarGeneratorTool } from "./tools/AvatarGeneratorTool";
import { Tool, ToolContext } from "./tools/Tool";
import { ToolResponse } from "../../types/chat";
import { ITextService } from "./ITextService";
import { MemoryTool } from "../../core/tools/memory";
import { GenerateTextTool } from "../../core/tools/generateText";
import { GenerateImageTool } from "../../core/tools/generateImage";
import { SearchTool } from "../../core/tools/search";
import { PhotoshootAgent } from "../../core/agents/PhotoshootAgent";

/**
 * A stub tool for capabilities handled by async queues rather than direct execution.
 */
class QueueTool implements Tool {
  constructor(public name: string, public description: string) {}
  async run(_input: any, _ctx: ToolContext): Promise<ToolResponse> {
    throw new Error(`Tool ${this.name} is handled via queue, not direct execution.`);
  }
}

export function getStandardToolCatalog(env: any, textService?: ITextService): ToolCatalog {
  const registry = new ToolRegistry()
    .register(new MemoryTool(env))
    .register(new StorytellerTool(textService || env, textService ? env : undefined))
    .register(new CreativeStudioTool(textService || env, textService ? env : undefined))
    .register(new PhotoshootAgent(env))
    .register(new AvatarGeneratorTool(textService || env, textService ? env : undefined))
    .register(new GenerateTextTool())
    .register(new GenerateImageTool(env))
    .register(new SearchTool(env))
    // Tools handled by external queues — registered so IntentEngine knows they exist
    .register(new QueueTool("shoot_engine", "Async queue worker running the older forensics-driven ShootEngine pipeline. Not called directly — kept for reference; shoot_engine_planner no longer routes here."))
    .register(new QueueTool("simple_shoot_engine", "Async queue worker that runs SimpleShootEngine (creative direction + Seedream generation). Not called directly — queued by shoot_engine_planner."))
    .register(new QueueTool("video_generator", "Generates motion and video content from visual assets."))
    .register(new QueueTool("instapost_generator", "Creates social media posts and captions for Instagram."))
    .register(new QueueTool("pinterest_style_analyser", "Analyses visual references and styles from Pinterest-like moodboards."));

  return new ToolCatalog(registry);
}
