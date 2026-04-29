import { getDb } from '../src/db/index';
import { sql } from 'drizzle-orm';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("No DB URL");
  
  const db = getDb(dbUrl);
  console.log("Truncating private_assets table...");
  await db.execute(sql`TRUNCATE TABLE private_assets CASCADE;`);
  console.log("Done.");
  process.exit(0);
}

main();
