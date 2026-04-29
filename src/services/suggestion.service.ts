import { eq, and, desc } from 'drizzle-orm';
import { profiles, assets, messages, chats } from '../db/schema';
import { MemoryServiceV2 } from './memory-v2.service';
import { TextService } from './gemini/TextService';

export interface Suggestion {
  text: string;
  type: 'action' | 'query' | 'insight';
  metadata?: any;
}

export class SuggestionService {
  private memoryService: MemoryServiceV2;
  private textService: TextService;
  private db: any;

  constructor(env: {
    DB: any;
    GEMINI_API_KEY: string;
    VERTEX_PROJECT_ID: string;
    VERTEX_LOCATION: string;
    VERTEX_SERVICE_ACCOUNT_EMAIL: string;
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string;
    QDRANT_URL: string;
    QDRANT_API_KEY: string;
  }) {
    this.db = env.DB;
    this.memoryService = new MemoryServiceV2(env);
    this.textService = new TextService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async getSuggestions(userId: string, projectId: string, chatId?: string): Promise<Suggestion[]> {
    // 1. Fetch Profile
    const [profile] = await this.db.select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    // 2. Fetch Memory (Insights, Patterns)
    let memory = { pastEpisodes: [], semanticInsights: [], patterns: [] };
    try {
      memory = await this.memoryService.retrieve(userId, projectId, "general preferences and brand style");
    } catch (err) {
      console.warn("SuggestionService: Memory retrieval failed, skipping.", err);
    }

    // 3. Fetch Project Assets
    let projectAssets = [];
    try {
      projectAssets = await this.db.select()
        .from(assets)
        .where(and(
          eq(assets.userId, userId),
          eq(assets.projectId, projectId)
        ))
        .orderBy(desc(assets.createdAt))
        .limit(10);
    } catch (err) {
      console.warn("SuggestionService: Asset retrieval failed, skipping.", err);
    }

    // 4. Fetch Recent Chat Context
    let recentMessages = [];
    if (chatId) {
      recentMessages = await this.db.select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.createdAt))
        .limit(5);
    } else {
        // Try to find the latest chat for the project if no chatId provided
        const [latestChat] = await this.db.select()
            .from(chats)
            .where(eq(chats.projectId, projectId))
            .orderBy(desc(chats.createdAt))
            .limit(1);
        
        if (latestChat) {
            recentMessages = await this.db.select()
                .from(messages)
                .where(eq(messages.chatId, latestChat.id))
                .orderBy(desc(messages.createdAt))
                .limit(5);
        }
    }

    // 5. Build Prompt for Gemini
    const context = {
      profile: profile ? {
        companyName: profile.companyName,
        industry: profile.industry,
        tone: profile.tone,
        aesthetic: profile.aesthetic,
        goals: profile.goals
      } : "No profile set",
      memory: {
        insights: memory.semanticInsights,
        patterns: memory.patterns
      },
      assets: projectAssets.map(a => ({ type: a.type, tags: a.tags, url: a.url })),
      recentChat: recentMessages.reverse().map(m => `${m.sender}: ${m.content}`)
    };

    const prompt = `
      You are an AI Creative Assistant for a brand called Allore.
      Based on the user's profile, memory, brand assets, and recent chat history, suggest 3-4 proactive things the user should do next or ask.
      
      CONTEXT:
      ${JSON.stringify(context, null, 2)}
      
      GUIDELINES:
      - Suggestions should be highly personalized and specific to the brand and assets.
      - If there are new assets, suggest using them in a photoshoot or campaign.
      - If there are clear preferences in memory, align suggestions with them.
      - Keep them short, actionable, and inspiring.
      - Return the result in JSON format.
      
      OUTPUT FORMAT:
      [
        { "text": "Create a lifestyle photoshoot for the silk dress with a 'minimalist' vibe.", "type": "action", "metadata": { "action": "photoshoot", "subject": "silk dress" } },
        { "text": "How can I improve the brand consistency across my social media assets?", "type": "query" }
      ]
    `;

    try {
      const response = await this.textService.generateText({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.7
        }
      });

      const suggestions = JSON.parse(response);
      return suggestions;
    } catch (error) {
      console.error("Failed to generate suggestions:", error);
      // Fallback suggestions
      return [
        { text: "Generate a new photoshoot for your brand", type: "action" },
        { text: "Analyze my recent assets for style consistency", type: "action" },
        { text: "What's the best way to use my brand colors?", type: "query" }
      ];
    }
  }
}
