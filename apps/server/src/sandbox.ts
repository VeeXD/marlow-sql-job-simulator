import pg from "pg";
import { randomBytes } from "node:crypto";
import {
  LATE_SOURCE_FILE,
  getWorldSeed,
  gradeCleanOrders,
  gradeConsumers,
  gradePipelineMeta,
  runPipeline,
  runScript,
  splitSql,
  assertSafe,
  tablesTouched,
  type GradeResult,
  type SqlExec,
  type StepLog,
} from "@sim/engine";
import { config, databaseUrl } from "./config.js";
import { pool } from "./db.js";

const { Client } = pg;

export type SandboxHandle = {
  sandboxDb: string;
  sandboxUser: string;
  sandboxPassword: string;
};

function clientFor(database: string, user?: string, password?: string): pg.Client {
  return new Client({ connectionString: databaseUrl(database, user, password) });
}

function asExec(client: pg.Client): SqlExec {
  return {
    async query(sql, params) {
      const result = await client.query(sql, params as never[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
  };
}

export async function ensureTemplate(force = false): Promise<void> {
  const seed = getWorldSeed();
  const meta = await pool.query(`SELECT value FROM app_meta WHERE key = 'seed_version'`);
  const exists = await pool.query(`SELECT 1 FROM pg_database WHERE datname = 'marlow_template'`);
  if (exists.rowCount && meta.rows[0]?.value === String(seed.version) && !force) return;
  if (exists.rowCount) {
    await pool.query(`UPDATE pg_database SET datallowconn = true WHERE datname = 'marlow_template'`);
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'marlow_template' AND pid <> pg_backend_pid()`,
    );
    await pool.query(`DROP DATABASE IF EXISTS marlow_template`);
  }
  await pool.query(`CREATE DATABASE marlow_template`);
  const client = clientFor("marlow_template");
  await client.connect();
  try {
    await runScript(asExec(client), `${seed.ddl}\n${seed.inserts}`);
  } finally {
    await client.end();
  }
  await pool.query(`UPDATE pg_database SET datallowconn = false WHERE datname = 'marlow_template'`);
  await pool.query(
    `INSERT INTO app_meta (key, value) VALUES ('seed_version', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(seed.version)],
  );
}

export async function cloneSandbox(sessionId: string): Promise<SandboxHandle> {
  const suffix = sessionId.replace(/-/g, "");
  const sandboxDb = `sandbox_${suffix}`;
  const sandboxUser = `player_${suffix}`;
  const sandboxPassword = randomBytes(18).toString("hex");
  await pool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'marlow_template' AND pid <> pg_backend_pid()`,
  );
  try {
    await pool.query(`CREATE DATABASE ${sandboxDb} TEMPLATE marlow_template`);
  } catch {
    await pool.query(`UPDATE pg_database SET datallowconn = true WHERE datname = 'marlow_template'`);
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'marlow_template' AND pid <> pg_backend_pid()`,
    );
    await pool.query(`CREATE DATABASE ${sandboxDb} TEMPLATE marlow_template`);
    await pool.query(`UPDATE pg_database SET datallowconn = false WHERE datname = 'marlow_template'`);
  }
  const client = clientFor(sandboxDb);
  try {
    await client.connect();
    await client.query(
      `CREATE ROLE ${sandboxUser} LOGIN PASSWORD '${sandboxPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await client.query(`GRANT CONNECT ON DATABASE ${sandboxDb} TO ${sandboxUser}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${sandboxUser}`);
    await client.query(`GRANT SELECT ON raw_orders, raw_events TO ${sandboxUser}`);
    await client.query(`ALTER ROLE ${sandboxUser} SET statement_timeout = '${config.statementTimeoutMs}ms'`);
    await client.query(`ALTER ROLE ${sandboxUser} SET timezone = 'UTC'`);
    await client.query(`ALTER ROLE ${sandboxUser} SET idle_in_transaction_session_timeout = '30s'`);
    await client.query(`ALTER ROLE ${sandboxUser} SET search_path = public`);
  } catch (err) {
    await client.end().catch(() => undefined);
    await pool.query(`DROP DATABASE IF EXISTS ${sandboxDb}`);
    await pool.query(`DROP ROLE IF EXISTS ${sandboxUser}`);
    throw err;
  }
  await client.end();
  await pool.query(`REVOKE ALL ON DATABASE ${sandboxDb} FROM PUBLIC`);
  await pool.query(`GRANT CONNECT ON DATABASE ${sandboxDb} TO ${sandboxUser}`);
  return { sandboxDb, sandboxUser, sandboxPassword };
}

export async function dropSandbox(handle: SandboxHandle): Promise<void> {
  await pool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [handle.sandboxDb],
  );
  await pool.query(`DROP DATABASE IF EXISTS ${handle.sandboxDb}`);
  await pool.query(`DROP ROLE IF EXISTS ${handle.sandboxUser}`);
}

export async function injectBreak(handle: SandboxHandle): Promise<void> {
  const client = clientFor(handle.sandboxDb);
  await client.connect();
  try {
    const existing = await client.query(`SELECT 1 FROM raw_orders WHERE source_file = $1 LIMIT 1`, [LATE_SOURCE_FILE]);
    if (existing.rows.length > 0) return;
    await runScript(asExec(client), getWorldSeed().breakSql);
  } finally {
    await client.end();
  }
}

export type StatementResult = {
  command: string | null;
  rowCount: number | null;
  fields: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
};

export type PlayerQueryResult = {
  ok: boolean;
  statements: StatementResult[];
  durationMs: number;
  error: {
    message: string;
    code?: string;
    detail?: string | null;
    hint?: string | null;
    position?: string | null;
    severity?: string | null;
  } | null;
};

export async function runPlayerQuery(handle: SandboxHandle, sql: string): Promise<PlayerQueryResult> {
  const started = Date.now();
  const statements = splitSql(sql);
  if (statements.length === 0) {
    return { ok: false, statements: [], durationMs: 0, error: { message: "No SQL to run." } };
  }
  if (statements.length > 25) {
    return { ok: false, statements: [], durationMs: 0, error: { message: "Too many statements in one run (max 25)." } };
  }
  if (sql.length > 100_000) {
    return { ok: false, statements: [], durationMs: 0, error: { message: "SQL is too large." } };
  }
  for (const statement of statements) {
    try {
      assertSafe(statement, { allowTransaction: true });
    } catch (err) {
      return {
        ok: false,
        statements: [],
        durationMs: Date.now() - started,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  const client = clientFor(handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword);
  await client.connect();
  const results: StatementResult[] = [];
  try {
    await client.query(`SET statement_timeout = '${config.statementTimeoutMs}ms'`);
    for (const statement of statements) {
      try {
        const result = await client.query(statement);
        const rows = result.rows.slice(0, config.rowCap);
        results.push({
          command: result.command,
          rowCount: result.rowCount,
          fields: result.fields.map((field) => field.name),
          rows,
          truncated: result.rows.length > config.rowCap,
        });
      } catch (err) {
        const pgErr = err as pg.DatabaseError;
        return {
          ok: false,
          statements: results,
          durationMs: Date.now() - started,
          error: {
            message: pgErr.message,
            code: pgErr.code,
            detail: pgErr.detail ?? null,
            hint: pgErr.hint ?? null,
            position: pgErr.position ?? null,
            severity: pgErr.severity ?? null,
          },
        };
      }
    }
  } finally {
    await client.end();
  }
  return { ok: true, statements: results, durationMs: Date.now() - started, error: null };
}

export async function introspect(handle: SandboxHandle): Promise<{ table: string; columns: { name: string; dataType: string; nullable: boolean }[] }[]> {
  const client = clientFor(handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword);
  await client.connect();
  try {
    const result = await client.query(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    const tables = new Map<string, { name: string; dataType: string; nullable: boolean }[]>();
    for (const row of result.rows) {
      const list = tables.get(row.table_name) ?? [];
      list.push({ name: row.column_name, dataType: row.data_type, nullable: row.is_nullable === "YES" });
      tables.set(row.table_name, list);
    }
    return [...tables.entries()].map(([table, columns]) => ({ table, columns }));
  } finally {
    await client.end();
  }
}

export async function runSavedPipeline(
  handle: SandboxHandle,
  steps: { name: string; sql: string }[],
): Promise<{ ok: boolean; logs: StepLog[] }> {
  const client = clientFor(handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword);
  await client.connect();
  try {
    await client.query(`SET statement_timeout = '${config.statementTimeoutMs}ms'`);
    return await runPipeline(steps, asExec(client));
  } finally {
    await client.end();
  }
}

export async function gradeSandbox(
  handle: SandboxHandle,
  kind: "clean" | "pipeline" | "break",
  meta: { stepCount: number; enabled: boolean; cadence: string; successfulRun: boolean },
): Promise<GradeResult> {
  const client = clientFor(handle.sandboxDb);
  await client.connect();
  try {
    await client.query(`SET statement_timeout = '30s'`);
    const exec = asExec(client);
    if (kind === "clean") return await gradeCleanOrders(exec);
    const clean = await gradeCleanOrders(exec);
    const consumers = await gradeConsumers(exec);
    const checks = [...clean.checks, ...consumers.checks];
    if (kind === "pipeline") checks.push(...gradePipelineMeta(meta).checks);
    return { passed: checks.every((check) => check.ok), checks };
  } finally {
    await client.end();
  }
}

export function touched(sql: string): string[] {
  return tablesTouched(sql);
}

/** Postgres sandbox adapter. MySQL and DuckDB throw from createAdapter until a later release. */
export function postgresAdapter(handle: SandboxHandle) {
  return {
    engine: "postgres" as const,
    run: (sql: string) => runPlayerQuery(handle, sql),
    introspect: () => introspect(handle),
  };
}
