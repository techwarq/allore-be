import { PinterestBrowserService } from "../src/services/pinterest-browser.service";
import * as dotenv from "dotenv";
import path from "path";

// Load environment variables from .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const GEMINI_KEY = process.env.GEMINI_API_KEY || "AIzaSyDfAuiYfy7OvUvJAqOEHcYi7d0w3aWPpGs";
  const PINTEREST_EMAIL = process.env.PINTEREST_EMAIL;
  const PINTEREST_PASSWORD = process.env.PINTEREST_PASSWORD;
  const PINTEREST_COOKIE = process.env.PINTEREST_COOKIE;
  
  console.log("🚀 Starting Pinterest LOCAL Demo...");
  console.log("⚠️  A Chrome window should pop up shortly.");

  const service = new PinterestBrowserService(
    GEMINI_KEY,
    process.env.BROWSERBASE_API_KEY || "",
    process.env.BROWSERBASE_PROJECT_ID || "default",
    (process.env.STAGEHAND_ENV as any) || "LOCAL",
    PINTEREST_EMAIL,
    PINTEREST_PASSWORD,
    PINTEREST_COOKIE
  );

  try {
    await service.init();
    
    const query = "modern luxury fashion";
    console.log(`🔍 Searching Pinterest for: "${query}"`);
    
    const results = await service.searchPinterest(query, 3, true); // analyze = true to test Gemini too
    
    console.log("\n✨ SCRAPE SUCCESSFUL! ✨");
    console.log("Found Pins:", results.length);
    results.forEach((pin, i) => {
      console.log(`\nPin ${i + 1}:`);
      console.log(`- Image: ${pin.imageUrl}`);
      console.log(`- Analysis: ${pin.analysis?.substring(0, 100)}...`);
    });

  } catch (error) {
    console.error("❌ Demo Failed:", error);
  } finally {
    console.log("\n👋 Closing browser in 5 seconds...");
    setTimeout(async () => {
      await service.close();
      process.exit(0);
    }, 5000);
  }
}

main();
