export {
  OpenRouterTextService,
  OPENROUTER_MODELS,
  type OpenRouterOptions,
} from "./openrouter/OpenRouterTextService";
export {
  FalService,
  FAL_MODELS,
  type FalSubscribeOptions,
  type FalGenerateImageOptions,
} from "./fal/FalService";

// OpenAI and Gemini providers already live in ../../services/openai and ../../services/gemini —
// add them here next so this module is the single entry point for all four providers.
