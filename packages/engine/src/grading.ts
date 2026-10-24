import { CHURN_SELECT_FROM, CLEAN_SELECT, REVENUE_SELECT_FROM } from "./reference.js";
import { failed, passed, type SqlExec } from "./sql.js";
import type { GradeCheck, GradeResult } from "./types.js";

function result(checks: GradeCheck[]): GradeResult {
  return { passed: checks.every((c) => c.ok), checks };
}

async function tableExists(exec: SqlExec, table: string): Promise<boolean> {
  const res = await exec.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [table],
  );
  return Boolean(res.rows[0]?.ok);
}

type ColumnInfo = { column_name: string; is_nullable: string; data_type: string };

async function columns(exec: SqlExec, table: string): Promise<ColumnInfo[]> {
  const res = await exec.query(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return res.rows as unknown as ColumnInfo[];
}

async function uniqueOn(exec: SqlExec, table: string, column: string): Promise<boolean> {
  const res = await exec.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = $1 AND i.indisunique`,
    [table],
  );
  return res.rows.some((row) => {
    const def = String(row.def ?? "");
    const single = new RegExp(`\\(${column}\\)`);
    const composite = new RegExp(`\\(${column}\\s*,`);
    return single.test(def) && !composite.test(def);
  });
}

async function buildRefs(exec: SqlExec): Promise<void> {
  await exec.query("DROP TABLE IF EXISTS g2_ref_clean");
  await exec.query("DROP TABLE IF EXISTS g2_ref_churn");
  await exec.query("DROP TABLE IF EXISTS g2_ref_revenue");
  await exec.query(`CREATE TEMP TABLE g2_ref_clean AS ${CLEAN_SELECT}`);
  await exec.query(`CREATE TEMP TABLE g2_ref_churn AS ${CHURN_SELECT_FROM("g2_ref_clean")}`);
  await exec.query(`CREATE TEMP TABLE g2_ref_revenue AS ${REVENUE_SELECT_FROM("g2_ref_clean")}`);
}

type CleanRow = { order_id: string; customer_id: string; ordered_at: string; amount_cents: number };

async function readClean(exec: SqlExec, table: string): Promise<CleanRow[]> {
  const res = await exec.query(
    `SELECT order_id::text AS order_id,
            customer_id::text AS customer_id,
            to_char(ordered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS ordered_at,
            amount_cents::bigint AS amount_cents
     FROM ${table}`,
  );
  return res.rows.map((r) => ({
    order_id: String(r.order_id),
    customer_id: String(r.customer_id),
    ordered_at: String(r.ordered_at),
    amount_cents: Number(r.amount_cents),
  }));
}

function indexBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Map<string, T> | null {
  const map = new Map<string, T>();
  for (const row of rows) {
    const id = String(row[key]);
    if (map.has(id)) return null;
    map.set(id, row);
  }
  return map;
}

export async function gradeCleanOrders(exec: SqlExec): Promise<GradeResult> {
  const checks: GradeCheck[] = [];
  if (!(await tableExists(exec, "clean_orders"))) {
    return result([failed("table_exists", "`clean_orders` does not exist yet.")]);
  }
  checks.push(passed("table_exists", "`clean_orders` exists."));

  const cols = await columns(exec, "clean_orders");
  const byName = new Map(cols.map((c) => [c.column_name, c]));
  const required = ["order_id", "customer_id", "ordered_at", "amount_cents"];
  const missingCols = required.filter((c) => !byName.has(c));
  checks.push(
    missingCols.length === 0
      ? passed("columns", "Required columns are present.")
      : failed("columns", `Missing columns: ${missingCols.map((c) => `\`${c}\``).join(", ")}.`),
  );

  const ordered = byName.get("ordered_at");
  if (ordered) {
    checks.push(
      ordered.data_type === "timestamp with time zone"
        ? passed("timestamptz", "`ordered_at` is timestamptz.")
        : failed("timestamptz", "`ordered_at` needs to be timestamptz so the clock is actually UTC."),
    );
  }

  const nullCols = required.filter((name) => byName.get(name)?.is_nullable !== "NO");
  checks.push(
    nullCols.length === 0
      ? passed("not_null", "order_id, customer_id, ordered_at, and amount_cents are NOT NULL.")
      : failed(
          "not_null",
          `These columns still allow nulls: ${nullCols.map((c) => `\`${c}\``).join(", ")}.`,
        ),
  );

  const unique = await uniqueOn(exec, "clean_orders", "order_id");
  checks.push(
    unique
      ? passed("unique", "`order_id` has a primary key or unique constraint.")
      : failed("unique", "`order_id` needs a primary key or a unique constraint, not just lucky data."),
  );

  await exec.query("BEGIN");
  try {
    await exec.query("SET LOCAL TIME ZONE 'UTC'");
    await buildRefs(exec);
    const expected = await readClean(exec, "g2_ref_clean");
    let actual: CleanRow[] = [];
    try {
      actual = await readClean(exec, "clean_orders");
    } catch (err) {
      checks.push(failed("rows", err instanceof Error ? err.message : String(err)));
      return result(checks);
    }
    const exp = indexBy(expected, "order_id");
    const act = indexBy(actual, "order_id");
    if (!act) {
      checks.push(failed("duplicates", "Duplicate `order_id` values are still in `clean_orders`."));
    } else if (!exp) {
      checks.push(failed("rows", "The reference set could not be built."));
    } else {
      checks.push(passed("duplicates", "No duplicate `order_id` values."));
      const missing = [...exp.keys()].filter((id) => !act.has(id)).length;
      const extra = [...act.keys()].filter((id) => !exp.has(id)).length;
      if (missing || extra) {
        checks.push(
          failed(
            "row_set",
            `The row set is off by ${extra} extra order ids and ${missing} missing order ids. Refunds, cancellations, duplicates, null keys, and clocks all move that set.`,
          ),
        );
      } else {
        checks.push(passed("row_set", "The set of order ids matches the agreed definition."));
        let badTime = 0;
        let badAmount = 0;
        let badCustomer = 0;
        for (const [id, row] of exp) {
          const got = act.get(id)!;
          if (got.ordered_at !== row.ordered_at) badTime++;
          if (got.amount_cents !== row.amount_cents) badAmount++;
          if (got.customer_id !== row.customer_id) badCustomer++;
        }
        checks.push(
          badTime === 0
            ? passed("timestamps", "Timestamps match UTC.")
            : failed("timestamps", `${badTime} timestamps are not the UTC values the landing zone supports.`),
        );
        checks.push(
          badAmount === 0 && badCustomer === 0
            ? passed("amounts", "Amounts and customers follow the latest load.")
            : failed(
                "amounts",
                `${badAmount} amounts and ${badCustomer} customers don't follow the latest load.`,
              ),
        );
      }
    }
  } finally {
    await exec.query("ROLLBACK");
  }
  return result(checks);
}

type ConsumerRow = Record<string, string | number>;

function normDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function compareMaps(
  exec: SqlExec,
  actualSql: string,
  expectedSql: string,
  key: string,
  fields: { name: string; numeric?: boolean; date?: boolean; tolerance?: number }[],
): Promise<GradeCheck> {
  const actual = await exec.query(actualSql);
  const expected = await exec.query(expectedSql);
  const shape = (raw: unknown, field: { numeric?: boolean; date?: boolean }) => {
    if (field.numeric) return Number(raw);
    if (field.date) return normDate(raw);
    return String(raw);
  };
  const toMap = (rows: Record<string, unknown>[]) => {
    const map = new Map<string, ConsumerRow>();
    for (const row of rows) {
      const id = key === "customer_id" ? String(row.customer_id) : normDate(row[key]);
      const shaped: ConsumerRow = {};
      for (const field of fields) shaped[field.name] = shape(row[field.name], field);
      map.set(id, shaped);
    }
    return map;
  };
  const exp = toMap(expected.rows);
  const act = toMap(actual.rows);
  if (exp.size !== act.size) {
    return failed("consumer_rows", `Expected ${exp.size} rows and found ${act.size}.`);
  }
  let differ = 0;
  for (const [id, row] of exp) {
    const got = act.get(id);
    if (!got) {
      differ++;
      continue;
    }
    for (const field of fields) {
      const a = row[field.name];
      const b = got[field.name];
      if (field.numeric) {
        if (Math.abs(Number(a) - Number(b)) > (field.tolerance ?? 0)) differ++;
      } else if (String(a) !== String(b)) differ++;
    }
  }
  return differ === 0
    ? passed("consumer_rows", "Consumer rows match the contract.")
    : failed("consumer_rows", `${differ} consumer values don't match the contract on the ticket.`);
}

export async function gradeConsumers(exec: SqlExec): Promise<GradeResult> {
  const checks: GradeCheck[] = [];
  for (const table of ["churn_features", "daily_revenue"] as const) {
    checks.push(
      (await tableExists(exec, table))
        ? passed(`${table}_exists`, `\`${table}\` exists.`)
        : failed(`${table}_exists`, `\`${table}\` does not exist yet.`),
    );
  }
  if (checks.some((c) => !c.ok)) return result(checks);

  const churnCols = await columns(exec, "churn_features");
  const revCols = await columns(exec, "daily_revenue");
  const need = (cols: ColumnInfo[], names: string[], id: string) => {
    const have = new Set(cols.map((c) => c.column_name));
    const missing = names.filter((n) => !have.has(n));
    checks.push(
      missing.length === 0
        ? passed(id, "Required columns are present.")
        : failed(id, `Missing columns: ${missing.map((c) => `\`${c}\``).join(", ")}.`),
    );
  };
  need(churnCols, ["customer_id", "as_of_date", "orders_30d", "revenue_30d", "days_since_last_order"], "churn_columns");
  need(revCols, ["revenue_date", "order_count", "gross_revenue", "aov"], "revenue_columns");

  checks.push(
    (await uniqueOn(exec, "churn_features", "customer_id"))
      ? passed("churn_unique", "`customer_id` is unique on `churn_features`.")
      : failed("churn_unique", "`churn_features.customer_id` needs a primary key or unique constraint."),
  );
  checks.push(
    (await uniqueOn(exec, "daily_revenue", "revenue_date"))
      ? passed("revenue_unique", "`revenue_date` is unique on `daily_revenue`.")
      : failed("revenue_unique", "`daily_revenue.revenue_date` needs a primary key or unique constraint."),
  );

  await exec.query("BEGIN");
  try {
    await exec.query("SET LOCAL TIME ZONE 'UTC'");
    await buildRefs(exec);
    const churn = await compareMaps(
      exec,
      `SELECT customer_id::text AS customer_id,
              as_of_date,
              orders_30d::int AS orders_30d,
              revenue_30d::bigint AS revenue_30d,
              days_since_last_order::int AS days_since_last_order
       FROM churn_features`,
      `SELECT customer_id::text AS customer_id, as_of_date, orders_30d, revenue_30d, days_since_last_order FROM g2_ref_churn`,
      "customer_id",
      [
        { name: "as_of_date", date: true },
        { name: "orders_30d", numeric: true },
        { name: "revenue_30d", numeric: true },
        { name: "days_since_last_order", numeric: true },
      ],
    );
    checks.push({ ...churn, id: "churn_values", detail: churn.ok ? "`churn_features` matches the contract." : `churn_features: ${churn.detail}` });
    const revenue = await compareMaps(
      exec,
      `SELECT revenue_date, order_count::int AS order_count, gross_revenue::bigint AS gross_revenue, aov::numeric AS aov FROM daily_revenue`,
      `SELECT revenue_date, order_count, gross_revenue, aov FROM g2_ref_revenue`,
      "revenue_date",
      [
        { name: "order_count", numeric: true },
        { name: "gross_revenue", numeric: true },
        { name: "aov", numeric: true, tolerance: 0.05 },
      ],
    );
    checks.push({
      ...revenue,
      id: "revenue_values",
      detail: revenue.ok ? "`daily_revenue` matches the contract." : `daily_revenue: ${revenue.detail}`,
    });
  } finally {
    await exec.query("ROLLBACK");
  }
  return result(checks);
}

export function gradePipelineMeta(input: {
  stepCount: number;
  enabled: boolean;
  cadence: string;
  successfulRun: boolean;
}): GradeResult {
  const checks: GradeCheck[] = [];
  checks.push(
    input.stepCount >= 2
      ? passed("steps", "The pipeline has at least two ordered steps.")
      : failed("steps", "A daily pipeline needs at least two ordered SQL steps."),
  );
  checks.push(
    input.cadence === "daily" && input.enabled
      ? passed("schedule", "The pipeline is enabled on a daily schedule.")
      : failed("schedule", "The contract is an enabled daily run."),
  );
  checks.push(
    input.successfulRun
      ? passed("ran", "There is a successful pipeline run.")
      : failed("ran", "I don't see a successful pipeline run yet."),
  );
  return result(checks);
}
