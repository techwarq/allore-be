import { BaseGeminiService } from "./BaseService";

export interface VideoGenerationOptions {
  model?: string;
  fps?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
}

export class VideoService extends BaseGeminiService {
  /**
   * Initiates video generation using Vertex AI Veo.
   * Returns an Operation ID because video generation is asynchronous.
   */
  async generateVideo(prompt: string, options: VideoGenerationOptions = {}): Promise<string> {
    const model = options.model || "veo-3.1-generate-001";
    const url = `${this.getBaseUrl()}/${model}:predict?key=${this.apiKey}`;

    const body = {
      instances: [
        {
          prompt: prompt,
        },
      ],
      parameters: {
        aspectRatio: options.aspectRatio || "16:9",
        fps: options.fps || 24
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Gemini Video Error: ${JSON.stringify(error)}`);
    }

    const result: any = await response.json();
    
    // Vertex AI returns an operation for long-running tasks like video gen
    return result.name || result.operationId || "operation-started";
  }

  /**
   * Checks the status of a video generation operation.
   */
  async checkStatus(operationName: string): Promise<any> {
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Gemini Video Status Error: ${JSON.stringify(error)}`);
    }

    return await response.json();
  }
}
