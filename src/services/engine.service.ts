import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { TextService } from "./gemini/TextService";
import { ImageService } from "./gemini/ImageService";
import { CompanyResearch } from "./company-research.service";
import { convertGeminiImagesToStorage } from "./image-storage.helper";

/* ---------------------- Response Types ---------------------- */

export interface ImageStory {
    image: string; // Base64 or Signed URL
    story: string;
    prompt: string;
}

export interface EngineResponse {
    photoshoots: ImageStory[];
    instagram: ImageStory[];
    websiteBanner: ImageStory[];
    researchSummary: string;
    selectedModel: string;
}

/* ---------------------- Request Types ---------------------- */

export interface CompanyPreferences {
    company_name?: string;
    company_size?: string;
    industry?: string;
    brand_style?: string;
    target_audience?: string;
    usps?: string[];
    goals?: string[];
    challenges?: string[];
    primary_use_case?: string;
    working_style?: string;
    delivery_prefs?: string[];
    drop_info?: {
        date?: string;
        pieces?: number;
        vibe?: string;
    };
    photoshoot_prefs?: any;
    tryon_prefs?: any;
    research_prefs?: any;
}

export interface UserPreferences {
    creator_type?: string;
    current_project?: string;
    main_goal?: string;
    experience_level?: 'beginner' | 'intermediate' | 'expert';
    personal_style?: string;
    inspiration_brands?: string[];
    planned_drop?: string;
    references?: string[];
    help_with?: string[];
    priority_result?: string;
    content_usage?: string[];
    theme_vibe?: string;
    remember_preferences?: boolean;
}

export interface BrandingKitUpload {
    filename: string;
    fileUrl: string;
    mimeType: string;
    base64FileData: string;
    uploadedAt: string | Date;
    processed: boolean;
}

/**
 * Unified Preferences interface that supports both UserPreferences and CompanyPreferences
 */
export interface Preferences {
    company?: CompanyPreferences;
    user?: UserPreferences;
    brandingKitUpload?: BrandingKitUpload;
}


export interface EngineRequest {
    modelImages: string[]; // URLs or Base64 references
    preferences: Preferences;
    userId?: string;
    db?: any;     // Database instance from Cloudflare Bindings
    bucket?: any; // R2 Bucket from Cloudflare Bindings
}

/* ---------------------- Engine Class ---------------------- */

export class Engine {
    private apiKey: string;
    private projectId: string;
    private location: string;
    private textService: TextService;
    private imageService: ImageService;
    private companyResearch: CompanyResearch;

    constructor(apiKey: string, projectId: string, location: string) {
        this.apiKey = apiKey;
        this.projectId = projectId;
        this.location = location;
        this.textService = new TextService(apiKey, projectId, location);
        this.imageService = new ImageService(apiKey, projectId, location);
        this.companyResearch = new CompanyResearch(apiKey, "", projectId, location);
    }

    async init() {
        await this.companyResearch.init();
    }

    async close() {
        await this.companyResearch.close();
    }

    /**
     * 1. Plan Research: Analyze branding kit and preferences to decide where and what to research.
     */
    private async planResearch(
        request: EngineRequest,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void
    ): Promise<any> {
        console.log("🧠 Planning research based on branding kit...");
        progressCallback?.({ step: 'planning', message: 'Analyzing branding kit to plan research...', progress: 5 });
        const brandingKit = request.preferences.brandingKitUpload;

        const prompt = `
You are a senior fashion creative director, brand strategist, and editorial visual researcher.

Your task is to analyze the brand kit below and generate *very specific research instructions* that an automated browser agent (Stagehand) will run to collect fashion inspiration.

--- BRAND KIT DATA (JSON) ---
${JSON.stringify(request.preferences, null, 2)}
--- END DATA ---

### YOUR OBJECTIVE
You must analyze ALL available preference data to plan a research strategy.

Pick the BEST platform for this brand’s aesthetic (Pinterest/Instagram/Vogue Runway).
Output **strict JSON only**, no additional text.

{
  "companyUrl": "https://www.pinterest.com/",
  "prompt": "detailed automated browser instructions for Stagehand",
  "searchQuery": "the exact keyword(s) to search",
  "rationale": "why this direction fits the brand"
}
`;

        const response: any = await this.textService.generateText({
            model: "gemini-3-flash-preview", // Use stable flash for fast planning
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: prompt },
                        ...(brandingKit
                            ? [
                                {
                                    inlineData: {
                                        mimeType: brandingKit.mimeType,
                                        data: brandingKit.base64FileData,
                                    },
                                },
                            ]
                            : []),
                    ],
                },
            ],
        });

        const text = response;
        try {
            const cleanText = text.replace(/```json/g, "").replace(/```/g, "").trim();
            return JSON.parse(cleanText);
        } catch (e) {
            console.error("Failed to parse research plan JSON", e);
            throw new Error("Failed to generate valid research plan");
        }
    }

    /**
     * 2. Execute Research: Run the planned research using CompanyResearch service.
     */
    private async executeResearch(
        plan: any,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void
    ) {
        console.log(`🕵️ Executing research on ${plan.companyUrl}...`);
        return await this.companyResearch.companyUrlResearch(plan.companyUrl, plan.prompt, progressCallback);
    }

    /**
     * 3. Select Model: Choose the best model image from the provided list based on the vibe.
     */
    private async selectModel(
        modelImages: string[],
        vibe: string,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void
    ): Promise<string> {
        console.log("👤 Selecting the best model for the vibe...");
        progressCallback?.({ step: 'model_selection', message: 'Selecting best model for photoshoot...', progress: 100 });
        if (modelImages.length === 0) throw new Error("No model images provided");
        if (modelImages.length === 1) return modelImages[0];

        const parts: any[] = [{ text: `Select the best model image for a photoshoot with this vibe: "${vibe}". Return ONLY the index (0-based) of the best image.` }];

        for (let i = 0; i < Math.min(modelImages.length, 5); i++) {
            const img = modelImages[i];
            if (img.startsWith("http")) {
                try {
                    const res = await fetch(img);
                    const buf = await res.arrayBuffer();
                    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                    const mime = res.headers.get("content-type") || "image/jpeg";
                    parts.push({ inlineData: { mimeType: mime, data: b64 } });
                } catch (e) {
                    console.error(`Failed to fetch model image ${i}`, e);
                }
            } else {
                parts.push({ inlineData: { mimeType: "image/jpeg", data: img } });
            }
        }

        const response: any = await this.textService.generateText({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts }],
            config: {
                temperature: 0.1
            }
        });

        const text = response;
        const index = parseInt(text.match(/\d+/)?.[0] || "0");

        return modelImages[index] || modelImages[0];
    }

    /**
     * 4. Generate Prompts: Create image generation prompts based on research and selected model.
     */
    private async generatePrompts(
        researchResult: any,
        selectedModel: string,
        preferences: Preferences,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void
    ): Promise<any> {
        console.log("✍️ Generating photoshoot prompts...");
        progressCallback?.({ step: 'prompts', message: 'Generating creative photoshoot concepts...', progress: 110 });

        const prompt = `
You are a senior fashion photographer and creative director.

RESEARCH SUMMARY:
${researchResult.researchSummary}

IMAGE TRENDS ANALYSIS:
${JSON.stringify(researchResult.imageAnalysis || {}, null, 2)}

TASK:
Generate distinct image concepts for:
1. Photoshoots (5 main concepts)
2. Instagram (5 social shots)
3. Website Banner (1 wide shot)

Your prompts must explicitly preserve the look of the reference model.
Output JSON only.
`;

        const response: any = await this.textService.generateText({
            model: "gemini-3-flash-preview", // Deeper reasoning for prompts
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                temperature: 1.0,
                responseMimeType: "application/json"
            }
        });

        const text = response;
        try {
            const cleanText = text.replace(/```json/g, "").replace(/```/g, "").trim();
            return JSON.parse(cleanText);
        } catch (e) {
            console.error("Failed to parse prompts JSON", e);
            return { photoshoots: [], instagram: [], websiteBanner: [] };
        }
    }

    /**
     * 5. Generate Images: Generate actual images with multimodal conditioning.
     */
    private async generateImages(
        prompts: any[],
        selectedModel: string,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void,
        categoryName?: string,
        userId?: string,
        db?: any,
        bucket?: any
    ): Promise<ImageStory[]> {
        progressCallback?.({ step: 'generating', message: `Generating ${categoryName || 'images'}...`, progress: 120 });
        const results: ImageStory[] = [];

        for (const p of prompts) {
            try {
                // Pass prompt and model image for identity preservation
                const response: any = await this.textService.generateText({
                    model: "gemini-3-pro-image-preview",
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: p.prompt },
                                (selectedModel.startsWith('http')
                                    ? { text: `[Identity Image Reference: ${selectedModel}]` }
                                    : { inlineData: { mimeType: "image/jpeg", data: selectedModel } })
                            ]
                        }
                    ],
                    config: {
                        imageConfig: {
                            aspectRatio: "4:5",
                            imageSize: "2K"
                        }
                    }
                });

                const candidate = response.candidates?.[0];
                const part = candidate?.content?.parts?.[0];

                if (part?.inlineData?.data) {
                    // Store
                    const stored = await convertGeminiImagesToStorage(
                        [{ mimeType: part.inlineData.mimeType || "image/jpeg", data: part.inlineData.data }],
                        {
                            filenamePrefix: `gen-${categoryName}-${Date.now()}`,
                            userId: userId || 'anon',
                            db,
                            bucket,
                            metadata: { prompt: p.prompt, story: p.story }
                        }
                    );

                    results.push({
                        image: stored[0].signedUrl,
                        story: p.story,
                        prompt: p.prompt
                    });
                }
            } catch (e) {
                console.error(`Failed to generate image for prompt:`, e);
            }
        }

        return results;
    }

    /**
     * Main Orchestration Method
     */
    public async run(
        request: EngineRequest,
        progressCallback?: (update: { step: string; message: string; progress?: number }) => void
    ): Promise<EngineResponse> {
        try {
            await this.init();

            // 1. Plan
            const researchPlan = await this.planResearch(request, progressCallback);

            // 2. Research
            const researchResult = await this.executeResearch(researchPlan, progressCallback);

            // 3. Select Model
            const vibe = request.preferences.company?.drop_info?.vibe || request.preferences.user?.theme_vibe || "fashion";
            const selectedModel = await this.selectModel(request.modelImages, vibe, progressCallback);

            // 4. Generate Prompts
            const promptsJSON = await this.generatePrompts(researchResult, selectedModel, request.preferences, progressCallback);

            // 5. Generate Images
            const photoshoots = await this.generateImages(promptsJSON.photoshoots || [], selectedModel, progressCallback, 'photoshoots', request.userId, request.db, request.bucket);
            const instagram = await this.generateImages(promptsJSON.instagram || [], selectedModel, progressCallback, 'instagram', request.userId, request.db, request.bucket);
            const websiteBanner = await this.generateImages(promptsJSON.websiteBanner || [], selectedModel, progressCallback, 'banner', request.userId, request.db, request.bucket);

            return {
                photoshoots,
                instagram,
                websiteBanner,
                researchSummary: researchResult.researchSummary,
                selectedModel
            };

        } catch (error) {
            console.error("Engine run failed:", error);
            throw error;
        } finally {
            await this.close();
        }
    }
}
