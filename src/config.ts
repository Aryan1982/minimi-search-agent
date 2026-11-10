import { existsSync } from "node:fs";

// Node's built-in .env loader; no dotenv dependency. Real env vars win over the file.
if (existsSync(".env")) process.loadEnvFile(".env");

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  dbPath: env.DB_PATH ?? "data/agent.db",
  anthropicKey: env.ANTHROPIC_API_KEY ?? "",
  tavilyKey: env.TAVILY_API_KEY ?? "",
  // The model that runs the agent loop and writes the answer.
  agentModel: env.AGENT_MODEL ?? "claude-sonnet-5-5",
  agentEffort: (env.AGENT_EFFORT ?? "medium") as "low" | "medium" | "high",
  // The model that turns a finished exchange into memory, off the hot path.
  extractModel: env.EXTRACT_MODEL ?? "claude-haiku-5-5",
  // Hard stop on model round trips per user turn.
  maxSteps: 6,
  // Prior turns of the open conversation replayed to the model.
  historyTurns: 12,
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.anthropicKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.tavilyKey) missing.push("TAVILY_API_KEY");
  return missing;
}
