import { assertSafe, splitSql, type SqlExec } from "./sql.js";
import type { StepLog } from "./types.js";

export async function runPipeline(
  steps: { name: string; sql: string }[],
  exec: SqlExec,
): Promise<{ ok: boolean; logs: StepLog[] }> {
  const logs: StepLog[] = [];
  for (const step of steps) {
    const started = Date.now();
    try {
      const statements = splitSql(step.sql);
      if (statements.length === 0) throw new Error("This step has no SQL.");
      for (const statement of statements) {
        assertSafe(statement, { allowTransaction: true });
        await exec.query(statement);
      }
      logs.push({ name: step.name, ok: true, durationMs: Date.now() - started });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logs.push({ name: step.name, ok: false, error: message, durationMs: Date.now() - started });
      return { ok: false, logs };
    }
  }
  return { ok: true, logs };
}
