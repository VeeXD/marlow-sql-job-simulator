/**
 * Plain-language glossary for words the desk actually uses.
 * Hover text is for the player. `speak` is the one sentence a coworker may add in chat.
 * Definitions describe the word. They do not describe how to build the table.
 */
export type GlossarySpeak = {
  guided: string;
  standard: string;
  skipIf?: RegExp;
};

export type GlossaryEntry = {
  id: string;
  term: string;
  definition: string;
  example?: string;
  /** Related table in the Marlow catalog, when the word points at one. */
  table?: string;
  regex: RegExp;
  /** Skip a match when the nearby words are a different sense (for example "join the meeting"). */
  suppressNear?: RegExp;
  speak?: GlossarySpeak;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function term(input: {
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  example?: string;
  table?: string;
  suppressNear?: RegExp;
  speak?: GlossarySpeak;
}): GlossaryEntry {
  const aliases = [...input.aliases].sort((left, right) => right.length - left.length);
  const { aliases: _aliases, ...rest } = input;
  return {
    ...rest,
    regex: new RegExp(`\\b(?:${aliases.map(escapeRegExp).join("|")})\\b`, "i"),
  };
}

export const GLOSSARY: GlossaryEntry[] = [
  term({
    id: "etl",
    term: "ETL",
    aliases: ["ETL"],
    definition: "Extract, transform, load: pull data out of a source, clean it, and save the result.",
    example: "Reading the order file, dropping bad rows, and writing a clean table.",
    speak: {
      guided: "ETL means extract, transform, load: pull the data out, clean it, and save the result.",
      standard: "ETL means extract, transform, load.",
      skipIf: /extract, transform, load/i,
    },
  }),
  term({
    id: "dag",
    term: "DAG",
    aliases: ["DAG", "DAGs"],
    definition: "A list of steps that run in order and do not loop back on themselves.",
    example: "Clean the orders, then build the feature table, then build the daily chart.",
    speak: {
      guided: "A DAG is just an ordered list of steps that does not loop back on itself.",
      standard: "A DAG is an ordered list of steps.",
      skipIf: /ordered list of steps/i,
    },
  }),
  term({
    id: "grain",
    term: "Grain",
    aliases: ["grain"],
    definition: "What one row stands for.",
    example: "One row per order, not one row per file or per event.",
    table: "clean_orders",
    speak: {
      guided: "Grain means what one row stands for.",
      standard: "Grain means what one row stands for.",
      skipIf: /what one row stands for/i,
    },
  }),
  term({
    id: "timestamptz",
    term: "timestamptz",
    aliases: ["timestamptz"],
    definition: "A timestamp that already knows its time zone.",
    example: "2024-06-03 16:00 UTC, rather than a clock reading with no zone attached.",
    table: "raw_orders",
    speak: {
      guided: "timestamptz means a timestamp that already knows its time zone.",
      standard: "timestamptz means a timestamp with a time zone.",
      skipIf: /timestamp that|timestamp with a time zone/i,
    },
  }),
  term({
    id: "aov",
    term: "AOV",
    aliases: ["AOV", "aov", "average order value"],
    definition: "Average order value: revenue divided by the number of orders.",
    example: "10000 cents across 4 orders is an AOV of 2500 cents.",
    table: "daily_revenue",
    speak: {
      guided: "`aov` means average order value, the revenue divided by the number of orders.",
      standard: "`aov` means average order value.",
      skipIf: /average order value/i,
    },
  }),
  term({
    id: "churn",
    term: "Churn",
    aliases: ["churn"],
    definition: "Customers who stop buying.",
    example: "Someone who ordered in May and never came back.",
    table: "churn_features",
    speak: {
      guided: "Churn means customers who stop buying.",
      standard: "Churn means customers who stop buying.",
      skipIf: /stop buying/i,
    },
  }),
  term({
    id: "landing",
    term: "Landing zone",
    aliases: ["landing zone"],
    definition: "Where raw files land before anyone cleans them.",
    example: "The order file and the event file, still messy.",
    table: "raw_orders",
    speak: {
      guided: "The landing zone is the raw files as they arrived, before anyone cleans them.",
      standard: "The landing zone is the raw files before cleaning.",
      skipIf: /raw files as they arrived|raw files before cleaning/i,
    },
  }),
  term({
    id: "pipeline",
    term: "Pipeline",
    aliases: ["pipeline", "pipelines"],
    definition: "A saved list of SQL steps that runs on a schedule.",
    example: "Every morning: rebuild the clean table, then the feature table, then the chart.",
    speak: {
      guided: "A pipeline is a saved list of SQL steps that runs on a schedule.",
      standard: "A pipeline is a saved list of SQL steps.",
      skipIf: /saved list of SQL steps/i,
    },
  }),
  term({
    id: "cohort",
    term: "Cohort",
    aliases: ["cohort", "cohorts"],
    definition: "A group of customers you keep together so you can compare them.",
    example: "Everyone whose first order was in June.",
    table: "repeat_cohorts",
  }),
  term({
    id: "join",
    term: "Join",
    aliases: ["join", "joins"],
    definition: "Combining rows from two tables by a shared value, such as an order id.",
    example: "Attach each event to the order it belongs to.",
    table: "raw_events",
    suppressNear: /meeting|calendar|reminder|transcript|knowledge transfer|i'll be there|sit down/i,
  }),
  term({
    id: "cte",
    term: "CTE",
    aliases: ["CTE", "CTEs"],
    definition: "A named temporary result inside one query, so you can reuse it further down.",
    example: "Name the clean orders, then aggregate that name.",
  }),
  term({
    id: "null",
    term: "Null",
    aliases: ["null", "nulls", "nullable"],
    definition: "A missing value. It is not zero and not an empty string.",
    example: "An order row with no customer id.",
    table: "raw_orders",
  }),
  term({
    id: "dedupe",
    term: "Dedupe",
    aliases: ["dedupe", "dedup", "deduped", "deduping", "deduplication"],
    definition: "Keeping one row when the same thing arrived more than once.",
    example: "The same order id loaded twice, and you keep the later load.",
    table: "clean_orders",
  }),
  term({
    id: "backfill",
    term: "Backfill",
    aliases: ["backfill", "backfills", "backfilled"],
    definition: "Filling in older dates after a pipeline starts, not only from today forward.",
    example: "Rebuilding daily revenue for all of May, not just this morning.",
  }),
  term({
    id: "sla",
    term: "SLA",
    aliases: ["SLA", "SLAs"],
    definition: "A promise about when something is ready, or how fresh it has to be.",
    example: "The chart is ready by 8am Pacific.",
  }),
  term({
    id: "feature",
    term: "Feature",
    aliases: ["feature", "features"],
    definition: "A number a model reads about one customer or one order.",
    example: "How many orders this customer placed in the last 30 days.",
    table: "churn_features",
  }),
  term({
    id: "primary-key",
    term: "Primary key",
    aliases: ["primary key", "primary keys"],
    definition: "The column, or columns, that uniquely identify each row.",
    example: "One order id, and no second row with that same id.",
    table: "clean_orders",
  }),
  term({
    id: "constraint",
    term: "Constraint",
    aliases: ["constraint", "constraints"],
    definition: "A rule the database enforces, such as unique or not null.",
    example: "Refusing a second row with the same order id.",
  }),
  term({
    id: "duplicate",
    term: "Duplicate",
    aliases: ["duplicate", "duplicates", "dupe", "dupes"],
    definition: "The same fact loaded more than once.",
    example: "One order id appearing on two rows of the raw file.",
    table: "raw_orders",
  }),
  term({
    id: "schema",
    term: "Schema",
    aliases: ["schema"],
    definition: "The list of tables and columns, and the types of those columns.",
    example: "raw_orders has an order id, a customer id, and an amount.",
    table: "raw_orders",
  }),
  term({
    id: "schema-drift",
    term: "Schema drift",
    aliases: ["schema drift"],
    definition: "A source table gains, loses, or renames a column after you already built on it.",
    example: "A new promo code column shows up on the order file.",
    table: "raw_orders",
  }),
  term({
    id: "erd",
    term: "ERD",
    aliases: ["ERD"],
    definition: "A picture of the tables and how they relate. Here it is the column list you can open from any screen.",
  }),
  term({
    id: "utc",
    term: "UTC",
    aliases: ["UTC"],
    definition: "The world clock with no daylight-saving shift. This database session is set to it.",
    example: "9:00am Pacific in June is 16:00 UTC.",
  }),
  term({
    id: "handoff",
    term: "Handoff",
    aliases: ["handoff"],
    definition: "A note for the next person: what the table means, and what broke.",
  }),
  term({
    id: "aggregate",
    term: "Aggregate",
    aliases: ["aggregate", "aggregates", "aggregation"],
    definition: "Combining many rows into one number, such as a count or a sum.",
    example: "Total revenue for one day.",
    table: "daily_revenue",
  }),
  term({
    id: "metric",
    term: "Metric",
    aliases: ["metric", "metrics"],
    definition: "A number the business watches, such as revenue or average order value.",
    table: "daily_revenue",
  }),
  term({
    id: "dashboard",
    term: "Dashboard",
    aliases: ["dashboard"],
    definition: "A chart page. Riley's reads the daily revenue table.",
    table: "daily_revenue",
  }),
  term({
    id: "sandbox",
    term: "Sandbox",
    aliases: ["sandbox"],
    definition: "Your own copy of the database. What you create there stays on your desk.",
  }),
  term({
    id: "freshness",
    term: "Freshness",
    aliases: ["freshness"],
    definition: "How recently the table was rebuilt from the latest files.",
    example: "The chart still shows yesterday because the morning run has not happened.",
  }),
];

const BY_ID = new Map(GLOSSARY.map((entry) => [entry.id, entry]));

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return BY_ID.get(id);
}

export type GlossarySpan =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "sql"; text: string }
  | { type: "term"; text: string; id: string };

function isSqlLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^(select|with|create|insert|update|delete|drop|alter|grant|revoke)\b/i.test(trimmed)) return true;
  return /\bselect\b/i.test(trimmed) && /\bfrom\b/i.test(trimmed);
}

function scanLine(line: string): GlossarySpan[] {
  if (isSqlLine(line)) return [{ type: "sql", text: line }];
  const spans: GlossarySpan[] = [];
  let index = 0;
  while (index < line.length) {
    let best: { at: number; length: number; entry: GlossaryEntry } | null = null;
    const rest = line.slice(index);
    for (const entry of GLOSSARY) {
      const match = entry.regex.exec(rest);
      if (!match || match.index < 0) continue;
      const at = index + match.index;
      const length = match[0].length;
      if (!best || at < best.at || (at === best.at && length > best.length)) {
        best = { at, length, entry };
      }
    }
    if (!best) {
      spans.push({ type: "text", text: line.slice(index) });
      break;
    }
    if (best.at > index) spans.push({ type: "text", text: line.slice(index, best.at) });
    const text = line.slice(best.at, best.at + best.length);
    const around = line.slice(Math.max(0, best.at - 60), best.at + best.length + 60);
    if (best.entry.suppressNear?.test(around)) spans.push({ type: "text", text });
    else spans.push({ type: "term", text, id: best.entry.id });
    index = best.at + best.length;
  }
  return spans;
}

/** Split one block of prose into plain text, code, SQL, and glossary hits. Code spans and SQL are not annotated. */
export function glossarySpans(input: string): GlossarySpan[] {
  const spans: GlossarySpan[] = [];
  const pattern = /```[\s\S]*?```|`[^`\n]+`/g;
  let last = 0;
  for (const match of input.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) spans.push(...scanProse(input.slice(last, start)));
    const raw = match[0];
    spans.push({
      type: "code",
      text: raw.startsWith("```") ? raw.replace(/^```[a-z]*\n?|\n?```$/gi, "") : raw.slice(1, -1),
    });
    last = start + raw.length;
  }
  if (last < input.length) spans.push(...scanProse(input.slice(last)));
  return spans;
}

function scanProse(text: string): GlossarySpan[] {
  const lines = text.split("\n");
  const spans: GlossarySpan[] = [];
  lines.forEach((line, index) => {
    spans.push(...scanLine(line));
    if (index < lines.length - 1) spans.push({ type: "text", text: "\n" });
  });
  return spans;
}
