/// <reference lib="dom" />
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { TextService } from "./gemini/TextService";

export interface PinterestBrowserPin {
  imageUrl: string;
  analysis?: string;
}

export class PinterestBrowserService {
  private stagehand: Stagehand;
  private apiKey: string;
  private browserbaseApiKey: string;
  private vertexProjectId: string;
  private vertexLocation: string;
  private projectId: string;
  private stagehandEnv: "BROWSERBASE" | "LOCAL";
  private email?: string;
  private password?: string;
  private cookieString?: string;
  private serviceAccountEmail?: string;
  private privateKey?: string;

  constructor(
    apiKey: string,
    browserbaseApiKey: string,
    vertexProjectId: string,
    vertexLocation: string,
    browserbaseProjectId: string = "default",
    stagehandEnv: "BROWSERBASE" | "LOCAL" = "BROWSERBASE",
    email?: string,
    password?: string,
    cookieString?: string,
    serviceAccountEmail?: string,
    privateKey?: string
  ) {
    this.apiKey = apiKey;
    this.browserbaseApiKey = browserbaseApiKey;
    this.vertexProjectId = vertexProjectId;
    this.vertexLocation = vertexLocation;
    this.projectId = browserbaseProjectId;
    this.stagehandEnv = stagehandEnv;
    this.email = email;
    this.password = password;
    this.cookieString = cookieString;
    this.serviceAccountEmail = serviceAccountEmail;
    this.privateKey = privateKey;

    this.stagehand = new Stagehand({
      env: this.stagehandEnv,
      apiKey: this.stagehandEnv === "BROWSERBASE" ? this.browserbaseApiKey : undefined,
      projectId: (this.stagehandEnv === "BROWSERBASE" && this.projectId && this.projectId !== "default") ? this.projectId : undefined,
      verbose: 1,
      model: { 
        modelName: "google/gemini-1.5-flash", 
        apiKey: this.apiKey 
      },
    });
  }

  async init() {
    console.log(`🤖 Initializing Stagehand (${this.stagehandEnv})...`);
    await this.stagehand.init();
    console.log(`✅ Stagehand initialized.`);
    
    // Perform Sign-In if credentials/cookies are available
    if (this.cookieString || (this.email && this.password)) {
      await this.signIn();
    }
  }

  /**
   * Authenticats the browser session using cookies or credentials.
   */
  async signIn() {
    let page = (this.stagehand as any).page;
    const context = this.stagehand.context;
    
    if (!page) {
      console.log("🔍 Page missing from stagehand.page during signIn, checking context.pages()...");
      page = context.pages()[0];
    }

    if (!page) {
      console.warn("⚠️ No page found in Stagehand during signIn. Context pages:", context.pages().length);
      return;
    }

    // 1. Try Cookie Injection first (Fastest)
    if (this.cookieString) {
      console.log("🍪 Injecting Pinterest cookies...");
      try {
        const cookies = this.cookieString.split(';').map(c => {
          const parts = c.trim().split('=');
          if (parts.length < 2) return null;
          const name = parts[0];
          const value = parts.slice(1).join('=');
          
          return {
            name,
            value,
            domain: '.pinterest.com',
            path: '/',
            secure: name.startsWith('__Secure-'),
            sameSite: 'Lax' as const,
          };
        }).filter((c): c is NonNullable<typeof c> => c !== null);

        await context.addCookies(cookies);
        console.log("✅ Cookies injected.");
      } catch (err: any) {
        console.warn("⚠️ Cookie injection failed, falling back to manual login window if available:", err.message);
      }
    }

    // 2. Fallback to Credential Login if email/password present
    if (this.email && this.password) {
      console.log("🔑 Checking if manual sign-in is required...");
      await page.goto("https://www.pinterest.com/login/");
      
      const isLoggedOut = await page.evaluate(() => {
        return !!document.querySelector('input[id="email"]') || !!document.querySelector('input[name="id"]');
      });

      if (isLoggedOut) {
        console.log(`👤 Logging in as ${this.email}...`);
        await page.act({
          action: `Sign in to Pinterest using email "${this.email}" and password "${this.password}"`,
        });
        console.log("✅ Logged in successfully.");
      } else {
        console.log("✅ Already logged in (likely via cookies).");
      }
    }
  }

  /**
   * Fetches the image INSIDE the browser context to avoid 403 Forbidden.
   */
  private async analyzeImage(page: any, imageUrl: string, prompt: string): Promise<string> {
    try {
      console.log(`🖼️ Analyzing image in-browser: ${imageUrl}`);

      const { base64Data, mimeType } = await page.evaluate(async (url: string) => {
        try {
          const response = await fetch(url);
          const blob = await response.blob();
          return new Promise<{ base64Data: string; mimeType: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve({ base64Data: (reader.result as string).split(",")[1], mimeType: blob.type });
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (err) {
          return { base64Data: "", mimeType: "" };
        }
      }, imageUrl);

      if (!base64Data) return "Analysis failed: Could not fetch image data.";

      const connector = new TextService(this.apiKey, this.vertexProjectId, this.vertexLocation, this.serviceAccountEmail, this.privateKey);
      const analysis = await connector.generateText({
        contents: [{
          role: "user",
          parts: [
            { text: `Analyze this image for fashion research: ${prompt}` },
            { inlineData: { mimeType: mimeType || "image/jpeg", data: base64Data } },
          ],
        }],
      }) || "No analysis.";

      console.log(`✅ Analysis complete for: ${imageUrl.substring(0, 50)}...`);
      return analysis;
    } catch (error: any) {
      console.error(`❌ Analysis failed for ${imageUrl}:`, error.message);
      return `Analysis failed: ${error.message}`;
    }
  }

  /**
   * Performs high-res image extraction from Pinterest using an automated browser.
   */
  async searchPinterest(query: string, limit: number = 5, analyze: boolean = false): Promise<PinterestBrowserPin[]> {
    let page = (this.stagehand as any).page;
    
    if (!page) {
      console.log("🔍 Page missing from stagehand.page, checking context.pages()...");
      page = this.stagehand.context.pages()[0];
    }

    if (!page) {
      throw new Error("No page found in Stagehand context. Ensure Stagehand is initialized.");
    }
    
    // Ensure we have setViewportSize (it might be the Stagehand one or Playwright one)
    if (typeof page.setViewportSize === 'function') {
      try {
        await page.setViewportSize({ width: 1280, height: 800 });
      } catch (e) {
        // Fallback for playwright style
        await page.setViewportSize(1280, 800);
      }
    }

    const pinterestUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
    console.log(`🌐 Navigating to Pinterest: ${pinterestUrl}`);

    await page.goto(pinterestUrl, { waitUntil: "networkidle" });

    // Bypass modals and login walls
    console.log(`🛡️  Checking for overlays/modals...`);
    await page.evaluate(() => {
      // Remove login overlays
      const selectors = [
        '[class*="Overlay"]', 
        '[class*="Modal"]', 
        'div[role="dialog"]',
        '#register_modal',
        '.FullPageSignupModal'
      ];
      selectors.forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          if (el.textContent?.toLowerCase().includes("log") || el.textContent?.toLowerCase().includes("sign up")) {
            el.remove();
          }
        });
      });
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "auto";
    });

    // If still on login page or redirected, try to go back to search
    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("signup")) {
      console.log("⚠️ Redirected to login. Attempting to force navigation back to search...");
      await page.goto(pinterestUrl, { waitUntil: "networkidle" });
    }

    // Verify if we are logged in by checking for a profile element or similar
    const isLoggedIn = await page.evaluate(() => {
      const selectors = [
        '[data-test-id="header-profile-button"]',
        '[aria-label="Profile"]',
        'div[data-test-id="HeaderContent"] img[src*="profile_images"]'
      ];
      return selectors.some(s => !!document.querySelector(s));
    });
    console.log(isLoggedIn ? "✅ Confirmed: Session is active." : "⚠️ Warning: Could not confirm active session. Results might be limited.");

    // Scroll
    for (let i = 0; i < 2; i++) {
      console.log(`🖱️  Scrolling to load more content (Step ${i + 1}/2)...`);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise(r => setTimeout(r, 2000));
    }

    const imageUrls: string[] = await page.evaluate((maxCount: number) => {
      try {
        const candidates: string[] = [];
        const getHighResUrl = (url: string) => {
          if (!url) return "";
          if (url.includes("pinimg.com")) return url.replace(/\/(236x|474x|60x60|136x136)\//, "/736x/");
          return url;
        };
        document.querySelectorAll("img").forEach(img => {
          const src = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("srcset")?.split(" ")[0];
          if (src && src.startsWith("http") && !src.includes("profile_images") && !src.includes("data:image")) {
            candidates.push(getHighResUrl(src));
          }
        });
        
        // Also look for background images in Pinterest's grid
        document.querySelectorAll('div[data-test-id="pin-visual-wrapper"] img').forEach(img => {
          const src = (img as HTMLImageElement).src;
          if (src) candidates.push(getHighResUrl(src));
        });
        return Array.from(new Set(candidates)).slice(0, maxCount);
      } catch (err) {
        return [];
      }
    }, limit);

    console.log(`✨ Found ${imageUrls.length} unique images.`);

    const results: PinterestBrowserPin[] = [];
    for (const url of imageUrls) {
      const pin: PinterestBrowserPin = { imageUrl: url };
      if (analyze) {
        pin.analysis = await this.analyzeImage(page, url, query);
      }
      results.push(pin);
    }
    return results;
  }

  /**
   * Dedicated fetch method to get image bytes using the browser context.
   * Useful when direct fetch from Worker is blocked by 403 Forbidden.
   */
  async fetchImage(imageUrl: string): Promise<{ data: ArrayBuffer; contentType: string }> {
    if (!this.stagehand.context) {
      await this.init();
    }
    let page = (this.stagehand as any).page || this.stagehand.context.pages()[0];
    if (!page) throw new Error("No page available in Stagehand context.");
    
    console.log(`📥 Fetching image data in-browser for fallback: ${imageUrl.substring(0, 50)}...`);
    const result = await page.evaluate(async (url: string) => {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise<{ base64Data: string; mimeType: string }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({
          base64Data: (reader.result as string).split(",")[1],
          mimeType: blob.type
        });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, imageUrl);

    const binaryString = atob(result.base64Data);
    const length = binaryString.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    return {
      data: bytes.buffer,
      contentType: result.mimeType
    };
  }

  async close() {
    console.log(`👋 Closing Stagehand...`);
    await this.stagehand.close();
    console.log(`✅ Stagehand closed.`);
  }
}
