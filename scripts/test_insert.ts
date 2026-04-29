import { getDb } from '../src/db/index';
import { privateAssets } from '../src/db/schema';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("No DB URL");
  
  const db = getDb(dbUrl);
  try {
    const res = await db.insert(privateAssets).values({
      r2Key: "test",
      tags: ["tag1"],
      colors: ["#fff"],
      angle: "test",
      background: "test",
      parsedData: { test: true }
    }).returning();
    console.log("Success:", res);
  } catch (err: any) {
    console.error("FAILED.");
    console.error("Message:", err.message);
    console.error("Code:", err.code);
    console.error("Detail:", err.detail);
    console.error("Cause:", err.cause);
    console.error("Full object:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  }
  process.exit(0);
}

main();
