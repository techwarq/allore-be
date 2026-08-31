import { BaseGeminiService } from "./BaseService";
import { ITextService, GenerateTextOpts } from "../chat/ITextService";
// import { VertexAuth } from "./VertexAuth";

export class TextService extends BaseGeminiService implements ITextService {
  /**
   * Normalizes systemInstruction to the Vertex AI required format.
   * Vertex AI expects { parts: [{ text: "..." }] }, not a plain string.
   */
  private normalizeSystemInstruction(si: any) {
    if (!si) return undefined;
    if (typeof si === 'string') return { parts: [{ text: si }] };
    return si;
  }

  /**
   * Retries transient failures (timeouts, 429/503 "high demand") so a single
   * slow/overloaded Gemini response doesn't hard-fail a whole tool step —
   * every caller (storyteller, creative studio, avatar casting, etc.) gets
   * this for free instead of each needing its own retry loop.
   */
  private async fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, maxAttempts = 3): Promise<Response> {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok || (response.status !== 429 && response.status !== 503)) return response;
        lastErr = new Error(`Gemini HTTP ${response.status}`);
      } catch (err) {
        // AbortSignal.timeout throws a DOMException ("TimeoutError") — retryable,
        // same as a network blip.
        lastErr = err;
      }
      if (attempt < maxAttempts) {
        console.warn(`[TextService] Attempt ${attempt} failed (${lastErr?.message || lastErr}), retrying...`);
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    throw lastErr;
  }

  /**
   * Generates a single text response (non-streaming).
   */
  async generateText(payload: GenerateTextOpts): Promise<string> {
    const model = payload.model || "gemini-3-flash-preview";
    let url: string;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    // Use Vertex AI if credentials are provided, otherwise fallback to Google AI
    // if (this.serviceAccountEmail && this.privateKey) {
    //   const token = await VertexAuth.getAccessToken(this.serviceAccountEmail, this.privateKey);
    //   url = this.getVertexUrl(model, "generateContent");
    //   headers["Authorization"] = `Bearer ${token}`;
    // } else {
      url = `${this.getBaseUrl()}/${model}:generateContent?key=${this.apiKey}`;
    // }

    const body: any = {
      contents: payload.contents,
      generationConfig: payload.config || payload.generationConfig || {},
      safetySettings: payload.safetySettings || [],
    };

    if (payload.systemInstruction) {
      body.systemInstruction = this.normalizeSystemInstruction(payload.systemInstruction);
    }

    let response: Response;
    try {
      response = await this.fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, 30_000);
    } catch (err: any) {
      throw new Error(`Gemini Text Error (${url}): ${err?.message || err}`);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini Text Error (${url}): ${error}`);
    }

    const json: any = await response.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  /**
   * Generates a full response including metadata and multiple parts (for images).
   */
  async generate(payload: any): Promise<any> {
    const model = payload.model || "gemini-3-flash-preview";
    let url: string;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    // if (this.serviceAccountEmail && this.privateKey) {
    //   const token = await VertexAuth.getAccessToken(this.serviceAccountEmail, this.privateKey);
    //   url = this.getVertexUrl(model, "generateContent");
    //   headers["Authorization"] = `Bearer ${token}`;
    // } else {
      url = `${this.getBaseUrl()}/${model}:generateContent?key=${this.apiKey}`;
    // }

    const body: any = {
      contents: payload.contents,
      generationConfig: payload.config || payload.generationConfig || {},
    };

    if (payload.systemInstruction) {
      body.systemInstruction = this.normalizeSystemInstruction(payload.systemInstruction);
    }

    let response: Response;
    try {
      response = await this.fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, 60_000);
    } catch (err: any) {
      throw new Error(`Gemini Error (${url}): ${err?.message || err}`);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini Error (${url}): ${error}`);
    }

    return await response.json();
  }

  /**
   * Streams text content using SSE.
   */
  async *streamText(payload: any): AsyncGenerator<string> {
    const model = payload.model || "gemini-3-flash-preview";
    let url: string;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    // if (this.serviceAccountEmail && this.privateKey) {
    //   const token = await VertexAuth.getAccessToken(this.serviceAccountEmail, this.privateKey);
    //   url = this.getVertexUrl(model, "streamGenerateContent") + "?alt=sse";
    //   headers["Authorization"] = `Bearer ${token}`;
    // } else {
      url = `${this.getBaseUrl()}/${model}:streamGenerateContent?key=${this.apiKey}&alt=sse`;
    // }

    const body: any = {
      contents: payload.contents,
      generationConfig: payload.config || payload.generationConfig || {},
      safetySettings: payload.safetySettings || [],
    };

    if (payload.systemInstruction) {
      body.systemInstruction = this.normalizeSystemInstruction(payload.systemInstruction);
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini Stream Error (${url}): ${error}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.startsWith("data: ")) {
            try {
              const json = JSON.parse(line.substring(6));
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) yield text;
            } catch (e) {
              console.error("[TextService] Error parsing SSE line:", line);
            }
          } else {
            console.log("[TextService] Non-SSE text chunk received:", line);
          }
        }
      }
    }
  }
}
