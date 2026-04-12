/**
 * Service to handle vector embedding generation using Google Gemini.
 */
export class EmbeddingService {
  private apiKey: string;
  private model = "gemini-embedding-001";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Generates a 768-dimension vector for the provided text.
   */
  async getEmbedding(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;

    const body = {
      model: `models/${this.model}`,
      content: {
        parts: [{ text }],
      },
      outputDimensionality: 768,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Gemini Embedding Error: ${JSON.stringify(error)}`);
    }

    const result: any = await response.json();
    return result.embedding.values;
  }
}
