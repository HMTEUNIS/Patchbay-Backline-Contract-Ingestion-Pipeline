/** Process environment for the ingest CLI. Nothing here is hardcoded. */

export type Config = {
  databaseUrl: string;
  ollamaHost: string;
  ollamaModel: string;
  /** Backline data directory, when set, so `make embed` can find a txt sidecar. */
  backlineDataDir: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    ollamaHost: required(env, "OLLAMA_HOST").replace(/\/+$/, ""),
    ollamaModel: required(env, "OLLAMA_MODEL"),
    backlineDataDir: optional(env, "BACKLINE_DATA_DIR"),
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing ${key}. Set it in .env (see .env.example).`);
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}
