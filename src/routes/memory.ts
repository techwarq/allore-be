import { Hono } from 'hono';
import { MemoryService, COLLECTIONS, type MemoryCollection } from '../services/memory.service';
import { EmbeddingService } from '../services/embedding.service';

type Bindings = {
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  GEMINI_API_KEY: string;
};

const memory = new Hono<{ Bindings: Bindings }>();

/**
 * Endpoint to add a memory to a specific collection.
 * Payload: { userId: string, collection: string, text: string, metadata?: any }
 */
memory.post('/add', async (c) => {
  try {
    const { userId, collection, text, metadata } = await c.req.json();

    if (!userId || !collection || !text) {
      return c.json({ error: 'Missing required fields: userId, collection, text' }, 400);
    }

    if (!COLLECTIONS.includes(collection as MemoryCollection)) {
      return c.json({ error: `Invalid collection. Must be one of: ${COLLECTIONS.join(', ')}` }, 400);
    }

    const embeddingService = new EmbeddingService(c.env.GEMINI_API_KEY);
    const memoryService = new MemoryService(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);

    console.log(`Generating embedding for collection: ${collection}`);
    const vector = await embeddingService.getEmbedding(text);

    const pointId = crypto.randomUUID();
    const payload = {
      userId,
      text,
      createdAt: new Date().toISOString(),
      ...metadata,
    };

    await memoryService.addMemory(collection as MemoryCollection, pointId, vector, payload);

    return c.json({
      success: true,
      message: 'Memory added successfully',
      pointId,
    });
  } catch (error: any) {
    console.error('Memory Add Error:', error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Endpoint to search for similar memories in a collection.
 * Payload: { userId: string, collection: string, text: string, limit?: number }
 */
memory.post('/search', async (c) => {
  try {
    const { userId, collection, text, limit } = await c.req.json();

    if (!userId || !collection || !text) {
      return c.json({ error: 'Missing required fields: userId, collection, text' }, 400);
    }

    if (!COLLECTIONS.includes(collection as MemoryCollection)) {
      return c.json({ error: `Invalid collection. Must be one of: ${COLLECTIONS.join(', ')}` }, 400);
    }

    const embeddingService = new EmbeddingService(c.env.GEMINI_API_KEY);
    const memoryService = new MemoryService(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);

    console.log(`Searching memory in collection: ${collection}`);
    const queryVector = await embeddingService.getEmbedding(text);

    const results = await memoryService.searchMemory(
      collection as MemoryCollection,
      userId,
      queryVector,
      limit || 5
    );

    return c.json({
      success: true,
      results,
    });
  } catch (error: any) {
    console.error('Memory Search Error:', error);
    return c.json({ error: error.message }, 500);
  }
});

export default memory;
