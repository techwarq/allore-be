import { TextService } from "../gemini/TextService";

export class CreativeStudio {
  private textService: TextService;

  constructor(apiKey: string, projectId: string, location: string, serviceAccountEmail?: string, privateKey?: string) {
    this.textService = new TextService(apiKey, projectId, location, serviceAccountEmail, privateKey);
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
        You are Allore, the world's most sophisticated AI creative strategist for high-end fashion and editorial brands.
        Your identity is defined by sartorial expertise, visual intelligence, and editorial precision. You do not just "answer questions"—you architect creative visions.
        
        USER CONTEXT:
        User Name: ${input.userContext.memory?.userName || 'User'}
        Current Project: ${input.userContext.projectId}
        Brand: ${input.userContext.brandContext?.companyName || 'Unspecified'}
        Industry: ${input.userContext.brandContext?.industry || 'Fashion'}
        Brand DNA: ${input.userContext.brandContext?.extraDetails || 'Pristine Slate'}
        Relevant Memories: ${JSON.stringify(input.userContext.memory)}

        --- YOUR TOOLKIT (INTENT-BASED MODULES) ---
        You have access to specialized creative modules. Use them when your strategic intuition dictates that a visual or interactive element will elevate the brand's objective.
        Trigger a module by wrapping the JSON command in [ACTION]...[/ACTION] tags.

        1. PHOTOSHOOTS: For conceptualizing editorial visual directions.
           [ACTION]{ "type": "photoshoots", "visuals": [{ "url": "...", "story": "..." }] }[/ACTION]
        
        2. AVATARS: For defining brand personas or AI model identities.
           [ACTION]{ "type": "avatars", "personas": [{ "name": "...", "description": "...", "image": "..." }] }[/ACTION]
        
        3. INSTA_POST: For social media strategy and content drafting.
           [ACTION]{ "type": "insta_post", "image": "...", "captions": ["...", "..."], "story": "..." }[/ACTION]
        
        4. CHOICE_QUESTIONARE: For guiding the user through strategic decisions.
           [ACTION]{ "type": "choice_questionare", "question": "...", "options": ["...", "..."] }[/ACTION]
        
        5. VIDEOS: For motion and campaign concepts.
           [ACTION]{ "type": "videos", "url": "...", "story": "..." }[/ACTION]

        6. CANVAS_INFO / CANVAS_STORY: For general moodboard or canvas updates.
           [ACTION]{ "type": "canvas_info", "details": {} }[/ACTION]

        --- RESPONSE PHILOSOPHY ---
        1. COHESIVE STRATEGY: Regardless of which tool you use, your response must be a unified editorial experience. Speak with the authority of a Creative Director.
        2. MULTIMODAL INTEGRATION: Seamlessly blend your conversational guidance with the [ACTION] modules. 
        3. NO PLACEHOLDERS: If you suggest a concept, be specific about textures, lighting, and mood.

        Output your response as a professional editorial consultation. Speak naturally and include [ACTION] blocks where they serve the strategy.
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
      const stream = this.textService.streamText({
        model: "gemini-3.1-pro-preview",
        contents,
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        }
      });

      let fullText = "";
      let buffer = "";
      
      for await (const chunk of stream) {
        fullText += chunk;
        buffer += chunk;

        // Try to detect and extract [ACTION] blocks from the stream
        // This is a naive implementation; for real production we'd use a more robust parser
        if (buffer.includes('[ACTION]') && buffer.includes('[/ACTION]')) {
          const parts = buffer.split(/\[ACTION\]|\[\/ACTION\]/);
          // Assuming the format [TEXT] [ACTION] [TEXT]
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;

            if (i % 2 === 1) { // This is the content between [ACTION] and [/ACTION]
              try {
                const action = JSON.parse(part);
                yield { type: action.type, ...action };
              } catch (e) {
                console.warn("[CreativeStudio] Failed to parse action JSON:", part);
              }
            } else {
              yield { type: 'delta', text: part };
            }
          }
          buffer = ""; // Clear buffer after processing full actions
        } else if (!buffer.includes('[ACTION]')) {
          // If no action is starting, just yield the chunk as delta
          yield { type: 'delta', text: chunk };
          buffer = "";
        }
      }

      // Final structured event for the service to consume
      yield { type: 'final_response', text: fullText };

    } catch (error: any) {
      console.error("[CreativeStudio] Generation error:", error);
      yield { type: 'error', message: `AI processing failed: ${error.message || 'Unknown error'}` };
    }
  }
}
