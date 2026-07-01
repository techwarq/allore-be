const SHOOT_MODEL = 'gpt-5.4-nano-2026-03-17'

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | any[]
}

export class OpenAITextService {
  constructor(private apiKey: string) {}

  async chat(system: string, userText: string, jsonMode = false): Promise<string> {
    return this._call([
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ], jsonMode)
  }

  async chatWithImage(
    system: string,
    userText: string,
    imageBase64: string,
    mimeType: string,
    jsonMode = false
  ): Promise<string> {
    return this._call([
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
          { type: 'text', text: userText },
        ],
      },
    ], jsonMode)
  }

  async chatWithMultipleImages(
    system: string,
    userText: string,
    images: Array<{ base64: string; mimeType: string }>,
    jsonMode = false
  ): Promise<string> {
    const imageContent: any[] = images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' },
    }))
    return this._call([
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          ...imageContent,
          { type: 'text', text: userText },
        ],
      },
    ], jsonMode)
  }

  private async _call(messages: Message[], jsonMode: boolean): Promise<string> {
    let lastError = ''
    for (let attempt = 1; attempt <= 4; attempt++) {
      const body: any = { model: SHOOT_MODEL, messages }
      if (jsonMode) body.response_format = { type: 'json_object' }

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })

      if (res.ok) {
        const json: any = await res.json()
        return json.choices?.[0]?.message?.content ?? ''
      }

      lastError = await res.text()
      if (res.status !== 503 && res.status !== 429) break
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 2000))
    }
    throw new Error(`OpenAI Text Error: ${lastError}`)
  }
}
