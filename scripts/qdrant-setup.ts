import * as dotenv from 'dotenv';
import { MemoryService } from '../src/services/memory.service.js';

// Load env vars, prioritizing the local .dev.vars if present or similar strategy,
// or just falling back to process.env.
// In cloudflare we use wrangler.jsonc but for local tsx script we can use dotenv.
dotenv.config({ path: '.env' }); 

async function runSetup() {
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantApiKey = process.env.QDRANT_API_KEY;

  if (!qdrantUrl) {
    console.error('QDRANT_URL is not set in environment variables. Please check your config.');
    // If testing without a dedicated .env, you can substitute the hardcoded cloud URL for quick setup
    console.warn('Fallback to environment variables might be failing. Make sure your cluster URL is provided.');
    process.exit(1);
  }

  console.log(`Connecting to Qdrant cluster at: ${qdrantUrl}`);

  const memoryService = new MemoryService(qdrantUrl, qdrantApiKey);

  try {
    console.log('Initializing collections...');
    await memoryService.initializeCollections();
    console.log('✅ All collections have been successfully verified/created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize collections:', error);
    process.exit(1);
  }
}

runSetup();
