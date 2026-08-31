import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenRouterTextService, OPENROUTER_EMBEDDING_MODELS } from "../core/ai-models/openrouter/OpenRouterTextService";

export interface StyleMemoryEnv {
  OPENROUTER_API_KEY: string;
  QDRANT_URL: string;
  QDRANT_API_KEY?: string;
  // Only needed to call getSignedUrl() — a caller running inside the Worker
  // with a direct ASSETS_BUCKET binding can skip this and sign URLs itself
  // via lib/r2's getSignedR2Url instead.
  API_URL?: string;
}

export interface StyleMatch {
  styleId: string;
  score: number;
  queries: string[];
  styleMemory: any;
  referenceIds: string[];
}

export interface ReferenceMatch {
  referenceId: string;
  styleId: string;
  score: number;
  sourceUrl: string; // Pinterest provenance only — don't serve this, it can 403/expire/get deleted
  r2Key: string | null; // durable — re-sign via getSignedUrl() rather than caching a URL
  signedUrl: string | null; // snapshot from curation time (7-day expiry) — fine for quick checks, not for production serving
  analysis: any;
  tags: string[];
}

// Must match what scripts/pinterest-style-curator.ts writes into Qdrant.
const STYLE_MEMORY_COLLECTION = "style_memory";
const STYLE_REFERENCES_COLLECTION = "style_references";
const EMBEDDING_MODEL = OPENROUTER_EMBEDDING_MODELS.PPLX_EMBED_V1_0_6B;

/**
 * Retrieval side of the Style Memory / Reference Bank system curated by
 * scripts/pinterest-style-curator.ts. Two-stage lookup — find the
 * best-matching style first, then rank+return references from WITHIN that
 * style — rather than one flat nearest-neighbor search across every
 * reference of every style. A flat search lets a reference from the wrong
 * style outrank a worse-scoring one from the right style just because its
 * wording happens to be closer to the query; filtering to a style first
 * makes sure the images that come back all actually belong to one visual
 * language.
 *
 * There's no category layer yet (see the "Style x Category" idea from the
 * original design doc) — this only does style-level retrieval. Category
 * compatibility filtering is a follow-up once category memory exists.
 */
export class StyleMemoryService {
  private qdrant: QdrantClient;
  private openrouter: OpenRouterTextService;
  private apiUrl?: string;

  constructor(env: StyleMemoryEnv) {
    this.qdrant = new QdrantClient({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY });
    this.openrouter = new OpenRouterTextService(env.OPENROUTER_API_KEY);
    this.apiUrl = env.API_URL;
  }

  /**
   * Mints a fresh signed URL for a reference's R2 key. The signedUrl cached
   * on a ReferenceMatch was snapshotted at curation time and expires in 7
   * days — callers that need a URL to actually last (e.g. handing it to an
   * image-gen model) should call this instead of using that snapshot.
   */
  async getSignedUrl(r2Key: string): Promise<string> {
    if (!this.apiUrl) throw new Error("StyleMemoryService: API_URL is required to call getSignedUrl().");
    const res = await fetch(`${this.apiUrl}/dev/style-images/signed-url?key=${encodeURIComponent(r2Key)}`);
    if (!res.ok) throw new Error(`Failed to sign URL for ${r2Key}: ${await res.text()}`);
    const json: any = await res.json();
    return json.signedUrl;
  }

  /** Stage 1 — which style(s) best match a free-text request. */
  async findStyles(query: string, limit = 3): Promise<StyleMatch[]> {
    const vector = await this.openrouter.getEmbedding(query, EMBEDDING_MODEL);
    const results = await this.qdrant.search(STYLE_MEMORY_COLLECTION, {
      vector,
      limit,
      with_payload: true,
    });
    return results.map(toStyleMatch);
  }

  /** Exact lookup by style_id — no embedding call, just a payload filter. */
  async getStyleById(styleId: string): Promise<StyleMatch | null> {
    const { points } = await this.qdrant.scroll(STYLE_MEMORY_COLLECTION, {
      filter: { must: [{ key: "style_id", match: { value: styleId } }] },
      limit: 1,
      with_payload: true,
    });
    const point = points[0];
    return point ? toStyleMatch({ ...point, score: 1 }) : null;
  }

  /** Stage 2 — best references WITHIN a given style, ranked against the request. */
  async getReferences(styleId: string, query: string, limit = 5): Promise<ReferenceMatch[]> {
    const vector = await this.openrouter.getEmbedding(query, EMBEDDING_MODEL);
    const results = await this.qdrant.search(STYLE_REFERENCES_COLLECTION, {
      vector,
      filter: { must: [{ key: "style_id", match: { value: styleId } }] },
      limit,
      with_payload: true,
    });
    return results.map(toReferenceMatch);
  }

  /**
   * High-level entry point — everything a downstream "Shoot Director"
   * prompt-generation step needs: the matched style (+ its Style Memory
   * JSON) and its top-N references. Pass `styleId` to pin a specific style
   * (skips the style-matching embedding call entirely); omit it to let the
   * request itself pick the best-fitting style.
   */
  async retrieve(
    query: string,
    opts: { styleId?: string; referenceLimit?: number } = {}
  ): Promise<{ style: StyleMatch | null; references: ReferenceMatch[] }> {
    const style = opts.styleId ? await this.getStyleById(opts.styleId) : (await this.findStyles(query, 1))[0] ?? null;

    if (!style) return { style: null, references: [] };

    const references = await this.getReferences(style.styleId, query, opts.referenceLimit ?? 5);
    return { style, references };
  }
}

function toStyleMatch(r: any): StyleMatch {
  return {
    styleId: r.payload?.style_id,
    score: r.score,
    queries: r.payload?.queries ?? [],
    styleMemory: r.payload?.style_memory,
    referenceIds: r.payload?.reference_ids ?? [],
  };
}

function toReferenceMatch(r: any): ReferenceMatch {
  return {
    referenceId: r.payload?.reference_id,
    styleId: r.payload?.style_id,
    score: r.score,
    sourceUrl: r.payload?.source_url,
    r2Key: r.payload?.r2_key ?? null,
    signedUrl: r.payload?.r2_signed_url ?? null,
    analysis: r.payload?.image_analysis,
    tags: r.payload?.tags ?? [],
  };
}
