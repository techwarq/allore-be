export default class GeminiConnector {
  public apiKey: string;
  private baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async *streamContent(payload: any): AsyncGenerator<string> {
    const model = payload.model || "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const body: any = {
      contents: payload.contents,
      generationConfig: payload.config || payload.generationConfig || {},
      safetySettings: payload.safetySettings || [],
    };

    if (payload.systemInstruction) {
      body.systemInstruction = payload.systemInstruction;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Gemini API Error: ${JSON.stringify(error)}`);
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
          if (line.startsWith("data: ")) {
            try {
              const json = JSON.parse(line.substring(6));
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) yield text;
            } catch (e) {
              console.error("Error parsing SSE line:", line);
            }
          }
        }
      }
    }
  }
}
