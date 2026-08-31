// The planner/intent agent already exists as IntentEngine (src/core/orchestrator) —
// it classifies intent and builds the tool task plan via Gemini JSON mode. Exposed
// here under the core/agents naming rather than duplicated.
export { IntentEngine as PlannerIntentAgent, type IntentPlan, type AnalyzeContext } from "../orchestrator/IntentEngine";
