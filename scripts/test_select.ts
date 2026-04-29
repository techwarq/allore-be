import { getDb } from '../src/db/index';
import { privateAssets } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("No DB URL");
  
  const db = getDb(dbUrl);
  try {
    const res = await db.select().from(privateAssets).where(eq(privateAssets.id, 'f5fcd6b7-f2ad-493f-8239-c2ab402c0161'));
    console.log("Success:", res);
  } catch (err: any) {
    console.error("FAILED.", err.message);
  }
  process.exit(0);
}

main();
