import OpenAI from "openai";

export interface OpenAIImageOptions {
  model?: string;
  n?: number;
  quality?: "low" | "medium" | "high" | "auto";
  size?: string;
  response_format?: "url" | "b64_json";
  style?: "vivid" | "natural";
  user?: string;
  output_format?: "png" | "jpeg" | "webp";
  output_compression?: number;
  background?: "opaque" | "transparent" | "auto";
  moderation?: "auto" | "low";
}

export interface OpenAIEditOptions extends OpenAIImageOptions {
  image: string | File | Blob | any; // Could be file path, base64, or stream
  mask?: string | File | Blob | any;
}

export interface OpenAIResponseOptions extends OpenAIImageOptions {
  input: string | any[];
  tools?: any[];
  previous_response_id?: string;
  stream?: boolean;
}

export class OpenAIConnector {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey: apiKey,
    });
  }

  /**
   * Basic Image Generation (Image API)
   */
  async generateImage(prompt: string, options: OpenAIImageOptions = {}) {
    const response = await this.client.images.generate({
      model: options.model || "gpt-image-2",
      prompt,
      n: options.n || 1,
      quality: options.quality || "auto",
      size: (options.size as any) || "auto",
      user: options.user,
      // @ts-ignore - Specific to gpt-image-2
      output_format: options.output_format,
      output_compression: options.output_compression,
    });

    return response;
  }

  /**
   * Image Editing (Image API)
   */
  async editImage(prompt: string, options: OpenAIEditOptions) {
    const response = await this.client.images.edit({
      model: options.model || "gpt-image-2",
      image: options.image,
      mask: options.mask,
      prompt,
      n: options.n || 1,
      size: (options.size as any) || "auto",
      user: options.user,
    });

    return response;
  }

  /**
   * Responses API (Conversational / Tool-based Generation)
   */
  async createResponse(options: OpenAIResponseOptions) {
    // @ts-ignore - responses API might be new and not in types
    const response = await this.client.responses.create({
      model: options.model || "gpt-5.4",
      input: options.input,
      tools: options.tools || [{ type: "image_generation" }],
      previous_response_id: options.previous_response_id,
      stream: options.stream,
      // Pass-through other options if they are supported in the tool config
    });

    return response;
  }

  /**
   * Stream Image Generation
   */
  async *streamImage(prompt: string, options: OpenAIImageOptions & { partial_images?: number } = {}) {
    // @ts-ignore - stream parameter on images.generate might be new
    const stream = await this.client.images.generate({
      model: options.model || "gpt-image-2",
      prompt,
      stream: true,
      partial_images: options.partial_images || 2,
    });

    for await (const event of stream as any) {
      yield event;
    }
  }

  /**
   * Helper to convert base64 to Buffer
   */
  base64ToBuffer(base64: string): Buffer {
    return Buffer.from(base64, "base64");
  }
}
