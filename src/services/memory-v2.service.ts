import { QdrantClient } from '@qdrant/js-client-rest';
import { eq, and, sql, desc, or } from 'drizzle-orm';
import { memoryEpisodes, memoryEntities, memoryRelations, semanticMemories } from '../db/schema';
import { SanitizerService, type MemoryEpisode } from './sanitizer.service';
import { EmbeddingService } from './embedding.service';

export class MemoryServiceV2 {
  private qdrant: QdrantClient;
  private sanitizer: SanitizerService;
  private embedding: EmbeddingService;
  private db: any;
  private readonly VECTOR_SIZE = 768;
  private readonly COLLECTION_NAME = 'episodes';
  private readonly GLOBAL_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

  constructor(env: {
    DB: any;
    QDRANT_URL: string;
    QDRANT_API_KEY: string;
    GEMINI_API_KEY: string;
    VERTEX_PROJECT_ID: string;
    VERTEX_LOCATION: string;
    VERTEX_SERVICE_ACCOUNT_EMAIL: string;
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  }) {
    this.db = env.DB;
    this.qdrant = new QdrantClient({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
    });
    this.sanitizer = new SanitizerService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
    this.embedding = new EmbeddingService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async initialize() {
    const collections = await this.qdrant.getCollections();
    const exists = collections.collections.some((c: any) => c.name === this.COLLECTION_NAME);

    if (!exists) {
      await this.qdrant.createCollection(this.COLLECTION_NAME, {
        vectors: { size: this.VECTOR_SIZE, distance: 'Cosine' },
      });
      await this.qdrant.createPayloadIndex(this.COLLECTION_NAME, {
        field_name: 'userId',
        field_schema: 'keyword',
      });
      await this.qdrant.createPayloadIndex(this.COLLECTION_NAME, {
        field_name: 'projectId',
        field_schema: 'keyword',
      });
    }
  }

  /**
   * Ingests raw data (profile or chat) into the relational memory system.
   */
  async ingest(userId: string, projectId: string, type: 'profile' | 'chat', rawData: any) {
    let episodeData: MemoryEpisode;

    if (type === 'profile') {
      episodeData = await this.sanitizer.sanitizeProfile(userId, rawData);
    } else {
      // For chat, rawData should be { message, assistantResponse }
      episodeData = await this.sanitizer.sanitizeChat(userId, rawData.message, rawData.assistantResponse);
    }

    // 1. Save Episode to Postgres
    const [episode] = await this.db.insert(memoryEpisodes).values({
      userId,
      projectId,
      content: episodeData,
      summary: episodeData.summary,
    }).returning();

    // 2. Save Entities and update Relations
    for (const ent of episodeData.entities) {
      // Check if entity exists for this user (by name and type)
      let [existing] = await this.db.select()
        .from(memoryEntities)
        .where(and(
          eq(memoryEntities.userId, userId),
          eq(memoryEntities.projectId, projectId),
          eq(memoryEntities.name, ent.name),
          eq(memoryEntities.type, ent.type)
        ))
        .limit(1);

      if (!existing) {
        [existing] = await this.db.insert(memoryEntities).values({
          userId,
          projectId,
          name: ent.name,
          type: ent.type,
          metadata: ent.metadata || {},
        }).returning();
      } else {
        // Update metadata/timestamp
        await this.db.update(memoryEntities)
          .set({ updatedAt: new Date(), metadata: { ...existing.metadata, ...(ent.metadata || {}) } })
          .where(eq(memoryEntities.id, existing.id));
      }

      // Store ID back in episodeData for relation mapping if needed, 
      // but we link by name in the sanitizer for simplicity.
    }

    // 3. Save Relations
    for (const rel of episodeData.relations) {
      const [fromEnt] = await this.db.select().from(memoryEntities).where(and(eq(memoryEntities.userId, userId), eq(memoryEntities.projectId, projectId), eq(memoryEntities.name, rel.from))).limit(1);
      const [toEnt] = await this.db.select().from(memoryEntities).where(and(eq(memoryEntities.userId, userId), eq(memoryEntities.projectId, projectId), eq(memoryEntities.name, rel.to))).limit(1);

      if (fromEnt && toEnt) {
        const [existingRel] = await this.db.select()
          .from(memoryRelations)
          .where(and(
            eq(memoryRelations.userId, userId),
            eq(memoryRelations.projectId, projectId),
            eq(memoryRelations.fromEntityId, fromEnt.id),
            eq(memoryRelations.toEntityId, toEnt.id),
            eq(memoryRelations.relationType, rel.type)
          ))
          .limit(1);

        if (existingRel) {
          // Decay old weight or strengthen (simple naive approach)
          const newWeight = Math.min(1.0, parseFloat(existingRel.weight) + 0.1);
          await this.db.update(memoryRelations)
            .set({ weight: newWeight.toString(), updatedAt: new Date() })
            .where(eq(memoryRelations.id, existingRel.id));
        } else {
          await this.db.insert(memoryRelations).values({
            userId,
            projectId,
            fromEntityId: fromEnt.id,
            toEntityId: toEnt.id,
            relationType: rel.type,
            weight: rel.weight.toString(),
          });
        }
      }
    }

    // 4. Save to Qdrant (Episode Summary)
    const vector = await this.embedding.getEmbedding(episodeData.summary);
    await this.qdrant.upsert(this.COLLECTION_NAME, {
      points: [{
        id: episode.id,
        vector,
        payload: { userId, projectId, episodeId: episode.id, summary: episodeData.summary }
      }]
    });

    return episode;
  }

  /**
   * Multi-layer retrieval for a given query.
   */
  async retrieve(userId: string, projectId: string, query: string) {
    const queryVector = await this.embedding.getEmbedding(query);

    // Layer 1: Vector Search (Episodes)
    const similarEpisodes = await this.qdrant.search(this.COLLECTION_NAME, {
      vector: queryVector,
      filter: { 
        must: [
          { key: 'userId', match: { value: userId } },
        ],
        should: [
          { key: 'projectId', match: { value: projectId } },
          { key: 'projectId', match: { value: this.GLOBAL_PROJECT_ID } }
        ]
      },
      limit: 3,
      with_payload: true,
    });

    // Layer 2: Entity & Relation Graph
    // Fetch semantic memories for the user
    const insights = await this.db.select()
      .from(semanticMemories)
      .where(and(
        eq(semanticMemories.userId, userId),
        or(
          eq(semanticMemories.projectId, projectId),
          eq(semanticMemories.projectId, this.GLOBAL_PROJECT_ID)
        )
      ))
      .orderBy(desc(semanticMemories.confidence))
      .limit(5);

    // Layer 3: Relationship Aggregation (Pattern extraction)
    // We fetch top relations for this user to see common patterns
    const topRelations = await this.db.select({
      from: memoryEntities.name,
      to: sql<string>`(SELECT name FROM memory_entities WHERE id = memory_relations.to_entity_id)`,
      type: memoryRelations.relationType,
      weight: memoryRelations.weight
    })
      .from(memoryRelations)
      .innerJoin(memoryEntities, eq(memoryRelations.fromEntityId, memoryEntities.id))
      .where(and(
        eq(memoryRelations.userId, userId),
        or(
          eq(memoryRelations.projectId, projectId),
          eq(memoryRelations.projectId, this.GLOBAL_PROJECT_ID)
        )
      ))
      .orderBy(desc(memoryRelations.weight))
      .limit(10);

    return {
      pastEpisodes: similarEpisodes.map((e: any) => e.payload?.summary),
      semanticInsights: insights.map((i: any) => i.insight),
      patterns: topRelations.map((r: any) => `${r.from} --(${r.type})--> ${r.to} (score: ${r.weight})`),
    };
  }

  /**
   * Background task to consolidate episodes into semantic memories.
   */
  async consolidate(userId: string, projectId: string) {
    const recentEpisodes = await this.db.select()
      .from(memoryEpisodes)
      .where(and(
        eq(memoryEpisodes.userId, userId),
        eq(memoryEpisodes.projectId, projectId)
      ))
      .orderBy(desc(memoryEpisodes.createdAt))
      .limit(10);

    if (recentEpisodes.length < 3) return; // Need at least a few episodes to find patterns

    const prompt = `
      You are a memory consolidation engine. Below are the last ${recentEpisodes.length} episodes of a user's interactions.
      Identify long-term insights, recurring preferences, or important patterns.
      
      EPISODES:
      ${recentEpisodes.map((e: any) => `- ${e.summary}`).join('\n')}
      
      OUTPUT FORMAT:
      Return a JSON array of insights:
      [{ "insight": "User prefers technical tone", "category": "preference", "confidence": 0.8 }]
    `;

    const response = await this.sanitizer['gemini'].generateText({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      model: "gemini-3.1-pro-preview",
      config: { responseMimeType: "application/json" }
    });

    const insights = JSON.parse(response);

    for (const insight of insights) {
      await this.db.insert(semanticMemories).values({
        userId,
        projectId,
        insight: insight.insight,
        category: insight.category,
        confidence: insight.confidence.toString(),
        sourceEpisodeIds: recentEpisodes.map((e: any) => e.id),
      }).onConflictDoUpdate({
        target: [semanticMemories.userId, semanticMemories.projectId, semanticMemories.insight],
        set: { confidence: insight.confidence.toString(), updatedAt: new Date() }
      });
    }
  }
}
