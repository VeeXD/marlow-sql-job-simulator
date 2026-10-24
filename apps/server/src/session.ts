import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  CAST,
  COMPANY,
  DIFFICULTIES,
  NEXT_PROJECT,
  PROJECT_META,
  RELATIONSHIPS,
  SCHEMA_CATALOG,
  addMinutes,
  advanceSimNow,
  createInitialState,
  createProviderFromEnv,
  dailySlotsCrossed,
  estimateTokens,
  reduce,
  renderPrompt,
  timelineFacts,
  wordReply,
  type DirectorEvent,
  type Difficulty,
  type Effect,
  type SessionState,
  type SpeakEffect,
} from "@sim/engine";
import { config, databaseUrl } from "./config.js";
import { HttpError, pool } from "./db.js";
import {
  cloneSandbox,
  dropSandbox,
  gradeSandbox,
  injectBreak,
  introspect,
  postgresAdapter,
  runPlayerQuery,
  runSavedPipeline,
  touched,
  type SandboxHandle,
} from "./sandbox.js";

type SessionRow = SandboxHandle & {
  id: string;
  token: string;
  state: SessionState;
};

type TelemetryWrite = { name: string; payload: Record<string, unknown> };

type Context = {
  client: pg.PoolClient;
  session: SessionRow;
  telemetry: TelemetryWrite[];
};

let refreshHook: (sessionId: string) => void = () => {};
export function setRefreshHook(fn: (sessionId: string) => void) {
  refreshHook = fn;
}

let redisGet: ((key: string) => Promise<string | null>) | null = null;
let redisSet: ((key: string, value: string) => Promise<void>) | null = null;
export function setLlmCache(get: (key: string) => Promise<string | null>, set: (key: string, value: string) => Promise<void>) {
  redisGet = get;
  redisSet = set;
}

const baseProvider = createProviderFromEnv();
const provider = {
  id: baseProvider.id,
  async complete(req: { model: "manager" | "teammate"; system: string; user: string; fallback: string }) {
    const key = `llm:${createHash("sha256").update(`${req.model}\n${req.system}\n${req.user}`).digest("hex")}`;
    if (redisGet) {
      const hit = await redisGet(key).catch(() => null);
      if (hit) return hit;
    }
    const text = await baseProvider.complete(req);
    if (redisSet) await redisSet(key, text).catch(() => undefined);
    return text;
  },
};

function narrativeStamp(state: SessionState): string {
  return JSON.stringify({
    messages: state.messages.map((message) => [message.id, message.body, message.intent]),
    tickets: state.tickets.map((ticket) => [
      ticket.id,
      ticket.released,
      ticket.status,
      ticket.evaluationRule,
      ticket.lastVerdict?.summary ?? null,
    ]),
    stage: state.stage,
    breakStatus: state.breakStatus,
    breakFixed: state.breakFixed,
    run: state.runs[0]?.id ?? null,
    standing: state.standing,
    projectCompleted: state.projectCompleted,
    handoff: state.handoff,
    next: state.nextProjectChosen,
    pipeline: state.pipeline,
    clockPaused: state.clockPaused,
    onboarding: state.onboarding,
    review: state.review?.summary ?? null,
  });
}

function rowOf(row: pg.QueryResultRow): SessionRow {
  return {
    id: row.id,
    token: row.token,
    sandboxDb: row.sandbox_db,
    sandboxUser: row.sandbox_user,
    sandboxPassword: row.sandbox_password,
    state: row.state as SessionState,
  };
}

async function applyEffects(ctx: Context, effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "telemetry") {
      ctx.telemetry.push({ name: effect.name, payload: effect.payload });
      await ctx.client.query(
        `INSERT INTO telemetry_events (session_id, event_name, stage, sim_time, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.session.id, effect.name, ctx.session.state.stage, ctx.session.state.simNow, effect.payload],
      );
    } else if (effect.type === "inject_break") {
      await injectBreak(ctx.session);
    } else if (effect.type === "speak") {
      await reword(ctx, effect);
    }
  }
}

async function reword(ctx: Context, effect: SpeakEffect): Promise<void> {
  const promptInput = {
    personaId: effect.personaId,
    intent: effect.intent,
    allowedFacts: effect.allowedFacts,
    playerName: ctx.session.state.playerName,
    difficulty: ctx.session.state.difficulty,
    history: ctx.session.state.messages.slice(-8).map((message) => ({
      author: message.authorName,
      body: message.body,
    })),
    playerMessage: effect.playerMessage,
    schema: SCHEMA_CATALOG.map((table) => ({ table: table.table, columns: [...table.columns] })),
  };
  if (ctx.session.state.llmTokensUsed >= config.llmBudget) return;
  let scratch: pg.Client | null = null;
  const spoken = await wordReply({
    provider,
    prompt: promptInput,
    fallback: effect.fallback,
    facts: timelineFacts(ctx.session.state),
    threshold: config.hintThreshold,
    exec: {
      async query(sql, params) {
        if (!scratch) {
          scratch = new pg.Client({
            connectionString: databaseUrl(ctx.session.sandboxDb, ctx.session.sandboxUser, ctx.session.sandboxPassword),
          });
          await scratch.connect();
        }
        const result = await scratch.query(sql, params as never[]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
      },
    },
  }).finally(async () => {
    await scratch?.end();
  });
  const message = ctx.session.state.messages.find((item) => item.id === effect.messageId);
  if (message) message.body = spoken.text;
  ctx.session.state.llmTokensUsed += estimateTokens(renderPrompt(promptInput) + spoken.text);
}

async function dispatch(ctx: Context, event: DirectorEvent): Promise<void> {
  const reduced = reduce(ctx.session.state, event);
  if (reduced.error) throw new HttpError(400, reduced.error);
  ctx.session.state = reduced.state;
  await applyEffects(ctx, reduced.effects);
}

async function syncClock(ctx: Context): Promise<void> {
  const now = Date.now();
  const state = ctx.session.state;
  if (state.projectCompleted || state.abandoned) return;
  const advanced = advanceSimNow(
    state.simNow,
    state.lastRealSyncAt,
    state.lastActivityAt,
    now,
    config.simSpeed,
    config.idlePauseMs,
    state.clockPaused,
  );
  if (advanced.paused) {
    await dispatch(ctx, { type: "tick", simNow: state.simNow, realNow: now, paused: true });
    return;
  }
  const target = Date.parse(advanced.simNow);
  let guard = 0;
  while (Date.parse(ctx.session.state.simNow) + 500 < target && guard < 500) {
    const prev = ctx.session.state.simNow;
    const nextMs = Math.min(Date.parse(prev) + 60_000, target);
    const next = new Date(nextMs).toISOString();
    await dispatch(ctx, { type: "tick", simNow: next, realNow: now, paused: false });
    await runDueSchedules(ctx, prev, ctx.session.state.simNow);
    guard++;
  }
}

async function runDueSchedules(ctx: Context, prevIso: string, nextIso: string): Promise<void> {
  const pipeline = ctx.session.state.pipeline;
  if (!pipeline.enabled || pipeline.steps.length === 0) return;
  const slots = dailySlotsCrossed(prevIso, nextIso, pipeline.schedule.hour, pipeline.schedule.minute);
  for (const slot of slots) {
    if (ctx.session.state.scheduledRunKeys.includes(slot)) continue;
    ctx.session.state.scheduledRunKeys.push(slot);
    await executePipeline(ctx, "schedule");
  }
}

async function executePipeline(ctx: Context, trigger: "manual" | "schedule"): Promise<void> {
  const result = await runSavedPipeline(ctx.session, ctx.session.state.pipeline.steps);
  await dispatch(ctx, { type: "pipeline_finished", ok: result.ok, logs: result.logs, trigger });
}

async function withSession<T>(id: string, token: string, fn: (ctx: Context) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [id]);
    const row = found.rows[0];
    if (!row || row.token !== token) throw new HttpError(401, "Unknown session.");
    const ctx: Context = { client, session: rowOf(row), telemetry: [] };
    const beforeNarrative = narrativeStamp(ctx.session.state);
    const value = await fn(ctx);
    const changed = narrativeStamp(ctx.session.state) !== beforeNarrative;
    await client.query(
      `UPDATE sessions
       SET state = $2::jsonb, updated_at = now(), last_activity_at = to_timestamp($3 / 1000.0),
           completed = $4, abandoned = $5
       WHERE id = $1`,
      [
        id,
        JSON.stringify(ctx.session.state),
        ctx.session.state.lastActivityAt,
        ctx.session.state.projectCompleted,
        ctx.session.state.abandoned,
      ],
    );
    await client.query("COMMIT");
    if (changed) refreshHook(id);
    if (config.posthogKey) {
      for (const event of ctx.telemetry) {
        fetch(`${config.posthogHost.replace(/\/$/, "")}/capture/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: config.posthogKey,
            event: event.name,
            distinct_id: id,
            properties: { ...event.payload, stage: ctx.session.state.stage },
          }),
        }).catch(() => undefined);
      }
    }
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function worldBrief() {
  return {
    company: COMPANY,
    difficulties: DIFFICULTIES,
    project: PROJECT_META,
    cast: CAST.map(({ id, name, role, pronouns }) => ({ id, name, role, pronouns })),
    nextProject: NEXT_PROJECT,
  };
}

export function toDto(session: SessionRow) {
  const state = session.state;
  return {
    id: session.id,
    token: session.token,
    playerName: state.playerName,
    difficulty: state.difficulty,
    stage: state.stage,
    simNow: state.simNow,
    clockPaused: state.clockPaused,
    standing: state.standing,
    standingLog: state.standingLog.slice(-12),
    messages: state.messages,
    tickets: state.tickets
      .filter((ticket) => ticket.released)
      .map(({ hiddenEvaluation: _hidden, ...ticket }) => ticket),
    onboarding: state.onboarding,
    breakStatus: state.breakStatus,
    breakFixed: state.breakFixed,
    projectCompleted: state.projectCompleted,
    abandoned: state.abandoned,
    review: state.review,
    handoff: state.handoff,
    nextProjectChosen: state.nextProjectChosen,
    pipeline: state.pipeline,
    runs: state.runs,
    orderDefinitionUnlocked: state.hidden.orderDefinitionUnlocked,
    connection: {
      engine: "postgres" as const,
      host: config.publicPgHost,
      port: config.publicPgPort,
      database: session.sandboxDb,
      user: session.sandboxUser,
      password: session.sandboxPassword,
      timezone: "UTC",
      statementTimeoutMs: config.statementTimeoutMs,
      rowCap: config.rowCap,
    },
    company: COMPANY,
    project: PROJECT_META,
    cast: CAST.map(({ id, name, role, pronouns }) => ({ id, name, role, pronouns })),
    relationships: RELATIONSHIPS,
    llmProvider: provider.id,
  };
}

async function touch(ctx: Context): Promise<void> {
  await syncClock(ctx);
  await dispatch(ctx, { type: "activity", realNow: Date.now() });
}

export async function createSession(playerName: string, difficulty: Difficulty) {
  const id = randomUUID();
  const token = randomBytesToken();
  const handle = await cloneSandbox(id);
  let state = createInitialState({ playerName, difficulty });
  const started = reduce(state, { type: "start" });
  state = started.state;
  await pool.query(
    `INSERT INTO sessions (id, token, player_name, difficulty, sandbox_db, sandbox_user, sandbox_password, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [id, token, state.playerName, difficulty, handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword, JSON.stringify(state)],
  );
  return withSession(id, token, async (ctx) => {
    await applyEffects(ctx, started.effects);
    return toDto(ctx.session);
  });
}

function randomBytesToken(): string {
  return createHash("sha256").update(randomUUID() + Date.now().toString()).digest("hex");
}

export async function getSession(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    await syncClock(ctx);
    return toDto(ctx.session);
  });
}

export async function postChat(id: string, token: string, channel: string, body: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "player_message", channel, body });
    return toDto(ctx.session);
  });
}

export async function postQuery(id: string, token: string, sql: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    const result = await postgresAdapter(ctx.session).run(sql);
    await dispatch(ctx, {
      type: "query",
      ok: result.ok,
      errorMessage: result.error?.message ?? null,
      tables: touched(sql),
    });
    return { session: toDto(ctx.session), result };
  });
}

export async function openTicket(id: string, token: string, ticketId: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "open_ticket", ticketId });
    return toDto(ctx.session);
  });
}

export async function submitTicket(id: string, token: string, ticketId: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    if (ticketId === "clean" || ticketId === "pipeline" || ticketId === "break") {
      const grade = await gradeSandbox(ctx.session, ticketId, {
        stepCount: ctx.session.state.pipeline.steps.length,
        enabled: ctx.session.state.pipeline.enabled,
        cadence: ctx.session.state.pipeline.schedule.cadence,
        successfulRun: ctx.session.state.runs.some((run) => run.ok),
      });
      await dispatch(ctx, { type: "submit", ticketId, grade });
    } else {
      await dispatch(ctx, { type: "submit", ticketId, grade: { passed: false, checks: [] } });
    }
    return toDto(ctx.session);
  });
}

export async function savePipeline(
  id: string,
  token: string,
  steps: { id?: string; name: string; sql: string }[],
  schedule: { cadence: "daily"; hour: number; minute: number; timezone: "America/Los_Angeles" },
) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "save_pipeline", steps: steps.map((step) => ({ ...step, id: step.id ?? "" })), schedule });
    return toDto(ctx.session);
  });
}

export async function runPipelineNow(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    if (ctx.session.state.pipeline.steps.length === 0) throw new HttpError(400, "Add at least one step first.");
    await executePipeline(ctx, "manual");
    return toDto(ctx.session);
  });
}

export async function submitHandoff(id: string, token: string, body: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "submit_handoff", body });
    return toDto(ctx.session);
  });
}

export async function chooseNext(id: string, token: string, projectId: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "choose_next", projectId });
    return toDto(ctx.session);
  });
}

export async function abandon(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    await dispatch(ctx, { type: "abandon" });
    return toDto(ctx.session);
  });
}

export async function advanceClock(id: string, token: string, minutes: number) {
  if (!config.allowDebugClock) throw new HttpError(404, "Not found.");
  const bounded = Math.max(0, Math.min(24 * 60, Math.floor(minutes)));
  return withSession(id, token, async (ctx) => {
    const now = Date.now();
    await dispatch(ctx, { type: "activity", realNow: now });
    for (let i = 0; i < bounded; i++) {
      const prev = ctx.session.state.simNow;
      const next = addMinutes(prev, 1);
      await dispatch(ctx, { type: "tick", simNow: next, realNow: now, paused: false });
      await runDueSchedules(ctx, prev, ctx.session.state.simNow);
    }
    return toDto(ctx.session);
  });
}

export async function testConnection(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    const result = await runPlayerQuery(ctx.session, "SELECT current_user, current_database()");
    return { ok: result.ok, error: result.error, statements: result.statements };
  });
}

export async function schemaFor(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    const live = await introspect(ctx.session);
    return { tables: live, catalog: SCHEMA_CATALOG, relationships: RELATIONSHIPS };
  });
}

export async function telemetryFor(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    const rows = await ctx.client.query(
      `SELECT event_name, stage, sim_time, payload, created_at
       FROM telemetry_events WHERE session_id = $1 ORDER BY id`,
      [id],
    );
    return rows.rows;
  });
}

export async function scanActiveSessions(): Promise<void> {
  const rows = await pool.query(
    `SELECT id, token FROM sessions
     WHERE completed = false AND abandoned = false
       AND last_activity_at > now() - interval '36 hours'`,
  );
  for (const row of rows.rows) {
    await withSession(row.id, row.token, async (ctx) => {
      await syncClock(ctx);
      const idleFor = Date.now() - ctx.session.state.lastActivityAt;
      if (idleFor > 24 * 60 * 60 * 1000 && !ctx.session.state.abandoned && !ctx.session.state.projectCompleted) {
        await dispatch(ctx, { type: "abandon" });
      }
    }).catch((err) => {
      console.error("director scan failed", row.id, err);
    });
  }
}

export async function reapOldSandboxes(): Promise<void> {
  const rows = await pool.query(
    `SELECT id, token, sandbox_db, sandbox_user, sandbox_password FROM sessions
     WHERE (completed OR abandoned) AND updated_at < now() - interval '7 days'`,
  );
  for (const row of rows.rows) {
    await dropSandbox({
      sandboxDb: row.sandbox_db,
      sandboxUser: row.sandbox_user,
      sandboxPassword: row.sandbox_password,
    }).catch(() => undefined);
  }
}

export async function listSessionHandles(): Promise<SandboxHandle[]> {
  const rows = await pool.query(`SELECT sandbox_db, sandbox_user, sandbox_password FROM sessions`);
  return rows.rows.map((row) => ({
    sandboxDb: row.sandbox_db,
    sandboxUser: row.sandbox_user,
    sandboxPassword: row.sandbox_password,
  }));
}
