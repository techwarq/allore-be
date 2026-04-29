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
      r2Key: "pinterest_db/1776513503167-97d9bb74-d174-43a4-be2b-5f1f624547d0.jpeg",
      tags: ["minimal luxury fashion","South Asian fashion","traditional attire","kurta ensemble","gold statement jewelry","studio photography","editorial","neutral tones","intricate patterns","fashion campaign"],
      colors: ["#81241C","#C5B387","#2F2A28","#9E8B61","#493B33"],
      angle: "eye-level full shot",
      background: "solid deep red studio backdrop",
      parsedData: {"description":"Three models showcase elegant, minimalist South Asian luxury ensembles in shades of beige and olive, accented with intricate patterns and bold gold jewelry. The composition features two standing models flanking a seated one against a rich, monochromatic deep red background.","name":"Luxury Minimalist South Asian Studio Photoshoot"}
    }).returning();
    console.log("Success:", res);
  } catch (err: any) {
    console.error("FAILED.");
    console.error("Full object:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  }
  process.exit(0);
}

main();
