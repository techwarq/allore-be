import { Tool, ToolContext } from "../../services/chat/tools/Tool";
import { ToolResponse } from "../../types/chat";
import { SimpleShootPlannerTool } from "../../services/chat/tools/SimpleShootPlannerTool";
import { ShootEngine, ShootEnv } from "../../services/shoots/ShootEngine";
import { ShootEngineInput } from "../../types/shoots";
// @ts-ignore — text module via wrangler rules
import shootEnginePlannerSkillRaw from "../skills/shoot-engine-planner.md";
import { parseSkill } from "../skills/loadSkill";

const SHOOT_ENGINE_PLANNER_SKILL = parseSkill(shootEnginePlannerSkillRaw);

type StreamFn = (event: object) => Promise<void>;

export interface PhotoshootAgentEnv extends ShootEnv {
  // Credit-saving switch — "false" stops ShootEngine short of the actual image
  // API call; it still streams a `prompt` event per shot for review.
  PHOTOSHOOT_IMAGE_GEN_ENABLED?: string;
}

/**
 * Unifies the two halves of the photoshoot pipeline behind one agent surface:
 * - plan/gate (SimpleShootPlannerTool) — asset + model-preference + shoot-brief
 *   gating, runs inside the DO's sync tool step and queues the generation work
 *   ("simple_shoot_engine", handled by SimpleShootEngine via the queue consumer).
 * - run (ShootEngine) — the older, forensics-driven full pipeline. Still available
 *   here for direct/bypass use by other agents, but no longer what the chat
 *   planner reaches for by default.
 *
 * `name` is "shoot_engine_planner", not "photoshoot_agent" — that's the literal
 * tool name baked into the planner prompt (prompts/intent.ts) and every chain
 * that hands off to this capability (AvatarGeneratorTool's resume step, this
 * tool's own avatar-gate resume step). Keeping this agent's identity aligned
 * with that string is what makes it the single object driving both the catalog
 * description (what the planner is told this can do) and execution (what
 * actually runs) — register this instead of the planner tool directly in
 * StandardTools.ts, or the two can drift out of sync.
 */
export class PhotoshootAgent implements Tool {
  name = "shoot_engine_planner";
  description =
    "Plans and generates a product photoshoot: gates on product assets (offers existing project assets or upload), model preference (AI avatars or product-only), and the creative brief (mood/setting/vibe), then generates the shots via a lightweight creative-direction + Seedream pipeline.";
  whenToUse = SHOOT_ENGINE_PLANNER_SKILL.whenToUse;
  routingNotes = SHOOT_ENGINE_PLANNER_SKILL.routingNotes;

  private planner: SimpleShootPlannerTool;

  constructor(private env: PhotoshootAgentEnv) {
    this.planner = new SimpleShootPlannerTool(env);
  }

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    return this.planner.run(input, ctx);
  }

  /**
   * Directly executes the OLDER forensics-driven shoot pipeline (bypasses the
   * queue). Caller is responsible for streaming/persisting events via `onEvent`.
   * `input.dryRun`, when explicitly set, always wins over the env default.
   */
  async runPipeline(input: ShootEngineInput, onEvent: StreamFn): Promise<void> {
    const engine = new ShootEngine(this.env);
    const dryRun = input.dryRun ?? (this.env.PHOTOSHOOT_IMAGE_GEN_ENABLED === "false");
    await engine.run({ ...input, dryRun }, onEvent);
  }
}
