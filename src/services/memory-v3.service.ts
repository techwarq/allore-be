import { QdrantClient } from '@qdrant/js-client-rest';
import { eq, and, desc, or, isNull, inArray } from 'drizzle-orm';
import {
  memSessions,
  memEpisodes,
  memNodes,
  memEdges,
  memInsights,
  profiles,
} from '../db/schema';
import { EmbeddingService } from './embedding.service';
import { TextService } from './gemini/TextService';

// ── Public types ─────────────────────────────────────────────────────────────

export type FeedbackScore = -1 | 0 | 1;

export interface RawInteraction {
  message: string;
  response: string;
  chatId?: string;
}

export interface FullContext {
  shortTerm: {
    session: any;
    projectSession: any;
  };
  episodic: {
    summary: string;
    feedbackScore: number;
    feedbackHint?: string;
  }[];
  longTerm: {
    brand: {
      tone?: string | null;
      aesthetic?: string | null;
      coreStory?: string | null;
      colorPalette?: any[];
      targetAudience?: string | null;
      visualMood?: string | null;
      lightingStyle?: string | null;
    } | null;
    insights: { insight: string; category: string; confidence: number }[];
    graph: string[];
  };
}

// ── Internal types ────────────────────────────────────────────────────────────

interface ParsedEpisode {
  events: { type: string; content: string }[];
  entities: { type: string; name: string; metadata?: any }[];
  relations: { from: string; to: string; type: string; weight: number }[];
  outcome: { feedback?: string; score?: number };
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryServiceV3
//
// Architecture:
//   Layer 1 — Short-Term Memory (STM)
//     · Per chat session, queryable by project
//     · Storage: mem_sessions (Postgres)
//
//   Layer 2 — Episodic Memory
//     · Every meaningful user↔AI interaction, feedback-scored
//     · Storage: mem_episodes (Postgres) + Qdrant (semantic search)
//     · Self-improvement: negative episodes re-embed as avoidance signals;
//       consolidate() distills patterns into LTM after N episodes
//
//   Layer 3 — Long-Term Memory (LTM)
//     · Brand DNA (profiles) + distilled insights (mem_insights) + graph
//     · Graph (mem_nodes + mem_edges) is the connective tissue: every layer
//       feeds it, retrieve() traverses it to compose ranked context
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryServiceV3 {
  private qdrant: QdrantClient;
  private embedding: EmbeddingService;
  private llm: TextService;
  private db: any;

  private readonly VECTOR_SIZE = 768;
  private readonly COLLECTION = 'mem_episodes';
  private readonly CONSOLIDATE_THRESHOLD = 10;

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
    this.qdrant = new QdrantClient({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY });
    this.embedding = new EmbeddingService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    );
    this.llm = new TextService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    );
  }

  async initialize() {
    const { collections } = await this.qdrant.getCollections();
    if (collections.some((c: any) => c.name === this.COLLECTION)) return;

    await this.qdrant.createCollection(this.COLLECTION, {
      vectors: { size: this.VECTOR_SIZE, distance: 'Cosine' },
    });
    await Promise.all([
      this.qdrant.createPayloadIndex(this.COLLECTION, { field_name: 'userId',       field_schema: 'keyword' }),
      this.qdrant.createPayloadIndex(this.COLLECTION, { field_name: 'projectId',    field_schema: 'keyword' }),
      this.qdrant.createPayloadIndex(this.COLLECTION, { field_name: 'feedbackScore', field_schema: 'integer' }),
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 1 — SHORT-TERM MEMORY
  // ─────────────────────────────────────────────────────────────────────────

  async saveSession(sessionId: string, userId: string, projectId: string | null, data: any) {
    await this.db
      .insert(memSessions)
      .values({ sessionId, userId, projectId, data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [memSessions.sessionId],
        set: { data, updatedAt: new Date() },
      });
  }

  async loadSession(sessionId: string): Promise<any> {
    const [row] = await this.db
      .select()
      .from(memSessions)
      .where(eq(memSessions.sessionId, sessionId))
      .limit(1);
    return row?.data ?? null;
  }

  async loadProjectSession(userId: string, projectId: string): Promise<any> {
    const [row] = await this.db
      .select()
      .from(memSessions)
      .where(and(eq(memSessions.userId, userId), eq(memSessions.projectId, projectId)))
      .orderBy(desc(memSessions.updatedAt))
      .limit(1);
    return row?.data ?? null;
  }

  async closeSession(sessionId: string) {
    await this.db
      .update(memSessions)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(memSessions.sessionId, sessionId));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 2 — EPISODIC MEMORY
  // ─────────────────────────────────────────────────────────────────────────

  async saveEpisode(userId: string, projectId: string, interaction: RawInteraction): Promise<string> {
    const parsed = await this.parseInteraction(interaction);

    const [episode] = await this.db
      .insert(memEpisodes)
      .values({
        userId,
        projectId,
        chatId: interaction.chatId ?? null,
        content: parsed,
        summary: parsed.summary,
        feedbackScore: 0,
        importance: '0.5000',
        wasConsolidated: false,
      })
      .returning({ id: memEpisodes.id });

    const vector = await this.embedding.getEmbedding(parsed.summary);
    await this.qdrant.upsert(this.COLLECTION, {
      points: [{
        id: episode.id,
        vector,
        payload: {
          userId,
          projectId,
          episodeId: episode.id,
          summary: parsed.summary,
          feedbackScore: 0,
          feedbackText: null,
          importance: 0.5,
        },
      }],
    });

    // Graph update is fire-and-forget — must not block the episode save
    this.updateGraph(userId, projectId, parsed).catch(err =>
      console.error('[MemoryV3] graph update error:', err),
    );

    return episode.id;
  }

  // Call this when the user explicitly gives feedback on an AI response.
  // score: 1 = positive, -1 = negative, 0 = neutral
  async updateFeedback(episodeId: string, score: FeedbackScore, feedbackText?: string): Promise<void> {
    const importance = this.computeImportance(score);

    await this.db
      .update(memEpisodes)
      .set({
        feedbackScore: score,
        feedbackText: feedbackText ?? null,
        importance: importance.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(memEpisodes.id, episodeId));

    // Re-embed with feedback baked into the text so future similarity search
    // naturally surfaces this episode when related queries arrive.
    const [row] = await this.db
      .select({ summary: memEpisodes.summary })
      .from(memEpisodes)
      .where(eq(memEpisodes.id, episodeId))
      .limit(1);

    if (!row) return;

    const embedText = this.buildEmbedText(row.summary, score, feedbackText);
    const vector = await this.embedding.getEmbedding(embedText);

    await this.qdrant.upsert(this.COLLECTION, {
      points: [{
        id: episodeId,
        vector,
        payload: { feedbackScore: score, feedbackText: feedbackText ?? null, importance },
      }],
    });
  }

  async searchEpisodes(userId: string, projectId: string, query: string, limit = 5) {
    const vector = await this.embedding.getEmbedding(query);
    const results = await this.qdrant.search(this.COLLECTION, {
      vector,
      filter: {
        must: [{ key: 'userId', match: { value: userId } }],
        // Return episodes from this project OR global episodes (projectId = GLOBAL_PROJECT_ID)
        should: [
          { key: 'projectId', match: { value: projectId } },
        ],
      },
      limit,
      with_payload: true,
    });

    return results.map((r: any) => ({
      episodeId: r.payload?.episodeId as string,
      summary: r.payload?.summary as string,
      feedbackScore: (r.payload?.feedbackScore as number) ?? 0,
      feedbackText: (r.payload?.feedbackText as string) ?? null,
      score: r.score as number,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 3 — LONG-TERM MEMORY
  // ─────────────────────────────────────────────────────────────────────────

  async loadBrandContext(userId: string) {
    const [profile] = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    if (!profile) return null;
    return {
      tone: profile.tone,
      aesthetic: profile.aesthetic,
      coreStory: profile.coreStory,
      colorPalette: profile.colorPalette,
      targetAudience: profile.targetAudience,
      visualMood: profile.visualMood,
      lightingStyle: profile.lightingStyle,
    };
  }

  async loadInsights(userId: string, projectId: string) {
    const rows = await this.db
      .select()
      .from(memInsights)
      .where(
        and(
          eq(memInsights.userId, userId),
          or(eq(memInsights.projectId, projectId), isNull(memInsights.projectId)),
        ),
      )
      .orderBy(desc(memInsights.confidence))
      .limit(12);

    return rows.map((r: any) => ({
      insight: r.insight as string,
      category: r.category as string,
      confidence: parseFloat(r.confidence),
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GRAPH LAYER
  // Nodes = entities (brand, style, topic, audience, product)
  // Edges = typed weighted relations
  // Traversal returns human-readable triples for the AI context window
  // ─────────────────────────────────────────────────────────────────────────

  private async updateGraph(userId: string, projectId: string, episode: ParsedEpisode) {
    const nodeMap: Record<string, string> = {};

    for (const ent of episode.entities) {
      const id = await this.upsertNode(userId, projectId, {
        name: ent.name,
        type: ent.type,
        scope: 'project',
        layer: 'episodic',
        metadata: ent.metadata ?? {},
      });
      nodeMap[ent.name] = id;
    }

    for (const rel of episode.relations) {
      const fromId = nodeMap[rel.from];
      const toId = nodeMap[rel.to];
      if (fromId && toId) {
        await this.upsertEdge(userId, projectId, {
          fromNodeId: fromId,
          toNodeId: toId,
          relationType: rel.type,
          weight: rel.weight,
          sourceLayer: 'episodic',
        });
      }
    }
  }

  async upsertNode(
    userId: string,
    projectId: string | null,
    node: { name: string; type: string; scope: 'global' | 'project'; layer: 'stm' | 'episodic' | 'ltm'; metadata: any },
  ): Promise<string> {
    const [existing] = await this.db
      .select({ id: memNodes.id, confidence: memNodes.confidence })
      .from(memNodes)
      .where(
        and(
          eq(memNodes.userId, userId),
          eq(memNodes.name, node.name),
          eq(memNodes.type, node.type),
          eq(memNodes.scope, node.scope),
        ),
      )
      .limit(1);

    if (existing) {
      const newConf = Math.min(1.0, parseFloat(existing.confidence) + 0.05);
      await this.db
        .update(memNodes)
        .set({ confidence: newConf.toFixed(4), metadata: node.metadata, updatedAt: new Date() })
        .where(eq(memNodes.id, existing.id));
      return existing.id;
    }

    const [created] = await this.db
      .insert(memNodes)
      .values({ userId, projectId, ...node, confidence: '0.5000' })
      .returning({ id: memNodes.id });
    return created.id;
  }

  async upsertEdge(
    userId: string,
    projectId: string | null,
    edge: { fromNodeId: string; toNodeId: string; relationType: string; weight: number; sourceLayer: 'stm' | 'episodic' | 'ltm' },
  ) {
    const [existing] = await this.db
      .select({ id: memEdges.id, weight: memEdges.weight })
      .from(memEdges)
      .where(
        and(
          eq(memEdges.userId, userId),
          eq(memEdges.fromNodeId, edge.fromNodeId),
          eq(memEdges.toNodeId, edge.toNodeId),
          eq(memEdges.relationType, edge.relationType),
        ),
      )
      .limit(1);

    if (existing) {
      const newWeight = Math.min(1.0, parseFloat(existing.weight) + 0.08);
      await this.db
        .update(memEdges)
        .set({ weight: newWeight.toFixed(4), lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(memEdges.id, existing.id));
    } else {
      await this.db.insert(memEdges).values({
        userId,
        projectId,
        ...edge,
        weight: edge.weight.toFixed(4),
        lastSeenAt: new Date(),
      });
    }
  }

  async traverseGraph(userId: string, projectId: string): Promise<string[]> {
    const nodes = await this.db
      .select()
      .from(memNodes)
      .where(
        and(
          eq(memNodes.userId, userId),
          or(eq(memNodes.projectId, projectId), isNull(memNodes.projectId)),
        ),
      )
      .orderBy(desc(memNodes.confidence))
      .limit(15);

    if (nodes.length === 0) return [];

    const nodeIds = nodes.map((n: any) => n.id as string);
    const nodeLabel: Record<string, string> = Object.fromEntries(
      nodes.map((n: any) => [n.id, `${n.name}(${n.type})`]),
    );

    const edges = await this.db
      .select()
      .from(memEdges)
      .where(and(eq(memEdges.userId, userId), inArray(memEdges.fromNodeId, nodeIds)))
      .orderBy(desc(memEdges.weight))
      .limit(20);

    return edges.map((e: any) => {
      const from = nodeLabel[e.fromNodeId] ?? e.fromNodeId;
      const to   = nodeLabel[e.toNodeId]   ?? e.toNodeId;
      return `${from} -[${(e.relationType as string).toUpperCase()}]→ ${to} (w:${parseFloat(e.weight).toFixed(2)})`;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONSOLIDATION — Background LTM distillation
  //
  // Run after every CONSOLIDATE_THRESHOLD new episodes (call from a
  // background queue / Cloudflare DO alarm, not inline with the request).
  // Reads unconsolidated episodes → LLM extracts durable patterns →
  // writes to mem_insights → marks episodes as consolidated.
  // ─────────────────────────────────────────────────────────────────────────

  async consolidate(userId: string, projectId: string): Promise<void> {
    const episodes = await this.db
      .select({
        id: memEpisodes.id,
        summary: memEpisodes.summary,
        feedbackScore: memEpisodes.feedbackScore,
        feedbackText: memEpisodes.feedbackText,
      })
      .from(memEpisodes)
      .where(
        and(
          eq(memEpisodes.userId, userId),
          eq(memEpisodes.projectId, projectId),
          eq(memEpisodes.wasConsolidated, false),
        ),
      )
      .orderBy(desc(memEpisodes.createdAt))
      .limit(this.CONSOLIDATE_THRESHOLD);

    if (episodes.length < 3) return;

    const lines = episodes.map((e: any) =>
      `- [score:${e.feedbackScore}] ${e.summary}${e.feedbackText ? ` | Feedback: "${e.feedbackText}"` : ''}`,
    );

    const prompt = `
You are a memory analyst for an AI creative assistant. Analyze these user interaction episodes and extract durable patterns.

EPISODES:
${lines.join('\n')}

Categories:
- "preference"           — something the user consistently wants
- "avoidance_pattern"    — something rejected (score -1 episodes)
- "reinforcement_pattern"— an approach that worked (score +1 episodes)
- "brand_knowledge"      — facts about the brand or product
- "style_pattern"        — recurring visual or tone choices

Return JSON array (max 5 insights, only high-confidence ones):
[{ "insight": string, "category": string, "confidence": number }]
    `.trim();

    let insights: { insight: string; category: string; confidence: number }[] = [];
    try {
      const raw = await this.llm.generateText({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        model: 'gemini-3-flash-preview',
        config: { responseMimeType: 'application/json' },
      });
      insights = JSON.parse(raw);
    } catch (err) {
      console.error('[MemoryV3] consolidate parse error:', err);
      return;
    }

    const episodeIds = episodes.map((e: any) => e.id);

    for (const ins of insights) {
      await this.upsertInsight(userId, projectId, ins, episodeIds);
    }

    // Mark episodes consolidated
    await this.db
      .update(memEpisodes)
      .set({ wasConsolidated: true, updatedAt: new Date() })
      .where(inArray(memEpisodes.id, episodeIds));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UNIFIED RETRIEVAL
  // Composes all 3 layers into a ranked context object for the AI prompt.
  //
  // Priority order in longTerm.insights:
  //   1. High-confidence LTM insights (reinforcement_pattern, preference)
  //   2. Avoidance patterns (so AI knows what to steer away from)
  //   3. Brand/style knowledge
  // Episodic results include feedbackHint so the AI can read:
  //   "⚠️ User disliked: 'too cluttered'" and avoid repeating mistakes.
  // ─────────────────────────────────────────────────────────────────────────

  async retrieve(
    userId: string,
    projectId: string,
    sessionId: string,
    query: string,
  ): Promise<FullContext> {
    const [session, projectSession, episodic, brand, insights, graph] = await Promise.all([
      this.loadSession(sessionId),
      this.loadProjectSession(userId, projectId),
      this.searchEpisodes(userId, projectId, query),
      this.loadBrandContext(userId),
      this.loadInsights(userId, projectId),
      this.traverseGraph(userId, projectId),
    ]);

    return {
      shortTerm: { session, projectSession },
      episodic: episodic.map(ep => ({
        summary: ep.summary,
        feedbackScore: ep.feedbackScore,
        feedbackHint: this.formatFeedbackHint(ep.feedbackScore, ep.feedbackText),
      })),
      longTerm: { brand, insights, graph },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async parseInteraction(interaction: RawInteraction): Promise<ParsedEpisode> {
    const prompt = `
Convert this AI interaction into a structured memory episode. Return valid JSON only.

USER: ${interaction.message}
ASSISTANT: ${interaction.response}

{
  "events": [{ "type": "query|instruction|feedback", "content": "brief description" }],
  "entities": [{ "type": "brand|style|topic|product|audience", "name": "TitleCase", "metadata": {} }],
  "relations": [{ "from": "EntityA", "to": "EntityB", "type": "prefers|avoids|leads_to|targets|negates", "weight": 0.6 }],
  "outcome": { "feedback": "positive|negative|neutral", "score": 0.5 },
  "summary": "One sentence: what was requested and what was learned."
}

Rules: max 3 entities, 2 relations. Entity names are Title Case and must be reusable across sessions.
    `.trim();

    try {
      const raw = await this.llm.generateText({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        model: 'gemini-3-flash-preview',
        config: { responseMimeType: 'application/json' },
      });
      return JSON.parse(raw);
    } catch {
      return {
        events: [{ type: 'query', content: interaction.message.slice(0, 100) }],
        entities: [],
        relations: [],
        outcome: { feedback: 'neutral', score: 0.5 },
        summary: interaction.message.slice(0, 200),
      };
    }
  }

  // Negative episodes embed as "AVOID: ..." so they cluster separately in
  // vector space and surface as warnings during future retrieval.
  private buildEmbedText(summary: string, score: FeedbackScore, feedbackText?: string): string {
    if (score === -1) return `AVOID: ${feedbackText ?? summary} | ${summary}`;
    if (score === 1)  return `GOOD: ${summary}`;
    return summary;
  }

  // Negative episodes get high importance (0.80) — they are just as valuable
  // as positive ones because they teach the agent what NOT to do.
  private computeImportance(score: FeedbackScore): number {
    if (score === 1)  return 0.85;
    if (score === -1) return 0.80;
    return 0.50;
  }

  private formatFeedbackHint(score: number, text: string | null): string | undefined {
    if (score === -1) return text ? `⚠️ User disliked: "${text}"` : '⚠️ User gave negative feedback';
    if (score === 1)  return text ? `✓ User liked: "${text}"` : '✓ User approved this approach';
    return undefined;
  }

  private async upsertInsight(
    userId: string,
    projectId: string | null,
    ins: { insight: string; category: string; confidence: number },
    sourceEpisodeIds: string[],
  ) {
    // No unique constraint handles nullable projectId cleanly in Postgres,
    // so we do a manual check-then-insert/update.
    const conditions = projectId
      ? and(eq(memInsights.userId, userId), eq(memInsights.projectId, projectId), eq(memInsights.insight, ins.insight))
      : and(eq(memInsights.userId, userId), isNull(memInsights.projectId), eq(memInsights.insight, ins.insight));

    const [existing] = await this.db.select({ id: memInsights.id }).from(memInsights).where(conditions).limit(1);

    if (existing) {
      await this.db
        .update(memInsights)
        .set({
          confidence: ins.confidence.toFixed(4),
          hitCount: existing.hitCount + 1,
          sourceEpisodeIds,
          updatedAt: new Date(),
        })
        .where(eq(memInsights.id, existing.id));
    } else {
      await this.db.insert(memInsights).values({
        userId,
        projectId,
        insight: ins.insight,
        category: ins.category,
        confidence: ins.confidence.toFixed(4),
        hitCount: 1,
        sourceEpisodeIds,
      });
    }
  }
}
