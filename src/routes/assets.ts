import { Hono } from 'hono';
import { getDb } from '../db';
import { sessionMiddleware, type AuthVariables } from '../middleware/auth';
import { AssetUploadService } from '../services/assetUpload.service';
import { BulkIngestService } from '../services/bulkIngest.service';
import { AssetSearchService } from '../services/assetSearch.service';
import { ChatRepository } from '../db/ChatRepository';
import { inArray, eq, and, desc } from 'drizzle-orm';
import { privateAssets, assets as userAssets } from '../db/schema';

type Bindings = {
  DATABASE_URL: string;
  ASSETS_BUCKET: R2Bucket;
  GEMINI_API_KEY: string;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  API_URL?: string;
};

const assets = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

/**
 * POST /assets/bulk-ingest
 * PUBLIC ROUTE (Internal Tool): Processes a batch of image URLs (max 10) for Pinterest DB directly to Qdrant.
 */
assets.post('/bulk-ingest', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const { urls, contextTags } = body;
  
  if (!Array.isArray(urls) || urls.length === 0) {
    return c.json({ error: 'An array of "urls" is required' }, 400);
  }
  
  if (urls.length > 10) {
    return c.json({ error: 'Maximum 10 URLs allowed per batch to prevent timeouts.' }, 400);
  }

  try {
    const db = getDb(c.env.DATABASE_URL);
    const ingestService = new BulkIngestService(c.env, db);

    const results = await ingestService.processBatch(urls, contextTags || '');

    const successful = results.filter(r => r.success).length;
    
    return c.json({
      success: true,
      processed: successful,
      total: urls.length,
      results
    });
  } catch (error: any) {
    console.error('[Assets Route] Bulk Ingest failed:', error);
    return c.json({ error: error.message || 'Failed to process bulk ingest' }, 500);
  }
});

/**
 * GET /assets/search-pinterest
 * PUBLIC ROUTE: Searches the Pinterest DB using natural language.
 */
assets.get('/search-pinterest', async (c) => {
  const query = c.req.query('q');
  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  try {
    const assetSearchService = new AssetSearchService(
      c.env.GEMINI_API_KEY,
      c.env.VERTEX_PROJECT_ID,
      c.env.VERTEX_LOCATION,
      c.env.QDRANT_URL,
      c.env.QDRANT_API_KEY,
      c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );

    // 1. Semantic Search in Qdrant
    const searchResults = await assetSearchService.searchPinterestAssets(query, 5);
    const assetIds = searchResults.map(r => r.assetId);

    if (assetIds.length === 0) {
      return c.json({ results: [] });
    }

    // 2. Fetch Metadata and R2 Keys from Postgres
    const db = getDb(c.env.DATABASE_URL);
    
    const queryResult = await db.select()
      .from(privateAssets)
      .where(inArray(privateAssets.id, assetIds));

    // 3. Format response
    const finalResults = searchResults.map(qRes => {
      const dbMatch = queryResult.find(dbRes => dbRes.id === qRes.assetId);
      return {
        id: qRes.assetId,
        score: qRes.score,
        tags: dbMatch?.tags,
        metadata: dbMatch?.parsedData,
        r2Key: dbMatch?.r2Key,
        downloadUrl: dbMatch ? `${c.env.API_URL || 'http://localhost:8787'}/assets/download?key=${encodeURIComponent(dbMatch.r2Key)}` : null
      };
    });

    return c.json({ results: finalResults });
  } catch (error: any) {
    console.error('[Assets Route] Search failed:', error);
    return c.json({ error: error.message || 'Search failed' }, 500);
  }
});

/**
 * GET /assets/download
 * PUBLIC ROUTE: Retrieves an image from R2 using its key.
 */
assets.get('/download', async (c) => {
  const key = c.req.query('key');
  if (!key) {
    return c.text('Missing key parameter', 400);
  }

  const object = await c.env.ASSETS_BUCKET.get(key);
  
  if (object === null) {
    return c.text('Object Not Found', 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);

  return new Response(object.body, {
    headers,
  });
});

/**
 * GET /assets/flush-r2
 * PUBLIC TEMPORARY ROUTE: Deletes all images inside the pinterest_db/ folder in R2.
 */
assets.get('/flush-r2', async (c) => {
  try {
    const list = await c.env.ASSETS_BUCKET.list({ prefix: 'pinterest_db/' });
    const keys = list.objects.map(o => o.key);
    
    if (keys.length === 0) {
      return c.json({ message: 'R2 is already empty for pinterest_db/' });
    }

    await c.env.ASSETS_BUCKET.delete(keys);
    return c.json({ message: `Successfully deleted ${keys.length} items from R2.` });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * POST /assets/upload
 * Handles asset uploads (image/video/doc), extracts AI metadata, and embeds into Qdrant.
 * Auth-free: pass userId in form data or defaults to "dev".
 */
assets.post('/upload', async (c) => {
  const formData = await c.req.parseBody();

  const file = formData['file'];
  const projectId = (formData['projectId'] as string) || 'default';
  const chatId = formData['chatId'] as string | undefined;
  const type = formData['type'] as string || 'image';
  const subtype = formData['subtype'] as string || 'reference';
  const productId = formData['productId'] as string | undefined;
  const userId = (formData['userId'] as string) || 'dev';

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Valid file is required' }, 400);
  }

  try {
    const db = getDb(c.env.DATABASE_URL);
    const uploadService = new AssetUploadService(c.env, db);
    const chatRepo = new ChatRepository(db);

    const asset = await uploadService.processUpload({
      userId,
      projectId,
      chatId,
      file,
      type,
      subtype,
      productId
    });

    const apiUrl = c.env.API_URL || 'http://localhost:8787';
    const downloadUrl = `${apiUrl}/assets/download?key=${encodeURIComponent(asset.url)}`;

    // If this is a chat-based upload, create a message and link it
    if (chatId) {
      const { messageId } = await chatRepo.createMessage({
        projectId,
        userId,
        chatId,
        sender: 'user',
        content: `Uploaded an image: ${downloadUrl}`,
        type: 'image_upload'
      });

      await chatRepo.linkAssetToMessage(messageId, asset.id);
    }

    // 5. Return sanitized response (Safe for Client)
    const safeAsset = {
      id: asset.id,
      url: downloadUrl,
      type: asset.type,
      subtype: asset.subtype,
      tags: asset.tags,
      colors: asset.colors,
      name: (asset.parsedData as any)?.name || null,
      description: (asset.parsedData as any)?.description || null,
      createdAt: asset.createdAt
    };

    return c.json({
      success: true,
      asset: safeAsset,
      message: 'Asset uploaded and processed successfully'
    });
  } catch (error: any) {
    console.error('[Assets Route] Upload failed:', error);
    return c.json({ error: error.message || 'Failed to upload asset' }, 500);
  }
});

// Protect all following routes
assets.use('*', sessionMiddleware);

/**
 * POST /assets/reindex?projectId=
 * Re-indexes all assets for the user (or a specific project) into Qdrant.
 * Safe to run multiple times — uses upsert under the hood.
 */
assets.post('/reindex', async (c) => {
  const user = c.get('user');
  const projectId = c.req.query('projectId');

  const db = getDb(c.env.DATABASE_URL);

  const rows = await db
    .select()
    .from(userAssets)
    .where(
      projectId
        ? and(eq(userAssets.userId, user.id), eq(userAssets.projectId, projectId))
        : eq(userAssets.userId, user.id)
    );

  if (rows.length === 0) {
    return c.json({ success: true, indexed: 0, message: 'No assets found.' });
  }

  const assetSearchService = new AssetSearchService(
    c.env.GEMINI_API_KEY,
    c.env.VERTEX_PROJECT_ID,
    c.env.VERTEX_LOCATION,
    c.env.QDRANT_URL,
    c.env.QDRANT_API_KEY,
    c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
  );

  // Check which assets are already indexed — skip them to conserve quota
  const allIds = rows.map(r => r.id);
  const existingIds = await assetSearchService.getExistingIds(allIds);
  const toIndex = rows.filter(r => !existingIds.has(r.id));

  if (toIndex.length === 0) {
    return c.json({
      success: true,
      total: rows.length,
      indexed: 0,
      skipped: rows.length,
      failed: 0,
      message: 'All assets are already indexed.',
    });
  }

  let indexed = 0;
  let failed = 0;

  for (const asset of toIndex) {
    try {
      const parsedData = asset.parsedData as any;
      const tags = (asset.tags as string[]) ?? [];
      const colors = (asset.colors as string[]) ?? [];

      const description = [
        parsedData?.name       ? `Name: ${parsedData.name}` : null,
        `Type: ${asset.subtype || asset.type || 'image'}`,
        parsedData?.description ? `Description: ${parsedData.description}` : null,
        tags.length             ? `Tags: ${tags.join(', ')}` : null,
        colors.length           ? `Colors: ${colors.join(', ')}` : null,
        asset.angle             ? `Angle: ${asset.angle}` : null,
        asset.background        ? `Background: ${asset.background}` : null,
      ].filter(Boolean).join('\n');

      await assetSearchService.ingest(description, {
        assetId: asset.id,
        userId: asset.userId,
        projectId: asset.projectId,
        type: asset.type || 'image',
        tags,
      });

      indexed++;
      // Pause between embeds to stay within Vertex AI quota
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[Reindex] Failed for asset ${asset.id}:`, err);
      failed++;
      // Longer pause after a 429 to let quota recover
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  return c.json({
    success: true,
    total: rows.length,
    skipped: existingIds.size,
    indexed,
    failed,
    message: `Re-indexed ${indexed}/${toIndex.length} missing assets (${existingIds.size} already indexed).`,
  });
});

// ── Shared label resolver ─────────────────────────────────────────────────────
function resolveLabel(asset: typeof userAssets.$inferSelect): string {
  return (asset.parsedData as any)?.name
    || (asset.tags as string[])?.[0]
    || asset.url?.split('/').pop()
    || 'Untitled';
}

/**
 * GET /assets/list?projectId=
 * Returns all assets for a project with id, label, and download URL.
 * Used by the asset picker UI.
 */
assets.get('/list', async (c) => {
  const user = c.get('user');
  const projectId = c.req.query('projectId');

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);
  const apiUrl = c.env.API_URL || 'http://localhost:8787';

  const rows = await db
    .select()
    .from(userAssets)
    .where(and(eq(userAssets.projectId, projectId), eq(userAssets.userId, user.id)))
    .orderBy(desc(userAssets.createdAt));

  const result = rows.map((a) => ({
    id: a.id,
    label: resolveLabel(a),
    url: `${apiUrl}/assets/download?key=${encodeURIComponent(a.url)}`,
    tags: a.tags,
    colors: a.colors,
    type: a.type,
    subtype: a.subtype,
    createdAt: a.createdAt,
  }));

  return c.json({ assets: result });
});

/**
 * GET /assets/mention?projectId=&q=
 * Semantic search over a project's assets — powers the @ mention autocomplete.
 * If q is empty/short, falls back to returning all project assets.
 */
assets.get('/mention', async (c) => {
  const user = c.get('user');
  const projectId = c.req.query('projectId');
  const q = (c.req.query('q') || '').trim();

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);
  const apiUrl = c.env.API_URL || 'http://localhost:8787';

  let rows: typeof userAssets.$inferSelect[] = [];

  if (q.length >= 2) {
    // Semantic search via Qdrant filtered by project
    try {
      const assetSearchService = new AssetSearchService(
        c.env.GEMINI_API_KEY,
        c.env.VERTEX_PROJECT_ID,
        c.env.VERTEX_LOCATION,
        c.env.QDRANT_URL,
        c.env.QDRANT_API_KEY,
        c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
        c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
      );

      const searchResults = await assetSearchService.searchByProject(q, user.id, projectId, 10);
      const assetIds = searchResults.map((r) => r.assetId);

      if (assetIds.length > 0) {
        const dbResults = await db
          .select()
          .from(userAssets)
          .where(inArray(userAssets.id, assetIds));

        // Preserve relevance order from Qdrant
        rows = searchResults
          .map((r) => dbResults.find((a) => a.id === r.assetId))
          .filter((a): a is typeof userAssets.$inferSelect => !!a);
      }
    } catch (err) {
      console.error('[Assets] Mention search failed, falling back to DB list:', err);
    }
  }

  // Fallback: return all project assets when query is short or search failed
  if (rows.length === 0) {
    rows = await db
      .select()
      .from(userAssets)
      .where(and(eq(userAssets.projectId, projectId), eq(userAssets.userId, user.id)))
      .orderBy(desc(userAssets.createdAt))
      .limit(20);
  }

  const result = rows.map((a) => ({
    id: a.id,
    label: resolveLabel(a),
    url: `${apiUrl}/assets/download?key=${encodeURIComponent(a.url)}`,
  }));

  return c.json({ assets: result });
});

export default assets;
