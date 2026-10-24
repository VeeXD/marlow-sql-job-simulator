import { isOrderDefinitionQuestion, isStatusUpdate, isSuggestion } from "./clarify.js";
import { addMinutes, minutesBetween, minutesSinceStart, SIM_START_ISO } from "./clock.js";
import { gradeHandoff } from "./handoff.js";
import { redactSql } from "./prompt.js";
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

export function createInitialState(input: { playerName: string; difficulty: Difficulty }): SessionState {
  const name = input.playerName.trim() || "Alex Morgan";
  const standing = { priya: 72, jonah: 72, sam: 72, riley: 72 };
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
        body: "Jonah's files are `raw_orders` and `raw_events`. They are dumps, not a model. Query both until you can describe the mess in your own words.",
        coachNotes:
          input.difficulty === "guided"
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
        body: "Finance and growth don't use the same order. I won't sign a table until the rule is written down. Ask me before you build — guessing doesn't unlock it.",
        coachNotes:
          input.difficulty === "guided"
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
        body: `Build \`clean_orders\` from the landing zone using the rule on this ticket. Put a primary key or unique constraint on \`order_id\`, and mark \`order_id\`, \`customer_id\`, \`ordered_at\`, and \`amount_cents\` NOT NULL. \`ordered_at\` is timestamptz.`,
        coachNotes:
          input.difficulty === "guided"
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
        body: PIPELINE_BODY,
        coachNotes:
          input.difficulty === "guided"
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
        body: "A file landed after a run. Riley's chart and Sam's features can drift from the landing zone when that happens. Rebuild from raw, tell them what moved, and leave a handoff note the next analyst can trust.",
        coachNotes:
          input.difficulty === "guided"
            ? "Check `source_file` for a drop you haven't seen. Then rerun the pipeline. The handoff box is on this ticket."
            : null,
        evaluationRule: BREAK_RULE,
        hiddenEvaluation: null,
        dueAt: addMinutes(SIM_START_ISO, 81 * 60),
        released: false,
      }),
    ],
    queriedTables: [],
    hidden: { orderDefinitionUnlocked: false },
    standing,
    standingLog: [],
    statusCredits: 0,
    onboarding: { welcome: false, walkthrough: false, kickoff: false },
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
    ? "You got eyes on both landing tables. It's later than I wanted, but MO-1 is done."
    : "You've queried `raw_orders` and `raw_events`. MO-1 is done. The definition ticket is the one that matters next.";
  ticket.lastVerdict = { passed: true, summary, atSim: state.simNow };
  bump(state, effects, "priya", late ? 2 : 4, late ? "explore late" : "explore on time");
  effects.push({ type: "telemetry", name: "deliverable_submitted", payload: { ticketId: "explore", passed: true } });
  effects.push({ type: "telemetry", name: "verdict", payload: { ticketId: "explore", passed: true } });
  speak(state, effects, { persona: "priya", channel: "dm:priya", intent: "verdict_explore", body: summary });
}

function maybeComplete(state: SessionState, effects: Effect[]) {
  if (state.projectCompleted || state.abandoned) return;
  if (!state.breakFixed || !state.handoff?.passed) return;
  state.projectCompleted = true;
  const summary = `${state.playerName}, that's the project. The orders table, the daily pipeline, and the late file are in a place I can defend. Standing sits with me at ${state.standing.priya}, Jonah at ${state.standing.jonah}, Sam at ${state.standing.sam}, Riley at ${state.standing.riley}. Next up in commerce is ${NEXT_PROJECT.title}. It isn't staffed yet — say the word and I'll hold your place.`;
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
  speak(state, effects, { persona: "priya", channel: "dm:priya", intent: "project_review", body: summary });
}

function applyTimeTriggers(state: SessionState, effects: Effect[]) {
  const mins = minutesSinceStart(state.simNow);
  if (mins >= TIMELINE.walkthroughMin && once(state, "walkthrough")) {
    state.onboarding.walkthrough = true;
    speak(state, effects, {
      persona: "jonah",
      channel: "team",
      intent: "walkthrough",
      body: `${state.playerName} — two landing tables, both mine: \`raw_orders\` and \`raw_events\`. File drops, not a model. Expect repeated \`order_id\`s, nulls, and clocks that disagree. \`ordered_at\` is timestamptz. \`ordered_at_local\` is Pacific wall time with no zone. Your session time zone is UTC. The ERD in the header is the column list. I have not finished the catalog refresh. It is still running. I won't write the clean layer.`,
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
      body: `Project's on the board: Trustworthy orders. Start with MO-1, then MO-2. I will not sign a table until you and I agree what an order is. Ask me. Don't guess.`,
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
      body: "Sketching the churn model on a sample. I have not finished the churn wiring. I don't have `churn_features` yet, and I won't invent it.",
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
      body: "Checking in. MO-1 has been quiet. Even a couple of counts on `raw_orders` and `raw_events` would tell us the shape of the mess.",
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
      body: "Did `clean_orders` land? I have not finished the churn wiring, and I'm blocked until that table exists. I won't write it.",
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
    release(state, effects, "break");
    effects.push({ type: "inject_break" });
    effects.push({ type: "telemetry", name: "break_detected", payload: { kind: "late_data" } });
    speak(state, effects, {
      persona: "riley",
      channel: "dm:riley",
      intent: "break_ping",
      body: "Something's off on the exec chart. It still looks like the pre-drop numbers, and finance already has refunds from this morning that I don't. A late file may have hit the landing zone after your run. Can you look? I can't fix `daily_revenue` from here.",
    });
    speak(state, effects, {
      persona: "priya",
      channel: "dm:priya",
      intent: "break_assign",
      body: "Riley's ping is the operate ticket, MO-5. Rebuild from the landing zone, then leave a handoff note. Being late costs standing, not access.",
    });
  }
}

function onceWould(state: SessionState, id: string): boolean {
  return !state.fired.includes(id);
}

function personaFor(channel: string, body: string): PersonaId | null {
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
  if (persona === "jonah") return "I won't write that query. Tell me which landing column looks wrong and what you already tried. The ERD is the map.";
  if (persona === "sam") return "I won't write that query. I only know whether `churn_features` looks stable.";
  if (persona === "riley") return "I won't write that query. I can tell you the chart looks wrong. Priya owns the definition.";
  return "I won't write that query. Tell me the decision you're stuck on and what you already tried.";
}

function generic(persona: PersonaId): string {
  if (persona === "jonah") return "Ask me about the landing files — columns, reloads, clocks. The ERD lists `raw_orders` and `raw_events`. I won't write the transform.";
  if (persona === "sam") return "I only consume `churn_features`. If a number looks wrong, tell me the `as_of_date` you built. I won't write the step.";
  if (persona === "riley") return "I look at `daily_revenue` by day. If you're unsure what an order is, that's Priya — I'm the dashboard, not the definition.";
  return "Say which decision you're stuck on. I can unblock a definition. I can't take the ticket, and I won't write the SQL.";
}

function replyTo(state: SessionState, effects: Effect[], channel: string, body: string) {
  const persona = personaFor(channel, body);
  if (!persona) return;
  const targetChannel = channel.startsWith("dm:") ? channel : persona === "priya" ? "team" : "team";
  const fact = progressFact(body, state);
  const t = body.toLowerCase();
  let intent = "ack";
  let text = generic(persona);
  if (/write (the |my )?(query|sql)|do it for me|give me the sql|write the pipeline|build it for me/.test(t)) {
    intent = "refuse_work";
    text = refuse(persona);
  } else if (fact) {
    intent = "progress";
    text = factSentence(fact);
  } else if (/duplicate|dupe|reload/.test(t)) {
    intent = "hint_dupe";
    text = "Reloads happen. The same `order_id` can land more than once, and I trust the later `loaded_at`. I won't write the dedupe.";
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
    name: "deliverable_submitted",
    payload: { ticketId, passed: grade.passed, late },
  });
  effects.push({ type: "telemetry", name: "verdict", payload: { ticketId, passed: grade.passed, late } });
  const delta = grade.passed ? (late ? 2 : 6) : -5;
  bump(state, effects, persona, delta, grade.passed ? (late ? `${ticketId} late` : `${ticketId} pass`) : `${ticketId} fail`);
  speak(state, effects, { persona, channel: `dm:${persona}`, intent: grade.passed ? "verdict_pass" : "verdict_fail", body: summary });
  return { late };
}

export function reduce(input: SessionState, event: DirectorEvent): ReduceResult {
  const state = structuredClone(input);
  const effects: Effect[] = [];
  if (state.abandoned && event.type !== "start") {
    return { state, effects, error: "This project was abandoned." };
  }
  if (state.projectCompleted && !["choose_next", "player_message", "tick", "activity"].includes(event.type)) {
    if (event.type !== "query" && event.type !== "open_ticket") {
      return { state, effects, error: "The project is already in review." };
    }
  }

  switch (event.type) {
    case "start": {
      state.onboarding.welcome = true;
      effects.push({ type: "telemetry", name: "project_started", payload: { difficulty: state.difficulty } });
      speak(state, effects, {
        persona: "priya",
        channel: "dm:priya",
        intent: "welcome",
        body: `${state.playerName} — welcome to Marlow. I'm Priya, I lead data. You're our new analytics engineer, starting on the commerce landing zone. Jonah owns the raw files. Sam and Riley are waiting on numbers they can defend. Your credentials are in Connections. The ERD sits in the header from every screen. I'll put the project on the board shortly.`,
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
      if (isOrderDefinitionQuestion(body) && !state.hidden.orderDefinitionUnlocked) {
        state.hidden.orderDefinitionUnlocked = true;
        const definition = findTicket(state, "definition");
        if (definition) {
          definition.status = "done";
          definition.evaluationRule = ORDER_DEFINITION;
          definition.lastVerdict = { passed: true, summary: ORDER_DEFINITION, atSim: state.simNow };
        }
        release(state, effects, "clean");
        effects.push({ type: "telemetry", name: "clarifying_question_asked", payload: { intent: "order_definition" } });
        effects.push({ type: "telemetry", name: "verdict", payload: { ticketId: "definition", passed: true } });
        bump(state, effects, "priya", 3, "clarified the order definition");
        const channel = event.channel.startsWith("dm:") ? event.channel : "dm:priya";
        speak(state, effects, {
          persona: "priya",
          channel,
          intent: "clarify_definition",
          body: `Good — that's the question finance and I closed. ${ORDER_DEFINITION} MO-3 is on the board with that rule. I still won't write the query.`,
          playerMessage: body,
        });
      } else {
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
      effects.push({
        type: "telemetry",
        name: "query_run",
        payload: { ok: event.ok, tables: event.tables },
      });
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
      if (once(state, `opened:${ticket.id}`)) {
        effects.push({ type: "telemetry", name: "ticket_opened", payload: { ticketId: ticket.id } });
      }
      break;
    }
    case "submit": {
      leaveReceive(state);
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
      state.nextProjectChosen = event.projectId;
      effects.push({ type: "telemetry", name: "next_project_chosen", payload: { projectId: event.projectId } });
      speak(state, effects, {
        persona: "priya",
        channel: "dm:priya",
        intent: "next_project",
        body: `I'll hold ${NEXT_PROJECT.title} for you. It isn't staffed in this release, so there's no second board yet. Your standing stays where it is.`,
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
