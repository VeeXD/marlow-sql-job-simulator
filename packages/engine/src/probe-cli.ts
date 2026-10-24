import { PGlite } from "@electric-sql/pglite";
import { getWorldSeed } from "./seed.js";
import { runScript, type SqlExec } from "./sql.js";
import { runProbeSuite } from "./probes.js";

const db = new PGlite();
const seed = getWorldSeed();
const exec: SqlExec = {
  async query(sql, params) {
    const res = await db.query(sql, params as never[]);
    return { rows: res.rows as Record<string, unknown>[], rowCount: res.rows.length };
  },
};
await db.exec("SET TIME ZONE 'UTC'");
await runScript(exec, `${seed.ddl}\n${seed.inserts}`);
const report = await runProbeSuite(exec);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
