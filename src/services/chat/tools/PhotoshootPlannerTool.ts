import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { TextService } from "../../gemini/TextService";
import { NanoBanaPromptBuilder, ProductLock, PlannedShot } from "../../nanobana/PromptBuilder";

export class PhotoshootPlannerTool implements Tool {
  name = "photoshoot_planner";
  description = "Converts brand story and moodboards into structured, technical shot prompts. MUST run before photoshoot_generator.";
  private textService: TextService;
  private promptBuilder: NanoBanaPromptBuilder;
  private env: any;

  constructor(textServiceOrEnv: any, env?: any) {
    if (textServiceOrEnv instanceof TextService) {
      this.textService = textServiceOrEnv;
      this.env = env;
    } else {
      this.env = textServiceOrEnv;
      this.textService = new TextService(
        this.env.GEMINI_API_KEY,
        this.env.VERTEX_PROJECT_ID,
        this.env.VERTEX_LOCATION,
        this.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
        this.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
      );
    }
    this.promptBuilder = new NanoBanaPromptBuilder(this.env);
  }

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    const product = ctx.memory?.product || {};
    const photoshootConfig = ctx.memory?.product?.details || { shotCount: 5 };
    const story = input.story || ctx.memory?.creative?.story || "";
    const style = input.style || ctx.memory?.creative?.style || {};
    const moodboardImages = input.moodboardImages || ctx.memory?.creative?.moodboardImages || [];
    const models: any[] = input.models || ctx.memory?.campaign?.models || [];
    const shotCount = photoshootConfig.shotCount || 5;

    // ── Pre-flight Gate: Product Awareness ──────────────────────────────────
    const productLocked = ctx.memory?.product?.productLocked === true;
    const alreadyAskedProduct = ctx.memory?.conversation?.answeredQuestions?.includes("product_source");

    if (!productLocked && !alreadyAskedProduct) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "product_source",
          content: {
            title: "Let's get your product",
            question: "I couldn't find a product in your project. How would you like to add it?",
            options: [
              { id: "uploaded", label: "Upload an image", description: "Share a photo of your product." },
              { id: "describe", label: "I'll describe it", description: "Tell me what it looks like." },
            ]
          }
        }]
      };
    }

    // ── Step 0: Pre-flight Gate (Avatar Selection) ───────────────────────────
    const hasModels = models.length > 0;
    const useAvatar = ctx.memory?.campaign?.useAvatar;
    const answeredAvatar = ctx.memory?.conversation?.answeredQuestions?.includes("avatar_choice");

    if (!hasModels && useAvatar === undefined && !answeredAvatar) {
      return {
        pauseForUserInput: true,
        visible: [
          {
            type: "choice_questionnaire",
            questionId: "avatar_choice",
            content: {
              title: "Model & Persona Selection",
              question: "How should we bring these shots to life? Do you need an AI model (Avatar) for this campaign?",
              options: [
                { id: "use_avatar", label: "Create AI Avatar", description: "Design a custom AI model that fits your brand aesthetic." },
                { id: "product_only", label: "Product Only", description: "Focus on the garment itself with clean backgrounds." }
              ]
            }
          }
        ]
      };
    }

    // If they chose avatar but none generated yet, inject AvatarGeneratorTool
    if (useAvatar && !hasModels) {
      return {
        nextTasks: [
          { id: "gen_avatars", tool: "avatar_generator", input: { ...input, story, style, moodboardImages } },
          { id: "replan_shots", tool: "photoshoot_planner", input }
        ]
      };
    }

    // ── Step 1: Extract Product Lock ────────────────────────────────────────
    const productLockInstruction = `
You are a product analyst. Extract a strict Product Lock object from the product details.
This will be used as the non-negotiable source of truth for image generation.

Output STRICT JSON only:
{
  "name": "product name",
  "colors": ["exact color 1", "exact color 2"],
  "material": "exact material",
  "texture": "exact texture description",
  "fit": "silhouette and fit description",
  "structure": ["structural detail 1", "structural detail 2"],
  "doNotChange": ["..."]
}
    `.trim();

    // ── Step 2: Prepare Planning Instruction ────────────────────────────────
    const planningInstruction = `
You are the Photoshoot Planner for Allore AI.
Convert brand story, product, and moodboard into structured photoshoot shot concepts.
Distribute evenly across: hero, lifestyle, detail, experimental.
Total shots: ${shotCount}.

Return STRICT JSON:
{
  "shots": [
    {
      "id": "shot_1",
      "type": "hero | lifestyle | detail | experimental",
      "concept": "...", "scene": "...", "composition": "...", "lighting": "...",
      "background": "...", "emotion": "...", "focus": "product | model | detail",
      "model_id": "model_1 or null",
      "camera": { "angle": "...", "lens": "..." }
    }
  ]
}
    `.trim();

    // ── Step 3: Run Parallel LLM Calls ──────────────────────────────────────
    const [productLockRaw, plannerRaw] = await Promise.all([
      this.textService.generateText({
        systemInstruction: productLockInstruction,
        contents: [{ role: "user", parts: [{ text: JSON.stringify(product) }] }]
      }),
      this.textService.generateText({
        systemInstruction: planningInstruction,
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ product, story, style, models, shotCount }) }] }]
      })
    ]);

    let productLock: ProductLock;
    try {
      const cleanLock = productLockRaw.replace(/^```json/m, '').replace(/```$/m, '').trim();
      productLock = JSON.parse(cleanLock);
    } catch {
      productLock = {
        name: product.name || "Product",
        colors: product.colors || [],
        material: product.material || "",
        texture: product.texture || "",
        fit: product.fit || "",
        structure: product.structure || [],
        doNotChange: ["preserve exact product design"]
      };
    }

    let rawShots: Omit<PlannedShot, 'prompt'>[];
    try {
      const cleanPlan = plannerRaw.replace(/^```json/m, '').replace(/```$/m, '').trim();
      rawShots = JSON.parse(cleanPlan).shots || [];
    } catch (err) {
      throw new Error("Photoshoot Planner failed to output valid structured shots.");
    }

    // ── Step 2: Extract Moodboard Context ───────────────────────────────────
    const moodboardContext = {
      lighting: style.lighting || "soft natural lighting",
      palette: style.color_palette || [],
      composition: style.composition || "clean, centered"
    };

    // ── Step 4: Build final NanoBana prompt for each shot ────────────────────
    const plannedShots: PlannedShot[] = [];

    for (const shot of rawShots) {
      const modelForShot = shot.model_id ? models.find(m => m.id === shot.model_id) : undefined;
      
      const prompt = await this.promptBuilder.buildPrompt(
        shot,
        productLock,
        modelForShot,
        moodboardContext
      );

      plannedShots.push({ ...shot, prompt });
    }



    return {
      visible: [
        {
          type: "status",
          content: `Planned ${plannedShots.length} production-ready shots with locked prompts.`
        }
      ],
      memoryUpdate: {
        product: {
          ...ctx.memory?.product,
          productLocked: true,
          productConstraints: productLock
        },
        plannedShots // NEW: Save to memory so Responser can see it for fan-out
      },
      hidden: {
        productLock,
        plannedShots
      },
      nextInput: {
        ...input,
        plannedShots,
        productLock
      }
    };
  }
}
