import { isDelayFlag, isOrderDefinitionQuestion, isStatusUpdate, isSuggestion } from "./clarify.js";
import { addMinutes, minutesBetween, minutesSinceStart, SIM_START_ISO } from "./clock.js";
import { gradeHandoff } from "./handoff.js";
import { redactSql } from "./prompt.js";
import {
  CONSENT_NOTICE,
  RETENTION_DAYS,
  SCENARIO_VERSION,
  SEED_LABEL,
  contentHash,
  isEscalation,
  isImprovementBeyondScope,
} from "./signals.js";
import { isAccessLocked } from "./telemetry.js";
import type {
  Difficulty,
  DirectorEvent,
  Effect,
  GradeResult,
  PersonaId,
  PipelineStep,
  ReduceResult,
  Schedule,
  SessionState,
  SpeakEffect,
  TicketState,
} from "./types.js";
import { CAST_BY_ID, NEXT_PROJECT } from "./world.js";

export const TIMELINE = {
  walkthroughMin: 10,
  kickoffMin: 25,
  jonahBusyMin: 6 * 60,
  catalogDoneMin: 24 * 60,
  jonahDoneMin: 26 * 60,
  samSketchMin: 8 * 60,
  breakDelayMin: 120,
  idleGuided: 90,
  idleStandard: 240,
  samCheckGuided: 70,
  samCheckStandard: 150,
};

export const ORDER_DEFINITION =
  "`clean_orders` is one row per order that was paid and not later refunded or cancelled. If the same `order_id` landed more than once, keep the latest load. Timestamps are UTC. Drop rows missing `order_id`, `customer_id`, `amount_cents`, or a timestamp.";

const CLEAN_RULE =
  "Unique `order_id` with a real constraint, refunds and cancellations excluded, `ordered_at` stored as timestamptz in UTC, null keys dropped, latest `loaded_at` wins. Columns `order_id`, `customer_id`, `ordered_at`, `amount_cents`, all NOT NULL.";

const PIPELINE_RULE =
  "`churn_features` and `daily_revenue` match the column contract, uniqueness constraints hold, and an enabled daily pipeline has a successful run that produced them.";

const BREAK_RULE =
  "After the late file, `clean_orders`, `churn_features`, and `daily_revenue` match the same contracts, and the handoff note covers duplicates, refunds, UTC, the pipeline, and the late file.";

const PIPELINE_BODY = `Sam needs \`churn_features\`. Riley needs \`daily_revenue\`. Build them with an ordered list of SQL steps on a daily schedule (06:00 Pacific). Rebuild from the landing zone every run.

\`churn_features\`
- \`customer_id\` unique, not null
- \`as_of_date\` — the UTC date of the latest \`ordered_at\` in \`clean_orders\`
- \`orders_30d\` — that customer's clean orders whose UTC date falls in [\`as_of_date\` - 29 days, \`as_of_date\`]
- \`revenue_30d\` — sum of \`amount_cents\` in that window
- \`days_since_last_order\` — \`as_of_date\` minus the UTC date of their latest order
- one row per customer in \`clean_orders\`

\`daily_revenue\`
- \`revenue_date\` unique — the UTC date of \`ordered_at\`
- \`order_count\`
- \`gross_revenue\` — sum of \`amount_cents\`
- \`aov\` — \`gross_revenue\` / \`order_count\` as real division

Your database session is already set to UTC.`;

const PIPELINE_BODY_STANDARD = `Daily pipeline at 06:00 Pacific. Ordered SQL steps, rebuilt from the landing zone.

\`churn_features\`: unique \`customer_id\`; \`as_of_date\` is the UTC date of the latest \`ordered_at\` in \`clean_orders\`; \`orders_30d\` and \`revenue_30d\` on the inclusive window [\`as_of_date\` - 29 days, \`as_of_date\`]; \`days_since_last_order\`; one row per customer.

\`daily_revenue\`: unique \`revenue_date\` (UTC date of \`ordered_at\`); \`order_count\`; \`gross_revenue\`; \`aov\` as real division.`;

const COHORT_RULE =
  "`repeat_cohorts` has one row per customer in `clean_orders`, a unique `customer_id`, `order_count`, and `repeat_buyer` true exactly when `order_count` is at least 2.";

export type TimelineFact = { id: string; person: string; noun: string; done: boolean };

export function timelineFacts(state: SessionState): TimelineFact[] {
  const mins = minutesSinceStart(state.simNow);
  return [
    {
      id: "catalog_refresh",
      person: "Jonah",
      noun: "catalog refresh",
      done: mins >= TIMELINE.catalogDoneMin,
    },
    {
      id: "churn_wiring",
      person: "Sam",
      noun: "churn wiring",
      done: state.cleanOrdersPassed,
    },
    {
      id: "dashboard_hookup",
      person: "Riley",
      noun: "dashboard hookup",
      done: state.pipelineEverSucceeded,
    },
  ];
}

export function factSentence(fact: TimelineFact): string {
  if (fact.done && fact.noun === "catalog refresh") {
    return "Jonah has finished the catalog refresh. Columns on `raw_orders` and `raw_events` did not change.";
  }
  if (!fact.done && fact.noun === "catalog refresh") {
    return "Jonah has not finished the catalog refresh. It is still running, and the landing columns are stable enough to read.";
  }
  if (fact.done && fact.noun === "churn wiring") {
    return "Sam has finished the churn wiring. The model points at `churn_features`, and he still will not write your SQL.";
  }
  if (!fact.done && fact.noun === "churn wiring") {
    return "Sam has not finished the churn wiring. He is sketching on a sample until `churn_features` exists.";
  }
  if (fact.done) {
    return "Riley has finished the dashboard hookup. They read `daily_revenue` and will say so if it drifts.";
  }
  return "Riley has not finished the dashboard hookup. They are waiting on `daily_revenue`.";
}

const DEFAULT_SCHEDULE: Schedule = {
  cadence: "daily",
  hour: 6,
  minute: 0,
  timezone: "America/Los_Angeles",
};

function ticket(
  partial: Omit<TicketState, "status" | "released" | "lastVerdict"> & { released?: boolean },
): TicketState {
  return {
    ...partial,
    status: "ready",
    released: partial.released ?? false,
    lastVerdict: null,
  };
}

export function createInitialState(input: {
  playerName: string;
  difficulty: Difficulty;
  consent?: SessionState["consent"];
}): SessionState {
  const name = input.playerName.trim() || "Alex Morgan";
  const standing = { priya: 72, jonah: 72, sam: 72, riley: 72 };
  const guided = input.difficulty === "guided";
  return {
    playerName: name,
    difficulty: input.difficulty,
    projectId: "trustworthy-orders",
    stage: "onboard",
    simNow: SIM_START_ISO,
    lastRealSyncAt: Date.now(),
    lastActivityAt: Date.now(),
    clockPaused: false,
    seq: 0,
    fired: [],
    messages: [],
    tickets: [
      ticket({
        id: "explore",
        key: "MO-1",
        title: "Explore the landing zone",
        body: guided
          ? "Jonah's files are `raw_orders` and `raw_events`. They are dumps, not a model. Query both until you can describe the mess in your own words."
          : "The landing zone is already in your database. Learn it before you build. The evaluation rule names the tables.",
        coachNotes: guided
          ? "Start with row counts, distinct `order_id`s, and where nulls sit. Don't build `clean_orders` on this ticket."
          : null,
        evaluationRule: "A successful query has run against `raw_orders` and against `raw_events`.",
        hiddenEvaluation: null,
        dueAt: addMinutes(SIM_START_ISO, 9 * 60),
        released: false,
      }),
      ticket({
        id: "definition",
        key: "MO-2",
        title: "Agree what counts as an order",
        body: guided
          ? "Finance and growth don't use the same order. I won't sign a table until the rule is written down. Ask me before you build — guessing doesn't unlock it."
          : "We have not agreed what an order is. Don't guess, and don't build until we have.",
        coachNotes: guided
          ? "The fight is about which rows belong in the table. Priya will answer a direct question. She will not volunteer the rule."
          : null,
        evaluationRule: "Hidden until you and Priya agree what counts as an order.",
        hiddenEvaluation: ORDER_DEFINITION,
        dueAt: addMinutes(SIM_START_ISO, 33 * 60),
        released: false,
      }),
      ticket({
        id: "clean",
        key: "MO-3",
        title: "Build clean_orders",
        body: guided
          ? "Build `clean_orders` from the landing zone using the rule on this ticket. Put a primary key or unique constraint on `order_id`, and mark `order_id`, `customer_id`, `ordered_at`, and `amount_cents` NOT NULL. `ordered_at` is timestamptz."
          : "Build `clean_orders` to the evaluation rule on this ticket. The constraints are part of done.",
        coachNotes: guided
          ? "Worth a look: repeated `order_id`s, `order_status`, refund and cancel events on `raw_events`, and rows that only have `ordered_at_local`."
          : null,
        evaluationRule: CLEAN_RULE,
        hiddenEvaluation: null,
        dueAt: addMinutes(SIM_START_ISO, 57 * 60),
        released: false,
      }),
      ticket({
        id: "pipeline",
        key: "MO-4",
        title: "Daily pipeline for churn and revenue",
        body: guided ? PIPELINE_BODY : PIPELINE_BODY_STANDARD,
        coachNotes: guided
          ? "Three steps is a natural shape: rebuild `clean_orders`, then `churn_features`, then `daily_revenue`. Run it once before you submit."
          : null,
        evaluationRule: PIPELINE_RULE,
        hiddenEvaluation: null,
        dueAt: addMinutes(SIM_START_ISO, 75 * 60),
        released: false,
      }),
      ticket({
        id: "break",
        key: "MO-5",
        title: "Late file and handoff",
        body: guided
          ? "A file landed after a run. Riley's chart and Sam's features can drift from the landing zone when that happens. Rebuild from raw, tell them what moved, and leave a handoff note the next analyst can trust."
          : "The landing zone moved after a run. Rebuild, tell the consumers, and leave a handoff note.",
        coachNotes: guided
          ? "Check `source_file` for a drop you haven't seen. Then rerun the pipeline. The handoff box is on this ticket."
          : null,
        evaluationRule: BREAK_RULE,
        hiddenEvaluation: null,
        dueAt: addMinutes(SIM_START_ISO, 81 * 60),
        released: false,
      }),
      ticket({
        id: "cohort",
        key: "RC-1",
        title: "Repeat buyers",
        body: guided
          ? "From `clean_orders`, build `repeat_cohorts`. One row per `customer_id`. `order_count` is how many clean orders they have. `repeat_buyer` is true when that count is at least 2. Put a primary key on `customer_id`."
          : "Build `repeat_cohorts` from `clean_orders`. The evaluation rule is the contract.",
        coachNotes: guided ? "This is one table. It reads `clean_orders` only. Don't reopen the landing-zone fight." : null,
        evaluationRule: COHORT_RULE,
        hiddenEvaluation: null,
        dueAt: addMinutes(SIM_START_ISO, 200 * 60),
        released: false,
      }),
    ],
    queriedTables: [],
    hidden: { orderDefinitionUnlocked: false },
    standing,
    standingLog: [],
    statusCredits: 0,
    onboarding: { welcome: false, walkthrough: false, kickoff: false },
    kt: { status: "scheduled", topicsCovered: [], questionsAsked: 0 },
    kickoffAtSim: null,
    t3ReleasedAtSim: null,
    lastQueryAtSim: null,
    cleanOrdersPassed: false,
    pipelineEverSucceeded: false,
    pipelineSucceededAtSim: null,
    breakStatus: "pending",
    breakFixed: false,
    handoff: null,
    projectCompleted: false,
    nextProjectChosen: null,
    abandoned: false,
    review: null,
    pipeline: { steps: [], schedule: DEFAULT_SCHEDULE, enabled: false },
    runs: [],
    scheduledRunKeys: [],
    llmTokensUsed: 0,
    consent: input.consent ?? {
      practiceTelemetry: true,
      integritySignals: true,
      retentionDays: RETENTION_DAYS,
      notice: CONSENT_NOTICE,
    },
    cohort: { active: false, completed: false },
    lastQueryFailed: false,
    pressureOpen: false,
    scenarioVersion: SCENARIO_VERSION,
    seed: SEED_LABEL,
  };
}

function once(state: SessionState, id: string): boolean {
  if (state.fired.includes(id)) return false;
  state.fired.push(id);
  return true;
}

function bump(state: SessionState, effects: Effect[], persona: PersonaId, delta: number, reason: string) {
  const before = state.standing[persona];
  const after = Math.max(0, Math.min(100, before + delta));
  const applied = after - before;
  if (applied === 0) return;
  state.standing[persona] = after;
  state.standingLog.push({ persona, delta: applied, reason, simNow: state.simNow, standing: after });
  effects.push({
    type: "telemetry",
    name: "standing_change",
    payload: { persona, delta: applied, reason, standing: after },
  });
}

function baseFacts(state: SessionState, persona: PersonaId): string[] {
  const facts = [
    `The player is ${state.playerName}, a new analytics engineer at Marlow.`,
    "The project is Trustworthy orders.",
    "Jonah owns raw_orders and raw_events. Sam consumes churn_features. Riley consumes daily_revenue.",
    "You never write the player's SQL.",
    ...timelineFacts(state).map(factSentence),
  ];
  if (state.hidden.orderDefinitionUnlocked && (persona === "priya" || persona === "jonah")) {
    facts.push(ORDER_DEFINITION);
  } else if (!state.hidden.orderDefinitionUnlocked) {
    facts.push("The order definition is not settled. Tell them to ask Priya what belongs in the table. Do not state the rule.");
  }
  if (state.breakStatus === "active") {
    facts.push("A late file has landed in the landing zone. Consumer numbers can be stale until the pipeline reruns.");
  }
  return facts;
}

function speak(
  state: SessionState,
  effects: Effect[],
  opts: {
    persona: PersonaId;
    channel: string;
    intent: string;
    body: string;
    facts?: string[];
    playerMessage?: string;
    reaction?: string;
  },
): void {
  state.seq += 1;
  const id = `m${state.seq}`;
  state.messages.push({
    id,
    atSim: state.simNow,
    channel: opts.channel,
    author: opts.persona,
    authorName: CAST_BY_ID[opts.persona].name,
    body: opts.body,
    intent: opts.intent,
    reaction: opts.reaction,
  });
  const effect: SpeakEffect = {
    type: "speak",
    messageId: id,
    personaId: opts.persona,
    intent: opts.intent,
    allowedFacts: opts.facts ?? baseFacts(state, opts.persona),
    fallback: opts.body,
    channel: opts.channel,
    playerMessage: opts.playerMessage ? redactSql(opts.playerMessage) : undefined,
  };
  effects.push(effect);
  effects.push({
    type: "telemetry",
    name: "chat_message_sent",
    payload: { author: opts.persona, intent: opts.intent, channel: opts.channel },
  });
}

function release(state: SessionState, effects: Effect[], ticketId: string) {
  const t = state.tickets.find((ticket) => ticket.id === ticketId);
  if (!t || t.released) return;
  t.released = true;
  effects.push({ type: "release_ticket", ticketId });
  if (ticketId === "clean") state.t3ReleasedAtSim = state.simNow;
}

function findTicket(state: SessionState, id: string): TicketState | undefined {
  return state.tickets.find((t) => t.id === id);
}

function recomputeStage(state: SessionState) {
  if (state.abandoned) return;
  if (state.nextProjectChosen) state.stage = "next";
  else if (state.projectCompleted) state.stage = "judged";
  else if (state.breakFixed && !state.projectCompleted) state.stage = "communicate";
  else if (state.breakStatus === "active") state.stage = "operate";
  else if (state.pipelineEverSucceeded || findTicket(state, "pipeline")?.released) state.stage = "build_pipeline";
  else if (state.hidden.orderDefinitionUnlocked) state.stage = "pull_clean";
  else if (state.onboarding.kickoff && state.fired.includes("left_receive")) state.stage = "investigate";
  else if (state.onboarding.kickoff) state.stage = "receive";
  else state.stage = "onboard";
}

function leaveReceive(state: SessionState) {
  if (state.onboarding.kickoff) once(state, "left_receive");
}

function finishExplore(state: SessionState, effects: Effect[]) {
  const ticket = findTicket(state, "explore");
  if (!ticket?.released || ticket.status === "done") return;
  if (!state.queriedTables.includes("raw_orders") || !state.queriedTables.includes("raw_events")) return;
  const late = Date.parse(state.simNow) > Date.parse(ticket.dueAt);
  ticket.status = "done";
  const summary = late
    ? "You got eyes on both landing tables. Later than I wanted, but MO-1 is done."
    : "Yeah. You've queried `raw_orders` and `raw_events`. MO-1 is done. The definition is the one that matters next.";
  ticket.lastVerdict = { passed: true, summary, atSim: state.simNow };
  bump(state, effects, "priya", late ? 2 : 4, late ? "explore late" : "explore on time");
  effects.push({
    type: "telemetry",
    name: "deadline_event",
    payload: {
      ticketId: "explore",
      outcome: late ? "late" : "on_time",
      leadMs: Date.parse(ticket.dueAt) - Date.parse(state.simNow),
      dueAt: ticket.dueAt,
    },
  });
  effects.push({ type: "telemetry", name: "deliverable_submitted", payload: { ticketId: "explore", passed: true } });
  effects.push({ type: "telemetry", name: "verdict", payload: { ticketId: "explore", passed: true } });
  speak(state, effects, { persona: "priya", channel: "dm:priya", intent: "verdict_explore", body: summary });
}

function maybeComplete(state: SessionState, effects: Effect[]) {
  if (state.projectCompleted || state.abandoned) return;
  if (!state.breakFixed || !state.handoff?.passed) return;
  state.projectCompleted = true;
  const summary = `${state.playerName}, that's the project. The orders table, the daily pipeline, and the late file are in a place I can defend. Standing sits with me at ${state.standing.priya}, Jonah at ${state.standing.jonah}, Sam at ${state.standing.sam}, Riley at ${state.standing.riley}. Next up in commerce is ${NEXT_PROJECT.title}. Say the word and I'll put RC-1 on this same board. The rest of that brief is not staffed.`;
  state.review = {
    summary,
    handoffScore: state.handoff.score,
    handoffTotal: state.handoff.total,
    nextProject: NEXT_PROJECT,
  };
  const breakTicket = findTicket(state, "break");
  if (breakTicket) breakTicket.status = "done";
  bump(state, effects, "priya", 4, "project review");
  effects.push({ type: "telemetry", name: "project_completed", payload: { handoffScore: state.handoff.score } });
  speak(state, effects, {
    persona: "priya",
    channel: "dm:priya",
    intent: "project_review",
    body: `${state.playerName}, that's the project. I can defend the orders table, the daily pipeline, and the late file.`,
  });
  speak(state, effects, {
    persona: "priya",
    channel: "dm:priya",
    intent: "project_review",
    body: `Standing sits with me at ${state.standing.priya}, Jonah at ${state.standing.jonah}, Sam at ${state.standing.sam}, Riley at ${state.standing.riley}. Next up is ${NEXT_PROJECT.title}. Say the word and I'll put RC-1 on this board.`,
    reaction: "👍",
  });
}

function applyTimeTriggers(state: SessionState, effects: Effect[]) {
  const mins = minutesSinceStart(state.simNow);
  if (mins >= TIMELINE.walkthroughMin && once(state, "walkthrough")) {
    state.onboarding.walkthrough = true;
    speak(state, effects, {
      persona: "jonah",
      channel: "team",
      intent: "walkthrough",
      body: `${state.playerName} — two landing tables, both mine: \`raw_orders\` and \`raw_events\`. File drops, not a model.`,
    });
    speak(state, effects, {
      persona: "jonah",
      channel: "team",
      intent: "walkthrough",
      body: "Expect repeated `order_id`s, nulls, and clocks that disagree. `ordered_at` is timestamptz. `ordered_at_local` is Pacific wall time with no zone. Your session time zone is UTC. The ERD is the column list.",
    });
    speak(state, effects, {
      persona: "jonah",
      channel: "team",
      intent: "walkthrough",
      body: "I have not finished the catalog refresh. It is still running. I won't write the clean layer.",
    });
  }
  if (mins >= TIMELINE.kickoffMin && once(state, "kickoff")) {
    state.onboarding.kickoff = true;
    state.kickoffAtSim = state.simNow;
    release(state, effects, "explore");
    release(state, effects, "definition");
    effects.push({ type: "telemetry", name: "onboarding_complete", payload: {} });
    speak(state, effects, {
      persona: "priya",
      channel: "dm:priya",
      intent: "kickoff",
      body: "Board's up. Trustworthy orders. Start with MO-1, then MO-2.",
      reaction: "👍",
    });
    speak(state, effects, {
      persona: "priya",
      channel: "dm:priya",
      intent: "kickoff",
      body: "I won't sign a table until we agree what an order is. Ask me. Don't guess.",
    });
  }
  if (mins >= TIMELINE.jonahBusyMin && once(state, "jonah_busy")) {
    speak(state, effects, {
      persona: "jonah",
      channel: "team",
      intent: "busy_catalog",
      body: "Heads down today. I have not finished the catalog refresh. It is still running. Landing tables are safe to read.",
    });
  }
  if (mins >= TIMELINE.samSketchMin && once(state, "sam_sketch") && !state.cleanOrdersPassed) {
    speak(state, effects, {
      persona: "sam",
      channel: "team",
      intent: "busy_churn",
      body: "Sketching the churn model on a sample. Honestly, I have not finished the churn wiring. No `churn_features` yet, and I won't invent it.",
    });
  }
  if (mins >= TIMELINE.jonahDoneMin && once(state, "jonah_done")) {
    speak(state, effects, {
      persona: "jonah",
      channel: "team",
      intent: "catalog_done",
      body: "I have finished the catalog refresh. No column changes on `raw_orders` or `raw_events`.",
    });
  }

  const idleLimit = state.difficulty === "guided" ? TIMELINE.idleGuided : TIMELINE.idleStandard;
  const explore = findTicket(state, "explore");
  if (
    state.kickoffAtSim &&
    explore?.released &&
    explore.status !== "done" &&
    onceWould(state, "idle_explore") &&
    minutesBetween(state.lastQueryAtSim ?? state.kickoffAtSim, state.simNow) >= idleLimit
  ) {
    once(state, "idle_explore");
    speak(state, effects, {
      persona: "priya",
      channel: "dm:priya",
      intent: "nudge_idle",
      body: "Checking in. MO-1's been quiet. Even a couple of counts on `raw_orders` and `raw_events` would show the shape of the mess.",
    });
  }

  const checkLimit = state.difficulty === "guided" ? TIMELINE.samCheckGuided : TIMELINE.samCheckStandard;
  if (
    state.t3ReleasedAtSim &&
    !state.cleanOrdersPassed &&
    onceWould(state, "sam_checkin") &&
    minutesBetween(state.t3ReleasedAtSim, state.simNow) >= checkLimit
  ) {
    once(state, "sam_checkin");
    speak(state, effects, {
      persona: "sam",
      channel: "dm:sam",
      intent: "check_table",
      body: "Hey. Did `clean_orders` land? I have not finished the churn wiring, and I'm blocked until that table exists. I won't write it.",
    });
  }

  if (
    state.pipelineEverSucceeded &&
    state.pipelineSucceededAtSim &&
    state.breakStatus === "pending" &&
    minutesBetween(state.pipelineSucceededAtSim, state.simNow) >= TIMELINE.breakDelayMin &&
    once(state, "break")
  ) {
    state.breakStatus = "active";
    state.pressureOpen = true;
    release(state, effects, "break");
    effects.push({ type: "inject_break", kind: "late_data" });
    effects.push({ type: "inject_break", kind: "schema_drift" });
    effects.push({ type: "inject_break", kind: "null_spike" });
    effects.push({ type: "telemetry", name: "break_detected", payload: { kind: "late_data" } });
    effects.push({ type: "telemetry", name: "break_detected", payload: { kind: "schema_drift" } });
    effects.push({ type: "telemetry", name: "break_detected", payload: { kind: "null_spike" } });
    effects.push({
      type: "telemetry",
      name: "pressure_window_start",
      payload: { trigger: "injected_break", kinds: ["late_data", "schema_drift", "null_spike"] },
    });
    speak(state, effects, {
      persona: "riley",
      channel: "dm:riley",
      intent: "break_ping",
      body: "Hey. Something's off on the exec chart.",
      reaction: "😬",
    });
    speak(state, effects, {
      persona: "riley",
      channel: "dm:riley",
      intent: "break_ping",
      body: "It still looks like the pre-drop numbers, and finance already has refunds from this morning that I don't. A late file may have hit the landing zone after your run. Can you look? I can't fix `daily_revenue` from here.",
    });
    speak(state, effects, {
      persona: "jonah",
      channel: "dm:jonah",
      intent: "break_schema",
      body: "Heads up. `raw_orders` grew a `promo_code` column, and the same drop has a null spike in `amount_cents`.",
    });
    speak(state, effects, {
      persona: "jonah",
      channel: "dm:jonah",
      intent: "break_schema",
      body: "I won't rewrite the pipeline. Don't trust column order.",
    });
    speak(state, effects, {
      persona: "priya",
      channel: "dm:priya",
      intent: "break_assign",
      body: "Riley's ping is MO-5. Rebuild from the landing zone, then leave a handoff note.",
    });
    speak(state, effects, {
      persona: "priya",
      channel: "dm:priya",
      intent: "break_assign",
      body: "Being late costs standing, not access.",
    });
  }
}

function noteKtQuestion(state: SessionState, effects: Effect[], body: string) {
  if (state.kt.status !== "live") return;
  state.kt.questionsAsked += 1;
  effects.push({
    type: "telemetry",
    name: "kt_question",
    payload: { length: body.length },
  });
}

const KT_TOPICS: { id: string; lines: string[] }[] = [
  {
    id: "company",
    lines: [
      "Okay. Quick KT, then you can poke around.",
      "Marlow sells home goods direct. Linens, lighting, kitchen tools. Finance stopped trusting the Thursday revenue chart. That's why this seat exists.",
    ],
  },
  {
    id: "project",
    lines: [
      "The project is Trustworthy orders. One clean table the company will sign, a daily pipeline for the model and the chart, and a late file that shows up after you think you're done.",
    ],
  },
  {
    id: "landscape",
    lines: [
      "Data lives in Postgres. Jonah's landing files are `raw_orders` and `raw_events`. Your session time zone is UTC.",
      "`ordered_at` is timestamptz. `ordered_at_local` is Pacific wall time with no zone. The ERD in the header is the column list. I won't walk the transform.",
    ],
  },
  {
    id: "role",
    lines: ["You're the analytics engineer. You report to me. You don't own the source files, and you don't own the chart."],
  },
  {
    id: "duties",
    lines: [
      "Your job this week: learn the landing zone, agree what an order is with me, build the clean table, put a daily pipeline under Sam and Riley, and write a handoff when something breaks.",
    ],
  },
  {
    id: "who",
    lines: [
      "Jonah for files and columns. Sam for the churn model. Riley for the exec chart. Me for what done means.",
      "Don't ask Riley to define an order. They'll just tell you the chart looks wrong.",
    ],
  },
  {
    id: "arrival",
    lines: [
      "Work shows up as tickets on the board, and as pings in chat when a number looks off. If both happen, the ping is usually the louder one.",
    ],
  },
  {
    id: "done",
    lines: [
      "Every ticket says what done means. I won't sign a table until we agree the rule. Guessing doesn't unlock it. Ask me.",
    ],
  },
  {
    id: "week",
    lines: [
      "First week, start with MO-1, then MO-2, once the board is up. Ask in this meeting or in my chat.",
      "I still won't write the SQL. Questions?",
    ],
  },
];

function deliverKt(state: SessionState, effects: Effect[]): string | null {
  if (state.kt.status === "live") return "KT is already going.";
  if (state.kt.status === "done") return "KT is already wrapped.";
  state.kt.status = "live";
  effects.push({ type: "telemetry", name: "kt_joined", payload: {} });
  for (const topic of KT_TOPICS) {
    topic.lines.forEach((body, index) => {
      speak(state, effects, {
        persona: "priya",
        channel: "meeting:kt",
        intent: index === 0 ? `kt_${topic.id}` : `kt_${topic.id}_more`,
        body,
        reaction: topic.id === "company" && index === 0 ? "👋" : undefined,
      });
    });
    state.kt.topicsCovered.push(topic.id);
    effects.push({ type: "telemetry", name: "kt_topic_covered", payload: { topic: topic.id } });
  }
  return null;
}

function onceWould(state: SessionState, id: string): boolean {
  return !state.fired.includes(id);
}

function personaFor(channel: string, body: string): PersonaId | null {
  if (channel === "meeting:kt") return "priya";
  if (channel.startsWith("dm:")) {
    const id = channel.slice(3) as PersonaId;
    if (id in CAST_BY_ID) return id;
    return null;
  }
  const t = body.toLowerCase();
  if (/jonah|landing|duplicate|dupe|timezone|time zone|null|column|source_file|raw_/.test(t)) return "jonah";
  if (/sam\b|churn|model|feature/.test(t)) return "sam";
  if (/riley|dashboard|exec|chart/.test(t)) return "riley";
  if (t.includes("?")) return "priya";
  return null;
}

function progressFact(body: string, state: SessionState): TimelineFact | null {
  const t = body.toLowerCase();
  const facts = timelineFacts(state);
  if (/catalog refresh/.test(t) || (/jonah/.test(t) && /finish|done|progress|status|catalog|how/.test(t))) return facts[0];
  if (/churn wiring/.test(t) || (/sam/.test(t) && /finish|done|progress|status|wiring|how/.test(t))) return facts[1];
  if (/dashboard hookup/.test(t) || (/riley/.test(t) && /finish|done|progress|status|hookup|how/.test(t))) return facts[2];
  return null;
}

function refuse(persona: PersonaId): string {
  if (persona === "jonah") return "Yeah, no. I won't write that query. Tell me which landing column looks wrong and what you already tried. The ERD is the map.";
  if (persona === "sam") return "I won't write that query. I only know whether `churn_features` looks stable.";
  if (persona === "riley") return "Ha, no. I won't write that query. I can tell you the chart looks wrong. Priya owns the definition.";
  return "I won't write that query. Tell me the decision you're stuck on and what you already tried.";
}

function smallTalk(persona: PersonaId): string {
  if (persona === "jonah") return "Hey. Landing files, or something else?";
  if (persona === "sam") return "Hey. If this is about `churn_features`, I'm listening. I won't write the step.";
  if (persona === "riley") return "Hey. If the chart looks weird, say which day. I won't write SQL.";
  return "Hey. What are you stuck on?";
}

function generic(persona: PersonaId): string {
  if (persona === "jonah") return "Ask me about the files. Columns, reloads, clocks. The ERD lists `raw_orders` and `raw_events`. I won't write the transform.";
  if (persona === "sam") return "I only consume `churn_features`. If a number looks wrong, tell me the `as_of_date` you built. I won't write the step.";
  if (persona === "riley") return "I look at `daily_revenue` by day. If you're unsure what an order is, that's Priya. I'm the chart, not the definition.";
  return "Okay so — which decision are you stuck on? I can unblock a definition. I won't write the SQL.";
}

function replyTo(state: SessionState, effects: Effect[], channel: string, body: string) {
  const persona = personaFor(channel, body);
  if (!persona) return;
  const targetChannel = channel.startsWith("dm:") || channel.startsWith("meeting:") ? channel : "team";
  const fact = progressFact(body, state);
  const t = body.toLowerCase();
  let intent = "ack";
  let text = generic(persona);
  if (/^(hi|hey|hello|morning|yo|thanks|thank you)\b/.test(t)) {
    intent = "small_talk";
    text = smallTalk(persona);
  } else if (/write (the |my )?(query|sql)|do it for me|give me the sql|write the pipeline|build it for me/.test(t)) {
    intent = "refuse_work";
    text = refuse(persona);
  } else if (fact) {
    intent = "progress";
    text = factSentence(fact);
  } else if (/duplicate|dupe|reload/.test(t)) {
    intent = "hint_dupe";
    text = "Yeah, reloads happen. The same `order_id` can land more than once, and I trust the later `loaded_at`. I won't write the dedupe.";
  } else if (/time ?zone|utc|pacific|los angeles|ordered_at_local|local time/.test(t)) {
    intent = "hint_tz";
    text = "Some rows have `ordered_at`. Some only have `ordered_at_local`, Pacific wall time with no zone. The clean table has to be UTC. Your session time zone is already UTC. I won't convert the rows.";
  } else if (/\bnull/.test(t)) {
    intent = "hint_null";
    text = "A null `order_id`, `customer_id`, or `amount_cents` means the file was short. I leave those rows in the landing zone. Whether they belong downstream is the project rule.";
  } else if (/pipeline|schedule|airflow|dag\b/.test(t)) {
    intent = "hint_pipeline";
    text = "An ordered list of SQL steps, run daily, is the whole runner. Sam reads `churn_features`. Riley reads `daily_revenue`. The column contract is on the ticket. We are not standing up another scheduler.";
  } else if (/refund|cancel/.test(t) && state.hidden.orderDefinitionUnlocked) {
    intent = "hint_rule";
    text = `We already settled it. ${ORDER_DEFINITION}`;
  } else if (/refund|cancel/.test(t)) {
    intent = "hint_rule_locked";
    text = "Refunds and cancellations are in the landing zone on purpose. If you want the rule for `clean_orders`, ask Priya whether those orders belong in the table. I won't guess it.";
  }
  speak(state, effects, {
    persona,
    channel: targetChannel,
    intent,
    body: text,
    playerMessage: body,
  });
}

function applyVerdict(
  state: SessionState,
  effects: Effect[],
  ticketId: string,
  grade: GradeResult,
  persona: PersonaId,
  passLine: string,
) {
  const ticket = findTicket(state, ticketId);
  if (!ticket?.released) return { error: "That ticket isn't on the board yet." };
  const late = Date.parse(state.simNow) > Date.parse(ticket.dueAt);
  const failed = grade.checks.filter((c) => !c.ok).slice(0, 3);
  const summary = grade.passed
    ? late
      ? `This is later than the due point, but it holds. ${passLine}`
      : passLine
    : `Not yet. ${failed.map((c) => c.detail).join(" ")} I won't send a query — the evaluation on the ticket is the contract.`;
  ticket.lastVerdict = { passed: grade.passed, summary, atSim: state.simNow };
  if (grade.passed) ticket.status = "done";
  else ticket.status = "in_progress";
  effects.push({
    type: "telemetry",
    name: "deadline_event",
    payload: {
      ticketId,
      outcome: late ? "late" : "on_time",
      leadMs: Date.parse(ticket.dueAt) - Date.parse(state.simNow),
      dueAt: ticket.dueAt,
    },
  });
  effects.push({
    type: "telemetry",
    name: "deliverable_submitted",
    payload: { ticketId, passed: grade.passed, late },
  });
  effects.push({ type: "telemetry", name: "verdict", payload: { ticketId, passed: grade.passed, late } });
  const delta = grade.passed ? (late ? 2 : 6) : -5;
  bump(state, effects, persona, delta, grade.passed ? (late ? `${ticketId} late` : `${ticketId} pass`) : `${ticketId} fail`);
  speak(state, effects, { persona, channel: `dm:${persona}`, intent: grade.passed ? "verdict_pass" : "verdict_fail", body: summary });
  return { late };
}

function notePriority(state: SessionState, effects: Effect[], chosenId: string) {
  const competing = state.tickets
    .filter((ticket) => ticket.released && ticket.status !== "done" && ticket.id !== chosenId)
    .map((ticket) => ticket.id);
  if (competing.length === 0) return;
  effects.push({
    type: "telemetry",
    name: "priority_decision",
    payload: { chosen: chosenId, competing },
  });
}

export function reduce(input: SessionState, event: DirectorEvent): ReduceResult {
  const state = structuredClone(input);
  if (!state.kt) state.kt = { status: "scheduled", topicsCovered: [], questionsAsked: 0 };
  const effects: Effect[] = [];
  if (state.abandoned && event.type !== "start") {
    return { state, effects, error: "This project was abandoned." };
  }
  if (state.projectCompleted) {
    const allowed = new Set<DirectorEvent["type"]>([
      "choose_next",
      "player_message",
      "tick",
      "activity",
      "query",
      "open_ticket",
    ]);
    const cohortSubmit =
      event.type === "submit" && event.ticketId === "cohort" && state.cohort.active && !state.cohort.completed;
    if (!cohortSubmit && !allowed.has(event.type)) {
      return { state, effects, error: "The project is already in review." };
    }
  }

  switch (event.type) {
    case "start": {
      state.onboarding.welcome = true;
      effects.push({
        type: "telemetry",
        name: "project_started",
        payload: { difficulty: state.difficulty, scenarioVersion: state.scenarioVersion, seed: state.seed },
      });
      effects.push({
        type: "telemetry",
        name: "consent_recorded",
        payload: {
          practiceTelemetry: state.consent.practiceTelemetry,
          integritySignals: state.consent.integritySignals,
          retentionDays: state.consent.retentionDays,
          notice: state.consent.notice,
        },
      });
      speak(state, effects, {
        persona: "priya",
        channel: "dm:priya",
        intent: "welcome",
        body: `Hey ${state.playerName}. I'm Priya. I lead data.`,
        reaction: "👋",
      });
      speak(state, effects, {
        persona: "priya",
        channel: "dm:priya",
        intent: "welcome",
        body: "You're our new analytics engineer on commerce. Jonah owns the raw files. Sam and Riley need numbers they can actually defend.",
      });
      speak(state, effects, {
        persona: "priya",
        channel: "dm:priya",
        intent: "welcome",
        body: "I put a knowledge transfer on your calendar for this morning. Join that before the board fills up. I still won't write the SQL.",
      });
      break;
    }
    case "tick": {
      state.simNow = event.simNow;
      state.lastRealSyncAt = event.realNow;
      state.clockPaused = event.paused;
      if (!event.paused) applyTimeTriggers(state, effects);
      break;
    }
    case "activity": {
      state.lastActivityAt = event.realNow;
      state.lastRealSyncAt = event.realNow;
      state.clockPaused = false;
      break;
    }
    case "player_message": {
      const body = event.body.trim();
      if (!body) return { state: input, effects: [], error: "Message is empty." };
      if (body.length > 4000) return { state: input, effects: [], error: "Message is too long." };
      leaveReceive(state);
      state.seq += 1;
      state.messages.push({
        id: `m${state.seq}`,
        atSim: state.simNow,
        channel: event.channel,
        author: "player",
        authorName: state.playerName,
        body,
        intent: "player",
      });
      const kind = isOrderDefinitionQuestion(body)
        ? "clarifying"
        : isStatusUpdate(body)
          ? "status"
          : isSuggestion(body)
            ? "suggestion"
            : "chat";
      effects.push({
        type: "telemetry",
        name: "chat_message_sent",
        payload: { author: "player", channel: event.channel, kind },
      });
      effects.push({
        type: "telemetry",
        name: "message_sent",
        payload: {
          channel: event.channel,
          length: body.length,
          messageId: `m${state.seq}`,
          wallLatencyMs: event.wallLatencyMs ?? null,
          toneFeatures: null,
        },
      });
      const persona = personaFor(event.channel, body);
      if (isEscalation(body)) {
        const from = state.lastQueryAtSim ?? state.kickoffAtSim ?? state.simNow;
        effects.push({
          type: "telemetry",
          name: "escalation",
          payload: {
            persona: persona ?? "priya",
            why: "player_asked_for_help",
            stuckSimMinutes: Math.max(0, minutesBetween(from, state.simNow)),
            messageId: `m${state.seq}`,
          },
        });
      }
      if (kind === "suggestion") {
        effects.push({
          type: "telemetry",
          name: "suggestion_made",
          payload: {
            messageId: `m${state.seq}`,
            contentHash: contentHash(body),
            accepted: state.statusCredits < 4,
            persona: "priya",
          },
        });
      }
      if (isImprovementBeyondScope(body)) {
        effects.push({
          type: "telemetry",
          name: "improvement_beyond_scope",
          payload: {
            messageId: `m${state.seq}`,
            contentHash: contentHash(body),
            accepted: false,
          },
        });
      }
      if (kind === "status" && isDelayFlag(body)) {
        const active = state.tickets.find((ticket) => ticket.released && ticket.status !== "done");
        if (active && Date.parse(state.simNow) < Date.parse(active.dueAt)) {
          effects.push({
            type: "telemetry",
            name: "deadline_event",
            payload: {
              ticketId: active.id,
              outcome: "flagged_early",
              leadMs: Date.parse(active.dueAt) - Date.parse(state.simNow),
              dueAt: active.dueAt,
            },
          });
        }
      }
      if (isOrderDefinitionQuestion(body) && !state.hidden.orderDefinitionUnlocked) {
        state.hidden.orderDefinitionUnlocked = true;
        const definition = findTicket(state, "definition");
        if (definition) {
          definition.status = "done";
          definition.evaluationRule = ORDER_DEFINITION;
          definition.lastVerdict = { passed: true, summary: ORDER_DEFINITION, atSim: state.simNow };
        }
        release(state, effects, "clean");
        const clarifying = {
          persona: event.channel.startsWith("dm:") ? event.channel.slice(3) : "priya",
          ticketId: "definition",
          beforeFirstQuery: state.lastQueryAtSim == null,
          hiddenIntentUnlocked: true,
          messageId: `m${state.seq}`,
        };
        effects.push({ type: "telemetry", name: "clarifying_question_asked", payload: clarifying });
        effects.push({ type: "telemetry", name: "clarifying_question", payload: clarifying });
        effects.push({ type: "telemetry", name: "verdict", payload: { ticketId: "definition", passed: true } });
        bump(state, effects, "priya", 3, "clarified the order definition");
        const channel = event.channel.startsWith("dm:") || event.channel.startsWith("meeting:") ? event.channel : "dm:priya";
        if (event.channel === "meeting:kt" && state.kt.status === "live") {
          state.kt.questionsAsked += 1;
          effects.push({
            type: "telemetry",
            name: "kt_question",
            payload: { messageId: `m${state.seq}`, length: body.length, topic: "definition" },
          });
        }
        speak(state, effects, {
          persona: "priya",
          channel,
          intent: "clarify_definition",
          body: "Yeah. That's the question finance and I closed.",
          playerMessage: body,
        });
        speak(state, effects, {
          persona: "priya",
          channel,
          intent: "clarify_definition",
          body: ORDER_DEFINITION,
          playerMessage: body,
        });
        speak(state, effects, {
          persona: "priya",
          channel,
          intent: "clarify_definition",
          body: "MO-3 is on the board with that rule. I still won't write the query.",
          playerMessage: body,
          reaction: "👍",
        });
      } else if (event.channel === "meeting:kt" && state.kt.status !== "live") {
        speak(state, effects, {
          persona: "priya",
          channel: "meeting:kt",
          intent: "kt_closed",
          body: "Join the meeting first. It's on your calendar. I'll take questions once we're in there.",
          playerMessage: body,
        });
      } else {
        if (event.channel === "meeting:kt") noteKtQuestion(state, effects, body);
        if ((kind === "status" || kind === "suggestion") && state.statusCredits < 4) {
          state.statusCredits += 1;
          bump(state, effects, "priya", 2, kind === "status" ? "status update" : "suggestion");
        }
        replyTo(state, effects, event.channel, body);
      }
      break;
    }
    case "query": {
      leaveReceive(state);
      state.lastQueryAtSim = state.simNow;
      for (const table of event.tables) {
        if (!state.queriedTables.includes(table)) state.queriedTables.push(table);
      }
      const followsError = state.lastQueryFailed;
      effects.push({
        type: "telemetry",
        name: "query_run",
        payload: {
          ok: event.ok,
          tables: event.tables,
          sqlHash: event.signal?.sqlHash ?? null,
          durationMs: event.signal?.durationMs ?? null,
          rowsReturned: event.signal?.rowsReturned ?? null,
          rowsScannedEstimate: event.signal?.rowsScannedEstimate ?? null,
          errorClass: event.signal?.errorClass ?? (event.ok ? null : "engine"),
          engine: event.signal?.engine ?? "postgres",
          followsError: event.signal?.followsError ?? followsError,
          profiling: event.signal?.profiling ?? false,
          truncated: event.signal?.truncated ?? false,
          capApplied: event.signal?.capApplied ?? false,
        },
      });
      if (event.signal?.profiling) {
        effects.push({
          type: "telemetry",
          name: "schema_explored",
          payload: { kind: "profiling_query", tables: event.tables, sqlHash: event.signal.sqlHash },
        });
      }
      state.lastQueryFailed = !event.ok;
      if (!event.ok) {
        effects.push({
          type: "telemetry",
          name: "error_returned",
          payload: { message: event.errorMessage ?? "" },
        });
      } else {
        finishExplore(state, effects);
      }
      break;
    }
    case "open_ticket": {
      leaveReceive(state);
      const ticket = findTicket(state, event.ticketId);
      if (!ticket?.released) return { state: input, effects: [], error: "That ticket isn't on the board yet." };
      if (ticket.status === "ready") ticket.status = "in_progress";
      notePriority(state, effects, ticket.id);
      if (once(state, `opened:${ticket.id}`)) {
        effects.push({ type: "telemetry", name: "ticket_opened", payload: { ticketId: ticket.id } });
      }
      break;
    }
    case "submit": {
      leaveReceive(state);
      const submitted = findTicket(state, event.ticketId);
      if (submitted?.released) notePriority(state, effects, submitted.id);
      if (event.ticketId === "definition") {
        return { state: input, effects: [], error: "Ask Priya what counts as an order. This ticket isn't a table." };
      }
      if (event.ticketId === "explore") {
        finishExplore(state, effects);
        const ticket = findTicket(state, "explore");
        if (ticket?.status !== "done") {
          speak(state, effects, {
            persona: "priya",
            channel: "dm:priya",
            intent: "verdict_fail",
            body: "Not yet. I need a successful query on both `raw_orders` and `raw_events`.",
          });
        }
        break;
      }
      if (event.ticketId === "clean") {
        if (!state.hidden.orderDefinitionUnlocked) {
          return { state: input, effects: [], error: "Settle the order definition with Priya before submitting the table." };
        }
        const verdict = applyVerdict(
          state,
          effects,
          "clean",
          event.grade,
          "priya",
          "`clean_orders` checks out. Unique orders, refunds and cancellations are out, timestamps are UTC, and the constraints are real.",
        );
        if ("error" in verdict && verdict.error) return { state: input, effects: [], error: verdict.error };
        if (event.grade.passed) {
          state.cleanOrdersPassed = true;
          release(state, effects, "pipeline");
          bump(state, effects, "jonah", 2, "clean orders respected the landing zone");
          speak(state, effects, {
            persona: "sam",
            channel: "dm:sam",
            intent: "table_landed",
            body: "Saw `clean_orders` land. I have finished the churn wiring. I need `churn_features` from your pipeline next — the contract is on MO-4. I won't write the step.",
          });
        }
        break;
      }
      if (event.ticketId === "pipeline") {
        const verdict = applyVerdict(
          state,
          effects,
          "pipeline",
          event.grade,
          "sam",
          "`churn_features` and `daily_revenue` match what we asked for, and the daily run is real.",
        );
        if ("error" in verdict && verdict.error) return { state: input, effects: [], error: verdict.error };
        if (event.grade.passed) {
          if (!state.pipelineEverSucceeded) {
            state.pipelineEverSucceeded = true;
            state.pipelineSucceededAtSim = state.simNow;
          }
          bump(state, effects, "riley", 4, "dashboard table landed");
          speak(state, effects, {
            persona: "riley",
            channel: "dm:riley",
            intent: "dashboard_hookup",
            body: "I have finished the dashboard hookup. If these `daily_revenue` numbers hold through the exec meeting I'll buy the coffee. Ping me if a late file shows up — it always does.",
          });
        }
        break;
      }
      if (event.ticketId === "cohort") {
        if (!state.cohort.active) return { state: input, effects: [], error: "Repeat purchase cohorts isn't on the board yet." };
        const verdict = applyVerdict(
          state,
          effects,
          "cohort",
          event.grade,
          "priya",
          "`repeat_cohorts` matches `clean_orders`. That's the whole stub sprint.",
        );
        if ("error" in verdict && verdict.error) return { state: input, effects: [], error: verdict.error };
        if (event.grade.passed) state.cohort.completed = true;
        break;
      }
      if (event.ticketId === "break") {
        if (state.breakStatus === "pending") {
          return { state: input, effects: [], error: "Nothing has broken yet." };
        }
        const verdict = applyVerdict(
          state,
          effects,
          "break",
          event.grade,
          "riley",
          "The tables match a fresh read of the landing zone, including the late file.",
        );
        if ("error" in verdict && verdict.error) return { state: input, effects: [], error: verdict.error };
        if (event.grade.passed) {
          state.breakFixed = true;
          state.breakStatus = "fixed";
          if (state.pressureOpen) {
            state.pressureOpen = false;
            effects.push({
              type: "telemetry",
              name: "pressure_window_end",
              payload: { trigger: "injected_break", recovered: true },
            });
          }
          const breakTicket = findTicket(state, "break");
          if (breakTicket && !state.handoff?.passed) {
            breakTicket.status = "in_progress";
            const prior = breakTicket.lastVerdict?.summary ?? "The tables match the landing zone.";
            breakTicket.lastVerdict = {
              passed: true,
              summary: `${prior} I still need the handoff note on MO-5 before I can close the project.`,
              atSim: state.simNow,
            };
          }
          effects.push({ type: "telemetry", name: "break_fixed", payload: {} });
          bump(state, effects, "sam", 4, "features caught up after the late file");
          maybeComplete(state, effects);
        }
        break;
      }
      return { state: input, effects: [], error: "Unknown ticket." };
    }
    case "save_pipeline": {
      leaveReceive(state);
      const prev = JSON.stringify(state.pipeline.steps.map((s) => ({ name: s.name, sql: s.sql })));
      const steps: PipelineStep[] = event.steps.map((step, index) => ({
        id: step.id || `step${index + 1}`,
        name: step.name.trim() || `Step ${index + 1}`,
        sql: step.sql,
      }));
      const next = JSON.stringify(steps.map((s) => ({ name: s.name, sql: s.sql })));
      state.pipeline.steps = steps;
      state.pipeline.schedule = event.schedule.cadence === "daily" ? event.schedule : DEFAULT_SCHEDULE;
      state.pipeline.enabled = steps.length > 0 && steps.every((s) => s.sql.trim().length > 0);
      if (prev !== next) {
        for (const step of steps) {
          effects.push({
            type: "telemetry",
            name: "pipeline_step_created",
            payload: { stepId: step.id, name: step.name },
          });
        }
      }
      break;
    }
    case "pipeline_finished": {
      state.seq += 1;
      state.runs.unshift({
        id: `run${state.seq}`,
        atSim: state.simNow,
        ok: event.ok,
        trigger: event.trigger,
        logs: event.logs,
      });
      state.runs = state.runs.slice(0, 20);
      effects.push({
        type: "telemetry",
        name: "pipeline_run",
        payload: { ok: event.ok, trigger: event.trigger },
      });
      if (event.ok && !state.pipelineEverSucceeded) {
        state.pipelineEverSucceeded = true;
        state.pipelineSucceededAtSim = state.simNow;
      }
      break;
    }
    case "submit_handoff": {
      if (state.breakStatus === "pending") {
        return { state: input, effects: [], error: "The handoff opens when the late file lands." };
      }
      const graded = gradeHandoff(event.body);
      state.handoff = {
        body: event.body,
        score: graded.score,
        total: graded.total,
        passed: graded.passed,
        missing: graded.missing,
        atSim: state.simNow,
      };
      effects.push({
        type: "telemetry",
        name: "handoff_submitted",
        payload: { score: graded.score, total: graded.total, passed: graded.passed },
      });
      if (!graded.passed) {
        speak(state, effects, {
          persona: "priya",
          channel: "dm:priya",
          intent: "handoff_fail",
          body: `The note isn't ready to hand to the next person. Still missing: ${graded.missing.join("; ")}. Standing doesn't move on a draft.`,
        });
      } else if (!state.breakFixed) {
        speak(state, effects, {
          persona: "priya",
          channel: "dm:priya",
          intent: "handoff_early",
          body: "The note is useful. The tables still don't match the landing zone after the late file, so I can't close the project yet.",
        });
      } else {
        speak(state, effects, {
          persona: "priya",
          channel: "dm:priya",
          intent: "handoff_pass",
          body: `Handoff holds (${graded.score}/${graded.total}). I'm closing the project.`,
        });
        maybeComplete(state, effects);
      }
      break;
    }
    case "choose_next": {
      if (!state.projectCompleted) return { state: input, effects: [], error: "Finish this project first." };
      if (event.projectId !== NEXT_PROJECT.id) return { state: input, effects: [], error: "That project isn't offered." };
      if (state.cohort.active) return { state: input, effects: [], error: "Repeat purchase cohorts is already on the board." };
      state.nextProjectChosen = event.projectId;
      state.cohort.active = true;
      const cohort = findTicket(state, "cohort");
      if (cohort) cohort.dueAt = addMinutes(state.simNow, 8 * 60);
      release(state, effects, "cohort");
      effects.push({ type: "telemetry", name: "next_project_chosen", payload: { projectId: event.projectId } });
      speak(state, effects, {
        persona: "priya",
        channel: "dm:priya",
        intent: "next_project",
        body: `Repeat purchase cohorts is a short sprint on this same database, not a new company. RC-1 is on the board: build \`repeat_cohorts\` from \`clean_orders\`. One row per customer, \`order_count\`, and \`repeat_buyer\` when that count is at least 2. The rest of the brief is not staffed. Standing carries.`,
      });
      break;
    }
    case "join_kt": {
      const error = deliverKt(state, effects);
      if (error) return { state: input, effects: [], error };
      break;
    }
    case "complete_kt": {
      if (state.kt.status !== "live") return { state: input, effects: [], error: "Join the knowledge transfer first." };
      state.kt.status = "done";
      effects.push({
        type: "telemetry",
        name: "kt_completed",
        payload: { questionsAsked: state.kt.questionsAsked, topics: state.kt.topicsCovered },
      });
      speak(state, effects, {
        persona: "priya",
        channel: "meeting:kt",
        intent: "kt_wrap",
        body: "Good. That's the transfer. Ping me if a definition is fuzzy. I still won't write the query.",
        reaction: "👍",
      });
      break;
    }
    case "abandon": {
      if (state.projectCompleted) return { state: input, effects: [], error: "The project is already complete." };
      state.abandoned = true;
      effects.push({ type: "telemetry", name: "session_abandoned", payload: { stage: state.stage } });
      break;
    }
    default:
      break;
  }

  recomputeStage(state);
  void isAccessLocked(0);
  return { state, effects };
}

export function assertNeverLocksAccess(): boolean {
  return isAccessLocked(0) === false && isAccessLocked(100) === false;
}
