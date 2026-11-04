/** Preview pages stay inside the workbench row cap. Notebook pulls may go higher. */
export const PREVIEW_PAGE_SIZE = 100;
export const PREVIEW_ROW_CAP = 500;
export const NOTEBOOK_ROW_CAP = 50_000;

export const RAW_TABLES = new Set(["raw_orders", "raw_events"]);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export function assertIdent(name: string): string {
  const trimmed = name.trim();
  if (!IDENT.test(trimmed)) throw new ProfileError("That name is not a plain table or column identifier.");
  return trimmed;
}

export function quoteIdent(name: string): string {
  return `"${assertIdent(name)}"`;
}

export function assertWritableTable(name: string): string {
  const safe = assertIdent(name);
  const lower = safe.toLowerCase();
  if (RAW_TABLES.has(lower)) {
    throw new ProfileError("raw_orders and raw_events stay read-only. Write a new table in your schema.");
  }
  if (lower.startsWith("pg_") || lower === "information_schema") {
    throw new ProfileError("That table name is reserved.");
  }
  return safe;
}

export function isNumericType(dataType: string): boolean {
  return /^(smallint|integer|bigint|decimal|numeric|real|double precision|float|float4|float8|money)$/i.test(dataType.trim());
}

export function pgTypeForDtype(dtype: string): "bigint" | "double precision" | "boolean" | "timestamptz" | "text" {
  const value = dtype.toLowerCase();
  if (value.includes("bool")) return "boolean";
  if (value.includes("datetime") || value.includes("timestamp")) return "timestamptz";
  if (value.includes("float") || value === "number" || value.includes("decimal")) return "double precision";
  if (value.includes("int")) return "bigint";
  return "text";
}

export function previewWindow(offset: number, limit = PREVIEW_PAGE_SIZE): { offset: number; limit: number } {
  if (!Number.isInteger(offset) || offset < 0) throw new ProfileError("Page offset must be zero or more.");
  if (!Number.isInteger(limit) || limit < 1 || limit > PREVIEW_PAGE_SIZE) {
    throw new ProfileError(`Preview pages are at most ${PREVIEW_PAGE_SIZE} rows.`);
  }
  if (offset >= PREVIEW_ROW_CAP) throw new ProfileError(`Preview stops at ${PREVIEW_ROW_CAP} rows.`);
  return { offset, limit: Math.min(limit, PREVIEW_ROW_CAP - offset) };
}

export function previewSql(
  table: string,
  opts: { sort: string; dir: "asc" | "desc"; offset: number; limit: number },
): string {
  const window = previewWindow(opts.offset, opts.limit);
  const direction = opts.dir === "desc" ? "DESC" : "ASC";
  return `SELECT * FROM public.${quoteIdent(table)} ORDER BY ${quoteIdent(opts.sort)} ${direction} NULLS LAST LIMIT ${window.limit} OFFSET ${window.offset}`;
}

export function countSql(table: string): string {
  return `SELECT count(*)::int AS n FROM public.${quoteIdent(table)}`;
}

export function scalarProfileSql(table: string, columns: { name: string; dataType: string }[]): string {
  const from = `public.${quoteIdent(table)}`;
  const parts = columns.map((column) => {
    const quoted = quoteIdent(column.name);
    const fields = [
      `'nulls', count(*) FILTER (WHERE ${quoted} IS NULL)`,
      `'distinct', count(DISTINCT ${quoted})`,
      `'min', min(${quoted})::text`,
      `'max', max(${quoted})::text`,
    ];
    if (isNumericType(column.dataType)) {
      fields.push(`'mean', avg(${quoted})`);
      fields.push(`'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY ${quoted})`);
    }
    const key = column.name.replace(/'/g, "''");
    return `'${key}', json_build_object(${fields.join(", ")})`;
  });
  const body = parts.length ? `json_build_object(${parts.join(", ")})` : `'{}'::json`;
  return `SELECT count(*)::int AS n, ${body} AS columns FROM ${from}`;
}

export function topValuesSql(table: string, column: string): string {
  const quoted = quoteIdent(column);
  return `SELECT ${quoted}::text AS value, count(*)::int AS n FROM public.${quoteIdent(table)} GROUP BY 1 ORDER BY n DESC, value ASC NULLS LAST LIMIT 5`;
}

export function histogramSql(table: string, column: string): string {
  const quoted = quoteIdent(column);
  const from = `public.${quoteIdent(table)}`;
  return `WITH stats AS (
  SELECT min(${quoted})::float8 AS lo, max(${quoted})::float8 AS hi FROM ${from} WHERE ${quoted} IS NOT NULL
)
SELECT width_bucket(${quoted}::float8, stats.lo, stats.hi + 1e-9, 8) AS bucket, count(*)::int AS n, stats.lo, stats.hi
FROM ${from}, stats
WHERE ${quoted} IS NOT NULL AND stats.lo IS NOT NULL AND stats.lo <> stats.hi
GROUP BY 1, stats.lo, stats.hi
ORDER BY 1`;
}

export function bucketLabel(bucket: number, lo: number, hi: number, bins = 8): string {
  const width = (hi - lo) / bins;
  const start = lo + (bucket - 1) * width;
  const end = start + width;
  const trim = (value: number) => {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 10000 || abs < 0.01)) return value.toExponential(2);
    return String(Math.round(value * 100) / 100);
  };
  return `${trim(start)}–${trim(end)}`;
}

export function dropCreateSql(table: string, columns: { name: string; dtype: string }[]): { drop: string; create: string } {
  const safe = assertWritableTable(table);
  if (columns.length === 0 || columns.length > 40) throw new ProfileError("A notebook table needs 1 to 40 columns.");
  const defs = columns.map((column) => `${quoteIdent(column.name)} ${pgTypeForDtype(column.dtype)}`);
  return {
    drop: `DROP TABLE IF EXISTS public.${quoteIdent(safe)}`,
    create: `CREATE TABLE public.${quoteIdent(safe)} (${defs.join(", ")})`,
  };
}
