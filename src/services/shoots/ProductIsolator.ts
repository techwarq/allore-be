export class ProductIsolator {
  constructor(private apiKey: string) {}

  async isolate(imageBase64: string, mimeType: string): Promise<{ data: string; mimeType: string }> {
    const bytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: mimeType || 'image/jpeg' })

    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('image[]', blob, 'product.jpg')
    form.append('prompt',
      'Extract only the primary product from this image. ' +
      'Remove the background, props, styling elements, and environment completely. ' +
      'Place the isolated product centered on a pure white background. ' +
      'Preserve the product\'s exact colors, materials, textures, patterns, text, and all details with 100% fidelity. ' +
      'Do not alter, enhance, or reinterpret the product in any way — only change the background to solid white.'
    )
    form.append('size', '1024x1024')
    form.append('quality', 'medium')
    form.append('n', '1')

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      throw new Error(`ProductIsolator: gpt-image-2 failed (${res.status}): ${await res.text()}`)
    }

    const json: any = await res.json()
    const b64 = json?.data?.[0]?.b64_json
    if (!b64) throw new Error('ProductIsolator: no image in response')

    return { data: b64, mimeType: 'image/png' }
  }
}
