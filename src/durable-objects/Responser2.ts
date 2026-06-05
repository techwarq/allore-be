import { DurableObject } from "cloudflare:workers";
import { IntentEngine } from "../services/chat/IntentEngine";
import { getStandardToolCatalog } from "../services/chat/StandardTools";
import { TextService } from "../services/gemini/TextService";


interface Attachment {
    type: "image" | "video" | "file"
    url: string          // R2 signed URL or CDN url
    mimeType: string     // "image/png", "video/mp4", "application/pdf" etc
    name: string         // original filename
    size: number         // bytes
    // type-specific extras
    width?: number       // images + videos
    height?: number      // images + videos
    duration?: number    // videos, in seconds
    thumbnailUrl?: string // videos
}

interface Message {
    role: "user" | "assistant"
    text: string        // text, can be empty string if attachment-only
    ts: number
    attachments?: Attachment[]   // optional — most messages have none
}
export class ChatSession extends DurableObject<Env> {
    private messages: Message[] = [];
    private isLocked = false;
    private activeWriter: WritableStreamDefaultWriter | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private textService: TextService;
    private toolCatalog: any;
    private intentEngine: IntentEngine;


    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)

        this.textService = new TextService(
            env.GEMINI_API_KEY,
            env.VERTEX_PROJECT_ID,
            env.VERTEX_LOCATION,
            env.VERTEX_SERVICE_ACCOUNT_EMAIL,
            env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
        );

        this.toolCatalog = getStandardToolCatalog(env, this.textService);

        this.intentEngine = new IntentEngine(
            this.textService,
            this.toolCatalog,

        );


        ctx.blockConcurrency(async () => {
            this.messages = await this.ctx.storage.get("messages") ?? []

        })
    }


    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/message") {
            return this.handleMessage(request)
        }

        return new Response("not found", { status: 404 })
    }


    private async handleMessage(request: Request): Promise<Response> {
        if (this.isLocked) {
            return new Response("locked", { status: 409 })
        }

        this.isLocked = true

        const body = await request.json<{ message: Message }>()
        const message = body.message
        this.messages.push({ role: "user", text: message.text, attachments: message.attachments, ts: Date.now() })
        await this.ctx.storage.put("messages", this.messages)

        const { readable, writable } = new TransformStream()
        this.activeWriter = writable.getWriter()
        const enc = new TextEncoder()
        const send = (data: object) =>
            this.activeWriter!.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`))

        this.ctx.waitUntil(this.runInBackground(message, send))

        return new Response(readable, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
            }
        })
    }

    private async runInBackground(
        message: Message,
        send: (data: object) => Promise<void>
    ) {
        try {

            this.heartbeatTimer = setInterval(() => {
                this.activeWriter?.write(new TextEncoder().encode(`: ping\n\n`))
            }, 15_000)


            await this.orchestrate(message, send)


        } catch (error) {
            send({ type: "error", message: String(err) })

        } finally {
            if (!this.activeWriter) return
            this.isLocked = false
            await this.activeWriter?.close()
            this.activeWriter = null
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer)
                this.heartbeatTimer = null
            }
        }
    }

    private async orchestrate(message: Message, send: (data: object) => Promise<void>) {
        await send({ type: "status", content: "Analyzing message..." })
        // TODO: full orchestration
    }

    // onAlarm()
}

