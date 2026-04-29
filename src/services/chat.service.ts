import { eq, and } from "drizzle-orm";
import { ChatRepository } from "../db/ChatRepository";
import { Memory } from "./chat/Memory";
import { CreativeStudio } from "./chat/CreativeStudio";
import { profiles } from "../db/schema";
import { MemoryServiceV2 } from "./memory-v2.service";

export interface ChatProcessInput {
  projectId: string;
  userId: string;
  message: string;
  sessionId?: string;
}

export class ChatService {
  private repo: ChatRepository;
  private memory: Memory;
  private memoryV2: MemoryServiceV2;
  private creativeStudio: CreativeStudio;
  private db: any;
  private env: any;

  constructor(env: { 
    DB: any;
    QDRANT_URL: string;
    QDRANT_API_KEY: string;
    GEMINI_API_KEY: string;
    VERTEX_PROJECT_ID: string;
    VERTEX_LOCATION: string;
    VERTEX_SERVICE_ACCOUNT_EMAIL: string;
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  }) {
    this.db = env.DB;
    this.env = env;
    this.repo = new ChatRepository(this.db);
    this.memory = new Memory(
      env.QDRANT_URL, 
      env.QDRANT_API_KEY, 
      env.GEMINI_API_KEY, 
      env.VERTEX_PROJECT_ID, 
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
    this.memoryV2 = new MemoryServiceV2(env);
    this.creativeStudio = new CreativeStudio(
      env.GEMINI_API_KEY, 
      env.VERTEX_PROJECT_ID, 
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  /**
   * Main entry point for processing a chat message.
   * Returns an AsyncGenerator for streaming back to the client.
   */
  async *processMessage(input: ChatProcessInput) {
    const { projectId, userId, message, sessionId } = input;

    // 1. Save User Message
    const { messageId: userMessageId, chatId: resolvedChatId } = await this.repo.createMessage({
      projectId,
      userId,
      content: message,
      sender: 'user',
      chatId: sessionId
    });

    // Let the frontend know exactly which chat thread this is via SSE metadata
    yield { type: 'session_info', sessionId: resolvedChatId };

    // 2. Detect Mentions (@asset) and Search Memory
    const mentionRegex = /@([^@,.;!?\n ]+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(message)) !== null) {
      mentions.push(match[1]);
    }

    let foundAssets: any[] = [];
    if (mentions.length > 0) {
      for (const mention of mentions) {
        const results = await this.memory.searchMemory('user_assets', userId, mention, 3);
        foundAssets.push(...results);
      }
      // Deduplicate
      const seen = new Set();
      foundAssets = foundAssets.filter((a: any) => {
        const id = a.id || a.url;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      // Formalize the link in the database (message_assets table)
      for (const asset of foundAssets) {
        try {
          if (asset.id) {
            await this.repo.linkAssetToMessage(userMessageId, asset.id);
          }
        } catch (err) {
          console.warn(`[ChatService] Failed to link asset ${asset.id} to message ${userMessageId}:`, err);
        }
      }
    }

    // 3. Retrieve History using the RESOLVED chat ID
    let history: any[] = [];
    if (resolvedChatId) {
      const msgs = await this.repo.getMessagesByChatId(resolvedChatId, projectId);
      history = msgs.map((m: any) => ({
        role: m.sender === 'user' ? 'user' : 'model',
        content: m.content
      })).reverse();
    }

    // 4. Load Memory (V2 Relational) & Brand Context
    let userMemory: any = null;
    let brandContext: any = null;
    try {
      userMemory = await this.memoryV2.retrieve(userId, projectId, message);
    } catch (err) {
      console.warn("[ChatService] Memory retrieval failed:", err);
    }
    
    try {
      const [profile] = await this.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      
      if (profile) {
          brandContext = {
              companyName: profile.companyName,
              industry: profile.industry,
              extraDetails: profile.extraDetails,
              goals: profile.goals,
              targetAudience: profile.targetAudience,
              userType: profile.userType,
              preferences: profile.preferences?.company || {}
          };
          console.log(`[ChatService] Loaded brand context for user ${userId}:`, JSON.stringify(brandContext, null, 2));
          userMemory = userMemory || {};
          userMemory.userName = profile.name || "User";
      } else {
          console.warn(`[ChatService] No profile found for user ${userId}`);
      }
    } catch (err) {
      console.warn("[ChatService] Brand context/profile retrieval failed:", err);
    }

    // 5. Augment Message with collected assets
    let augmentedContent = message;
    if (foundAssets.length > 0) {
      const assetList = foundAssets.map((a: any) => `- ${a.title || a.label || 'Asset'} (URL: ${a.url})`).join('\n');
      augmentedContent += `\n\n[SYSTEM NOTE: The following assets were found in your library for the items mentioned with @:\n${assetList}\nYou can refer to these assets in your response.]`;
    }

    // 6. Prepare Input for Creative Studio
    const creativeInput = {
      message: {
        content: augmentedContent,
        sender_id: userId,
        project_id: projectId
      },
      history: history,
      userContext: {
        userId: userId,
        projectId: projectId,
        memory: userMemory,
        brandContext: brandContext,
      }
    };

    // 7. Process with Interceptor Pattern
    const generator = this.creativeStudio.process(creativeInput);
    const finalResponseBuffer: string[] = [];

    // Yield collected visuals first
    if (foundAssets.length > 0) {
        yield {
            type: 'collected_visuals',
            visuals: foundAssets.map((a: any) => a.url).filter(Boolean)
        };
    }

    const generatedAssets: any[] = [];
    for await (const event of generator as any) {
      if (event.type === 'final_response' && event.text) {
        finalResponseBuffer.push(event.text);
      }
      if (event.type === 'generated_asset' && event.asset) {
        generatedAssets.push(event.asset);
      }
      // Collect assets from new module types
      if (event.type === 'photoshoots' && event.visuals) {
          generatedAssets.push(...event.visuals.map((v: any) => ({ ...v, type: 'photoshoot_concept' })));
      }
      if (event.type === 'avatars' && event.personas) {
          generatedAssets.push(...event.personas.map((p: any) => ({ url: p.image, metadata: p, type: 'avatar_persona' })));
      }
      if (event.type === 'insta_post' && event.image) {
          generatedAssets.push({ url: event.image, type: 'social_post', metadata: { captions: event.captions, story: event.story } });
      }
      if (event.type === 'videos' && event.url) {
          generatedAssets.push({ url: event.url, type: 'video_concept', metadata: { story: event.story } });
      }
      yield event;
    }

    // 8. Save Assistant Response
    if (finalResponseBuffer.length > 0) {
      const fullText = finalResponseBuffer.join('\n');
      const assistantMessageId = await this.repo.createMessage({
        projectId,
        userId,
        content: fullText,
        sender: 'assistant',
        chatId: resolvedChatId
      });

      // Link any generated assets to this assistant message
      for (const asset of generatedAssets) {
        try {
          // If it's a new asset, it might need to be created first, but assuming it comes with an ID or we create it here
          const assetRecord = await this.repo.createAsset({
            userId,
            projectId,
            chatId: resolvedChatId,
            type: asset.type,
            source: 'ai',
            url: asset.url,
            metadata: asset.metadata
          });
          await this.repo.linkAssetToMessage(assistantMessageId.messageId, assetRecord.id);
        } catch (err) {
          console.warn("[ChatService] Failed to persist/link generated asset:", err);
        }
      }

      // 9. Ingest into Relational Memory V2 (Async)
      try {
        await this.memoryV2.initialize();
        await this.memoryV2.ingest(userId, projectId, 'chat', { message, assistantResponse: fullText });
        
        // Optional: Consolidate every few messages (naive simple trigger)
        if (Math.random() > 0.8) {
           await this.memoryV2.consolidate(userId, projectId);
        }
      } catch (err) {
        console.warn("[ChatService] Memory ingestion failed:", err);
      }
    }
  }

  // Helper methodologies for cost and tokens
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateCost(tokens: number, model: string): number {
    if (model.includes("flash")) return (tokens / 1_000_000) * 0.15;
    return (tokens / 1_000_000) * 10.0;
  }

  getModelForBudget(credits: number): string {
    // 🛡️ INTERNAL BYPASS: Always return high-tier model during payment issue bypass
    return "gemini-1.5-pro";
  }
}
