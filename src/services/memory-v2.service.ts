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
  private readonly EPISODES_COLLECTION = 'episodes';
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
    const exists = collections.collections.some((c: any) => c.name === this.EPISODES_COLLECTION);

    if (!exists) {
      await this.qdrant.createCollection(this.EPISODES_COLLECTION, {
        vectors: { size: this.VECTOR_SIZE, distance: 'Cosine' },
      });
      await this.qdrant.createPayloadIndex(this.EPISODES_COLLECTION, {
        field_name: 'userId',
        field_schema: 'keyword',
      });
      await this.qdrant.createPayloadIndex(this.EPISODES_COLLECTION, {
        field_name: 'projectId',
        field_schema: 'keyword',
      });
    }
  }

  // --- SHORT-TERM MEMORY (STM) ---
  // Focus: Current chat state, project session, and immediate context.

  async saveShortTermMemory(sessionId: string, data: any) {
    await this.db.insert(sessionMemory)
      .values({
        sessionId,
        data,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [sessionMemory.sessionId],
        set: { data, updatedAt: new Date() }
      });
  }

  async retrieveShortTermMemory(sessionId: string) {
    const [memory] = await this.db.select()
      .from(sessionMemory)
      .where(eq(sessionMemory.sessionId, sessionId))
      .limit(1);
    return memory?.data || {};
  }

  // --- EPISODIC MEMORY ---
  // Focus: User interactions, AI responses, and feedback for self-improvement.

  async saveEpisode(userId: string, projectId: string, interaction: { message: string, response: string, feedback?: string }) {
    // 1. Sanitize and extract structured data
    const episodeData: MemoryEpisode = await this.sanitizer.sanitizeChat(userId, interaction.message, interaction.response);
    
    // Add feedback if present
    if (interaction.feedback) {
      episodeData.summary += ` | User Feedback: ${interaction.feedback}`;
    }

    // 2. Save to Postgres
    const [episode] = await this.db.insert(memoryEpisodes).values({
      userId,
      projectId,
      content: episodeData,
      summary: episodeData.summary,
    }).returning();

    // 3. Save to Qdrant for semantic search
    const vector = await this.embedding.getEmbedding(episodeData.summary);
    await this.qdrant.upsert(this.EPISODES_COLLECTION, {
      points: [{
        id: episode.id,
        vector,
        payload: { userId, projectId, episodeId: episode.id, summary: episodeData.summary, feedback: interaction.feedback }
      }]
    });

    // 4. Update Graph Nodes (Long-Term process)
    await this.updateGraph(userId, projectId, episodeData);

    return episode;
  }

  async retrieveEpisodicContext(userId: string, projectId: string, query: string) {
    const queryVector = await this.embedding.getEmbedding(query);
    const similarEpisodes = await this.qdrant.search(this.EPISODES_COLLECTION, {
      vector: queryVector,
      filter: { 
        must: [{ key: 'userId', match: { value: userId } }],
        should: [
          { key: 'projectId', match: { value: projectId } },
          { key: 'projectId', match: { value: this.GLOBAL_PROJECT_ID } }
        ]
      },
      limit: 5,
      with_payload: true,
    });

    return similarEpisodes.map((e: any) => ({
      summary: e.payload?.summary,
      feedback: e.payload?.feedback
    }));
  }

  // --- LONG-TERM MEMORY (LTM) & GRAPH ---
  // Focus: User history, preferences, brand context, and the knowledge graph.

  private async updateGraph(userId: string, projectId: string, data: MemoryEpisode) {
    // Save/Update Entities (Nodes)
    for (const ent of data.entities) {
      let [existing] = await this.db.select()
        .from(memoryEntities)
        .where(and(
          eq(memoryEntities.userId, userId),
          eq(memoryEntities.projectId, projectId),
          eq(memoryEntities.name, ent.name)
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
        await this.db.update(memoryEntities)
          .set({ updatedAt: new Date(), metadata: { ...existing.metadata, ...(ent.metadata || {}) } })
          .where(eq(memoryEntities.id, existing.id));
      }
    }

    // Save/Update Relations (Edges)
    for (const rel of data.relations) {
      const [fromEnt] = await this.db.select().from(memoryEntities).where(and(eq(memoryEntities.userId, userId), eq(memoryEntities.projectId, projectId), eq(memoryEntities.name, rel.from))).limit(1);
      const [toEnt] = await this.db.select().from(memoryEntities).where(and(eq(memoryEntities.userId, userId), eq(memoryEntities.projectId, projectId), eq(memoryEntities.name, rel.to))).limit(1);

      if (fromEnt && toEnt) {
        const [existingRel] = await this.db.select()
          .from(memoryRelations)
          .where(and(
            eq(memoryRelations.userId, userId),
            eq(memoryRelations.fromEntityId, fromEnt.id),
            eq(memoryRelations.toEntityId, toEnt.id),
            eq(memoryRelations.relationType, rel.type)
          ))
          .limit(1);

        if (existingRel) {
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
  }

  async retrieveLongTermMemory(userId: string, projectId: string) {
    // 1. Fetch Brand Profile (Context)
    const [brandProfile] = await this.db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);

    // 2. Fetch Semantic Insights (Preferences/Patterns)
    const insights = await this.db.select()
      .from(semanticMemories)
      .where(and(
        eq(semanticMemories.userId, userId),
        or(eq(semanticMemories.projectId, projectId), eq(semanticMemories.projectId, this.GLOBAL_PROJECT_ID))
      ))
      .orderBy(desc(semanticMemories.confidence))
      .limit(10);

    // 3. Fetch Graph Patterns
    const topRelations = await this.db.select({
      from: memoryEntities.name,
      to: sql<string>`(SELECT name FROM memory_entities WHERE id = memory_relations.to_entity_id)`,
      type: memoryRelations.relationType,
      weight: memoryRelations.weight
    })
      .from(memoryRelations)
      .innerJoin(memoryEntities, eq(memoryRelations.fromEntityId, memoryEntities.id))
      .where(eq(memoryRelations.userId, userId))
      .orderBy(desc(memoryRelations.weight))
      .limit(10);

    return {
      brandContext: brandProfile ? {
        tone: brandProfile.tone,
        aesthetic: brandProfile.aesthetic,
        coreStory: brandProfile.coreStory,
      } : null,
      preferences: insights.map((i: any) => i.insight),
      graph: topRelations.map((r: any) => `${r.from} --(${r.type})--> ${r.to}`),
    };
  }

  /**
   * Background task to consolidate episodes into LTM insights.
   */
  async consolidate(userId: string, projectId: string) {
    const recentEpisodes = await this.db.select()
      .from(memoryEpisodes)
      .where(and(eq(memoryEpisodes.userId, userId), eq(memoryEpisodes.projectId, projectId)))
      .orderBy(desc(memoryEpisodes.createdAt))
      .limit(10);

    if (recentEpisodes.length < 3) return;

    const prompt = `
      Consolidate the following episodes into long-term insights (preferences, patterns, or knowledge).
      Episodes:
      ${recentEpisodes.map((e: any) => `- ${e.summary}`).join('\n')}
      
      Return JSON array: [{ "insight": string, "category": string, "confidence": number }]
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

  // --- UNIFIED RETRIEVAL ---
  
  async retrieveFullContext(userId: string, projectId: string, sessionId: string, query: string) {
    const [stm, episodes, ltm] = await Promise.all([
      this.retrieveShortTermMemory(sessionId),
      this.retrieveEpisodicContext(userId, projectId, query),
      this.retrieveLongTermMemory(userId, projectId)
    ]);

    return {
      shortTerm: stm,
      episodic: episodes,
      longTerm: ltm
    };
  }
}
