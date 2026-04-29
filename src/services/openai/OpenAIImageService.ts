import { OpenAIConnector, OpenAIImageOptions } from "../connectors/OpenAIConnector";

export class OpenAIImageService {
  private connector: OpenAIConnector;

  constructor(apiKey: string) {
    this.connector = new OpenAIConnector(apiKey);
  }

  /**
   * Simple wrapper to generate images and return them as base64 strings.
   */
  async generate(prompt: string, options: OpenAIImageOptions = {}): Promise<string[]> {
    const result = await this.connector.generateImage(prompt, {
      ...options,
    });

    return result.data
      .map(img => img.b64_json)
      .filter((b64): b64 is string => !!b64);
  }

  /**
   * Conversational image generation using the Responses API.
   */
  async chatGenerate(prompt: string, previousResponseId?: string): Promise<{ images: string[], responseId: string }> {
    const response = await this.connector.createResponse({
      input: prompt,
      previous_response_id: previousResponseId,
      tools: [{ type: "image_generation", action: "generate" }]
    });

    const images = response.output
      .filter((o: any) => o.type === "image_generation_call")
      .map((o: any) => o.result);

    return {
      images,
      responseId: response.id
    };
  }

  /**
   * Edit an existing image or use it as a reference.
   */
  async edit(prompt: string, imageBase64: string, options: OpenAIImageOptions = {}): Promise<string[]> {
    const imageBuffer = this.connector.base64ToBuffer(imageBase64);
    
    const result = await this.connector.editImage(prompt, {
      ...options,
      image: imageBuffer,
    });

    return result.data
      .map(img => img.b64_json)
      .filter((b64): b64 is string => !!b64);
  }

  /**
   * Generate an image using a reference image (Identity Preservation).
   * For gpt-image-2, this is often done via the edit endpoint but with a focus on the prompt.
   */
  async generateWithReference(prompt: string, referenceImageBase64: string, options: OpenAIImageOptions = {}): Promise<string[]> {
    return this.edit(prompt, referenceImageBase64, options);
  }
}
