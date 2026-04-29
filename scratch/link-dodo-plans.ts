
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../src/db/schema';
import { eq, or } from 'drizzle-orm';

const connectionString = "postgresql://neondb_owner:npg_gknX9ZNuxY1y@ep-bold-cherry-allqdd82-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const sql = neon(connectionString);
const db = drizzle(sql, { schema });

async function main() {
  console.log('--- Linking Dodo Product IDs ---');

  // Both internal IDs that have been seen in errors
  const planIdsToLink = [
    '992410e3-b8ca-4159-910b-8d2360097e39',
    'f7d88181-4d96-4b8e-953a-f198a913dd78'
  ];

  const result = await db.update(schema.plans)
    .set({ dodoProductId: 'pdt_0Nct6FC8prYQJoQ3DOFh6' })
    .where(
      or(
        eq(schema.plans.name, 'Pro'),
        ...planIdsToLink.map(id => eq(schema.plans.id, id))
      )
    )
    .returning();

  if (result.length > 0) {
    result.forEach(p => console.log(`✅ Linked Plan: ${p.name} (ID: ${p.id}) to Dodo ID: pdt_0Nct6FC8prYQJoQ3DOFh6`));
  } else {
    console.warn('⚠️ No matching plans found to update.');
  }

  process.exit(0);
}

main().catch(console.error);
