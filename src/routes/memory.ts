import { Hono } from 'hono';
import { MemoryServiceV2 } from '../services/memory-v2.service';
import { MemoryService, COLLECTIONS, type MemoryCollection } from '../services/memory.service';
import { EmbeddingService } from '../services/embedding.service';
import { getDb } from '../db';

type Bindings = {
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  GEMINI_API_KEY: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  DATABASE_URL: string;
};

const memory = new Hono<{ Bindings: Bindings }>();

// --- V1 Endpoints (Legacy) ---
// ... (omitting for brevity in replacement but I will keep them)

/**
 * Endpoint to add a memory to a specific collection.
 */
memory.post('/add', async (c) => {
    // ... (Keep existing V1 /add logic)
    const { userId, collection, text, metadata } = await c.req.json();
    if (!userId || !collection || !text) return c.json({ error: 'Missing required fields' }, 400);
    if (!COLLECTIONS.includes(collection as MemoryCollection)) return c.json({ error: 'Invalid collection' }, 400);
    const embeddingService = new EmbeddingService(c.env.GEMINI_API_KEY, c.env.VERTEX_PROJECT_ID, c.env.VERTEX_LOCATION);
    const memoryService = new MemoryService(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    const vector = await embeddingService.getEmbedding(text);
    const pointId = crypto.randomUUID();
    const payload = { userId, text, createdAt: new Date().toISOString(), ...metadata };
    await memoryService.addMemory(collection as MemoryCollection, pointId, vector, payload);
    return c.json({ success: true, message: 'Memory added successfully', pointId });
});

/**
 * Endpoint to search for similar memories in a collection.
 */
memory.post('/search', async (c) => {
    // ... (Keep existing V1 /search logic)
    const { userId, collection, text, limit } = await c.req.json();
    if (!userId || !collection || !text) return c.json({ error: 'Missing required fields' }, 400);
    if (!COLLECTIONS.includes(collection as MemoryCollection)) return c.json({ error: 'Invalid collection' }, 400);
    const embeddingService = new EmbeddingService(c.env.GEMINI_API_KEY, c.env.VERTEX_PROJECT_ID, c.env.VERTEX_LOCATION);
    const memoryService = new MemoryService(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    const queryVector = await embeddingService.getEmbedding(text);
    const results = await memoryService.searchMemory(collection as MemoryCollection, userId, queryVector, limit || 5);
    return c.json({ success: true, results });
});

// --- V2 Endpoints (Relational) ---

/**
 * POST /memory/v2/ingest
 * Manually ingest data into the relational graph.
 * Payload: { userId: string, type: 'profile'|'chat', data: any }
 */
memory.post('/v2/ingest', async (c) => {
  try {
    const { userId, projectId, type, data } = await c.req.json();
    if (!userId || !projectId) return c.json({ error: 'Missing userId or projectId' }, 400);
    
    const db = getDb(c.env.DATABASE_URL);
    const memoryV2 = new MemoryServiceV2({ 
        DB: db, 
        ...c.env 
    });

    await memoryV2.initialize();
    const episode = await memoryV2.ingest(userId, projectId, type, data);

    return c.json({ success: true, episodeId: episode.id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * POST /memory/v2/retrieve
 * Retrieve distilled context from the relational engine.
 * Payload: { userId: string, query: string }
 */
memory.post('/v2/retrieve', async (c) => {
  try {
    const { userId, projectId, query } = await c.req.json();
    if (!userId || !projectId) return c.json({ error: 'Missing userId or projectId' }, 400);

    const db = getDb(c.env.DATABASE_URL);
    const memoryV2 = new MemoryServiceV2({ DB: db, ...c.env });

    const results = await memoryV2.retrieve(userId, projectId, query);
    return c.json({ success: true, results });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * POST /memory/v2/consolidate
 * Manually trigger consolidation/distillation for a user.
 * Payload: { userId: string }
 */
memory.post('/v2/consolidate', async (c) => {
  try {
    const { userId, projectId } = await c.req.json();
    if (!userId || !projectId) return c.json({ error: 'Missing userId or projectId' }, 400);

    const db = getDb(c.env.DATABASE_URL);
    const memoryV2 = new MemoryServiceV2({ DB: db, ...c.env });

    await memoryV2.consolidate(userId, projectId);
    return c.json({ success: true, message: 'Consolidation complete' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default memory;

