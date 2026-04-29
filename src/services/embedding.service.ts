import { VertexAuth } from "./gemini/VertexAuth";

/**
 * Service to handle vector embedding generation using Google Gemini.
 */
export class EmbeddingService {
  private apiKey: string;
  private projectId?: string;
  private location?: string;
  private serviceAccountEmail?: string;
  private privateKey?: string;
  
  // Vertex AI model name vs Google AI model name
  private model = "text-embedding-004";

  constructor(apiKey: string, projectId?: string, location?: string, serviceAccountEmail?: string, privateKey?: string) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.location = location;
    this.serviceAccountEmail = serviceAccountEmail;
    this.privateKey = privateKey;
  }

  /**
   * Generates a 768-dimension vector for the provided text.
   */
  async getEmbedding(text: string): Promise<number[]> {
    let url: string;
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: any;

    if (this.serviceAccountEmail && this.privateKey && this.projectId) {
      // Vertex AI Path
      const token = await VertexAuth.getAccessToken(this.serviceAccountEmail, this.privateKey);
      const loc = this.location || "us-central1";
      url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${loc}/publishers/google/models/${this.model}:predict`;
      headers["Authorization"] = `Bearer ${token}`;
      
      body = {
        instances: [{ content: text }]
      };
    } else {
      // Google AI (Developer) Path
      const devModel = "gemini-embedding-2-preview";
      url = `https://generativelanguage.googleapis.com/v1beta/models/${devModel}:embedContent?key=${this.apiKey}`;
      body = {
        model: `models/${devModel}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini Embedding Error (${url}): ${error}`);
    }

    const result: any = await response.json();
    
    // Handle different response structures between Vertex and Google AI
    if (result.predictions?.[0]?.embeddings?.values) {
      return result.predictions[0].embeddings.values;
    } else if (result.embedding?.values) {
      return result.embedding.values;
    }

    throw new Error(`Invalid embedding response: ${JSON.stringify(result)}`);
  }
}
