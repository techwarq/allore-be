import { Stagehand } from "@browserbasehq/stagehand";

async function test() {
  console.log("🚀 Starting Stagehand test...");
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: { 
      modelName: "google/gemini-2.0-flash", 
      apiKey: "AIzaSyDfAuiYfy7OvUvJAqOEHcYi7d0w3aWPpGs" // From .env
    },
  });

  try {
    await stagehand.init();
    console.log("✅ Stagehand initialized successfully!");
    const page = stagehand.page;
    await page.goto("https://google.com");
    console.log("🌐 Navigated to Google");
    await stagehand.close();
    console.log("👋 Closed Stagehand");
  } catch (err) {
    console.error("❌ Stagehand test failed:", err);
  }
}

test();
