import { MemoryService } from "../memory.service";
import { EmbeddingService } from "../embedding.service";

export class Memory {
  private memoryService: MemoryService;
  private embeddingService: EmbeddingService;

  constructor(qdrantUrl: string, qdrantKey: string, geminiKey: string, projectId: string, location: string, serviceAccountEmail?: string, privateKey?: string) {
    this.memoryService = new MemoryService(qdrantUrl, qdrantKey);
    this.embeddingService = new EmbeddingService(geminiKey, projectId, location, serviceAccountEmail, privateKey);
  }

  async retrieve(userId: string, query: string) {
    try {
      const vector = await this.embeddingService.getEmbedding(query);
      const results = await this.memoryService.searchMemory('user_interactions', userId, vector, 5);
      return results.map(r => r.payload);
    } catch (err) {
      console.warn("[Memory] Retrieval failed:", err);
      return [];
    }
  }

  async searchMemory(collection: any, userId: string, query: string, limit: number = 5) {
    try {
      const vector = await this.embeddingService.getEmbedding(query);
      const results = await this.memoryService.searchMemory(collection, userId, vector, limit);
      // Map to the format expected by the chat service (unwrapping payload)
      return results.map(r => ({
        ...r.payload,
        id: r.id
      }));
    } catch (err) {
      console.warn("[Memory] Search failed:", err);
      return [];
    }
  }
}
