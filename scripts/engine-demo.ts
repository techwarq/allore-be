import { Engine, EngineRequest } from "../src/services/engine.service";
import * as dotenv from "dotenv";
import path from "path";

// Load environment variables from .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
    console.log("🚀 Starting Research & Generation Engine Demo...");
    
    const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
    if (!GEMINI_KEY) {
        console.error("❌ GEMINI_API_KEY is missing in .env");
        process.exit(1);
    }

    const engine = new Engine(GEMINI_KEY);

    const mockupRequest: EngineRequest = {
        userId: "demo-user-123",
        modelImages: [
            "https://images.unsplash.com/photo-1539109136881-3be0616acf4b?q=80&w=1280", // Sample Fashion Model
            "https://images.unsplash.com/photo-1529139513055-07f90f63a3c2?q=80&w=1280"
        ],
        preferences: {
            company: {
                company_name: "Luxe Minimal",
                brand_style: "High-end, architectural, monochrome",
                target_audience: "Minimalist fashion enthusiasts, Gen Z creative professionals",
                industry: "Fashion",
                drop_info: {
                    vibe: "Winter Architecture"
                }
            },
            user: {
                personal_style: "Scandinavian Minimalist",
                inspiration_brands: ["Acne Studios", "Jil Sander", "Fear of God"]
            }
        },
        // Mocks for DB and Bucket - Engine will fallback to base64 if these are empty
        db: null,
        bucket: null
    };

    try {
        console.log("🛠️  Initializing Engine...");
        await engine.init();

        console.log("🎬 Running Engine Orchesration...");
        const response = await engine.run(mockupRequest, (update) => {
            console.log(`[${update.step.toUpperCase()}] ${update.message} (${update.progress || 0}%)`);
        });

        console.log("\n✨ ENGINE RUN SUCCESSFUL! ✨");
        console.log("-----------------------------------");
        console.log("Research Summary:");
        console.log(response.researchSummary.substring(0, 500) + "...");
        
        console.log("\nPhotoshoot Assets Generated:", response.photoshoots.length);
        response.photoshoots.forEach((p, i) => {
            console.log(`\nAsset ${i + 1}:`);
            console.log(`- Prompt: ${p.prompt.substring(0, 100)}...`);
            console.log(`- Image (URL/Base64 snippet): ${p.image.substring(0, 100)}...`);
        });

    } catch (error) {
        console.error("❌ Engine Run Failed:", error);
    } finally {
        console.log("\n👋 Closing Engine...");
        await engine.close();
        process.exit(0);
    }
}

main();
