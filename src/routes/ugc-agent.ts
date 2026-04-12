import { Hono } from 'hono'
import { getDb } from '../db'
import { uploadedAssets, generatedAssets } from '../db/schema'
import { UGCScriptService } from '../services/ugc-script.service'
import { UGCFrameGenerationService } from '../services/ugc-frame-generation.service'
import { UGCVideoGenerationService } from '../services/ugc-video-generation.service'
import { UGCFinalizationService } from '../services/ugc-finalization.service'

type Bindings = {
  DATABASE_URL: string
  GEMINI_API_KEY: string
  ASSETS_BUCKET: R2Bucket
}

const ugcAgent = new Hono<{ Bindings: Bindings }>()

// ==========================================
// 📥 1. UPLOADS (R2)
// ==========================================

ugcAgent.post('/upload/script', async (c) => {
    try {
        // Typically extracting from sessionMiddleware
        const userId = 'anonymous'; // Replace with c.get('user').id in production
        const formData = await c.req.formData()
        const file = formData.get('file') as File

        if (!file) return c.json({ error: 'No file uploaded' }, 400)

        const filename = `scripts/${userId}-${Date.now()}-${file.name.replace(/\\s+/g, '_')}`
        
        // Save raw file directly to R2
        await c.env.ASSETS_BUCKET.put(filename, await file.arrayBuffer(), {
            httpMetadata: { contentType: file.type }
        })

        // (Optional) Track in database
        const db = getDb(c.env.DATABASE_URL)
        const [asset] = await db.insert(uploadedAssets).values({
            userId,
            fileUrl: filename,
            assetType: 'script_document'
        }).returning()

        return c.json({ success: true, url: filename, assetId: asset.id })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

ugcAgent.post('/upload/image', async (c) => {
    try {
        const userId = 'anonymous'; // Adjust per auth
        const formData = await c.req.formData()
        const file = formData.get('file') as File
        const type = formData.get('type') || 'product' // 'avatar' | 'product'

        if (!file) return c.json({ error: 'No image uploaded' }, 400)

        const filename = `images/${userId}-${Date.now()}-${file.name.replace(/\\s+/g, '_')}`
        
        await c.env.ASSETS_BUCKET.put(filename, await file.arrayBuffer(), {
            httpMetadata: { contentType: file.type }
        })

        const db = getDb(c.env.DATABASE_URL)
        const [asset] = await db.insert(uploadedAssets).values({
            userId,
            fileUrl: filename,
            assetType: type as string
        }).returning()

        return c.json({ success: true, url: filename, assetId: asset.id })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

// ==========================================
// 🧠 2. STATE PIPELINE
// ==========================================

ugcAgent.post('/analyze-script', async (c) => {
    try {
        const { fileBase64, mimeType } = await c.req.json()

        const scriptService = new UGCScriptService(c.env.GEMINI_API_KEY)
        const structuredResults = await scriptService.processScript(fileBase64, mimeType)

        return c.json({ success: true, scriptData: structuredResults })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

ugcAgent.post('/generate-frames', async (c) => {
    try {
        const userId = 'anonymous'; // Provide from auth
        const { scriptData, aspectRatio, avatarUrl, productImages } = await c.req.json()

        const frameService = new UGCFrameGenerationService(
            c.env.GEMINI_API_KEY, 
            getDb(c.env.DATABASE_URL), 
            c.env.ASSETS_BUCKET, 
            userId
        )

        const executionPlan = await frameService.createFrameExecutionPlan({ scriptData, aspectRatio, avatarUrl, productImages })
        const generatedFrames = await frameService.generateSceneFrames(executionPlan)

        return c.json({ success: true, framesData: generatedFrames })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

ugcAgent.post('/generate-video-prompts', async (c) => {
    try {
        const { scriptData, framesData, aspectRatio, projectId } = await c.req.json()

        const videoService = new UGCVideoGenerationService(c.env.GEMINI_API_KEY, projectId)
        const formattedPrompts = await videoService.formatVeoJsonPrompts(scriptData, framesData, aspectRatio)

        return c.json({ success: true, videoPrompts: formattedPrompts })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

ugcAgent.post('/generate-video-clips', async (c) => {
    try {
        const { formattedPrompts, projectId } = await c.req.json()

        const videoService = new UGCVideoGenerationService(c.env.GEMINI_API_KEY, projectId)
        const videoClipUrls = await videoService.generateVideos(formattedPrompts)

        return c.json({ success: true, videoClipUrls })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

ugcAgent.post('/finalize-video', async (c) => {
    try {
        const { videoClipUrls } = await c.req.json()

        const finalizationService = new UGCFinalizationService()
        const finalUrl = await finalizationService.stitchClips(videoClipUrls)

        return c.json({ success: true, finalUrl })
    } catch (error: any) {
        return c.json({ error: error.message }, 500)
    }
})

export default ugcAgent
