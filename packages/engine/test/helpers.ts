import { PGlite } from "@electric-sql/pglite";
import { getWorldSeed, type WorldSeed } from "../src/seed.js";
import { runScript, type SqlExec } from "../src/sql.js";

export async function freshDb(): Promise<{ exec: SqlExec; seed: WorldSeed }> {
  const db = new PGlite();
  const exec: SqlExec = {
    async query(sql, params) {
      const res = await db.query(sql, params);
      return {
        rows: (res.rows ?? []) as Record<string, unknown>[],
        rowCount: res.rows?.length ?? null,
        fields: res.fields?.map((field) => ({ name: field.name })),
      };
    },
  };
  await exec.query("SET TIME ZONE 'UTC'");
  const seed = getWorldSeed();
  await runScript(exec, seed.ddl);
  await runScript(exec, seed.inserts);
  return { exec, seed };
}
