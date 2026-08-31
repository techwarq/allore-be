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

    // 2. Verify the cookie actually produced a real session. Checking whether
    // the login FORM is absent (the old check) is a false-positive trap: a
    // stale/expired cookie still lands on a guest page with no login form
    // visible, so that check reported "already logged in" even when it
    // wasn't. Navigate to the real homepage and look for an actual logged-in
    // indicator (profile button) instead.
    await page.goto("https://www.pinterest.com/", { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2500));
    let loggedIn = await this.checkLoggedIn(page);
    console.log(loggedIn ? "✅ Cookie session confirmed active." : "⚠️ Cookie session not active (cookie missing/expired).");

    // 3. Fall back to a real credential login only if the cookie session
    // couldn't be confirmed — not gated on a login-form-presence guess.
    if (!loggedIn && this.email && this.password) {
      console.log(`🔑 Logging in as ${this.email}...`);
      await page.goto("https://www.pinterest.com/login/", { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 2000));

      // This `page` came from context.pages()[0] (Stagehand's own .page wasn't
      // populated yet) — it only proxies a subset of the Playwright API.
      // page.$()/page.act() aren't on it, but page.evaluate() is (confirmed —
      // the cookie-injection overlay-removal step above uses it fine), so the
      // whole fill+submit happens inside the page via evaluate. Pinterest's
      // inputs are React-controlled, so a plain `el.value = x` doesn't
      // register — the native-setter + dispatchEvent('input') trick is
      // required for React to see the change.
      // No inner named/const-assigned helper functions — see the comment on
      // the image-extraction evaluate() below for why (esbuild __name wrapper
      // breaks once this is serialized and run standalone in the page).
      // Both fields are filled inline instead of through a shared helper.
      const result = await page.evaluate(
        ({ email, password }: { email: string; password: string }) => {
          try {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

            const emailEl = document.querySelector<HTMLInputElement>(
              '#email, input[name="id"], input[type="email"], input[autocomplete="username"]'
            );
            const passwordEl = document.querySelector<HTMLInputElement>(
              '#password, input[name="password"], input[type="password"]'
            );
            if (!emailEl || !passwordEl) return { ok: false, reason: "fields not found" };

            if (setter) setter.call(emailEl, email); else emailEl.value = email;
            emailEl.dispatchEvent(new Event("input", { bubbles: true }));
            emailEl.dispatchEvent(new Event("change", { bubbles: true }));

            if (setter) setter.call(passwordEl, password); else passwordEl.value = password;
            passwordEl.dispatchEvent(new Event("input", { bubbles: true }));
            passwordEl.dispatchEvent(new Event("change", { bubbles: true }));

            const submitBtn =
              document.querySelector<HTMLButtonElement>('button[type="submit"]') ||
              Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
                /log ?in/i.test(b.textContent || "")
              );
            if (!submitBtn) return { ok: false, reason: "submit button not found" };
            submitBtn.click();
            return { ok: true };
          } catch (err: any) {
            return { ok: false, reason: err?.message || String(err) };
          }
        },
        { email: this.email, password: this.password }
      );

      if (!result.ok) {
        console.warn(`⚠️ Could not auto-fill the login form (${result.reason}) — layout may have changed.`);
      }

      await new Promise((r) => setTimeout(r, 3500));
      loggedIn = await this.checkLoggedIn(page);
      console.log(loggedIn ? "✅ Logged in with credentials." : "⚠️ Credential login could not be confirmed either — scraping may return guest-limited/empty results. Pinterest may be showing a CAPTCHA or 2FA challenge that needs a manual pass in the open Chrome window.");
    }
  }

  /**
   * Real logged-in check — looks for an actual profile/account indicator,
   * not the absence of a login form (which false-positives on stale cookies).
   */
  private async checkLoggedIn(page: any): Promise<boolean> {
    return page.evaluate(() => {
      const selectors = [
        '[data-test-id="header-profile-button"]',
        '[aria-label="Profile"]',
        'div[data-test-id="HeaderContent"] img[src*="profile_images"]',
      ];
      return selectors.some((s) => !!document.querySelector(s));
    });
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
  async searchPinterest(query: string, limit: number = 5, analyze: boolean = false, scrollSteps: number = 2): Promise<PinterestBrowserPin[]> {
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

    // Pinterest never goes fully network-idle — it keeps analytics beacons and
    // a live-update websocket open indefinitely, so `waitUntil: "networkidle"`
    // reliably hard-times-out here instead of ever resolving. "domcontentloaded"
    // fires as soon as the DOM is parsed; the explicit sleep after it gives the
    // client-side app time to hydrate/render pins before we start querying it.
    await page.goto(pinterestUrl, { waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 3000));

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
      await page.goto(pinterestUrl, { waitUntil: "domcontentloaded" });
      await new Promise(r => setTimeout(r, 3000));
    }

    // Verify if we are logged in by checking for a profile element or similar
    const isLoggedIn = await this.checkLoggedIn(page);
    console.log(isLoggedIn ? "✅ Confirmed: Session is active." : "⚠️ Warning: Could not confirm active session. Results might be limited.");

    if (!isLoggedIn) {
      const debugPath = `/tmp/pinterest-debug-${Date.now()}.png`;
      try {
        await page.screenshot({ path: debugPath, fullPage: false });
        console.log(`📸 Saved a screenshot of what the page actually looks like: ${debugPath}`);
      } catch {}
    }

    // Scroll — a larger scrollSteps lets callers build a bigger candidate pool
    // (e.g. for curation pipelines that filter/rank afterward) than the
    // default quick-pick used by the chat vibe-picker gate.
    for (let i = 0; i < scrollSteps; i++) {
      console.log(`🖱️  Scrolling to load more content (Step ${i + 1}/${scrollSteps})...`);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise(r => setTimeout(r, 2000));
    }

    // No inner named/const-assigned helper functions here — esbuild's
    // `__name` name-preservation wrapper (triggered by this file having a
    // class) gets baked into any such function when tsx transpiles it, and
    // that wrapper call fails at runtime once Stagehand serializes this
    // callback and runs it standalone inside the page (no `__name` there).
    // Logic is inlined per-call-site instead. Errors are surfaced instead of
    // swallowed so a real failure doesn't read as "found 0 images".
    const extraction: { urls: string[]; error?: string } = await page.evaluate((maxCount: number) => {
      try {
        const candidates: string[] = [];
        document.querySelectorAll("img").forEach((img) => {
          const src = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("srcset")?.split(" ")[0];
          if (src && src.startsWith("http") && !src.includes("profile_images") && !src.includes("data:image")) {
            candidates.push(src.includes("pinimg.com") ? src.replace(/\/(236x|474x|60x60|136x136)\//, "/736x/") : src);
          }
        });

        // Also look for background images in Pinterest's grid
        document.querySelectorAll('div[data-test-id="pin-visual-wrapper"] img').forEach((img) => {
          const src = (img as HTMLImageElement).src;
          if (src) candidates.push(src.includes("pinimg.com") ? src.replace(/\/(236x|474x|60x60|136x136)\//, "/736x/") : src);
        });
        return { urls: Array.from(new Set(candidates)).slice(0, maxCount) };
      } catch (err: any) {
        return { urls: [], error: err?.message || String(err) };
      }
    }, limit);

    const imageUrls = extraction.urls;
    if (extraction.error) console.warn(`⚠️ Image extraction hit an error in-page: ${extraction.error}`);
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
