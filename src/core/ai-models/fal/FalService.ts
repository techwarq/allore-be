const QUEUE_BASE = "https://queue.fal.run";

export const FAL_MODELS = {
  FLUX_SCHNELL: "fal-ai/flux/schnell",
  SEEDREAM_V5: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
  SEEDREAM_V5_EDIT: "fal-ai/bytedance/seedream/v5/lite/edit",
} as const;

const DEFAULT_IMAGE_MODEL = FAL_MODELS.FLUX_SCHNELL;

export interface FalSubscribeOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface FalGenerateImageOptions {
  model?: string;
  imageSize?: string;
  numImages?: number;
  [key: string]: any;
}

/**
 * Client for fal.ai's queue-based Model APIs, implemented over raw fetch since the
 * official fal-client Node SDK isn't Workers-compatible. `subscribe()` mirrors what
 * fal_client.subscribe() does: submit, poll status, fetch the result.
 */
export class FalService {
  constructor(private apiKey: string) {}

  async submit(
    model: string,
    input: Record<string, any>
  ): Promise<{ requestId: string; statusUrl: string; responseUrl: string }> {
    const res = await fetch(`${QUEUE_BASE}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      throw new Error(`Fal Submit Error (${model}): ${await res.text()}`);
    }

    const json: any = await res.json();
    return { requestId: json.request_id, statusUrl: json.status_url, responseUrl: json.response_url };
  }

  async status(statusUrl: string): Promise<{ status: string; queuePosition?: number }> {
    const res = await fetch(statusUrl, { headers: { Authorization: `Key ${this.apiKey}` } });
    if (!res.ok) throw new Error(`Fal Status Error: ${await res.text()}`);
    const json: any = await res.json();
    return { status: json.status, queuePosition: json.queue_position };
  }

  async result<T = any>(responseUrl: string): Promise<T> {
    const res = await fetch(responseUrl, { headers: { Authorization: `Key ${this.apiKey}` } });
    if (!res.ok) throw new Error(`Fal Result Error: ${await res.text()}`);
    return res.json();
  }

  /**
   * Submits a job and polls until completion, returning the final result.
   * Equivalent to the official fal_client.subscribe() helper.
   */
  async subscribe<T = any>(
    model: string,
    input: Record<string, any>,
    options: FalSubscribeOptions = {}
  ): Promise<T> {
    const pollIntervalMs = options.pollIntervalMs ?? 1500;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const { statusUrl, responseUrl } = await this.submit(model, input);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { status } = await this.status(statusUrl);
      if (status === "COMPLETED") return this.result<T>(responseUrl);
      if (status === "ERROR" || status === "FAILED") {
        throw new Error(`Fal job failed (${model}): status=${status}`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`Fal job timed out (${model}) after ${timeoutMs}ms`);
  }

  /** Convenience wrapper — generates images and returns their URLs (fal returns hosted URLs, not base64). */
  async generateImage(prompt: string, options: FalGenerateImageOptions = {}): Promise<string[]> {
    const { model, ...input } = options;
    const result = await this.subscribe<{ images?: Array<{ url: string }> }>(model || DEFAULT_IMAGE_MODEL, {
      prompt,
      ...input,
    });
    return (result.images ?? []).map((img) => img.url);
  }

  /** Text-to-image via Seedream v5. */
  async generateSeedreamImage(prompt: string, options: Omit<FalGenerateImageOptions, "model"> = {}): Promise<string[]> {
    return this.generateImage(prompt, { ...options, model: FAL_MODELS.SEEDREAM_V5 });
  }

  /** Reference-image editing via Seedream v5 — pass one or more source image URLs. */
  async editWithSeedream(prompt: string, imageUrls: string[], options: Omit<FalGenerateImageOptions, "model"> = {}): Promise<string[]> {
    const { imageSize, numImages, ...rest } = options;
    const result = await this.subscribe<{ images?: Array<{ url: string }> }>(FAL_MODELS.SEEDREAM_V5_EDIT, {
      prompt,
      image_urls: imageUrls,
      image_size: imageSize,
      num_images: numImages,
      ...rest,
    });
    return (result.images ?? []).map((img) => img.url);
  }
}
