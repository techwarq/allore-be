
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../src/db/schema';
import { eq } from 'drizzle-orm';

const connectionString = "postgresql://neondb_owner:npg_gknX9ZNuxY1y@ep-bold-cherry-allqdd82-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const sql = neon(connectionString);
const db = drizzle(sql, { schema });

async function main() {
  const email = "sonalinayak0804@gmail.com";
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  
  if (!user) {
    console.log(`❌ User NOT FOUND for email: ${email}`);
    const allUsers = await db.select().from(schema.users).limit(10);
    console.log('--- Sample Users in DB ---');
    console.log(allUsers.map(u => u.email));
  } else {
    console.log(`✅ User FOUND: ${user.id} (${user.email})`);
    const [credits] = await db.select().from(schema.userCredits).where(eq(schema.userCredits.userId, user.id)).limit(1);
    console.log(`Current Credits: ${credits?.creditsRemaining ?? 'No record'}`);
  }
  process.exit(0);
}

main().catch(console.error);
