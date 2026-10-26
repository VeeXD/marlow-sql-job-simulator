import { SEED_VERSION } from "./seed.js";
import { stripCommentsAndStrings } from "./sql.js";

/** Fixed scenario identity. Variants in a later release change this, not the player. */
export const SCENARIO_VERSION = "marlow-commerce-2024-06";
export const SEED_LABEL = `seed-v${SEED_VERSION}`;
export const RETENTION_DAYS = 90;
export const CONSENT_NOTICE =
  "Practice mode. The desk records queries, messages, timings, and — with this notice — paste size, focus loss, and a typing-cadence summary. Experimental. Not a hiring score. Kept with the session for 90 days.";

export const EXPERIMENTAL_LABEL =
  "Experimental — not validated; must not be the sole basis of any hiring decision.";

/** Non-cryptographic content reference. Not a secret and not a score. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

export function errorClass(code?: string | null): string {
  if (!code) return "rejected";
  if (code === "57014") return "statement_timeout";
  if (code === "42P01") return "undefined_table";
  if (code === "42703") return "undefined_column";
  if (code === "42601") return "syntax";
  if (code.startsWith("42")) return "syntax_or_schema";
  if (code.startsWith("22")) return "data_exception";
  if (code.startsWith("23")) return "integrity_constraint";
  return code;
}

export function isProfilingQuery(sql: string): boolean {
  const scan = stripCommentsAndStrings(sql).toLowerCase();
  if (!/^\s*(select|with|table)\b/.test(scan)) return false;
  const shape = /\bcount\s*\(|\bdistinct\b|\bmin\s*\(|\bmax\s*\(|\bgroup\s+by\b/.test(scan);
  const target = /\braw_orders\b|\braw_events\b|\binformation_schema\b|\bpg_catalog\b/.test(scan);
  return shape && target;
}

export function isImprovementBeyondScope(text: string): boolean {
  return /\b(test|constraint|monitor|alert|index|check constraint|data quality)\b/i.test(text);
}

export function isEscalation(text: string): boolean {
  return /escalat|i(?:'m| am) stuck|need help|can you (?:ask|ping)|over my head|i(?:'m| am) blocked/.test(
    text.toLowerCase(),
  );
}

export type StoredSignal = {
  id?: number | string;
  event_name: string;
  stage?: string | null;
  sim_time?: string | null;
  wall_time?: string | null;
  created_at?: string | null;
  scenario_version?: string | null;
  seed?: string | null;
  payload?: Record<string, unknown> | null;
};

export type Evidence = {
  eventId: number | string | null;
  name: string;
  simTime: string | null;
  wallTime: string | null;
  stage: string | null;
  scenarioVersion: string | null;
  seed: string | null;
  payload: Record<string, unknown>;
};

const DIMENSIONS: { id: string; label: string; names: string[] }[] = [
  {
    id: "technical",
    label: "Technical knowledge",
    names: ["query_run", "error_returned", "verdict", "deliverable_submitted", "pipeline_run"],
  },
  {
    id: "curiosity",
    label: "Curiosity",
    names: ["schema_explored", "clarifying_question", "clarifying_question_asked", "kt_question"],
  },
  {
    id: "creativity",
    label: "Creativity and innovation",
    names: ["suggestion_made", "improvement_beyond_scope"],
  },
  {
    id: "completion",
    label: "Ability to complete tasks",
    names: ["deadline_event", "handoff_submitted", "project_completed", "ticket_opened", "pipeline_step_created"],
  },
  {
    id: "pressure",
    label: "Reaction to pressure and deadlines",
    names: ["pressure_window_start", "pressure_window_end", "break_detected", "break_fixed"],
  },
  {
    id: "working_style",
    label: "Working-style and values alignment",
    names: [
      "escalation",
      "priority_decision",
      "message_sent",
      "chat_message_sent",
      "standing_change",
      "kt_joined",
      "kt_topic_covered",
      "kt_completed",
    ],
  },
];

function toEvidence(event: StoredSignal): Evidence {
  return {
    eventId: event.id ?? null,
    name: event.event_name,
    simTime: event.sim_time ?? null,
    wallTime: event.wall_time ?? event.created_at ?? null,
    stage: event.stage ?? null,
    scenarioVersion: event.scenario_version ?? null,
    seed: event.seed ?? null,
    payload: event.payload ?? {},
  };
}

/**
 * Groups stored events under the six hiring dimensions. This is an index of
 * evidence, not a score, a rank, or a hiring recommendation.
 */
export function groupSignals(events: StoredSignal[]) {
  const used = new Set<string>();
  const dimensions = DIMENSIONS.map((dimension) => {
    const matched = events.filter((event) => dimension.names.includes(event.event_name));
    for (const event of matched) used.add(event.event_name);
    return {
      id: dimension.id,
      label: dimension.label,
      eventCount: matched.length,
      events: matched.map(toEvidence),
    };
  });
  const integrity = events
    .filter((event) => event.event_name === "integrity_signal" || event.event_name === "consent_recorded")
    .map(toEvidence);
  const other = events
    .filter((event) => !DIMENSIONS.some((dimension) => dimension.names.includes(event.event_name)))
    .filter((event) => event.event_name !== "integrity_signal" && event.event_name !== "consent_recorded")
    .map(toEvidence);
  return {
    experimental: true as const,
    label: EXPERIMENTAL_LABEL,
    scored: false as const,
    dimensions,
    integrity,
    other,
    knownNames: used,
  };
}
