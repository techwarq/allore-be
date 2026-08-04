import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";

export class ShootEngineTool implements Tool {
  name = "shoot_engine_planner";
  description = "Plans and triggers the full campaign photoshoot pipeline using brand story + product assets. Use this for any photoshoot, lookbook, or campaign generation request. Must run after storyteller (or standalone if story is already in memory).";

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    // ── Guard: prevent double-queuing when this re-runs after avatar generation ─
    if (ctx.memory?.campaign?.shootEngineQueued) {
      return { visible: [] };
    }

    // ── Gate 1: need product assets ───────────────────────────────────────────
    const assetIds: string[] = ctx.memory?.product?.assetIds?.length
      ? ctx.memory.product.assetIds
      : ctx.memory?.product?.primaryAssetId
        ? [ctx.memory.product.primaryAssetId]
        : [];

    if (assetIds.length === 0) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "product_source",
          content: {
            title: "Let's get your products",
            question: "I need your product images to generate the campaign shoots. How would you like to add them?",
            options: [
              { id: "upload", label: "Upload images", description: "Share photos of your products." },
              { id: "describe", label: "I'll describe them", description: "Tell me what they look like." },
            ]
          }
        }]
      };
    }

    // ── Gate 2: do they want models / avatars? ────────────────────────────────
    const useAvatar = ctx.memory?.campaign?.useAvatar;
    const answeredAvatarChoice = ctx.memory?.conversation?.answeredQuestions?.includes("avatar_choice");

    if (useAvatar === undefined && !answeredAvatarChoice) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "avatar_choice",
          content: {
            title: "Model Direction",
            question: "Do you want human models (AI avatars) in these shoots, or product-only?",
            options: [
              { id: "use_avatar",    label: "Yes, add AI models",  description: "We'll generate AI avatars styled to your brand." },
              { id: "product_only",  label: "Product only",        description: "Clean product shots — no models." },
            ]
          }
        }]
      };
    }

    // ── Gate 3: avatar requested but not yet generated → generate first ───────
    const avatarImages: any[] = ctx.memory?.campaign?.avatarImages ?? [];
    const hasAvatars = avatarImages.length > 0;

    if (useAvatar && !hasAvatars) {
      return {
        visible: [{
          type: "chat_text",
          status: "Let's create your AI models first — then we'll shoot with them."
        }],
        // avatar_generator chains back to shoot_engine_planner when done.
        // Also queue a resume task so it recovers gracefully if avatar_generator pauses mid-flow.
        nextTasks: [
          { id: "gen_avatars",          tool: "avatar_generator"    as any, input: {} },
          { id: "resume_shoot_planner", tool: "shoot_engine_planner" as any, input: {} },
        ]
      };
    }

    // ── All gates cleared: build intent and queue shoot_engine ────────────────
    const story   = input.story   || ctx.memory?.creative?.story        || "";
    const style   = input.style   || ctx.memory?.creative?.style        || {};
    const message = input.message || "";

    const intentParts: string[] = [];
    if (story) intentParts.push(story.slice(0, 400));
    if (style.aesthetic)          intentParts.push(`Visual style: ${style.aesthetic}`);
    if (style.color_palette?.length) intentParts.push(`Color palette: ${(style.color_palette as string[]).join(", ")}`);
    if (style.lighting)           intentParts.push(`Lighting: ${style.lighting}`);
    if (useAvatar)                intentParts.push("Include human models wearing the product.");
    if (message)                  intentParts.push(message);

    const intent    = intentParts.join(". ") || "Create professional product photoshoots";
    const projectId = ctx.memory?.projectId || input.projectId || "default";
    const userId    = ctx.userId || "anon";

    // Collect avatar R2 keys (all angles) for the ShootEngine to use as model references
    const modelR2Keys: string[] = hasAvatars
      ? avatarImages.map((a: any) => a.r2Key).filter(Boolean)
      : [];

    return {
      visible: [{
        type: "status",
        content: `Campaign ready. Generating ${assetIds.length > 1 ? `${assetIds.length} products'` : "your product's"} photoshoots${hasAvatars ? " with your AI models" : ""}...`
      }],
      // Mark queued so if this tool is called again (resume task) it's a no-op
      memoryUpdate: { campaign: { ...ctx.memory?.campaign, shootEngineQueued: true } },
      nextTasks: [{
        id: `shoot_engine_${Date.now()}`,
        tool: "shoot_engine" as any,
        input: { intent, assetIds, projectId, userId, modelR2Keys }
      }]
    };
  }
}
