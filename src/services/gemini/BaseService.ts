export abstract class BaseGeminiService {
  protected apiKey: string;
  protected projectId: string;
  protected location: string;
  protected serviceAccountEmail?: string;
  protected privateKey?: string;

  constructor(apiKey: string, projectId: string, location: string, serviceAccountEmail?: string, privateKey?: string) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.location = location;
    this.serviceAccountEmail = serviceAccountEmail;
    this.privateKey = privateKey;
  }

  /**
   * Using Google AI gateway (generativelanguage) to support API Key authentication.
   */
  protected getBaseUrl(apiVersion: string = "v1beta"): string {
    return `https://generativelanguage.googleapis.com/${apiVersion}/models`;
  }

  /**
   * Returns the Vertex AI specific endpoint for a model.
   */
  protected getVertexUrl(model: string, operation: "generateContent" | "streamGenerateContent"): string {
    let loc = this.location || "us-central1";
    
    // Gemini 3 models are strictly global
    if (model.includes("gemini-3") || loc === "global") {
      loc = "global";
      const proj = this.projectId;
      // Global endpoints do not have a location prefix on the hostname
      return `https://aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${model}:${operation}`;
    }

    const proj = this.projectId;
    return `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${model}:${operation}`;
  }
}
