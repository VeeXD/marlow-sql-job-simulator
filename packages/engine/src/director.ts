import { isDelayFlag, isOrderDefinitionQuestion, isStatusUpdate, isSuggestion } from "./clarify.js";
import { addMinutes, minutesBetween, minutesSinceStart, SIM_START_ISO } from "./clock.js";
import { BURST_LIMIT, isAck, paceLines, PLAYER_REACTIONS, rareReaction } from "./dialogue.js";
import { gradeHandoff } from "./handoff.js";
import { glossText, redactSql } from "./prompt.js";
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
  HeldLine,
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

const PIPELINE_BODY = `Sam needs \`churn_features\` for churn (customers who stop buying). Riley needs \`daily_revenue\` for the exec chart. Build both with a pipeline: a saved list of SQL steps on a daily schedule (06:00 Pacific). A pipeline just runs those steps in order. Rebuild from the landing zone (the raw files as they arrived) every run.

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

const PIPELINE_BODY_STANDARD = `Daily pipeline (a saved list of SQL steps) at 06:00 Pacific. Rebuilt from the landing zone.

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

export function defaultNotebook(): SessionState["notebook"] {
  return {
    cells: [
      {
        id: "cell-1",
        source:
          'df = sql("SELECT * FROM raw_orders LIMIT 20")\ndf.describe()',
      },
      {
        id: "cell-2",
        source: 'write_table(df.head(10), "order_sample")\n"saved order_sample"',
      },
    ],
  };
}

export function createInitialState(input: {
  playerName: string;
  difficulty: Difficulty;
  consent?: SessionState["consent"];
  /** Guided defaults to on. Pass false to skip, true to force it on Standard. */
  tour?: boolean;
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
    held: [],
    notices: [],
    pendingReactions: [],
    explained: [],
    meetings: { kt: "scheduled", standup: "scheduled" },
    tour: {
      status: (input.tour ?? input.difficulty === "guided") ? "active" : "off",
      step: (input.tour ?? input.difficulty === "guided") ? "chat" : null,
    },
    notebook: defaultNotebook(),
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

function speak(state: SessionState, effects: Effect[], opts: HeldLine): void {
  const glossed = glossText(opts.body, state.difficulty, state.explained);
  state.explained = glossed.explained;
  const body = glossed.body;
  state.seq += 1;
  const id = `m${state.seq}`;
  state.messages.push({
    id,
    atSim: state.simNow,
    channel: opts.channel,
    author: opts.persona,
    authorName: CAST_BY_ID[opts.persona].name,
    body,
    intent: opts.intent,
    replyToId: opts.replyToId,
  });
  const topic = /^kt_([a-z0-9]+)$/.exec(opts.intent);
  if (topic && state.kt && !state.kt.topicsCovered.includes(topic[1])) {
    state.kt.topicsCovered.push(topic[1]);
    effects.push({ type: "telemetry", name: "kt_topic_covered", payload: { topic: topic[1] } });
  }
  const effect: SpeakEffect = {
    type: "speak",
    messageId: id,
    personaId: opts.persona,
    intent: opts.intent,
    allowedFacts: opts.facts ?? baseFacts(state, opts.persona),
    fallback: body,
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

function utter(
  state: SessionState,
  effects: Effect[],
  lines: HeldLine[],
  options?: { hold?: boolean; max?: number },
): void {
  const paced = paceLines(lines, options?.max ?? BURST_LIMIT, options?.hold ?? false);
  for (const line of paced.now) speak(state, effects, line);
  if (paced.later.length) state.held.push(...paced.later);
}

function releaseHeld(state: SessionState, effects: Effect[], channel: string, max: number): void {
  let left = max;
  const remain: HeldLine[] = [];
  for (const line of state.held) {
    if (left > 0 && line.channel === channel) {
      speak(state, effects, line);
      left -= 1;
    } else {
      remain.push(line);
    }
  }
  state.held = remain;
}

export const CALENDAR = [
  {
    id: "kt" as const,
    title: "Knowledge transfer",
    with: "Priya Shah",
    when: "Monday 9:20 AM PT",
    startMin: 20,
    endMin: 50,
    action: "join" as const,
  },
  {
    id: "standup" as const,
    title: "Data standup",
    with: "the commerce team",
    when: "Tuesday 9:15 AM PT",
    startMin: 24 * 60 + 15,
    endMin: 24 * 60 + 30,
    action: null,
  },
];

function pushNotice(
  state: SessionState,
  effects: Effect[],
  notice: Omit<SessionState["notices"][number], "id" | "atSim">,
): void {
  const id = `notice-${notice.meetingId}-${notice.kind}-${notice.leadMinutes ?? "missed"}`;
  if (state.notices.some((item) => item.id === id)) return;
  state.notices.push({ ...notice, id, atSim: state.simNow });
  effects.push({
    type: "telemetry",
    name: notice.kind === "meeting_missed" ? "meeting_missed" : "meeting_reminder",
    payload: { meetingId: notice.meetingId, leadMinutes: notice.leadMinutes, noticeId: id },
  });
}

function applyMeetingNotices(state: SessionState, effects: Effect[]) {
  const mins = minutesSinceStart(state.simNow);
  for (const meeting of CALENDAR) {
    const attended =
      meeting.id === "kt" ? state.kt.status !== "scheduled" || state.meetings.kt === "joined" : state.meetings.standup === "acked";
    if (attended) {
      once(state, `meet:${meeting.id}:10`);
      once(state, `meet:${meeting.id}:1`);
      once(state, `meet:${meeting.id}:missed`);
      continue;
    }
    for (const lead of [10, 1] as const) {
      if (mins >= meeting.startMin - lead && mins < meeting.endMin && once(state, `meet:${meeting.id}:${lead}`)) {
        pushNotice(state, effects, {
          kind: "meeting_soon",
          meetingId: meeting.id,
          leadMinutes: lead,
          action: meeting.action,
          body:
            lead === 10
              ? `${meeting.title} with ${meeting.with} starts in 10 minutes (${meeting.when}).`
              : `${meeting.title} with ${meeting.with} starts in 1 minute (${meeting.when}).`,
        });
      }
    }
    if (mins >= meeting.endMin && once(state, `meet:${meeting.id}:missed`)) {
      if (meeting.id === "kt") state.meetings.kt = "missed";
      else state.meetings.standup = "missed";
      pushNotice(state, effects, {
        kind: "meeting_missed",
        meetingId: meeting.id,
        leadMinutes: null,
        action: meeting.action,
        body: `You missed ${meeting.title} with ${meeting.with} (${meeting.when}). Nothing is locked. Catch up in chat, or open the notes.`,
      });
    }
  }
}

export function calendarView(state: SessionState) {
  const mins = minutesSinceStart(state.simNow);
  return CALENDAR.map((meeting) => {
    let phase: "upcoming" | "soon" | "live" | "joined" | "missed" | "done" = "upcoming";
    if (meeting.id === "kt" && state.kt.status === "done") phase = "done";
    else if (meeting.id === "kt" && state.kt.status === "live") phase = "joined";
    else if (meeting.id === "standup" && state.meetings.standup === "acked") phase = "joined";
    else if ((meeting.id === "kt" && state.meetings.kt === "missed") || (meeting.id === "standup" && state.meetings.standup === "missed")) {
      phase = "missed";
    } else if (mins >= meeting.endMin) phase = "missed";
    else if (mins >= meeting.startMin) phase = "live";
    else if (mins >= meeting.startMin - 10) phase = "soon";
    return {
      id: meeting.id,
      title: meeting.title,
      with: meeting.with,
      when: meeting.when,
      startAt: addMinutes(SIM_START_ISO, meeting.startMin),
      endAt: addMinutes(SIM_START_ISO, meeting.endMin),
      phase,
      action: meeting.action,
    };
  });
}

function deliverDueReactions(state: SessionState) {
  const now = Date.parse(state.simNow);
  const waiting = [];
  for (const item of state.pendingReactions) {
    if (Date.parse(item.atSim) > now) {
      waiting.push(item);
      continue;
    }
    const message = state.messages.find((entry) => entry.id === item.messageId);
    if (!message || message.author !== "player") continue;
    message.reactions = message.reactions ?? [];
    if (message.reactions.some((reaction) => reaction.author === item.persona)) continue;
    message.reactions.push({ emoji: item.emoji, author: item.persona, atSim: state.simNow });
  }
  state.pendingReactions = waiting;
}

function scheduleReaction(state: SessionState, messageId: string, persona: PersonaId | null, body: string) {
  if (!persona) return;
  if (body.trim().length < 12) return;
  if (!rareReaction(messageId)) return;
  state.pendingReactions.push({
    messageId,
    persona,
    emoji: "👍",
    atSim: addMinutes(state.simNow, 6),
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
  utter(state, effects, [
    {
      persona: "priya",
      channel: "dm:priya",
      intent: "project_review",
      body: `${state.playerName}, that's the project. I can defend the orders table, the daily pipeline, and the late file.`,
    },
    {
      persona: "priya",
      channel: "dm:priya",
      intent: "project_review",
      body: `Standing sits with me at ${state.standing.priya}, Jonah at ${state.standing.jonah}, Sam at ${state.standing.sam}, Riley at ${state.standing.riley}. Next up is ${NEXT_PROJECT.title}. Say the word and I'll put RC-1 on this board.`,
    },
  ]);
}

function applyTimeTriggers(state: SessionState, effects: Effect[]) {
  applyMeetingNotices(state, effects);
  const mins = minutesSinceStart(state.simNow);
  if (mins >= TIMELINE.walkthroughMin && once(state, "walkthrough")) {
    state.onboarding.walkthrough = true;
    utter(state, effects, [
      {
        persona: "jonah",
        channel: "team",
        intent: "walkthrough",
        body: `${state.playerName} — I own two raw tables, \`raw_orders\` and \`raw_events\`. They are file drops, not a cleaned model.`,
      },
      {
        persona: "jonah",
        channel: "team",
        intent: "walkthrough",
        body: "Expect a repeated `order_id`, empty values, and clocks that disagree. `ordered_at` is timestamptz, and `ordered_at_local` is Pacific wall time with no zone. Your session is UTC. The ERD lists the columns.",
      },
      {
        persona: "jonah",
        channel: "team",
        intent: "walkthrough",
        body: "I have not finished the catalog refresh. It is still running. I won't write the clean layer.",
      },
    ]);
  }
  if (mins >= TIMELINE.kickoffMin && once(state, "kickoff")) {
    state.onboarding.kickoff = true;
    state.kickoffAtSim = state.simNow;
    release(state, effects, "explore");
    release(state, effects, "definition");
    effects.push({ type: "telemetry", name: "onboarding_complete", payload: {} });
    utter(state, effects, [
      {
        persona: "priya",
        channel: "dm:priya",
        intent: "kickoff",
        body: "Board's up. This project is Trustworthy orders. Start with MO-1, then MO-2.",
      },
      {
        persona: "priya",
        channel: "dm:priya",
        intent: "kickoff",
        body: "I won't sign a table until we agree what an order is. Ask me in your own words. Don't guess.",
      },
    ]);
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
      body: "I'm sketching the churn model on a sample. Honestly, I have not finished the churn wiring. No `churn_features` yet, and I won't invent it.",
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
      body: "Checking in. MO-1 has been quiet. Even a couple of counts on `raw_orders` and `raw_events` would show the shape of the mess.",
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
    utter(
      state,
      effects,
      [
        { persona: "riley", channel: "dm:riley", intent: "break_ping", body: "Hey. The exec chart looks wrong." },
        {
          persona: "riley",
          channel: "dm:riley",
          intent: "break_ping",
          body: "It still shows the old numbers, and finance has refunds from this morning that I don't. A late file may have landed after your run. Can you look? I can't fix `daily_revenue` from here.",
        },
      ],
      { max: 2 },
    );
    utter(
      state,
      effects,
      [
        {
          persona: "jonah",
          channel: "dm:jonah",
          intent: "break_schema",
          body: "Heads up. `raw_orders` grew a `promo_code` column, and the same drop has empty `amount_cents` values.",
        },
        {
          persona: "jonah",
          channel: "dm:jonah",
          intent: "break_schema",
          body: "I won't rewrite your steps. Don't trust column order.",
        },
      ],
      { max: 2 },
    );
    utter(
      state,
      effects,
      [
        {
          persona: "priya",
          channel: "dm:priya",
          intent: "break_assign",
          body: "Riley's ping is MO-5. Rebuild from the landing zone, then leave a handoff note the next person can trust.",
        },
        {
          persona: "priya",
          channel: "dm:priya",
          intent: "break_assign",
          body: "Being late costs standing, not access.",
        },
      ],
      { max: 2 },
    );
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
      "Marlow sells home goods direct: linens, lighting, and kitchen tools. Say go on when you want the next point.",
      "Finance stopped trusting the Thursday revenue chart. That's why this seat exists.",
    ],
  },
  {
    id: "project",
    lines: [
      "The project is Trustworthy orders. One clean table the company will sign, then a daily feed for the model and the chart, then a late file after you think you're done.",
      "Grain means what one row stands for. The clean table's grain is one row per real order.",
    ],
  },
  {
    id: "landscape",
    lines: [
      "The data lives in Postgres. Jonah's files are `raw_orders` and `raw_events`. Your session time zone is UTC.",
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
      "This week: learn the raw files, agree what an order is with me, build the clean table, put a daily run under Sam and Riley, and write a handoff when something breaks.",
      "That daily run is a small pipeline, not a full ETL tool. ETL means extract, transform, load: pull the file, clean it, and publish a table.",
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
  state.meetings.kt = "joined";
  effects.push({ type: "telemetry", name: "kt_joined", payload: {} });
  const lines: HeldLine[] = [];
  for (const topic of KT_TOPICS) {
    topic.lines.forEach((body, index) => {
      lines.push({
        persona: "priya",
        channel: "meeting:kt",
        intent: index === 0 ? `kt_${topic.id}` : `kt_${topic.id}_cont`,
        body,
      });
    });
  }
  utter(state, effects, lines, { hold: true, max: 3 });
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
  if (persona === "jonah") return "Hey. Is this about the raw files, or something else?";
  if (persona === "sam") return "Hey. If this is about `churn_features`, I'm listening. I won't write the step.";
  if (persona === "riley") return "Hey. If the chart looks weird, say which day. I won't write SQL.";
  return "Hey. What are you stuck on?";
}

function generic(persona: PersonaId): string {
  if (persona === "jonah") return "Ask me about the files. Which column, which reload, or which clock. The ERD lists `raw_orders` and `raw_events`. I won't write the transform.";
  if (persona === "sam") return "I only read `churn_features`. If a number looks wrong, tell me the `as_of_date` you built. I won't write the step.";
  if (persona === "riley") return "I look at `daily_revenue` by day. If you're unsure what an order is, that's Priya. I'm the chart, not the definition.";
  return "Okay so — which decision are you stuck on? I can unblock a definition. I won't write the SQL.";
}

function replyTo(state: SessionState, effects: Effect[], channel: string, body: string, replyToId?: string) {
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
    text = "Save an ordered list of SQL steps and run it daily. People sometimes call that list a DAG. Sam reads `churn_features`. Riley reads `daily_revenue`. The column contract is on the ticket. We are not standing up another scheduler.";
  } else if (/refund|cancel/.test(t) && state.hidden.orderDefinitionUnlocked) {
    intent = "hint_rule";
    text = `We already settled it. ${ORDER_DEFINITION}`;
  } else if (/refund|cancel/.test(t)) {
    intent = "hint_rule_locked";
    text = "Refunds and cancellations are in the landing zone on purpose. If you want the rule for `clean_orders`, ask Priya whether those orders belong in the table. I won't guess it.";
  }
  utter(
    state,
    effects,
    [
      {
        persona,
        channel: targetChannel,
        intent,
        body: text,
        playerMessage: body,
        replyToId,
      },
    ],
    { max: 2 },
  );
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
  if (!state.held) state.held = [];
  if (!state.notices) state.notices = [];
  if (!state.pendingReactions) state.pendingReactions = [];
  if (!state.explained) state.explained = [];
  if (!state.meetings) state.meetings = { kt: "scheduled", standup: "scheduled" };
  if (!state.tour) {
    state.tour = {
      status: state.difficulty === "guided" ? "active" : "off",
      step: state.difficulty === "guided" ? "chat" : null,
    };
  }
  if (!state.notebook?.cells?.length) state.notebook = defaultNotebook();
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
      "react",
      "tour",
      "ack_meeting",
      "save_notebook",
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
      if (state.tour.status === "active") {
        effects.push({
          type: "telemetry",
          name: "tour_started",
          payload: { auto: state.difficulty === "guided", step: state.tour.step },
        });
        effects.push({ type: "telemetry", name: "tour_step", payload: { step: state.tour.step, surface: "desk" } });
      }
      utter(
        state,
        effects,
        [
          {
            persona: "priya",
            channel: "dm:priya",
            intent: "welcome",
            body: `Hey ${state.playerName}. I'm Priya. I lead the data team.`,
            intact: true,
          },
          {
            persona: "priya",
            channel: "dm:priya",
            intent: "welcome",
            body: "Your knowledge transfer is on the calendar at 9:20 AM Pacific. Join from the reminder. I still won't write the SQL.",
            intact: true,
          },
        ],
        { max: 2 },
      );
      break;
    }
    case "tick": {
      state.simNow = event.simNow;
      state.lastRealSyncAt = event.realNow;
      state.clockPaused = event.paused;
      deliverDueReactions(state);
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
      const playerMessageId = `m${state.seq}`;
      state.messages.push({
        id: playerMessageId,
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
          messageId: playerMessageId,
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
            messageId: playerMessageId,
          },
        });
      }
      if (kind === "suggestion") {
        effects.push({
          type: "telemetry",
          name: "suggestion_made",
          payload: {
            messageId: playerMessageId,
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
            messageId: playerMessageId,
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
          messageId: playerMessageId,
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
            payload: { messageId: playerMessageId, length: body.length, topic: "definition" },
          });
        }
        scheduleReaction(state, playerMessageId, "priya", body);
        utter(state, effects, [
          {
            persona: "priya",
            channel,
            intent: "clarify_definition",
            body: "Yeah. That's the question finance and I closed. Refunded orders and cancelled orders stay out of the clean table.",
            playerMessage: body,
            replyToId: playerMessageId,
          },
          {
            persona: "priya",
            channel,
            intent: "clarify_definition",
            body: ORDER_DEFINITION,
            playerMessage: body,
            intact: true,
          },
          {
            persona: "priya",
            channel,
            intent: "clarify_definition",
            body: "MO-3 is on the board with that rule. I still won't write the query.",
            playerMessage: body,
          },
        ]);
      } else if (
        isAck(body) &&
        state.held.some((line) => line.channel === event.channel) &&
        (event.channel !== "meeting:kt" || state.kt.status === "live")
      ) {
        releaseHeld(state, effects, event.channel, 2);
      } else if (event.channel === "meeting:kt" && state.kt.status !== "live") {
        speak(state, effects, {
          persona: "priya",
          channel: "meeting:kt",
          intent: "kt_closed",
          body: "Join the meeting first. It's on your calendar at 9:20. I'll take questions once we're in there.",
          playerMessage: body,
          replyToId: playerMessageId,
        });
      } else {
        if (event.channel === "meeting:kt" && !isAck(body)) noteKtQuestion(state, effects, body);
        if ((kind === "status" || kind === "suggestion") && state.statusCredits < 4) {
          state.statusCredits += 1;
          bump(state, effects, "priya", 2, kind === "status" ? "status update" : "suggestion");
        }
        scheduleReaction(state, playerMessageId, personaFor(event.channel, body), body);
        replyTo(state, effects, event.channel, body, playerMessageId);
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
      state.held = state.held.filter((line) => line.channel !== "meeting:kt");
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
      });
      break;
    }
    case "react": {
      const message = state.messages.find((item) => item.id === event.messageId);
      if (!message) return { state: input, effects: [], error: "That message isn't in the thread." };
      if (!PLAYER_REACTIONS.includes(event.emoji as (typeof PLAYER_REACTIONS)[number])) {
        return { state: input, effects: [], error: "That reaction isn't available." };
      }
      message.reactions = message.reactions ?? [];
      const existing = message.reactions.findIndex((reaction) => reaction.author === "player" && reaction.emoji === event.emoji);
      if (existing >= 0) message.reactions.splice(existing, 1);
      else message.reactions.push({ emoji: event.emoji, author: "player", atSim: state.simNow });
      effects.push({
        type: "telemetry",
        name: "reaction_added",
        payload: { messageId: message.id, emoji: event.emoji, author: "player", removed: existing >= 0 },
      });
      break;
    }
    case "ack_meeting": {
      if (event.meetingId !== "standup") return { state: input, effects: [], error: "That meeting can't be marked that way." };
      state.meetings.standup = "acked";
      effects.push({ type: "telemetry", name: "meeting_acked", payload: { meetingId: "standup" } });
      break;
    }
    case "tour": {
      if (event.action === "skip") {
        state.tour.status = "skipped";
        effects.push({ type: "telemetry", name: "tour_skipped", payload: { step: state.tour.step } });
        break;
      }
      if (event.action === "complete") {
        state.tour.status = "completed";
        effects.push({ type: "telemetry", name: "tour_completed", payload: { step: state.tour.step } });
        state.tour.step = null;
        break;
      }
      const step = event.step || state.tour.step || "chat";
      state.tour.status = "active";
      state.tour.step = step;
      if (event.action === "replay") {
        effects.push({ type: "telemetry", name: "tour_replayed", payload: { step } });
      } else if (event.action === "start") {
        effects.push({ type: "telemetry", name: "tour_started", payload: { auto: false, step } });
      }
      effects.push({ type: "telemetry", name: "tour_step", payload: { step, surface: "desk" } });
      break;
    }
    case "save_notebook": {
      if (event.cells.length > 40) return { state: input, effects: [], error: "Too many notebook cells." };
      state.notebook = {
        cells: event.cells.map((cell, index) => ({
          id: cell.id.trim().slice(0, 40) || `cell-${index + 1}`,
          source: cell.source.slice(0, 20_000),
        })),
      };
      if (state.notebook.cells.length === 0) state.notebook = defaultNotebook();
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
