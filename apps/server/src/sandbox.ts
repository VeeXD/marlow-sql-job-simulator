import pg from "pg";
import { randomBytes } from "node:crypto";
import {
  LATE_SOURCE_FILE,
  applyRowCap,
  getWorldSeed,
  gradeCleanOrders,
  gradeConsumers,
  gradePipelineMeta,
  gradeRepeatCohorts,
  nullSpikeSql,
  runPipeline,
  runScript,
  schemaDriftSql,
  splitSql,
  NOTEBOOK_ROW_CAP,
  PREVIEW_PAGE_SIZE,
  assertSafe,
  assertWritableTable,
  bucketLabel,
  countSql,
  dropCreateSql,
  histogramSql,
  isNumericType,
  previewSql,
  previewWindow,
  quoteIdent,
  scalarProfileSql,
  stripCommentsAndStrings,
  tablesTouched,
  topValuesSql,
  type BreakKind,
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
    await pool.query(`ALTER DATABASE marlow_template ALLOW_CONNECTIONS true`);
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
  await pool.query(`ALTER DATABASE marlow_template ALLOW_CONNECTIONS false`);
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
    await pool.query(`ALTER DATABASE marlow_template ALLOW_CONNECTIONS true`);
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'marlow_template' AND pid <> pg_backend_pid()`,
    );
    await pool.query(`CREATE DATABASE ${sandboxDb} TEMPLATE marlow_template`);
    await pool.query(`ALTER DATABASE marlow_template ALLOW_CONNECTIONS false`);
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

export async function injectBreak(handle: SandboxHandle, kind: BreakKind = "late_data"): Promise<void> {
  const client = clientFor(handle.sandboxDb);
  await client.connect();
  try {
    if (kind === "late_data") {
      const existing = await client.query(`SELECT 1 FROM raw_orders WHERE source_file = $1 LIMIT 1`, [LATE_SOURCE_FILE]);
      if (existing.rows.length > 0) return;
      await runScript(asExec(client), getWorldSeed().breakSql);
      return;
    }
    if (kind === "schema_drift") {
      await runScript(asExec(client), schemaDriftSql());
      return;
    }
    await runScript(asExec(client), nullSpikeSql());
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
  capApplied: boolean;
  rowsScannedEstimate: number | null;
};

export type PlayerQueryResult = {
  ok: boolean;
  statements: StatementResult[];
  durationMs: number;
  rowsScannedEstimate: number | null;
  error: {
    message: string;
    code?: string;
    detail?: string | null;
    hint?: string | null;
    position?: string | null;
    severity?: string | null;
  } | null;
};

export async function runPlayerQuery(handle: SandboxHandle, sql: string, rowCap = config.rowCap): Promise<PlayerQueryResult> {
  const started = Date.now();
  const statements = splitSql(sql);
  if (statements.length === 0) {
    return { ok: false, statements: [], durationMs: 0, rowsScannedEstimate: null, error: { message: "No SQL to run." } };
  }
  if (statements.length > 25) {
    return { ok: false, statements: [], durationMs: 0, rowsScannedEstimate: null, error: { message: "Too many statements in one run (max 25)." } };
  }
  if (sql.length > 100_000) {
    return { ok: false, statements: [], durationMs: 0, rowsScannedEstimate: null, error: { message: "SQL is too large." } };
  }
  for (const statement of statements) {
    try {
      assertSafe(statement, { allowTransaction: true });
    } catch (err) {
      return {
        ok: false,
        statements: [],
        durationMs: Date.now() - started,
        rowsScannedEstimate: null,
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
      const capped = applyRowCap(statement, rowCap);
      const rowsScannedEstimate = isReadStatement(statement) ? await estimateScanned(handle, capped.sql) : null;
      try {
        const result = await client.query(capped.sql);
        const truncated = capped.capApplied && result.rows.length > rowCap;
        const rows = truncated ? result.rows.slice(0, rowCap) : result.rows;
        results.push({
          command: result.command,
          rowCount: truncated ? rows.length : result.rowCount,
          fields: result.fields.map((field) => field.name),
          rows,
          truncated,
          capApplied: capped.capApplied,
          rowsScannedEstimate,
        });
      } catch (err) {
        const pgErr = err as pg.DatabaseError;
        return {
          ok: false,
          statements: results,
          durationMs: Date.now() - started,
          rowsScannedEstimate: sumEstimates(results),
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
  return { ok: true, statements: results, durationMs: Date.now() - started, rowsScannedEstimate: sumEstimates(results), error: null };
}

function isReadStatement(statement: string): boolean {
  return /^(select|with|table|values|show)\b/i.test(stripCommentsAndStrings(statement).trim());
}

function sumEstimates(results: StatementResult[]): number | null {
  const known = results.map((item) => item.rowsScannedEstimate).filter((value): value is number => value != null);
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

function sumScanRows(node: { "Node Type"?: string; "Plan Rows"?: number; Plans?: unknown[] } | null | undefined): number {
  if (!node) return 0;
  const type = node["Node Type"] ?? "";
  const self = /Scan/.test(type) && typeof node["Plan Rows"] === "number" ? node["Plan Rows"] : 0;
  const children = (node.Plans ?? []).reduce<number>((sum, child) => sum + sumScanRows(child as typeof node), 0);
  return self + children;
}

/** Planner estimate only. A separate connection so a failed EXPLAIN cannot abort the player's transaction. */
async function estimateScanned(handle: SandboxHandle, sql: string): Promise<number | null> {
  const client = clientFor(handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword);
  try {
    await client.connect();
    await client.query(`SET statement_timeout = '${config.statementTimeoutMs}ms'`);
    const explained = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    const plan = explained.rows[0]?.["QUERY PLAN"] as { Plan?: { "Node Type"?: string; "Plan Rows"?: number; Plans?: unknown[] } }[] | undefined;
    return sumScanRows(plan?.[0]?.Plan);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
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
  kind: "clean" | "pipeline" | "break" | "cohort",
  meta: { stepCount: number; enabled: boolean; cadence: string; successfulRun: boolean },
): Promise<GradeResult> {
  const client = clientFor(handle.sandboxDb);
  await client.connect();
  try {
    await client.query(`SET statement_timeout = '30s'`);
    const exec = asExec(client);
    if (kind === "cohort") return await gradeRepeatCohorts(exec);
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

export type TableColumn = { name: string; dataType: string; nullable: boolean };

async function publicColumns(handle: SandboxHandle, table: string): Promise<TableColumn[]> {
  const client = clientFor(handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword);
  await client.connect();
  try {
    const result = await client.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    return result.rows.map((row) => ({
      name: String(row.column_name),
      dataType: String(row.data_type),
      nullable: row.is_nullable === "YES",
    }));
  } finally {
    await client.end();
  }
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function previewPlayerTable(
  handle: SandboxHandle,
  table: string,
  opts: { sort?: string; dir?: "asc" | "desc"; offset?: number },
) {
  const columns = await publicColumns(handle, table);
  if (columns.length === 0) {
    return { error: "That table is not in your database yet." };
  }
  const sort = opts.sort && columns.some((column) => column.name === opts.sort) ? opts.sort : columns[0].name;
  const window = previewWindow(opts.offset ?? 0, PREVIEW_PAGE_SIZE);
  const counted = await runPlayerQuery(handle, countSql(table));
  if (!counted.ok) return { error: counted.error?.message ?? "Could not count the table." };
  const total = Number(counted.statements[0]?.rows[0]?.n ?? 0);
  const preview = await runPlayerQuery(handle, previewSql(table, { sort, dir: opts.dir === "desc" ? "desc" : "asc", ...window }));
  if (!preview.ok) return { error: preview.error?.message ?? "Could not preview the table." };
  const statement = preview.statements[0];
  return {
    table,
    columns: statement?.fields ?? columns.map((column) => column.name),
    rows: statement?.rows ?? [],
    offset: window.offset,
    limit: window.limit,
    total,
    browseCap: 500,
    sort,
    dir: opts.dir === "desc" ? "desc" : "asc",
    readOnly: table === "raw_orders" || table === "raw_events",
  };
}

export async function profilePlayerTable(handle: SandboxHandle, table: string) {
  const columns = await publicColumns(handle, table);
  if (columns.length === 0) return { error: "That table is not in your database yet." as const };
  const scalar = await runPlayerQuery(handle, scalarProfileSql(table, columns));
  if (!scalar.ok) return { error: scalar.error?.message ?? "Could not profile the table." };
  const header = scalar.statements[0]?.rows[0] ?? {};
  const rows = Number(header.n ?? 0);
  const blob = (header.columns ?? {}) as Record<string, Record<string, unknown>>;
  const profiles = [];
  for (const column of columns) {
    const stats = blob[column.name] ?? {};
    const nulls = Number(stats.nulls ?? 0);
    const numeric = isNumericType(column.dataType);
    const top = await runPlayerQuery(handle, topValuesSql(table, column.name));
    if (!top.ok) return { error: top.error?.message ?? `Could not summarize ${column.name}.` };
    let histogram: { label: string; n: number }[] = [];
    if (numeric) {
      const hist = await runPlayerQuery(handle, histogramSql(table, column.name));
      if (!hist.ok) return { error: hist.error?.message ?? `Could not bin ${column.name}.` };
      const bins = hist.statements[0]?.rows ?? [];
      if (bins.length === 0 && stats.min != null && stats.min === stats.max) {
        histogram = [{ label: String(stats.min), n: Math.max(0, rows - nulls) }];
      } else {
        histogram = bins.map((bin) => ({
          label: bucketLabel(Number(bin.bucket), Number(bin.lo), Number(bin.hi)),
          n: Number(bin.n),
        }));
      }
    } else {
      histogram = (top.statements[0]?.rows ?? []).map((row) => ({
        label: row.value == null ? "null" : String(row.value),
        n: Number(row.n),
      }));
    }
    profiles.push({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      rows,
      nulls,
      nullPct: rows === 0 ? 0 : Math.round((nulls / rows) * 1000) / 10,
      distinct: Number(stats.distinct ?? 0),
      min: stats.min == null ? null : String(stats.min),
      max: stats.max == null ? null : String(stats.max),
      mean: numeric ? asNumber(stats.mean) : null,
      median: numeric ? asNumber(stats.median) : null,
      top: (top.statements[0]?.rows ?? []).map((row) => ({
        value: row.value == null ? "null" : String(row.value),
        n: Number(row.n),
      })),
      histogram,
    });
  }
  return { table, rows, columns: profiles, readOnly: table === "raw_orders" || table === "raw_events" };
}

export async function writePlayerTable(
  handle: SandboxHandle,
  name: string,
  columns: { name: string; dtype: string }[],
  rows: unknown[][],
) {
  if (rows.length > NOTEBOOK_ROW_CAP) {
    throw new Error(`A notebook write stops at ${NOTEBOOK_ROW_CAP} rows.`);
  }
  const built = dropCreateSql(name, columns);
  assertSafe(built.drop);
  assertSafe(built.create);
  assertWritableTable(name);
  const client = clientFor(handle.sandboxDb, handle.sandboxUser, handle.sandboxPassword);
  await client.connect();
  try {
    await client.query(`SET statement_timeout = '${config.statementTimeoutMs}ms'`);
    await client.query("BEGIN");
    await client.query(built.drop);
    await client.query(built.create);
    const quotedCols = columns.map((column) => quoteIdent(column.name)).join(", ");
    const width = columns.length;
    for (let start = 0; start < rows.length; start += 200) {
      const chunk = rows.slice(start, start + 200);
      const params: unknown[] = [];
      const groups = chunk.map((row) => {
        const slots = columns.map((_, index) => {
          params.push(row[index] ?? null);
          return `$${params.length}`;
        });
        if (row.length !== width) throw new Error("A notebook row does not match the columns.");
        return `(${slots.join(", ")})`;
      });
      await client.query(`INSERT INTO public.${quoteIdent(assertWritableTable(name))} (${quotedCols}) VALUES ${groups.join(", ")}`, params);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  return { table: assertWritableTable(name), rows: rows.length };
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
