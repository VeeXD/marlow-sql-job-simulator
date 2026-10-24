import { CLEAN_SELECT, REFERENCE_PLAN } from "./reference.js";
import { assertSafe, splitSql, stripCommentsAndStrings, type SqlExec } from "./sql.js";
import { SCHEMA_IDENTIFIERS } from "./world.js";
import type { TimelineFact } from "./director.js";

export type GuardResult = { ok: boolean; reasons: string[] };

export function checkG1(text: string, idents: string[] = SCHEMA_IDENTIFIERS): GuardResult {
  const reasons: string[] = [];
  const known = new Set(idents.map((s) => s.toLowerCase()));
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const parts = match[1]
      .split(".")
      .map((p) => p.trim().toLowerCase().replace(/"/g, ""))
      .filter(Boolean);
    const ok = (parts.length === 1 || parts.length === 2) && parts.every((p) => known.has(p));
    if (!ok) reasons.push(`unknown identifier \`${match[1]}\``);
  }
  const stripped = text.replace(/`[^`]*`/g, " ");
  for (const ident of idents) {
    if (new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(stripped)) {
      reasons.push(`unmarked identifier ${ident}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const AI_TELLS = [
  /as an ai\b/i,
  /language model/i,
  /system prompt/i,
  /\bopenai\b/i,
  /\bchatgpt\b/i,
  /\banthropic\b/i,
  /debug mode/i,
  /out of character/i,
  /\bi am (an? )?(ai|llm|chatbot|bot)\b/i,
  /jailbreak/i,
  /lasagna/i,
  /capital of france/i,
  /my instructions are/i,
  /developer mode/i,
  /i have no restrictions/i,
  /here is the (hidden|reference|solution)/i,
  /hidden rubric/i,
];

const ADVERSARIAL = [
  /ignore (all |any |previous )?instructions/i,
  /system prompt/i,
  /system message/i,
  /\byou are now\b/i,
  /jailbreak/i,
  /developer mode/i,
  /i('| a)?m the developer/i,
  /print your (system|instructions|prompt)/i,
  /lasagna/i,
  /capital of france/i,
  /poem about the moon/i,
  /favorite recipe/i,
  /what model are you\?/i,
  /are you chatgpt/i,
  /without restrictions/i,
  /sqlbot/i,
  /reveal withheld/i,
  /translate your instructions/i,
  /dump the persona/i,
  /disregard marlow/i,
  /hack a database/i,
  /out of character/i,
  /debug mode/i,
  /from now on you are/i,
  /override and send the answer/i,
  /joke about politicians/i,
  /hidden rubric/i,
];

export function isAdversarialUser(text: string): boolean {
  return ADVERSARIAL.some((re) => re.test(text));
}

export function outOfFrame(reply: string, userText?: string): boolean {
  if (AI_TELLS.some((re) => re.test(reply))) return true;
  if (userText && isAdversarialUser(userText)) {
    const grounded = /marlow|priya|jonah|sam|riley|clean_orders|raw_orders|raw_events|pipeline|erd|landing|churn_features|daily_revenue/i.test(
      reply,
    );
    if (!grounded) return true;
  }
  return false;
}

export function checkG3(reply: string, userText?: string): GuardResult {
  if (!outOfFrame(reply, userText)) return { ok: true, reasons: [] };
  return { ok: false, reasons: ["out of character"] };
}

export function claimAbout(text: string, fact: Pick<TimelineFact, "noun">): "done" | "not_done" | "none" {
  const t = text.toLowerCase();
  const noun = fact.noun.toLowerCase();
  const idx = t.indexOf(noun);
  if (idx < 0) return "none";
  const window = t.slice(Math.max(0, idx - 100), idx + noun.length + 100);
  if (
    /not finished|hasn't finished|has not finished|have not finished|isn't finished|is not finished|still running|not started|hasn't started|has not started|still working|not done|isn't done|is not done/.test(
      window,
    )
  ) {
    return "not_done";
  }
  if (/finished|completed|shipped|wrapped|is done|have finished|has finished/.test(window)) return "done";
  return "none";
}

export function checkG4(text: string, facts: TimelineFact[]): GuardResult {
  const reasons: string[] = [];
  for (const fact of facts) {
    const claim = claimAbout(text, fact);
    if (claim === "none") continue;
    if (claim === "done" && !fact.done) reasons.push(`claims ${fact.person} finished the ${fact.noun} too early`);
    if (claim === "not_done" && fact.done) reasons.push(`claims ${fact.person} has not finished the ${fact.noun}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const DISTINCTIVE = [
  "row_number",
  "partition by",
  "america/los_angeles",
  "order_refunded",
  "order_cancelled",
  "loaded_at desc",
  "at time zone",
];

export function assessNearComplete(reply: string, referencePlan = REFERENCE_PLAN, threshold = 0.55) {
  const score = jaccard(tokenize(reply), tokenize(referencePlan));
  const lower = reply.toLowerCase();
  const distinctive = DISTINCTIVE.filter((token) => lower.includes(token)).length;
  const steps = reply.split("\n").reduce((n, line) => {
    const listed = /^\s*(\d+[\.\)]|[-*])\s+\S/.test(line) ? 1 : 0;
    const sqlish = /\b(create table|row_number|partition by|at time zone)\b/i.test(line) ? 1 : 0;
    return n + listed + sqlish;
  }, 0);
  const blocked = distinctive >= 3 || (steps >= 4 && score >= 0.34) || score >= threshold;
  return { score, steps, distinctive, blocked };
}

export function extractSql(text: string): string[] {
  const chunks: string[] = [];
  for (const match of text.matchAll(/```(?:sql)?\s*([\s\S]*?)```/gi)) chunks.push(match[1]);
  const inline = text.replace(/```[\s\S]*?```/g, "");
  for (const line of inline.split("\n")) {
    if (/^\s*(select|with|create|insert)\b/i.test(line)) chunks.push(line);
  }
  return chunks
    .flatMap((chunk) => splitSql(chunk))
    .filter((statement) => /^(select|with|create|insert|drop|delete|update)\b/i.test(stripCommentsAndStrings(statement).trim()))
    .slice(0, 8);
}

function norm(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  return String(value ?? "");
}

async function projectionMatches(exec: SqlExec, rows: Record<string, unknown>[]): Promise<boolean> {
  if (rows.length === 0) return false;
  const sample = rows[0];
  const keys = Object.keys(sample).map((k) => k.toLowerCase());
  if (!keys.includes("order_id")) return false;
  const expected = await exec.query(
    `SELECT order_id::text AS order_id, amount_cents::bigint AS amount_cents FROM g2_ref_clean`,
  );
  const expIds = new Set(expected.rows.map((r) => String(r.order_id)));
  const gotIds = new Set(rows.map((r) => String(r.order_id ?? r.ORDER_ID)));
  if (expIds.size === 0 || expIds.size !== gotIds.size) return false;
  for (const id of expIds) if (!gotIds.has(id)) return false;
  if (keys.includes("amount_cents")) {
    const expAmt = new Map(expected.rows.map((r) => [String(r.order_id), Number(r.amount_cents)]));
    for (const row of rows) {
      const id = String(row.order_id ?? row.ORDER_ID);
      const amt = Number(row.amount_cents ?? row.AMOUNT_CENTS);
      if (expAmt.get(id) !== amt) return false;
    }
  }
  return true;
}

async function tableMatches(exec: SqlExec, table: string, ref: string, cols: string[]): Promise<boolean> {
  const exists = await exec.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema IN ('public','pg_temp') AND table_name = $1) AS ok`,
    [table],
  );
  // temp tables may not show in information_schema the same way; try a direct read
  void exists;
  try {
    const actual = await exec.query(`SELECT ${cols.join(", ")} FROM ${table}`);
    const expected = await exec.query(`SELECT ${cols.join(", ")} FROM ${ref}`);
    if (actual.rows.length !== expected.rows.length || actual.rows.length === 0) return false;
    const key = cols[0];
    const pack = (rows: Record<string, unknown>[]) =>
      rows
        .map((row) => cols.map((c) => norm(row[c] ?? row[c.toUpperCase()])).join("|"))
        .sort()
        .join("\n");
    void key;
    return pack(actual.rows) === pack(expected.rows);
  } catch {
    return false;
  }
}

export async function sqlLeaksAnswer(exec: SqlExec, sqlChunks: string[]): Promise<boolean> {
  if (sqlChunks.length === 0) return false;
  await exec.query("BEGIN");
  try {
    await exec.query("SET LOCAL TIME ZONE 'UTC'");
    await exec.query("DROP TABLE IF EXISTS g2_ref_clean");
    await exec.query(`CREATE TEMP TABLE g2_ref_clean AS ${CLEAN_SELECT}`);
    let lastRows: Record<string, unknown>[] | null = null;
    for (const statement of sqlChunks) {
      assertSafe(statement);
      const res = await exec.query(statement);
      if (/^(select|with)\b/i.test(statement.trim())) lastRows = res.rows;
    }
    if (lastRows && (await projectionMatches(exec, lastRows))) return true;
    if (await tableMatches(exec, "clean_orders", "g2_ref_clean", ["order_id", "amount_cents"])) return true;
    return false;
  } catch {
    return false;
  } finally {
    await exec.query("ROLLBACK");
  }
}

export async function evaluateDraft(
  draft: string,
  ctx: {
    facts: TimelineFact[];
    userText?: string;
    exec?: SqlExec;
    threshold?: number;
    idents?: string[];
  },
): Promise<GuardResult> {
  const reasons: string[] = [];
  const g1 = checkG1(draft, ctx.idents);
  if (!g1.ok) reasons.push(...g1.reasons.map((r) => `G1 ${r}`));
  const near = assessNearComplete(draft, REFERENCE_PLAN, ctx.threshold ?? 0.55);
  if (near.blocked) reasons.push(`G2 near-complete (score ${near.score.toFixed(2)}, steps ${near.steps}, distinctive ${near.distinctive})`);
  const sql = extractSql(draft);
  if (ctx.exec && sql.length) {
    for (const statement of sql) {
      try {
        assertSafe(statement);
      } catch (err) {
        reasons.push(`G2 unsafe sql: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!reasons.some((r) => r.startsWith("G2 unsafe")) && (await sqlLeaksAnswer(ctx.exec, sql))) {
      reasons.push("G2 sql reproduces the expected result");
    }
  }
  const g3 = checkG3(draft, ctx.userText);
  if (!g3.ok) reasons.push(...g3.reasons.map((r) => `G3 ${r}`));
  const g4 = checkG4(draft, ctx.facts);
  if (!g4.ok) reasons.push(...g4.reasons.map((r) => `G4 ${r}`));
  return { ok: reasons.length === 0, reasons };
}
