import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingService } from "./embedding.service";

export interface AssetVectorMetadata {
  assetId: string;
  userId: string;
  projectId: string;
  type: string;
  tags: string[];
}

let isAssetCollectionInitialized = false;

export class AssetSearchService {
  private embeddingService: EmbeddingService;
  private qdrant: QdrantClient;
  private readonly COLLECTION_NAME = "brand_assets";
  private readonly PINTEREST_COLLECTION_NAME = "pinterest_assets";
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
    this.embeddingService = new EmbeddingService(apikey, projectId, location, serviceAccountEmail, privateKey);
    this.qdrant = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
    });
  }

  async initializeCollection() {
    if (isAssetCollectionInitialized) return;

    const collections = await this.qdrant.getCollections();
    const exists = collections.collections.some(c => c.name === this.COLLECTION_NAME);

    if (!exists) {
      console.log(`Creating collection: ${this.COLLECTION_NAME}`);
      await this.qdrant.createCollection(this.COLLECTION_NAME, {
        vectors: { size: this.VECTOR_SIZE, distance: "Cosine" },
      });
    }
    
    const pinterestExists = collections.collections.some(c => c.name === this.PINTEREST_COLLECTION_NAME);
    if (!pinterestExists) {
      console.log(`Creating collection: ${this.PINTEREST_COLLECTION_NAME}`);
      await this.qdrant.createCollection(this.PINTEREST_COLLECTION_NAME, {
        vectors: { size: this.VECTOR_SIZE, distance: "Cosine" },
      });
    }

    // Ensure payload indexes exist for filtered fields (idempotent — safe to re-run)
    await this.qdrant.createPayloadIndex(this.COLLECTION_NAME, {
      field_name: "userId",
      field_schema: "keyword",
    });
    await this.qdrant.createPayloadIndex(this.COLLECTION_NAME, {
      field_name: "projectId",
      field_schema: "keyword",
    });

    isAssetCollectionInitialized = true;
  }

  /**
   * Generates an embedding for the textual description of the asset and saves it to Qdrant.
   * @param textDescription The text to embed (e.g., "A luxury red silk dress. Tags: red, silk, luxury").
   * @param metadata Metadata linking back to the Postgres database.
   */
  async ingest(textDescription: string, metadata: AssetVectorMetadata) {
    await this.initializeCollection();

    const vector = await this.embeddingService.getEmbedding(textDescription);

    const id = metadata.assetId; // Use the Postgres UUID as the Qdrant ID for direct mapping

    await this.qdrant.upsert(this.COLLECTION_NAME, {
      wait: true, // Wait for confirmation since this is a direct upload pipeline
      points: [
        {
          id,
          vector,
          payload: {
            textDescription,
            ...metadata,
          },
        },
      ],
    });

    return id;
  }

  /**
   * Ingests a global Pinterest-style asset directly into Qdrant.
   * Maps to the Postgres private_assets table via ID.
   */
  async ingestPinterestAsset(assetId: string, textDescription: string, tags: string[]) {
    await this.initializeCollection();

    const vector = await this.embeddingService.getEmbedding(textDescription);

    await this.qdrant.upsert(this.PINTEREST_COLLECTION_NAME, {
      wait: true,
      points: [
        {
          id: assetId,
          vector,
          payload: {
            textDescription,
            tags,
            type: "pinterest_reference"
          },
        },
      ],
    });

    return assetId;
  }

  /**
   * Searches for global Pinterest assets based on a natural language query.
   */
  async searchPinterestAssets(queryText: string, limit: number = 5) {
    await this.initializeCollection();

    const queryVector = await this.embeddingService.getEmbedding(queryText);

    const searchResults = await this.qdrant.search(this.PINTEREST_COLLECTION_NAME, {
      vector: queryVector,
      limit,
      with_payload: true,
      with_vector: false,
    });

    return searchResults.map(res => ({
      assetId: res.id as string,
      score: res.score,
      payload: res.payload
    }));
  }

  /**
   * Searches for assets based on a natural language query.
   */
  async search(queryText: string, userId: string, limit: number = 5) {
    await this.initializeCollection();

    const queryVector = await this.embeddingService.getEmbedding(queryText);

    const searchResults = await this.qdrant.search(this.COLLECTION_NAME, {
      vector: queryVector,
      limit,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          {
            key: "userId",
            match: { value: userId }
          }
        ]
      }
    });

    return searchResults.map(res => ({
      assetId: res.id as string,
      score: res.score,
      payload: res.payload
    }));
  }

  /**
   * Returns the set of IDs that already exist as points in the brand_assets collection.
   * Used by the reindex endpoint to skip already-indexed assets.
   */
  async getExistingIds(ids: string[]): Promise<Set<string>> {
    await this.initializeCollection();
    const points = await this.qdrant.retrieve(this.COLLECTION_NAME, {
      ids,
      with_payload: false,
      with_vector: false,
    });
    return new Set(points.map(p => p.id as string));
  }

  /**
   * Searches for assets scoped to a specific project (used for @ mention autocomplete).
   */
  async searchByProject(queryText: string, userId: string, projectId: string, limit: number = 10) {
    await this.initializeCollection();

    const queryVector = await this.embeddingService.getEmbedding(queryText);

    const searchResults = await this.qdrant.search(this.COLLECTION_NAME, {
      vector: queryVector,
      limit,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: "userId", match: { value: userId } },
          { key: "projectId", match: { value: projectId } },
        ]
      }
    });

    return searchResults.map(res => ({
      assetId: res.id as string,
      score: res.score,
      payload: res.payload
    }));
  }
}
