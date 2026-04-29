import { Hono } from 'hono'
import { OpenAIImageService } from '../services/openai/OpenAIImageService'
import { sessionMiddleware } from '../middleware/auth'

const creative = new Hono<{
  Bindings: {
    OPENAI_API_KEY: string
    DATABASE_URL: string
  },
  Variables: {
    user: any
  }
}>()

const GLOBAL_STYLE = `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
soft golden hour lighting, emotional storytelling, highly detailed anime style,
clean line art, shallow depth of field, warm color grading,
consistent characters: slightly overweight teenage boy with glasses, shy expression, school uniform hoodie,
athletic confident senior boy, sleeveless shirt, friendly energy,
modern school + outdoor environment, cinematic composition`;

const DEFAULT_PANELS = [
  {
    id: 1,
    title: "BULLYING → ISOLATION",
    prompt: `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
left: school corridor, group of boys laughing and teasing a slightly overweight boy with glasses, pointing and mocking, high energy, chaotic, warm indoor lighting,
right: same boy sitting alone near a window after school, sunlight falling softly, empty space around him, quiet, withdrawn, emotional contrast`
  },
  {
    id: 2,
    title: "SAD → BREAKDOWN",
    prompt: `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
left: boy sitting on his bed in a dim messy room, head down, evening blue light, silence, low energy,
right: close-up of his face lying sideways, teary eyes, soft shadows, emotional and vulnerable, shallow depth of field`
  },
  {
    id: 3,
    title: "SENIOR → WATCHING",
    prompt: `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
left: athletic senior laughing with friends outdoors near school fence, sunset lighting, drinking from a shiny blue can, confident relaxed vibe,
right: boy watching from distance behind fence, slightly hidden, warm sunset light hitting his face, quiet admiration`
  },
  {
    id: 4,
    title: "OFFER → IMPACT",
    prompt: `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
left: senior bending slightly, handing the shiny blue can toward the boy, friendly smile, soft golden light,
right: senior gently ruffling the boy’s hair and walking away, boy looking surprised and emotional, warm sunlight glow`
  },
  {
    id: 5,
    title: "DECISION → ACTION",
    prompt: `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
left: close-up of the boy holding the blue can, staring at it with focus, light reflecting off it, symbolic moment,
right: early morning scene, boy running along a road with sunrise in background, determination, motion blur, warm light`
  },
  {
    id: 6,
    title: "GROWTH → FULL CIRCLE",
    prompt: `anime cinematic film strip, ultra wide 21:9, split into two scenes left and right,
left: boy now fitter, studying at desk and working out in gym environment, confident posture, the blue can visible nearby,
right: boy smiling confidently with friends, tossing the can playfully toward the senior, senior catching it and smiling back, sunset golden light, emotional closure`
  }
];

creative.post('/cinematic-strip', async (c) => {
  const body = await c.req.json();
  const panels = body.panels || DEFAULT_PANELS;
  const apiKey = c.env.OPENAI_API_KEY;

  if (!apiKey) {
    return c.json({ error: 'OPENAI_API_KEY is not configured.' }, 500);
  }

  const ai = new OpenAIImageService(apiKey);
  const results: any[] = [];
  let referenceImage: string | null = null;

  try {
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      const prompt = `${GLOBAL_STYLE}\n\n${panel.prompt}`;
      
      console.log(`[Creative] Generating Panel ${i + 1}: ${panel.title}`);
      
      let images: string[];
      if (i === 0) {
        // First panel generates the anchor image
        images = await ai.generate(prompt, {
          model: "gpt-image-2",
          size: "3840x2160", // 4K Landscape for that 21:9 vibe (or close to it)
          quality: "high"
        });
        referenceImage = images[0];
      } else {
        // Subsequent panels use the first image as a reference
        images = await ai.generateWithReference(prompt, referenceImage!, {
          model: "gpt-image-2",
          size: "3840x2160",
          quality: "high"
        });
      }

      results.push({
        panelId: panel.id,
        title: panel.title,
        image: images[0]
      });
    }

    return c.json({
      success: true,
      results
    });

  } catch (error: any) {
    console.error('[Creative] Error generating cinematic strip:', error);
    return c.json({ error: error.message || 'Failed to generate cinematic strip.' }, 500);
  }
});

export default creative;
