import { eq, and, desc } from 'drizzle-orm';
import { messages, chats, assets, messageAssets, profiles } from './schema';

export class ChatRepository {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  /**
   * Creates a new message in a chat.
   */
  async createMessage(data: {
    projectId: string;
    userId: string;
    content: string;
    sender: string; // 'user', 'assistant', 'system'
    chatId?: string;
    type?: string;
  }) {
    let targetChatId = data.chatId;
    
    // 1. Resolve or create chat
    // Ensure the chatId is a valid UUID before using it. 
    // If it's a virtual ID (like 'user-UUID'), we treat it as undefined to trigger resolution.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (targetChatId && !uuidRegex.test(targetChatId)) {
      targetChatId = undefined;
    }

    if (!targetChatId) {
      // Create a brand new chat thread
      const [newChat] = await this.db
        .insert(chats)
        .values({
          projectId: data.projectId,
          title: 'Conversation',
        })
        .returning();
      targetChatId = newChat.id;
    }

    // 2. Insert message
    const [newMessage] = await this.db
      .insert(messages)
      .values({
        chatId: targetChatId,
        projectId: data.projectId,
        sender: data.sender,
        content: data.content,
        type: data.type || 'text',
      })
      .returning();

    return { messageId: newMessage.id, chatId: targetChatId };
  }

  /**
   * Creates a unified asset record.
   */
  async createAsset(data: {
    userId: string;
    projectId: string;
    chatId?: string;
    type: string;
    source: string;
    url: string;
    metadata?: any;
    generationId?: string;
  }) {
    const [newAsset] = await this.db
      .insert(assets)
      .values({
        userId: data.userId,
        projectId: data.projectId,
        chatId: data.chatId,
        type: data.type,
        source: data.source,
        url: data.url,
        metadataJson: data.metadata || {},
        generationId: data.generationId
      })
      .returning();
    
    return newAsset;
  }

  /**
   * Links an asset to a message via the junction table.
   */
  async linkAssetToMessage(messageId: string, assetId: string) {
    await this.db
      .insert(messageAssets)
      .values({
        messageId,
        assetId,
      });
  }

  async getMessagesByChatId(chatId: string, fallbackProjectId?: string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let targetChatId = chatId;
    
    if (!uuidRegex.test(chatId)) {
      if (!fallbackProjectId) return [];
      
      const [existingChat] = await this.db
        .select()
        .from(chats)
        .where(eq(chats.projectId, fallbackProjectId))
        .limit(1);
        
      if (!existingChat) return [];
      targetChatId = existingChat.id;
    }

    return await this.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, targetChatId))
      .orderBy(desc(messages.createdAt));
  }

  async getProfile(userId: string) {
    const [profile] = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    return profile;
  }
}
