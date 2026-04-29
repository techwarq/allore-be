
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../src/db/schema';
import { eq } from 'drizzle-orm';

const connectionString = "postgresql://neondb_owner:npg_gknX9ZNuxY1y@ep-bold-cherry-allqdd82-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const sql = neon(connectionString);
const db = drizzle(sql, { schema });

async function main() {
  const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.id, 'f7d88181-4d96-4b8e-953a-f198a913dd78')).limit(1);
  console.log(JSON.stringify(plan, null, 2));
}

main().catch(console.error);
