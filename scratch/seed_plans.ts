import { neon } from '@neondatabase/serverless';
import * as dotenv from 'dotenv';
dotenv.config();

const sql = neon(process.env.DATABASE_URL!);

async function seed() {
  console.log("🌱 Seeding plans...");
  
  try {
    // 1. Clear existing plans if any
    await sql`DELETE FROM "plans"`;

    // 2. Insert Starter Plan
    await sql`
      INSERT INTO "plans" (id, name, price_monthly, monthly_credits)
      VALUES (gen_random_uuid(), 'Starter', 20.00, 200)
    `;

    // 3. Insert Pro Plan
    await sql`
      INSERT INTO "plans" (id, name, price_monthly, monthly_credits)
      VALUES (gen_random_uuid(), 'Pro', 150.00, 1000)
    `;

    console.log("✅ Plans seeded successfully.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
