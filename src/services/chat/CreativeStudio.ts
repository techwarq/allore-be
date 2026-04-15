import GeminiConnector from "../connectors/gemini.connector";

export class CreativeStudio {
  private gemini: GeminiConnector;

  constructor(apiKey: string) {
    this.gemini = new GeminiConnector(apiKey);
  }

  /**
   * Main processing engine (Generator).
   * Orchestrates the AI response based on augmented user input and context.
   */
  async *process(input: { 
    message: { content: string, sender_id: string, project_id: string },
    history: any[],
    userContext: any
  }) {
    try {
      // 1. Define Brand/System instructions
      const systemInstruction = `
        You are Allore, a high-end fashion AI creative strategist. 
        Your goal is to help users conceptualize photoshoots, social media content, and brand research.
        
        USER CONTEXT:
        Current Project: ${input.userContext.projectId}
        Brand Context: ${JSON.stringify(input.userContext.brandContext || {})}
        Relevant Memories: ${JSON.stringify(input.userContext.memory)}
        
        Be creative, professional, and visually descriptive.
      `.trim();

      // 2. Prepare conversation history for Gemini
      const contents = input.history.map(h => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
      }));

      // Add current augmented message
      contents.push({ 
        role: 'user', 
        parts: [{ text: input.message.content }] 
      });

      // 3. Stream from Gemini API
      const stream = this.gemini.streamContent({
        model: "gemini-1.5-pro",
        contents,
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        }
      });

      let fullText = "";
      for await (const chunk of stream) {
        fullText += chunk;
        yield { type: 'delta', text: chunk };
      }

      // Final structured event for the service to consume
      yield { type: 'final_response', text: fullText };

    } catch (error) {
      console.error("[CreativeStudio] Generation error:", error);
      yield { type: 'error', message: "AI processing failed." };
    }
  }
}
