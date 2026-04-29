import { Hono } from 'hono';
import { SuggestionService } from '../services/suggestion.service';
import { sessionMiddleware, type AuthVariables } from '../middleware/auth';
import { getDb } from '../db';

const suggestions = new Hono<{ Variables: AuthVariables, Bindings: any }>();

suggestions.get('/', sessionMiddleware, async (c) => {
  const user = c.get('user');
  const projectId = c.req.query('projectId');
  const chatId = c.req.query('chatId');

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const suggestionService = new SuggestionService({
    DB: getDb(c.env.DATABASE_URL),
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    QDRANT_URL: c.env.QDRANT_URL,
    QDRANT_API_KEY: c.env.QDRANT_API_KEY,
  });

  try {
    const results = await suggestionService.getSuggestions(user.id, projectId, chatId);
    return c.json({
      success: true,
      suggestions: results
    });
  } catch (error: any) {
    console.error('Suggestions route error:', error);
    return c.json({ error: 'Failed to fetch suggestions' }, 500);
  }
});

export default suggestions;
