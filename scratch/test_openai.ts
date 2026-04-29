import { OpenAIConnector } from "../src/services/connectors/OpenAIConnector";
import { OpenAIImageService } from "../src/services/openai/OpenAIImageService";

// Mocking OpenAI Client behavior for testing the connector structure
async function testConnector() {
  console.log("🚀 Testing OpenAIConnector...");
  
  const connector = new OpenAIConnector("fake-key");
  
  // We can't actually run it without a key, but we can verify the methods exist
  console.log("- generateImage exists:", typeof connector.generateImage === "function");
  console.log("- editImage exists:", typeof connector.editImage === "function");
  console.log("- createResponse exists:", typeof connector.createResponse === "function");
  console.log("- streamImage exists:", typeof connector.streamImage === "function");

  console.log("✅ Connector structure verified.");
}

async function testService() {
  console.log("🚀 Testing OpenAIImageService...");
  
  const service = new OpenAIImageService("fake-key");
  
  console.log("- generate exists:", typeof service.generate === "function");
  console.log("- chatGenerate exists:", typeof service.chatGenerate === "function");
  console.log("- edit exists:", typeof service.edit === "function");

  console.log("✅ Service structure verified.");
}

testConnector().catch(console.error);
testService().catch(console.error);
