/**
 * Connection adapters. Release 1 ships Postgres only. MySQL, DuckDB, and pgvector
 * plug in behind this shape later; callers should go through `createAdapter`.
 */
export type EngineName = "postgres" | "mysql" | "duckdb";

export type AdapterColumn = { name: string; dataType: string; nullable: boolean };

export type AdapterSchema = { table: string; columns: AdapterColumn[] }[];

export type AdapterQueryResult = {
  ok: boolean;
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number | null;
  truncated: boolean;
  command: string | null;
  durationMs: number;
  error?: {
    message: string;
    code?: string;
    detail?: string | null;
    hint?: string | null;
    position?: string | null;
    severity?: string | null;
  };
};

export interface SandboxAdapter {
  readonly engine: EngineName;
  run(sql: string): Promise<AdapterQueryResult>;
  introspect(): Promise<AdapterSchema>;
}

export function createAdapter(engine: string): { engine: "postgres" } {
  if (engine !== "postgres") {
    throw new Error(
      `${engine} is not in this release. The sandbox adapter interface is ready; only Postgres is wired up.`,
    );
  }
  return { engine: "postgres" };
}
