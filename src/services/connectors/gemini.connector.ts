export default class GeminiConnector {
  private apiKey: string;
  private baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateContent(payload: any): Promise<any> {
    const model = payload.model || "gemini-1.5-flash"; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

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

    return await response.json();
  }
}
