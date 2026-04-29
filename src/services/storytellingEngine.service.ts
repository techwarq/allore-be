import { QdrantClient } from "@qdrant/js-client-rest";
import { TextService } from "./gemini/TextService";
import { EmbeddingService } from "./embedding.service";

export interface StorytellingMetadata {
  type: string;
  tags: string[];
  use_case?: string[];
  strength: "high" | "medium";
  source: string;
  category: string;
}

// Static cache to avoid redundant collection checks across requests in the same isolate
let isCollectionInitialized = false;

export class StorytellingEngineService {
  private textService: TextService;
  private embeddingService: EmbeddingService;
  private qdrant: QdrantClient;
  private readonly COLLECTION_NAME = "storytelling_engine";
  private readonly VECTOR_SIZE = 768;

  constructor(
    apikey: string,
    projectId: string,
    location: string,
    qdrantUrl: string,
    qdrantApiKey?: string,
    serviceAccountEmail?: string,
    privateKey?: string
  ) {
    this.textService = new TextService(apikey, projectId, location, serviceAccountEmail, privateKey);
    this.embeddingService = new EmbeddingService(apikey, projectId, location, serviceAccountEmail, privateKey);
    this.qdrant = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
    });
  }

  /**
   * Ensures the storytelling_engine collection exists.
   */
  async initializeCollection() {
    if (isCollectionInitialized) return;

    const start = Date.now();
    const collections = await this.qdrant.getCollections();
    const exists = collections.collections.some(c => c.name === this.COLLECTION_NAME);

    if (!exists) {
      console.log(`Creating collection: ${this.COLLECTION_NAME}`);
      await this.qdrant.createCollection(this.COLLECTION_NAME, {
        vectors: {
          size: this.VECTOR_SIZE,
          distance: "Cosine",
        },
      });
    }
    
    isCollectionInitialized = true;
    console.log(`[Qdrant] Collection Check took ${Date.now() - start}ms`);
  }

  /**
   * Generates embeddings and saves content to Qdrant.
   */
  async ingest(text: string, metadata: Omit<StorytellingMetadata, "category">) {
    const ingestStart = Date.now();
    
    // 1. Generate Embedding
    const embedStart = Date.now();
    const vector = await this.embeddingService.getEmbedding(text);
    console.log(`[Embedding] Generation took ${Date.now() - embedStart}ms`);

    // 2. Prepare Payload
    const fullMetadata: StorytellingMetadata = {
      ...metadata,
      category: this.COLLECTION_NAME
    };

    // 3. Upsert into Qdrant
    const id = crypto.randomUUID();
    const upsertStart = Date.now();
    await this.qdrant.upsert(this.COLLECTION_NAME, {
      wait: false,
      points: [
        {
          id,
          vector,
          payload: {
            text,
            ...fullMetadata,
          },
        },
      ],
    });
    console.log(`[Qdrant] Upsert took ${Date.now() - upsertStart}ms`);
    console.log(`[Ingest] Completed in ${Date.now() - ingestStart}ms`);

    return id;
  }

  /**
   * Batch ingests multiple items sequentially.
   */
  async batchIngest(items: Array<{ text: string, metadata: any }>) {
    const results = [];
    console.log(`[Batch Ingest] Processing ${items.length} items...`);
    
    for (let i = 0; i < items.length; i++) {
        console.log(`[Batch Ingest] Processing item ${i + 1}/${items.length}`);
        try {
            const id = await this.ingest(items[i].text, {
                type: items[i].metadata?.type || 'general',
                tags: items[i].metadata?.tags || [],
                use_case: items[i].metadata?.use_case || [],
                strength: items[i].metadata?.strength || 'medium',
                source: items[i].metadata?.source || 'unknown'
            });
            results.push({ success: true, id });
        } catch (error: any) {
            console.error(`[Batch Ingest] Failed to ingest item ${i}:`, error);
            results.push({ success: false, error: error.message });
        }
    }
    
    return results;
  }

  /**
   * Performs semantic search on the storytelling engine.
   */
  async search(queryText: string, limit: number = 5) {
    const searchStart = Date.now();
    
    // 1. Generate Query Embedding
    const embedStart = Date.now();
    const queryVector = await this.embeddingService.getEmbedding(queryText);
    console.log(`[Search] Embedding Generation took ${Date.now() - embedStart}ms`);

    // 2. Perform Search in Qdrant
    const qdrantStart = Date.now();
    const searchResults = await this.qdrant.search(this.COLLECTION_NAME, {
      vector: queryVector,
      limit,
      with_payload: true,
      with_vector: false
    });
    console.log(`[Search] Qdrant Query took ${Date.now() - qdrantStart}ms`);
    console.log(`[Search] Completed in ${Date.now() - searchStart}ms`);

    return searchResults.map(res => ({
      id: res.id,
      score: res.score,
      payload: res.payload
    }));
  }
}