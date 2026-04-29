import { BaseGeminiService } from "./BaseService";

export interface ImageGenerationOptions {
  sampleCount?: number;
  aspectRatio?: "1:1" | "9:16" | "16:9" | "4:3" | "3:4";
  model?: string;
  outputMimeType?: "image/png" | "image/jpeg";
}

export class ImageService extends BaseGeminiService {
  /**
   * Generates images based on a text prompt using the Nano Banana (Gemini Native) pipeline.
   */
  async generateImage(prompt: string, options: ImageGenerationOptions = {}): Promise<string[]> {
    const model = options.model || "gemini-3.1-flash-image-preview";
    const url = `${this.getBaseUrl("v1beta")}/${model}:generateContent?key=${this.apiKey}`;

    const body = {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: options.aspectRatio || "1:1",
          imageSize: "1K"
        }
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini Image Error (${url}): ${error}`);
    }

    const json: any = await response.json();
    const images: string[] = [];

    if (json.candidates?.[0]?.content?.parts) {
      for (const part of json.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          images.push(part.inlineData.data);
        }
      }
    }

    return images;
  }
}
