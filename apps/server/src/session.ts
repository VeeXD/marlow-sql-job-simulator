import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  CAST,
  COMPANY,
  CONSENT_NOTICE,
  DIFFICULTIES,
  NEXT_PROJECT,
  PROJECT_META,
  RELATIONSHIPS,
  RETENTION_DAYS,
  SCHEMA_CATALOG,
  addMinutes,
  advanceSimNow,
  contentHash,
  createInitialState,
  createProviderFromEnv,
  dailySlotsCrossed,
  errorClass,
  estimateTokens,
  groupSignals,
  isProfilingQuery,
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
    // Fallback is part of the key so a mock (or a rejected draft) cannot reuse
    // another line from the same persona prompt. Bursts share a system prompt.
    const key = `llm:${createHash("sha256").update(`${req.model}\n${req.fallback}\n${req.system}\n${req.user}`).digest("hex")}`;
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
    cohort: state.cohort,
  });
}

function hydrateState(raw: SessionState): SessionState {
  const fresh = createInitialState({
    playerName: raw.playerName,
    difficulty: raw.difficulty,
    consent: raw.consent,
  });
  const state: SessionState = {
    ...fresh,
    ...raw,
    consent: raw.consent ?? fresh.consent,
    cohort: raw.cohort ?? fresh.cohort,
    lastQueryFailed: raw.lastQueryFailed ?? false,
    pressureOpen: raw.pressureOpen ?? false,
    scenarioVersion: raw.scenarioVersion ?? fresh.scenarioVersion,
    seed: raw.seed ?? fresh.seed,
  };
  if (!state.tickets.some((ticket) => ticket.id === "cohort")) {
    const cohort = fresh.tickets.find((ticket) => ticket.id === "cohort");
    if (cohort) state.tickets.push(structuredClone(cohort));
  }
  return state;
}

function rowOf(row: pg.QueryResultRow): SessionRow {
  return {
    id: row.id,
    token: row.token,
    sandboxDb: row.sandbox_db,
    sandboxUser: row.sandbox_user,
    sandboxPassword: row.sandbox_password,
    state: hydrateState(row.state as SessionState),
  };
}

async function writeTelemetry(ctx: Context, name: string, payload: Record<string, unknown>): Promise<void> {
  ctx.telemetry.push({ name, payload });
  await ctx.client.query(
    `INSERT INTO telemetry_events (session_id, event_name, stage, sim_time, payload, scenario_version, seed, wall_time)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())`,
    [
      ctx.session.id,
      name,
      ctx.session.state.stage,
      ctx.session.state.simNow,
      payload,
      ctx.session.state.scenarioVersion ?? null,
      ctx.session.state.seed ?? null,
    ],
  );
}

async function applyEffects(ctx: Context, effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "telemetry") {
      await writeTelemetry(ctx, effect.name, effect.payload);
    } else if (effect.type === "inject_break") {
      await injectBreak(ctx.session, effect.kind);
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
  const cohortOpen = state.cohort?.active && !state.cohort.completed;
  if ((state.projectCompleted && !cohortOpen) || state.abandoned) return;
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
    signalsPage: config.signalsPage,
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
    kt: state.kt ?? { status: "scheduled" as const, topicsCovered: [], questionsAsked: 0 },
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
    consent: state.consent,
    cohort: state.cohort,
    scenarioVersion: state.scenarioVersion,
    seed: state.seed,
    signalsPage: config.signalsPage,
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
  let state = createInitialState({
    playerName,
    difficulty,
    consent: {
      practiceTelemetry: true,
      integritySignals: true,
      retentionDays: RETENTION_DAYS,
      notice: CONSENT_NOTICE,
    },
  });
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

export async function joinKt(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "join_kt" });
    return toDto(ctx.session);
  });
}

export async function completeKt(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    await dispatch(ctx, { type: "complete_kt" });
    return toDto(ctx.session);
  });
}

export async function postChat(id: string, token: string, channel: string, body: string) {
  return withSession(id, token, async (ctx) => {
    const previousActivity = ctx.session.state.lastActivityAt;
    await touch(ctx);
    const wallLatencyMs = Math.max(0, Date.now() - previousActivity);
    await dispatch(ctx, { type: "player_message", channel, body, wallLatencyMs });
    return toDto(ctx.session);
  });
}

export async function postQuery(id: string, token: string, sql: string) {
  return withSession(id, token, async (ctx) => {
    await touch(ctx);
    const result = await postgresAdapter(ctx.session).run(sql);
    const rowsReturned = result.statements.reduce((count, statement) => count + statement.rows.length, 0);
    await dispatch(ctx, {
      type: "query",
      ok: result.ok,
      errorMessage: result.error?.message ?? null,
      tables: touched(sql),
      signal: {
        sqlHash: contentHash(sql),
        durationMs: result.durationMs,
        rowsReturned,
        rowsScannedEstimate: result.rowsScannedEstimate,
        errorClass: result.ok ? null : errorClass(result.error?.code),
        engine: "postgres",
        followsError: false,
        profiling: isProfilingQuery(sql),
        truncated: result.statements.some((statement) => statement.truncated),
        capApplied: result.statements.some((statement) => statement.capApplied),
      },
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
    if (ticketId === "clean" || ticketId === "pipeline" || ticketId === "break" || ticketId === "cohort") {
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

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function telemetryFor(id: string, token: string) {
  return withSession(id, token, async (ctx) => {
    const rows = await ctx.client.query(
      `SELECT id, event_name, stage, sim_time, wall_time, created_at, scenario_version, seed, payload
       FROM telemetry_events WHERE session_id = $1 ORDER BY id`,
      [id],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      event_name: row.event_name,
      stage: row.stage,
      sim_time: iso(row.sim_time),
      wall_time: iso(row.wall_time),
      created_at: iso(row.created_at),
      scenario_version: row.scenario_version,
      seed: row.seed,
      payload: row.payload,
    }));
  });
}

export async function signalsFor(id: string, token: string) {
  if (!config.signalsPage) throw new HttpError(404, "Not found.");
  const events = await telemetryFor(id, token);
  return groupSignals(events);
}

export async function recordSignal(
  id: string,
  token: string,
  body:
    | { kind: "erd_opened" }
    | { kind: "table_previewed"; table: string }
    | { kind: "paste"; pasteChars: number }
    | { kind: "focus_loss" }
    | { kind: "typing_cadence"; keyCount: number; medianIntervalMs: number },
) {
  return withSession(id, token, async (ctx) => {
    if (body.kind === "erd_opened" || body.kind === "table_previewed") {
      await writeTelemetry(ctx, "schema_explored", {
        kind: body.kind,
        table: body.kind === "table_previewed" ? body.table : null,
      });
      return { ok: true };
    }
    if (!ctx.session.state.consent?.integritySignals) {
      throw new HttpError(403, "Integrity signals were not accepted for this session.");
    }
    if (body.kind === "paste") {
      await writeTelemetry(ctx, "integrity_signal", { kind: "paste", pasteChars: body.pasteChars });
    } else if (body.kind === "focus_loss") {
      await writeTelemetry(ctx, "integrity_signal", { kind: "focus_loss" });
    } else {
      await writeTelemetry(ctx, "integrity_signal", {
        kind: "typing_cadence",
        keyCount: body.keyCount,
        medianIntervalMs: body.medianIntervalMs,
      });
    }
    return { ok: true };
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
