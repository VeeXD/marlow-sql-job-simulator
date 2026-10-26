import { describe, expect, it } from "vitest";
import { gradeCleanOrders, gradeConsumers, gradePipelineMeta, gradeRepeatCohorts } from "../src/grading.js";
import { COHORT_SELECT, referencePipelineSteps } from "../src/reference.js";
import { runPipeline } from "../src/runner.js";
import { SqlRejected, assertSafe, runScript, splitSql } from "../src/sql.js";
import { buildWorldSeed, nullSpikeSql, schemaDriftSql } from "../src/seed.js";
import { freshDb } from "./helpers.js";

describe("seed and grading", () => {
  it("builds the same seed twice", () => {
    const a = buildWorldSeed();
    const b = buildWorldSeed();
    expect(a.inserts).toBe(b.inserts);
    expect(a.breakSql).toBe(b.breakSql);
    expect(a.manifest.duplicateOrderId).toBeTruthy();
    expect(a.manifest.breakRefundIds.length).toBe(6);
    expect(a.manifest.breakNewIds.length).toBe(12);
  });

  it("grades the reference pipeline and rejects the traps", async () => {
    const { exec, seed } = await freshDb();
    const manifest = seed.manifest;

    const dupes = await exec.query(
      `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT order_id)::int AS ids
       FROM raw_orders WHERE order_id IS NOT NULL`,
    );
    expect(Number(dupes.rows[0].rows)).toBeGreaterThan(Number(dupes.rows[0].ids));

    const missing = await gradeCleanOrders(exec);
    expect(missing.passed).toBe(false);
    expect(missing.checks.some((c) => c.id === "table_exists" && !c.ok)).toBe(true);

    const run = await runPipeline(referencePipelineSteps(), exec);
    expect(run.ok, JSON.stringify(run.logs)).toBe(true);
    const clean = await gradeCleanOrders(exec);
    expect(clean.passed, JSON.stringify(clean.checks)).toBe(true);
    const consumers = await gradeConsumers(exec);
    expect(consumers.passed, JSON.stringify(consumers.checks)).toBe(true);

    const present = async (id: string) => {
      const res = await exec.query(`SELECT 1 FROM clean_orders WHERE order_id = $1`, [id]);
      return res.rows.length > 0;
    };
    expect(await present(manifest.localOnlyOrderId)).toBe(true);
    expect(await present(manifest.duplicateOrderId)).toBe(true);
    expect(await present(manifest.badTzOrderId)).toBe(true);
    expect(await present(manifest.refundedOrderId)).toBe(false);
    expect(await present(manifest.refundEventOnlyOrderId)).toBe(false);

    const amount = await exec.query(`SELECT amount_cents::int AS amount_cents FROM clean_orders WHERE order_id = $1`, [
      manifest.duplicateOrderId,
    ]);
    expect(Number(amount.rows[0].amount_cents)).toBe(manifest.duplicateLatestAmount);

    const local = await exec.query(
      `SELECT to_char(ordered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts FROM clean_orders WHERE order_id = $1`,
      [manifest.localOnlyOrderId],
    );
    expect(String(local.rows[0].ts).startsWith(manifest.localOnlyUtc.slice(0, 19))).toBe(true);

    await exec.query(`UPDATE clean_orders SET ordered_at = ordered_at + interval '1 day' WHERE order_id = $1`, [
      manifest.localOnlyOrderId,
    ]);
    const drifted = await gradeCleanOrders(exec);
    expect(drifted.passed).toBe(false);
    expect(drifted.checks.some((c) => c.id === "timestamps" && !c.ok)).toBe(true);

    const rerun = await runPipeline(referencePipelineSteps(), exec);
    expect(rerun.ok).toBe(true);
    await exec.query(`ALTER TABLE clean_orders DROP CONSTRAINT clean_orders_pkey`);
    const unconstrained = await gradeCleanOrders(exec);
    expect(unconstrained.passed).toBe(false);
    expect(unconstrained.checks.some((c) => c.id === "unique" && !c.ok)).toBe(true);

    await runPipeline(referencePipelineSteps(), exec);
    await exec.query(
      `INSERT INTO clean_orders (order_id, customer_id, ordered_at, amount_cents)
       SELECT order_id, customer_id, ordered_at, amount_cents FROM clean_orders LIMIT 1`,
    ).catch(() => undefined);
    await exec.query(`ALTER TABLE clean_orders DROP CONSTRAINT clean_orders_pkey`);
    await exec.query(
      `INSERT INTO clean_orders (order_id, customer_id, ordered_at, amount_cents)
       SELECT order_id, customer_id, ordered_at, amount_cents FROM clean_orders LIMIT 1`,
    );
    const duped = await gradeCleanOrders(exec);
    expect(duped.checks.some((c) => c.id === "duplicates" && !c.ok || c.id === "unique" && !c.ok)).toBe(true);

    await runPipeline(referencePipelineSteps(), exec);
    const before = await exec.query(`SELECT COUNT(*)::int AS n FROM clean_orders`);
    await runScript(exec, seed.breakSql);
    const stale = await gradeCleanOrders(exec);
    expect(stale.passed).toBe(false);
    await runPipeline(referencePipelineSteps(), exec);
    const after = await gradeCleanOrders(exec);
    expect(after.passed, JSON.stringify(after.checks)).toBe(true);
    const afterConsumers = await gradeConsumers(exec);
    expect(afterConsumers.passed, JSON.stringify(afterConsumers.checks)).toBe(true);
    const afterCount = await exec.query(`SELECT COUNT(*)::int AS n FROM clean_orders`);
    expect(Number(afterCount.rows[0].n)).not.toBe(Number(before.rows[0].n));
    expect(await present(manifest.breakNewIds[0])).toBe(true);
    expect(await present(manifest.breakRefundIds[0])).toBe(false);

    await runScript(exec, schemaDriftSql());
    await runScript(exec, nullSpikeSql());
    await runScript(exec, schemaDriftSql());
    await runScript(exec, nullSpikeSql());
    const withExtras = await gradeCleanOrders(exec);
    expect(withExtras.passed, JSON.stringify(withExtras.checks)).toBe(true);
    const promo = await exec.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'raw_orders' AND column_name = 'promo_code'`,
    );
    expect(promo.rows.length).toBe(1);
    const spike = await exec.query(
      `SELECT COUNT(*)::int AS n FROM raw_orders WHERE source_file = 'orders_2024_06_null_spike.csv'`,
    );
    expect(Number(spike.rows[0].n)).toBe(6);

    await exec.query(`CREATE TABLE repeat_cohorts AS ${COHORT_SELECT}`);
    await exec.query(`ALTER TABLE repeat_cohorts ADD PRIMARY KEY (customer_id)`);
    const cohort = await gradeRepeatCohorts(exec);
    expect(cohort.passed, JSON.stringify(cohort.checks)).toBe(true);

    expect(
      gradePipelineMeta({ stepCount: 3, enabled: true, cadence: "daily", successfulRun: true }).passed,
    ).toBe(true);
    expect(gradePipelineMeta({ stepCount: 1, enabled: true, cadence: "daily", successfulRun: true }).passed).toBe(false);
  });
});

describe("sql safety and runner", () => {
  it("splits statements and blocks sandbox escapes", () => {
    expect(splitSql("SELECT 1; SELECT 'a;b';")).toEqual(["SELECT 1", "SELECT 'a;b'"]);
    expect(() => assertSafe("DROP DATABASE sim")).toThrow(SqlRejected);
    expect(() => assertSafe("DROP TABLE raw_orders")).toThrow(SqlRejected);
    expect(() => assertSafe("TRUNCATE raw_events")).toThrow(SqlRejected);
    expect(() => assertSafe("SELECT * FROM raw_orders")).not.toThrow();
    expect(() => assertSafe("SELECT 1; -- DROP TABLE raw_orders")).not.toThrow();
  });

  it("stops the pipeline on the first failing step", async () => {
    const { exec } = await freshDb();
    const result = await runPipeline(
      [
        { name: "ok", sql: "CREATE TABLE runner_probe (id int); INSERT INTO runner_probe VALUES (1);" },
        { name: "bad", sql: "SELECT * FROM no_such_table" },
        { name: "skipped", sql: "CREATE TABLE should_not_exist (id int);" },
      ],
      exec,
    );
    expect(result.ok).toBe(false);
    expect(result.logs.map((l) => l.name)).toEqual(["ok", "bad"]);
    expect(result.logs[1].error).toMatch(/no_such_table/);
    const skipped = await exec.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'should_not_exist') AS ok`,
    );
    expect(skipped.rows[0].ok).toBe(false);
    const dropped = await runPipeline([{ name: "nope", sql: "DROP TABLE raw_orders" }], exec);
    expect(dropped.ok).toBe(false);
    const still = await exec.query(`SELECT COUNT(*)::int AS n FROM raw_orders`);
    expect(Number(still.rows[0].n)).toBeGreaterThan(0);
  });
});
