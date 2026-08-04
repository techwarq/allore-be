import { Tool, ToolContext } from "../../services/chat/tools/Tool";
import { ToolResponse } from "../../types/chat";
import { AssetSearchService } from "../../services/assetSearch.service";

export interface SearchInput {
  query: string;
  limit?: number;
  scope?: "project" | "user";
}

export interface SearchEnv {
  GEMINI_API_KEY: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}

/**
 * Semantic search over the user's own assets (Qdrant-backed). Distinct from
 * memory_recall — this searches uploaded/generated assets, not conversation
 * or brand memory.
 */
export class SearchTool implements Tool {
  name = "search";
  description =
    "Semantic search over the user's uploaded assets and prior creative work. Use to find relevant reference images, past products, or moodboard items by description.";

  private searchService: AssetSearchService;

  constructor(env: SearchEnv) {
    this.searchService = new AssetSearchService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.QDRANT_URL,
      env.QDRANT_API_KEY,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  async run(input: SearchInput, ctx: ToolContext): Promise<ToolResponse> {
    const userId = ctx.userId ?? ctx.memory?.userId;
    const projectId = ctx.memory?.projectId;

    if (!input?.query || !userId) {
      return { visible: [] };
    }

    const results =
      input.scope === "project" && projectId
        ? await this.searchService.searchByProject(input.query, userId, projectId, input.limit ?? 10)
        : await this.searchService.search(input.query, userId, input.limit ?? 5);

    return { visible: [], hidden: { results } };
  }
}
