import { z } from 'zod';
import { R2Bucket } from '@cloudflare/workers-types';

export interface PinterestPin {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  link: string;
  width: number;
  height: number;
  dominantColor: string;
}

export class PinterestService {
  private static PINTEREST_API_BASE = 'https://www.pinterest.com/resource';

  /**
   * Search for pins using Pinterest's internal Resource API.
   * Requires a valid PINTEREST_COOKIE for unrestricted access.
   */
  static async searchPins(query: string, cookie: string, limit: number = 20): Promise<PinterestPin[]> {
    const csrfToken = cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    const data = {
      options: {
        query: query,
        scope: 'pins',
        page_size: limit,
        no_fetch_context_on_resource: false,
      },
      context: {},
    };

    const url = `${this.PINTEREST_API_BASE}/PinSearchResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify(data))}`;
    
    console.log(`🔍 Pinterest API Search: "${query}" (limit: ${limit})`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken,
        'Referer': 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(query),
        'Cookie': cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`Pinterest API failed: ${response.statusText}`);
    }

    const body = (await response.json()) as any;
    const pins = body.resource_response?.data?.results || [];
    
    console.log(`✅ Pinterest API: Found ${pins.length} pins.`);
    return this.normalizePins(pins);
  }

  /**
   * Get related pins for a specific pin ID.
   */
  static async getRelatedPins(pinId: string, cookie: string, limit: number = 20): Promise<PinterestPin[]> {
    const csrfToken = cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const sourceUrl = `/pin/${pinId}/`;
    const data = {
      options: {
        pin_id: pinId,
        page_size: limit,
        add_pin_id: true,
      },
      context: {},
    };

    const url = `${this.PINTEREST_API_BASE}/RelatedPinsResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify(data))}`;
    
    console.log(`🔍 Pinterest API Related Pins for: ${pinId}`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken,
        'Referer': `https://www.pinterest.com/pin/${pinId}/`,
        'Cookie': cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`Pinterest API failed: ${response.statusText}`);
    }

    const body = (await response.json()) as any;
    const pins = body.resource_response?.data || [];

    return this.normalizePins(pins);
  }

  /**
   * Downloads a Pinterest image and uploads it to R2.
   * Then saves the reference in the private_assets table.
   */
  static async saveToR2(
    db: any,
    bucket: R2Bucket,
    userId: string,
    imageUrl: string,
    metadata: any = {},
    data?: ArrayBuffer,
    contentType?: string
  ): Promise<any> {
    let finalData: any;
    let finalContentType: string;

    if (data && contentType) {
      console.log(`💾 Using provided image data (${contentType})`);
      finalData = data;
      finalContentType = contentType;
    } else {
      console.log(`🌐 Fetching image: ${imageUrl.substring(0, 50)}...`);
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
        },
      });

      if (!response.ok) {
        if (response.status === 403) {
          console.warn(`🛡️  Direct fetch blocked (403 Forbidden) for ${imageUrl}`);
          throw new Error("FORBIDDEN_DIRECT_FETCH");
        }
        console.error(`❌ Failed to fetch image: ${response.status} ${response.statusText}`);
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }

      finalData = response.body;
      finalContentType = response.headers.get('Content-Type') || 'image/jpeg';
    }

    const extension = finalContentType.split('/')[1] || 'jpg';
    const fileName = `private/${userId}/${crypto.randomUUID()}.${extension}`;
    
    console.log(`📤 Uploading to R2: ${fileName} (${finalContentType})...`);
    // Upload to R2
    await bucket.put(fileName, finalData, {
      httpMetadata: { contentType: finalContentType },
    });

    // Save to Database
    console.log(`🗄️  Saving asset reference to database...`);
    const [asset] = await db.insert((await import('../db/schema')).privateAssets).values({
      userId,
      fileName,
      originalUrl: imageUrl,
      contentType: finalContentType,
      metadata,
    }).returning();
    
    console.log(`✅ Asset saved successfully: ${asset.id}`);
    return asset;
  }

  /**
   * Normalizes raw Pinterest API data and upgrades image URLs to high-res.
   */
  private static normalizePins(rawPins: any[]): PinterestPin[] {
    return rawPins
      .filter((pin) => pin.id && pin.images)
      .map((pin) => {
        // Upgrade image URL to 736x or original
        const rawUrl = pin.images?.orig?.url || pin.images?.['736x']?.url || pin.images?.['474x']?.url;
        const highResUrl = rawUrl ? rawUrl.replace(/\/(236x|474x|564x)\//, '/736x/') : '';

        return {
          id: pin.id,
          title: pin.title || pin.pinner?.full_name || '',
          description: pin.description || '',
          imageUrl: highResUrl,
          link: `https://www.pinterest.com/pin/${pin.id}/`,
          width: pin.images?.orig?.width || 736,
          height: pin.images?.orig?.height || 1000,
          dominantColor: pin.dominant_color || '#ffffff',
        };
      });
  }
}
