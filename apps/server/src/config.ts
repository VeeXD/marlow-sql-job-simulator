export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://sim:sim@127.0.0.1:5432/sim",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  apiPort: Number(process.env.API_PORT ?? 3848),
  publicPgHost: process.env.PUBLIC_PG_HOST ?? "localhost",
  publicPgPort: Number(process.env.PUBLIC_PG_PORT ?? 5432),
  simSpeed: Number(process.env.SIM_SPEED ?? 120),
  idlePauseMs: Number(process.env.IDLE_PAUSE_MS ?? 90_000),
  allowDebugClock: process.env.ALLOW_DEBUG_CLOCK !== "false",
  statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS ?? 15_000),
  rowCap: Number(process.env.ROW_CAP ?? 500),
  enableWorker: process.env.ENABLE_WORKER !== "false",
  llmBudget: Number(process.env.LLM_SESSION_BUDGET_TOKENS ?? 80_000),
  hintThreshold: Number(process.env.HINT_SIMILARITY_THRESHOLD ?? 0.55),
  posthogKey: process.env.POSTHOG_KEY ?? "",
  posthogHost: process.env.POSTHOG_HOST ?? "https://app.posthog.com",
  logLevel: process.env.LOG_LEVEL ?? "info",
  signalsPage:
    process.env.ALLOW_SIGNALS_PAGE === "false"
      ? false
      : process.env.ALLOW_SIGNALS_PAGE === "true"
        ? true
        : process.env.NODE_ENV !== "production",
};

export function databaseUrl(database: string, user?: string, password?: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}
