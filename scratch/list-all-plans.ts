
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../src/db/schema';

const connectionString = "postgresql://neondb_owner:npg_gknX9ZNuxY1y@ep-bold-cherry-allqdd82-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const sql = neon(connectionString);
const db = drizzle(sql, { schema });

async function main() {
  const allPlans = await db.select().from(schema.plans);
  console.log('--- Current Plans in Database ---');
  console.log(JSON.stringify(allPlans, null, 2));
  process.exit(0);
}

main().catch(console.error);
