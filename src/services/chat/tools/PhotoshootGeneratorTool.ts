import { Tool, ToolContext } from "./Tool";
import { ToolResponse, AvatarImage } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { getDb } from "../../../db";
import { privateAssets } from "../../../db/schema";
import { fetchR2AsBase64, getSignedR2Url, base64ToArrayBuffer } from "../../../lib/r2";

export class PhotoshootGeneratorTool implements Tool {
  name = "photoshoot_generator";
  description = "Generates final high-quality product images based on a photoshoot plan.";
  private textService: TextService;

  constructor(private env: any, textService?: TextService) {
    if (textService) {
      this.textService = textService;
    } else {
      this.textService = new TextService(
        env.GEMINI_API_KEY,
        env.VERTEX_PROJECT_ID,
        env.VERTEX_LOCATION,
        env.VERTEX_SERVICE_ACCOUNT_EMAIL,
        env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
      );
    }
  }

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    const memory = ctx.memory || {};
    const shot = input.shot;
    if (!shot) throw new Error("No specific shot provided for generation.");

    const userId = ctx.userId || ctx.memory?.userId || "anon";
    const projectId = memory.campaign?.projectId || input.projectId || (ctx.brandContext as any)?.id;
    const db = getDb(this.env.DATABASE_URL);

    // ── Fetch reference images from R2 ────────────────────────────────────
    const [garmentBytes, avatarBytes] = await Promise.all([
      // Always fetch the garment — it's the non-negotiable product reference
      memory.product?.primaryAssetKey
        ? fetchR2AsBase64(this.env.ASSETS_BUCKET, memory.product.primaryAssetKey)
        : Promise.resolve(null),

      // Fetch the avatar angle that matches this shot's model_id
      memory.campaign?.useAvatar && memory.campaign?.avatarImages?.length
        ? (() => {
            const avatarImage = memory.campaign.avatarImages.find(
              (a: AvatarImage) => a.angleId === (shot.camera?.angle?.includes('close') ? 'front' : 'front') // simple mapping for now
            ) || memory.campaign.avatarImages[0];
            return fetchR2AsBase64(this.env.ASSETS_BUCKET, avatarImage.r2Key);
          })()
        : Promise.resolve(null),
    ]);

    // ── Build multimodal parts ────────────────────────────────────────────
    const parts: any[] = [
      { text: shot.prompt },
      { text: this.buildShotInstruction(shot, memory) }
    ];

    if (garmentBytes) {
      parts.push({
        inlineData: { mimeType: garmentBytes.mimeType, data: garmentBytes.data }
      });
      parts.push({ text: "PRODUCT REFERENCE: The above image is the EXACT garment. Reproduce it with zero modifications — same color, cut, texture, silhouette. This is non-negotiable." });
    }

    if (avatarBytes) {
      parts.push({
        inlineData: { mimeType: avatarBytes.mimeType, data: avatarBytes.data }
      });
      parts.push({ text: "MODEL REFERENCE: The above image is the exact model/avatar for this shot. Use this person's appearance faithfully." });
    }

    // ── Generate with retry ───────────────────────────────────────────────
    let attempts = 0;
    const maxAttempts = 6;

    while (attempts < maxAttempts) {
      try {
        const response = await this.textService.generate({
          model: "gemini-3.1-flash-image-preview",
          contents: [{ role: "user", parts }],
          config: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "9:16", imageSize: "2K" }
          }
        });

        const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
        if (!part?.inlineData?.data) throw new Error("No image data in response.");

        // ── Store to R2 ──────────────────────────────────────────────────
        const key = `photoshoots/${userId}/${projectId || 'default'}/${Date.now()}-${shot.id}.jpg`;

        await this.env.ASSETS_BUCKET.put(key, base64ToArrayBuffer(part.inlineData.data), {
          httpMetadata: { contentType: part.inlineData.mimeType || "image/jpeg" }
        });

        // ── Generate signed URL ──────────────────────────────────────────
        const signedUrl = await getSignedR2Url(this.env.ASSETS_BUCKET, key, 7200);

        // ── Save to DB ───────────────────────────────────────────────────
        const assetId = crypto.randomUUID();
        await db.insert(privateAssets).values({
          id: assetId,
          userId: userId && userId !== 'anon' ? userId : null,
          projectId: projectId,
          r2Key: key,
          type: "photoshoot",
          metadata: {
            shotId: shot.id,
            concept: shot.concept,
            prompt: shot.prompt
          }
        });

        return {
          visible: [
            { type: "status", content: `Shot ready: "${shot.concept}"` },
            {
              type: "photoshoots",
              items: [{ shotId: shot.id, url: signedUrl, concept: shot.concept }]
            }
          ],
          hidden: {
            generatedAssets: [{ shotId: shot.id, url: signedUrl, key }]
          }
        };

      } catch (err: any) {
        attempts++;
        const isQuota = err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");
        const isTimeout = err.message?.includes("524") || err.message?.includes("TIMEOUT");

        if (attempts >= maxAttempts) {
          return {
            visible: [{
              type: "status",
              content: `Failed "${shot.concept}": ${isQuota ? "quota exceeded" : err.message}`
            }]
          };
        }

        const backoffMs = (isQuota || isTimeout) ? 61000 : Math.pow(2, attempts) * 1000;
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }

    return { visible: [{ type: "status", content: "Generation timed out." }] };
  }

  private buildShotInstruction(shot: any, memory: any): string {
    return [
      `Shot type: ${shot.type}. Concept: ${shot.concept}.`,
      `Scene: ${shot.scene}. Composition: ${shot.composition}.`,
      `Lighting: ${shot.lighting}. Background: ${shot.background}.`,
      `Emotion: ${shot.emotion}. Camera: ${shot.camera?.angle}, ${shot.camera?.lens}.`,
      `Brand story alignment: ${memory.creative?.story?.slice(0, 150) || "premium fashion brand"}.`,
      `CRITICAL: The garment must be shown exactly as in the product reference. No alterations.`
    ].join(" ");
  }
}
