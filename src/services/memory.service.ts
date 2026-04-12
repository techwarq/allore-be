import { QdrantClient } from '@qdrant/js-client-rest';

// --- Types & Interfaces ---

export type MemoryCollection = 
  | 'user_interactions'
  | 'user_assets'
  | 'user_brand'
  | 'user_objectives'
  | 'user_info';

export const COLLECTIONS: MemoryCollection[] = [
  'user_interactions',
  'user_assets',
  'user_brand',
  'user_objectives',
  'user_info',
];

export interface CoreMemoryPayload {
  userId: string;
  text: string;
  createdAt: string;
}

export interface InteractionMemoryPayload extends CoreMemoryPayload {
  role: 'user' | 'assistant' | 'system';
}

export interface AssetMemoryPayload extends CoreMemoryPayload {
  assetType: string;
  url: string;
}

export interface BrandMemoryPayload extends CoreMemoryPayload {
  attribute: string;
  companyName?: string;
  brandAssets?: string;
}

export interface ObjectiveMemoryPayload extends CoreMemoryPayload {
  status: 'pending' | 'in_progress' | 'completed' | 'abandoned';
  priority: number; // e.g., 1-5
}

export type UserInfoMemoryPayload = CoreMemoryPayload;

// Maps collection name to its specific payload type
export type CollectionPayloadMap = {
  user_interactions: InteractionMemoryPayload;
  user_assets: AssetMemoryPayload;
  user_brand: BrandMemoryPayload;
  user_objectives: ObjectiveMemoryPayload;
  user_info: UserInfoMemoryPayload;
};

// --- Memory Service ---

export class MemoryService {
  private client: QdrantClient;
  private readonly VECTOR_SIZE = 768; // For Gemini text-embedding-004 or similar

  constructor(url: string, apiKey?: string) {
    this.client = new QdrantClient({
      url,
      apiKey,
    });
  }

  /**
   * Run this once to ensure all collections exist with the proper configuration.
   * Qdrant creates them if they don't exist.
   */
  async initializeCollections() {
    for (const collection of COLLECTIONS) {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === collection);

      if (!exists) {
        console.log(`Creating collection in Qdrant: ${collection}`);
        await this.client.createCollection(collection, {
          vectors: {
            size: this.VECTOR_SIZE,
            distance: 'Cosine',
          },
        });

        // Create a keyword index on userId for fast payload filtering
        await this.client.createPayloadIndex(collection, {
          field_name: 'userId',
          field_schema: 'keyword',
        });
        console.log(`Created payload index on userId for ${collection}`);
      }
    }
  }

  /**
   * Adds a memory vector and its metadata into the specified collection.
   */
  async addMemory<T extends MemoryCollection>(
    collection: T,
    id: string, // Unique UUID for the point
    vector: number[],
    payload: CollectionPayloadMap[T]
  ) {
    if (vector.length !== this.VECTOR_SIZE) {
      throw new Error(`Vector length must be ${this.VECTOR_SIZE}`);
    }

    await this.client.upsert(collection, {
      wait: true,
      points: [
        {
          id,
          vector,
          payload: payload as any, 
        },
      ],
    });
  }

  /**
   * Searches for similar memories within a specific collection, filtering by userId.
   */
  async searchMemory<T extends MemoryCollection>(
    collection: T,
    userId: string,
    queryVector: number[],
    limit: number = 5,
    scoreThreshold: number = 0.7 // Configurable similarity threshold
  ) {
    const searchResults = await this.client.search(collection, {
      vector: queryVector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          {
            key: 'userId',
            match: {
              value: userId,
            },
          },
        ],
      },
    });

    return searchResults.map(result => ({
      id: result.id,
      score: result.score,
      payload: result.payload as unknown as CollectionPayloadMap[T]
    }));
  }
}
