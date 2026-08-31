import { PinterestService, PinterestPin } from "./pinterest.service";
import { PinterestBrowserService } from "./pinterest-browser.service";

export interface PinterestVibeEnv {
  PINTEREST_COOKIE?: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  STAGEHAND_ENV?: "BROWSERBASE" | "LOCAL";
  PINTEREST_EMAIL?: string;
  PINTEREST_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  VERTEX_PROJECT_ID?: string;
  VERTEX_LOCATION?: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  API_URL?: string;
}

export interface VibeOption {
  id: string;
  imageUrl: string;
  title: string;
  description: string;
  pinUrl?: string;
}

/**
 * Real Pinterest reference images for the shoot vibe-picker gate — deliberately
 * NOT AI-generated previews and NOT the internal pinterest_assets Qdrant
 * collection (both were explicitly ruled out). Prefers the fast cookie-based
 * internal Resource API (PinterestService); falls back to full browser
 * automation with login (PinterestBrowserService) when no cookie is configured
 * or the fast path comes back empty. Fails closed (returns []) on any error —
 * the calling gate treats an empty result as "Pinterest unavailable this turn"
 * and falls through to the plain text brief question rather than blocking the
 * shoot.
 */
export async function fetchPinterestVibes(
  env: PinterestVibeEnv,
  query: string,
  limit = 4
): Promise<VibeOption[]> {
  if (env.PINTEREST_COOKIE) {
    try {
      const pins = await PinterestService.searchPins(query, env.PINTEREST_COOKIE, limit);
      if (pins.length > 0) {
        return pins.slice(0, limit).map((p, i) => pinToVibeOption(p, i, env));
      }
    } catch (err: any) {
      console.warn("[PinterestVibe] Cookie-based search failed, falling back to browser:", err.message);
    }
  }

  if (!env.BROWSERBASE_API_KEY) {
    console.warn("[PinterestVibe] No PINTEREST_COOKIE result and no BROWSERBASE_API_KEY configured — skipping.");
    return [];
  }

  const browser = new PinterestBrowserService(
    env.GEMINI_API_KEY || "",
    env.BROWSERBASE_API_KEY,
    env.VERTEX_PROJECT_ID || "",
    env.VERTEX_LOCATION || "",
    env.BROWSERBASE_PROJECT_ID || "default",
    // Always BROWSERBASE here, regardless of env.STAGEHAND_ENV — this code
    // runs inside a Cloudflare Worker (even under `wrangler dev`), which
    // cannot spawn a native local Chrome process the way Stagehand's LOCAL
    // mode requires (it needs CHROME_PATH pointing at a real browser
    // executable on the host, which doesn't exist in a Workers runtime).
    // BROWSERBASE connects to a remote browser over the network instead,
    // which works fine from a Worker. If env.STAGEHAND_ENV=LOCAL, that's a
    // config meant for the standalone Node scripts (scripts/pinterest-demo.ts,
    // company-research.service.ts), not this code path.
    "BROWSERBASE",
    env.PINTEREST_EMAIL,
    env.PINTEREST_PASSWORD,
    env.PINTEREST_COOKIE,
    env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
  );

  try {
    await browser.init();
    const pins = await browser.searchPinterest(query, limit, false);
    return pins.slice(0, limit).map((p, i) => ({
      id: `vibe_${i}`,
      imageUrl: proxyImageUrl(env, p.imageUrl),
      title: `Vibe ${i + 1}`,
      description: query,
    }));
  } catch (err: any) {
    console.warn("[PinterestVibe] Browser-based search failed:", err.message);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

function pinToVibeOption(p: PinterestPin, i: number, env: PinterestVibeEnv): VibeOption {
  return {
    id: `vibe_${i}`,
    imageUrl: proxyImageUrl(env, p.imageUrl),
    title: p.title || `Vibe ${i + 1}`,
    description: p.description || p.title || "",
    pinUrl: p.link,
  };
}

// react-konva's useImage (the vibe-picker canvas) loads images with
// crossOrigin="anonymous" — i.pinimg.com sends no Access-Control-Allow-Origin
// header, so the browser silently refuses to draw it. Route through our own
// CORS-enabled proxy instead of handing the frontend Pinterest's raw CDN URL.
function proxyImageUrl(env: PinterestVibeEnv, url: string): string {
  if (!env.API_URL || !url) return url;
  return `${env.API_URL}/assets/proxy-image?url=${encodeURIComponent(url)}`;
}
