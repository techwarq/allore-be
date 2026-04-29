export interface GenerateTextOpts {
  model?: string;
  contents: Array<{
    role: "user" | "model" | "system";
    parts: Array<{ 
      text?: string;
      inlineData?: {
        mimeType: string;
        data: string;
      };
    }>;
  }>;
  generationConfig?: {
    responseMimeType?: "application/json" | "text/plain";
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
  };
  systemInstruction?: string | { parts: Array<{ text: string }> };
  safetySettings?: any[];
}

export interface ITextService {
  generateText(opts: GenerateTextOpts): Promise<string>;
}
