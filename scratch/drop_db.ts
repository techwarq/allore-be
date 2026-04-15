import { neon } from '@neondatabase/serverless';
import * as dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.env.DATABASE_URL!;
const sql = neon(dbUrl);

async function dropAll() {
  console.log("🌊 Starting database cleanup...");
  
  const tables = [
    "chats", "messages", "projects", "users", "waitlist", 
    "uploaded_assets", "generated_assets", "private_assets", 
    "purchases", "background_generations", "model_generations", 
    "pose_generations", "company_preferences", "user_preferences"
  ];

  const types = ["role", "auth_provider", "message_type", "user_plan"];

  try {
    for (const table of tables) {
      console.log(`- Dropping table ${table}...`);
      // Use tagged template for each
      if (table === "chats") await sql`DROP TABLE IF EXISTS "chats" CASCADE`;
      if (table === "messages") await sql`DROP TABLE IF EXISTS "messages" CASCADE`;
      if (table === "projects") await sql`DROP TABLE IF EXISTS "projects" CASCADE`;
      if (table === "users") await sql`DROP TABLE IF EXISTS "users" CASCADE`;
      if (table === "waitlist") await sql`DROP TABLE IF EXISTS "waitlist" CASCADE`;
      if (table === "uploaded_assets") await sql`DROP TABLE IF EXISTS "uploaded_assets" CASCADE`;
      if (table === "generated_assets") await sql`DROP TABLE IF EXISTS "generated_assets" CASCADE`;
      if (table === "private_assets") await sql`DROP TABLE IF EXISTS "private_assets" CASCADE`;
      if (table === "purchases") await sql`DROP TABLE IF EXISTS "purchases" CASCADE`;
      if (table === "background_generations") await sql`DROP TABLE IF EXISTS "background_generations" CASCADE`;
      if (table === "model_generations") await sql`DROP TABLE IF EXISTS "model_generations" CASCADE`;
      if (table === "pose_generations") await sql`DROP TABLE IF EXISTS "pose_generations" CASCADE`;
      if (table === "company_preferences") await sql`DROP TABLE IF EXISTS "company_preferences" CASCADE`;
      if (table === "user_preferences") await sql`DROP TABLE IF EXISTS "user_preferences" CASCADE`;
    }

    for (const type of types) {
      console.log(`- Dropping type ${type}...`);
      if (type === "role") await sql`DROP TYPE IF EXISTS "role" CASCADE`;
      if (type === "auth_provider") await sql`DROP TYPE IF EXISTS "auth_provider" CASCADE`;
      if (type === "message_type") await sql`DROP TYPE IF EXISTS "message_type" CASCADE`;
      if (type === "user_plan") await sql`DROP TYPE IF EXISTS "user_plan" CASCADE`;
    }

    console.log("✨ Database is now clean.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    process.exit(1);
  }
}

dropAll();
