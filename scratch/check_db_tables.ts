import { neon } from '@neondatabase/serverless';
import * as dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.env.DATABASE_URL!;
const sql = neon(dbUrl);

async function checkTables() {
  try {
    const result = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    console.log("📍 Current Tables in DB:");
    console.table(result);
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to fetch tables:", err);
    process.exit(1);
  }
}

checkTables();
