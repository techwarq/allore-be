import { eq, and } from "drizzle-orm";
import { ChatRepository } from "../db/ChatRepository";
import { Memory } from "./chat/Memory";
import { CreativeStudio } from "./chat/CreativeStudio";
import { companyPreferences } from "../db/schema";

export interface ChatProcessInput {
  projectId: string;
  userId: string;
  message: string;
  sessionId?: string;
}

export class ChatService {
  private repo: ChatRepository;
  private memory: Memory;
  private creativeStudio: CreativeStudio;
  private db: any;

  constructor(env: { 
    DB: any;
    QDRANT_URL: string;
    QDRANT_API_KEY: string;
    GEMINI_API_KEY: string;
  }) {
    this.db = env.DB;
    this.repo = new ChatRepository(this.db);
    this.memory = new Memory(env.QDRANT_URL, env.QDRANT_API_KEY, env.GEMINI_API_KEY);
    this.creativeStudio = new CreativeStudio(env.GEMINI_API_KEY);
  }

  /**
   * Main entry point for processing a chat message.
   * Returns an AsyncGenerator for streaming back to the client.
   */
  async *processMessage(input: ChatProcessInput) {
    const { projectId, userId, message, sessionId } = input;

    // 1. Save User Message
    await this.repo.createMessage({
      projectId,
      userId,
      content: message,
      sender: 'user',
      chatId: sessionId
    });

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
      foundAssets = foundAssets.filter(a => {
        const id = a.id || a.url;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    // 3. Retrieve History
    let history: any[] = [];
    if (sessionId) {
      const msgs = await this.repo.getMessagesByChatId(sessionId);
      history = msgs.map(m => ({
        role: m.sender === 'user' ? 'user' : 'model',
        content: m.content
      })).reverse();
    }

    // 4. Load Memory & Brand Context
    let userMemory: any[] = [];
    let brandContext: any = null;
    try {
      userMemory = await this.memory.retrieve(userId, message);
    } catch (err) {
      console.warn("[ChatService] Memory retrieval failed:", err);
    }
    
    try {
      [brandContext] = await this.db
        .select()
        .from(companyPreferences)
        .where(eq(companyPreferences.userId, userId))
        .limit(1);
    } catch (err) {
      console.warn("[ChatService] Brand context retrieval failed:", err);
    }

    // 5. Augment Message with collected assets
    let augmentedContent = message;
    if (foundAssets.length > 0) {
      const assetList = foundAssets.map(a => `- ${a.title || a.label || 'Asset'} (URL: ${a.url})`).join('\n');
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
            visuals: foundAssets.map(a => a.url).filter(Boolean)
        };
    }

    for await (const event of generator) {
      if (event.type === 'final_response' && event.text) {
        finalResponseBuffer.push(event.text);
      }
      yield event;
    }

    // 8. Save Assistant Response
    if (finalResponseBuffer.length > 0) {
      const fullText = finalResponseBuffer.join('\n');
      await this.repo.createMessage({
        projectId,
        userId,
        content: fullText,
        sender: 'assistant',
        chatId: sessionId
      });
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
    return credits < 100 ? "gemini-1.5-flash" : "gemini-1.5-pro";
  }
}
