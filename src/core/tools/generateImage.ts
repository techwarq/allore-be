import { Tool, ToolContext } from "../../services/chat/tools/Tool";
import { ToolResponse } from "../../types/chat";
import { ImageService } from "../../services/gemini/ImageService";
import { convertGeminiImagesToStorage } from "../../services/image-storage.helper";
import { getDb } from "../../db";

export interface GenerateImageInput {
  prompt: string;
  aspectRatio?: "1:1" | "9:16" | "16:9" | "4:3" | "3:4";
  count?: number;
}

export interface GenerateImageEnv {
  GEMINI_API_KEY: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  DATABASE_URL: string;
  ASSETS_BUCKET: R2Bucket;
  // Credit-saving switch — "false" stops short of the actual Gemini call and
  // streams the prompt back for review instead.
  IMAGE_GEN_ENABLED?: string;
}

/**
 * Standalone image generation primitive — for one-off image needs outside the
 * full photoshoot pipeline (ShootEngine). Generates via Gemini, then persists
 * to R2/private_assets the same way the shoot pipeline does.
 */
export class GenerateImageTool implements Tool {
  name = "generate_image";
  description =
    "Generates one or more images from a text prompt and stores them, returning signed URLs. Use for standalone image needs — not for full campaign photoshoots (use shoot_engine_planner for that).";

  private imageService: ImageService;

  constructor(private env: GenerateImageEnv) {
    this.imageService = new ImageService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async run(input: GenerateImageInput, ctx: ToolContext): Promise<ToolResponse> {
    if (!input?.prompt) {
      return { visible: [{ type: "error", message: "generate_image requires a prompt." }] };
    }

    if (this.env.IMAGE_GEN_ENABLED === "false") {
      return {
        visible: [{
          type: "chat_text",
          ai: `Image generation is paused to save credits — here's the prompt for review:\n\n"${input.prompt}"`,
          info: { prompt: input.prompt, aspectRatio: input.aspectRatio, count: input.count },
        }],
      };
    }

    const base64Images = await this.imageService.generateImage(input.prompt, {
      aspectRatio: input.aspectRatio,
      sampleCount: input.count,
    });

    if (!base64Images.length) {
      return { visible: [{ type: "error", message: "Image generation returned no results." }] };
    }

    const db = getDb(this.env.DATABASE_URL);
    const stored = await convertGeminiImagesToStorage(
      base64Images.map((data) => ({ mimeType: "image/png", data })),
      {
        filenamePrefix: "generated",
        userId: ctx.userId ?? "anon",
        projectId: ctx.memory?.projectId,
        db,
        bucket: this.env.ASSETS_BUCKET,
        metadata: { prompt: input.prompt },
      }
    );

    return {
      visible: [{ type: "shoot_images", items: stored.map((s) => ({ url: s.signedUrl })) }],
      hidden: { images: stored },
    };
  }
}
