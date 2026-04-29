import { ChatRepository } from "../../db/ChatRepository";
import { SubscriptionService, AccessResult } from "../subscription.service";

export interface Responser {
    process(message: string, attachments?: any[]): Promise<ReadableStream>;
    setContext(brandContext: any, userId: string, projectId: string): Promise<void>;
}

export interface RateLimit {
    check(userId: string): Promise<boolean>;
}

export default class ChatService {
    private repo: ChatRepository;
    private rateLimiter: RateLimit;
    private subscriptionService: SubscriptionService;
    private responser: Responser;

    constructor(
        repo: ChatRepository, 
        rateLimiter: RateLimit, 
        subscriptionService: SubscriptionService,
        responser: Responser
    ) {
        this.repo = repo;
        this.rateLimiter = rateLimiter;
        this.subscriptionService = subscriptionService;
        this.responser = responser;
    }

    /**
     * Streams the chat response back to the client.
     */
    async *chat(userId: string, message: string, projectId: string, attachments?: any[]) {
        // 1. Rate limit check (Cheap)
        const isAllowed = await this.rateLimiter.check(userId);
        if (!isAllowed) {
            yield { type: 'error', message: 'Too many requests' };
            return;
        }

        // 2. Subscription/Credit check
        const access: AccessResult = await this.subscriptionService.checkAccess(userId);
        if (!access.allowed) {
            yield { type: 'error', message: access.message || 'No active plan' };
            return;
        }

        // 3. Load Brand Context from profile
        const profile = await this.repo.getProfile(userId);
        const brandContext = profile ? {
            companyName: profile.companyName,
            industry: profile.industry,
            extraDetails: profile.extraDetails,
            goals: profile.goals,
            targetAudience: profile.targetAudience,
            userType: profile.userType,
            preferences: (profile.preferences as any)?.company || {}
        } : {};

        // 4. Set Context on Responser
        await this.responser.setContext(brandContext, userId, projectId);

        // 5. Save User Message
        const saved = await this.repo.createMessage({
            userId,
            projectId,
            content: message,
            sender: 'user',
            type: 'text',
        });

        yield { type: 'session_info', chatId: saved.chatId };

        // 6. Start Streaming from Responser
        const readable = await this.responser.process(message, attachments || []);
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let fullResponse = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                fullResponse += chunk;
                
                if (chunk) {
                    yield { type: 'chunk', text: chunk };
                }
            }

            // 7. Save Assistant Response after stream completion
            await this.repo.createMessage({
                userId,
                projectId,
                chatId: saved.chatId!,
                content: fullResponse,
                sender: 'assistant',
                type: 'text',
            });

            // 8. Deduct Credits (Calculating tokens from fullResponse)
            const tokenCount = Math.ceil(fullResponse.length / 4); // Simple estimation
            const deduction = await this.subscriptionService.deductCredits(
                userId,
                tokenCount,
                'chat_usage',
                saved.chatId!
            );

            yield { 
                type: 'done', 
                message: fullResponse,
                creditsRemaining: deduction.data?.creditsRemaining ?? access.creditsRemaining ?? 0
            };

        } catch (err: any) {
            console.error('[ChatService] Stream error:', err);
            yield { type: 'error', message: 'Stream interrupted' };
        } finally {
            reader.releaseLock();
        }
    }
}
