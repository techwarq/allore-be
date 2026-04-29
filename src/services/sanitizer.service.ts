import { TextService } from "./gemini/TextService";

export interface MemoryEpisode {
  events: { type: string; content: string }[];
  entities: { type: string; name: string; metadata?: any }[];
  relations: { from: string; to: string; type: string; weight: number }[];
  outcome: { feedback?: string; score?: number; details?: any };
  summary: string;
}

export class SanitizerService {
  private gemini: TextService;

  constructor(apiKey: string, projectId: string, location: string, serviceAccountEmail?: string, privateKey?: string) {
    this.gemini = new TextService(apiKey, projectId, location, serviceAccountEmail, privateKey);
  }

  /**
   * Transforms raw profile data into a structured memory episode.
   */
  async sanitizeProfile(userId: string, data: any): Promise<MemoryEpisode> {
    const prompt = `
      You are an expert knowledge analyst. Convert the following user profile data into a structured memory graph.
      
      USER PROFILE DATA:
      ${JSON.stringify(data, null, 2)}
      
      OUTPUT FORMAT:
      You must return a valid JSON object with the following structure:
      {
        "events": [{ "type": "onboarding_capture", "content": "Brief summary of capture" }],
        "entities": [{ "type": "brand|topic|style|audience|user", "name": "Name of entity", "metadata": {} }],
        "relations": [{ "from": "entity_name", "to": "entity_name", "type": "prefers|avoids|targets|competitor_of", "weight": 0.5-1.0 }],
        "outcome": { "details": "Summary of onboarding state" },
        "summary": "A concise 'Founder-style' summary of this user's identity and goals."
      }

      RULES:
      1. Be concise.
      2. Ensure entity names are consistent and reusable.
      3. The summary should read like: "Founder of [Brand], focused on [Domain]. Targets [Audience] using [Style]."
    `;

    const response = await this.gemini.generateText({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      model: "gemini-3-flash-preview", // Use flash for speed
      config: { responseMimeType: "application/json" }
    });

    try {
      return JSON.parse(response);
    } catch (e) {
      console.error("Failed to parse sanitizer response:", response);
      throw new Error("Invalid response from memory sanitizer");
    }
  }

  /**
   * Transforms a chat message and context into a structured memory episode.
   */
  async sanitizeChat(userId: string, message: string, assistantResponse: string): Promise<MemoryEpisode> {
    const prompt = `
      You are an expert knowledge analyst. Convert the following chat interaction into a structured memory graph.
      
      USER MESSAGE: ${message}
      ASSISTANT RESPONSE: ${assistantResponse}
      
      OUTPUT FORMAT:
      {
        "events": [{ "type": "query|feedback|instruction", "content": "..." }],
        "entities": [{ "type": "topic|style|intent", "name": "...", "metadata": {} }],
        "relations": [{ "from": "...", "to": "...", "type": "prefers|leads_to|negates", "weight": 0.5 }],
        "outcome": { "feedback": "positive|negative|neutral", "score": 0.0-1.0 },
        "summary": "Brief summary of what was learned or achieved in this turn."
      }
    `;

    const response = await this.gemini.generateText({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      model: "gemini-3-flash-preview",
      config: { responseMimeType: "application/json" }
    });

    try {
      return JSON.parse(response);
    } catch (e) {
      console.error("Failed to parse sanitizer response:", response);
      throw new Error("Invalid response from memory sanitizer");
    }
  }
}
