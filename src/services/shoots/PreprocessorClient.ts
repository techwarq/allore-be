import { CropInstruction } from './AssetLabeler'

export type ZoneCrop = { data: string; mimeType: string; size: number }
export type ZoneCrops = Record<string, ZoneCrop>

export class PreprocessorClient {
  constructor(private baseUrl: string) {}

  /**
   * New: send LLM-decided crop instructions to Python.
   * Returns crops keyed by instruction name.
   */
  async preprocessCustom(
    imageBase64: string,
    mimeType: string,
    instructions: CropInstruction[]
  ): Promise<ZoneCrops> {
    const bytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: mimeType || 'image/jpeg' })

    const form = new FormData()
    form.append('file', blob, 'product.jpg')
    form.append('instructions', JSON.stringify(instructions))

    const res = await fetch(`${this.baseUrl}/preprocess-custom`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      throw new Error(`Preprocessor error (${res.status}): ${await res.text()}`)
    }

    return res.json() as Promise<ZoneCrops>
  }
}
