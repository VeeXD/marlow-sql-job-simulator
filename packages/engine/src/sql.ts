import type { GradeCheck } from "./types.js";

export type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
  fields?: { name: string }[];
};

export interface SqlExec {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

export function splitSql(input: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "-" && n === "-") {
      const end = s.indexOf("\n", i);
      const chunk = end === -1 ? s.slice(i) : s.slice(i, end + 1);
      cur += chunk;
      i += chunk.length;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = s.indexOf("*/", i + 2);
      const chunk = end === -1 ? s.slice(i) : s.slice(i, end + 2);
      cur += chunk;
      i += chunk.length;
      continue;
    }
    if (c === "'") {
      cur += c;
      i++;
      while (i < s.length) {
        cur += s[i];
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            cur += s[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        const chunk = end === -1 ? s.slice(i) : s.slice(i, end + tag.length);
        cur += chunk;
        i += chunk.length;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

export function stripCommentsAndStrings(input: string): string {
  let out = "";
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "-" && n === "-") {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end;
      out += " ";
      continue;
    }
    if (c === "/" && n === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        i = end === -1 ? s.length : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const FORBIDDEN: { re: RegExp; reason: string }[] = [
  { re: /\b(create|drop)\s+database\b/i, reason: "CREATE/DROP DATABASE is not allowed in the sandbox." },
  { re: /\b(create|alter|drop)\s+role\b/i, reason: "Role changes are not allowed in the sandbox." },
  { re: /\balter\s+system\b/i, reason: "ALTER SYSTEM is not allowed." },
  { re: /\b(grant|revoke)\b/i, reason: "GRANT and REVOKE are not allowed." },
  { re: /\b(create|drop)\s+extension\b/i, reason: "Extensions are not allowed." },
  { re: /\bcreate\s+(function|procedure|language)\b/i, reason: "Functions and procedures are not allowed." },
  { re: /\bcopy\b/i, reason: "COPY is not allowed." },
  { re: /\bdo\s*\$/i, reason: "DO blocks are not allowed." },
  { re: /\b(pg_read_file|pg_ls_dir|lo_import|lo_export|dblink)\b/i, reason: "That function is not allowed." },
  { re: /\bset\s+role\b/i, reason: "SET ROLE is not allowed." },
  { re: /\bvacuum\b/i, reason: "VACUUM is not allowed." },
];

export class SqlRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlRejected";
  }
}

export function assertSafe(statement: string, opts?: { allowTransaction?: boolean }): void {
  const scan = stripCommentsAndStrings(statement).trim();
  if (!scan) return;
  if (!opts?.allowTransaction && /^(begin|commit|rollback|end)\b/i.test(scan)) {
    throw new SqlRejected("Blocked before it reached Postgres: transaction control is not allowed in this context.");
  }
  if (/^set\b/i.test(scan)) {
    throw new SqlRejected("SET is not allowed. The sandbox already fixes statement timeout and time zone.");
  }
  for (const rule of FORBIDDEN) {
    if (rule.re.test(scan)) throw new SqlRejected(`Blocked before it reached Postgres: ${rule.reason}`);
  }
  const landingWrite =
    /\b(?:drop\s+table(?:\s+if\s+exists)?|truncate(?:\s+table)?|alter\s+table|delete\s+from|update|insert\s+into|create\s+table(?:\s+if\s+not\s+exists)?)\s+(?:only\s+)?(?:public\.)?raw_(?:orders|events)\b/i;
  if (landingWrite.test(scan)) {
    throw new SqlRejected(
      "Blocked before it reached Postgres: raw_orders and raw_events are the landing zone and stay read-only.",
    );
  }
}

export async function runScript(exec: SqlExec, sql: string): Promise<void> {
  for (const statement of splitSql(sql)) {
    await exec.query(statement);
  }
}

export function tablesTouched(sql: string): string[] {
  const scan = stripCommentsAndStrings(sql).toLowerCase();
  const names = ["raw_orders", "raw_events", "clean_orders", "churn_features", "daily_revenue", "repeat_cohorts"];
  return names.filter((n) => new RegExp(`\\b${n}\\b`).test(scan));
}

type LimitHit = { kind: "number"; value: number; numberStart: number; numberEnd: number } | { kind: "other" };

function findTopLevelLimit(statement: string): LimitHit | null {
  const s = statement;
  let i = 0;
  let depth = 0;
  let last: LimitHit | null = null;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "-" && n === "-") {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(s.slice(i));
      if (tag) {
        const end = s.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? s.length : end + tag[0].length;
        continue;
      }
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    const prev = i === 0 ? " " : s[i - 1];
    if (depth === 0 && !/[A-Za-z0-9_]/.test(prev) && /^limit\b/i.test(s.slice(i))) {
      let j = i + "limit".length;
      while (j < s.length && /\s/.test(s[j])) j++;
      const num = /^(\d+)/.exec(s.slice(j));
      if (num) {
        last = { kind: "number", value: Number(num[1]), numberStart: j, numberEnd: j + num[1].length };
      } else {
        last = { kind: "other" };
      }
      i = num ? j + num[1].length : j;
      continue;
    }
    i++;
  }
  return last;
}

/**
 * Push the row cap into a read statement. Fetch cap+1 so the caller can see
 * truncation without buffering the rest of the result. Writes are unchanged.
 */
export function applyRowCap(statement: string, cap: number): { sql: string; capApplied: boolean } {
  const scan = stripCommentsAndStrings(statement).trim();
  if (!/^(select|with|table|values|show)\b/i.test(scan)) return { sql: statement, capApplied: false };
  const fetch = cap + 1;
  const limit = findTopLevelLimit(statement);
  if (limit?.kind === "number") {
    if (limit.value <= cap) return { sql: statement, capApplied: false };
    return {
      sql: statement.slice(0, limit.numberStart) + String(fetch) + statement.slice(limit.numberEnd),
      capApplied: true,
    };
  }
  if (limit?.kind === "other") {
    return { sql: `SELECT * FROM (\n${statement}\n) AS _row_cap LIMIT ${fetch}`, capApplied: true };
  }
  return { sql: `${statement}\nLIMIT ${fetch}`, capApplied: true };
}

export function failed(id: string, detail: string): GradeCheck {
  return { id, ok: false, detail };
}

export function passed(id: string, detail: string): GradeCheck {
  return { id, ok: true, detail };
}
