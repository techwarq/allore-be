import { PinterestBrowserService } from "./pinterest-browser.service";

/**
 * Service to handle automated company/brand research.
 * Uses Stagehand to browse visual platforms (Pinterest, Instagram, Vogue).
 */
export class CompanyResearch {
    private pinterestService: PinterestBrowserService | null = null;
    private apiKey: string;
    private browserbaseApiKey: string;
    private projectId: string;
    private location: string;

    constructor(
        apiKey: string = process.env.GEMINI_API_KEY || "", 
        browserbaseApiKey: string = process.env.BROWSERBASE_API_KEY || "",
        projectId: string = process.env.VERTEX_PROJECT_ID || "",
        location: string = process.env.VERTEX_LOCATION || ""
    ) {
        this.apiKey = apiKey;
        this.browserbaseApiKey = browserbaseApiKey;
        this.projectId = projectId;
        this.location = location;
    }

    async init() {
        console.log("🕵️ Initializing CompanyResearch...");
        this.pinterestService = new PinterestBrowserService(
            this.apiKey,
            this.browserbaseApiKey,
            this.projectId,
            this.location,
            "default",
            (process.env.STAGEHAND_ENV as any) || "LOCAL",
            process.env.PINTEREST_EMAIL,
            process.env.PINTEREST_PASSWORD,
            process.env.PINTEREST_COOKIE
        );
        await this.pinterestService.init();
    }

    async close() {
        if (this.pinterestService) {
            await this.pinterestService.close();
        }
    }

    /**
     * Executes a natural language research prompt on a specific visual platform.
     */
    async companyUrlResearch(
        url: string,
        prompt: string,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void
    ): Promise<any> {
        if (!this.pinterestService) await this.init();
        
        // Stagehand's magic is in its ability to follow natural language prompts.
        // We'll use the PinterestBrowserService's context.

        progressCallback?.({ step: 'research_start', message: `Navigating to ${url}...`, progress: 10 });
        
        const stagehandInternal = (this.pinterestService as any).stagehand;
        const page = stagehandInternal.page || (await stagehandInternal.context.pages()[0]);

        console.log(`🌐 Researching on: ${url}`);
        await page.goto(url, { waitUntil: "networkidle" });

        // If it's Pinterest and we are not logged in, we might need a fallback.
        // But our PinterestBrowserService already handles sign-in.

        progressCallback?.({ step: 'research_executing', message: `Stagehand is performing research: "${prompt}"...`, progress: 40 });

        // Use Stagehand's 'act' to follow the prompt
        console.log(`🤖 Stagehand acting on prompt: ${prompt}`);
        await page.act({ action: prompt });

        progressCallback?.({ step: 'research_extraction', message: "Extracting visual trends and insights...", progress: 70 });

        // Use Stagehand's 'extract' to get structured data from the research
        const researchData = await page.extract({
            instruction: "Extract a summary of the visual style, key trends, color palettes, and at least 5 high-resolution image URLs found during this research.",
            schema: {
                type: "object",
                properties: {
                    researchSummary: { type: "string" },
                    imageAnalysis: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            imageUrl: { type: "string" },
                            vibe: { type: "string" }
                          }
                        }
                    },
                    colorPalette: { type: "array", items: { type: "string" } }
                }
            }
        });

        console.log(`✅ Research completed with ${researchData.imageAnalysis?.length || 0} images.`);
        progressCallback?.({ step: 'research_done', message: "Visual research complete.", progress: 100 });

        return researchData;
    }
}
