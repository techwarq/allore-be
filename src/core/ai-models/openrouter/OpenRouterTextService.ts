import type { GenerateTextOpts, ITextService } from "../../../services/chat/ITextService";

export const OPENROUTER_MODELS = {
  GPT_4O_MINI: "openai/gpt-4o-mini",
  QWEN_3_7_FLASH: "qwen/qwen3.7-flash",
  QWEN_3_7_PLUS: "qwen/qwen3.7-plus",
  MINIMAX_M3: "minimax/minimax-m3",
} as const;

const DEFAULT_MODEL = OPENROUTER_MODELS.GPT_4O_MINI;
const API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Tried in order if the primary model exhausts its retries on a 429/503 — cheap
// multimodal models from OTHER Chinese providers/pools first (Qwen's own
// higher tier, then a different provider entirely via MiniMax), so a
// shared-pool quota exhaustion on one provider doesn't take down the other.
// OpenAI stays as the very last resort, not the first fallback.
const FALLBACK_CHAIN: string[] = [
  OPENROUTER_MODELS.QWEN_3_7_PLUS,
  OPENROUTER_MODELS.MINIMAX_M3,
  OPENROUTER_MODELS.GPT_4O_MINI,
];

interface Message {
  role: "system" | "user" | "assistant";
  content: string | any[];
}

export interface OpenRouterOptions {
  model?: string;
  // Optional attribution headers — surfaces the app on OpenRouter's leaderboards.
  siteUrl?: string;
  siteName?: string;
  // Reasoning models (e.g. Qwen3.7) burn thousands of hidden "reasoning" tokens by default,
  // multiplying latency/cost for simple utility calls. Off unless a caller opts in.
  reasoning?: boolean;
}

/**
 * Text generation via OpenRouter's unified chat/completions API (OpenAI-compatible,
 * routes to any of OpenRouter's hosted models by slug, e.g. "anthropic/claude-sonnet-4.5").
 * Implements ITextService so it can substitute for TextService (Gemini) anywhere a
 * tool takes a text engine.
 */
export class OpenRouterTextService implements ITextService {
  constructor(private apiKey: string, private options: OpenRouterOptions = {}) {}

  async chat(system: string, userText: string, jsonMode = false, model?: string): Promise<string> {
    return this._call(
      [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      { jsonMode, model }
    );
  }

  async chatWithImage(
    system: string,
    userText: string,
    imageBase64: string,
    mimeType: string,
    jsonMode = false,
    model?: string
  ): Promise<string> {
    return this._call(
      [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: "text", text: userText },
          ],
        },
      ],
      { jsonMode, model }
    );
  }

  async chatWithMultipleImages(
    system: string,
    userText: string,
    images: Array<{ base64: string; mimeType: string }>,
    jsonMode = false,
    model?: string
  ): Promise<string> {
    const imageContent = images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    }));
    return this._call(
      [
        { role: "system", content: system },
        { role: "user", content: [...imageContent, { type: "text", text: userText }] },
      ],
      { jsonMode, model }
    );
  }

  /** ITextService adapter — accepts Gemini-shaped contents so this can drop in for TextService. */
  async generateText(opts: GenerateTextOpts): Promise<string> {
    const messages: Message[] = [];
    const systemText =
      typeof opts.systemInstruction === "string"
        ? opts.systemInstruction
        : opts.systemInstruction?.parts.map((p) => p.text).join("\n");
    if (systemText) messages.push({ role: "system", content: systemText });

    for (const c of opts.contents) {
      const role = c.role === "model" ? "assistant" : c.role === "system" ? "system" : "user";
      const textParts = c.parts
        .filter((p) => p.text)
        .map((p) => p.text)
        .join("\n");
      const imageParts = c.parts.filter((p) => p.inlineData);

      if (imageParts.length) {
        messages.push({
          role,
          content: [
            ...imageParts.map((p) => ({
              type: "image_url",
              image_url: { url: `data:${p.inlineData!.mimeType};base64,${p.inlineData!.data}` },
            })),
            { type: "text", text: textParts },
          ],
        });
      } else {
        messages.push({ role, content: textParts });
      }
    }

    return this._call(messages, {
      jsonMode: opts.generationConfig?.responseMimeType === "application/json",
      model: opts.model,
      temperature: opts.generationConfig?.temperature,
    });
  }

  private async _call(
    messages: Message[],
    opts: { jsonMode?: boolean; model?: string; temperature?: number } = {}
  ): Promise<string> {
    const primaryModel = opts.model || this.options.model || DEFAULT_MODEL;
    const result = await this._attempt(primaryModel, messages, opts);
    if (result.ok) return result.text;

    if (!result.retryable) {
      throw new Error(`OpenRouter Text Error: ${result.lastError}`);
    }

    // A 429/503 that survives 4 retries usually means the specific model's
    // shared pool is exhausted upstream, not that OpenRouter itself is down —
    // retrying the same model further won't help. Walk the fallback chain
    // instead of giving up after one attempt.
    let lastError = result.lastError;
    for (const fallbackModel of FALLBACK_CHAIN) {
      if (fallbackModel === primaryModel) continue;
      console.warn(`[OpenRouter] ${primaryModel} exhausted retries (${lastError.slice(0, 200)}) — trying ${fallbackModel}`);
      const attempt = await this._attempt(fallbackModel, messages, opts);
      if (attempt.ok) return attempt.text;
      lastError = attempt.lastError;
      if (!attempt.retryable) break;
    }

    throw new Error(`OpenRouter Text Error: ${lastError}`);
  }

  private async _attempt(
    model: string,
    messages: Message[],
    opts: { jsonMode?: boolean; temperature?: number }
  ): Promise<{ ok: true; text: string } | { ok: false; retryable: boolean; lastError: string }> {
    let lastError = "";
    let retryable = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const body: any = {
        model,
        messages,
        temperature: opts.temperature,
        reasoning: { enabled: this.options.reasoning ?? false },
      };
      if (opts.jsonMode) body.response_format = { type: "json_object" };

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(this.options.siteUrl ? { "HTTP-Referer": this.options.siteUrl } : {}),
          ...(this.options.siteName ? { "X-Title": this.options.siteName } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });

      if (res.ok) {
        const json: any = await res.json();
        return { ok: true, text: json.choices?.[0]?.message?.content ?? "" };
      }

      lastError = await res.text();
      retryable = res.status === 503 || res.status === 429;
      if (!retryable) break;
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
    return { ok: false, retryable, lastError };
  }
}
