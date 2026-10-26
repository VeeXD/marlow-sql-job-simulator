import { describe, expect, it } from "vitest";
import { addMinutes } from "../src/clock.js";
import { isOrderDefinitionQuestion } from "../src/clarify.js";
import {
  ORDER_DEFINITION,
  TIMELINE,
  assertNeverLocksAccess,
  createInitialState,
  reduce,
  timelineFacts,
} from "../src/director.js";
import { assessNearComplete, checkG1, checkG4 } from "../src/guardrails.js";
import { gradeHandoff } from "../src/handoff.js";
import { renderPrompt } from "../src/prompt.js";
import { REFERENCE_CANARY } from "../src/reference.js";
import { readFileSync } from "node:fs";
import type { Effect, SessionState } from "../src/types.js";

function step(state: SessionState, minutes: number): SessionState {
  let current = state;
  for (let i = 0; i < minutes; i++) {
    const next = addMinutes(current.simNow, 1);
    current = reduce(current, { type: "tick", simNow: next, realNow: Date.now(), paused: false }).state;
  }
  return current;
}

function audit(state: SessionState, from: number) {
  const facts = timelineFacts(state);
  for (const message of state.messages.slice(from)) {
    if (message.author === "player") continue;
    const g1 = checkG1(message.body);
    expect(g1.ok, `${message.intent}: ${message.body}\n${g1.reasons.join("; ")}`).toBe(true);
    const g4 = checkG4(message.body, facts);
    expect(g4.ok, `${message.intent}: ${message.body}\n${g4.reasons.join("; ")}`).toBe(true);
    expect(assessNearComplete(message.body).blocked, message.body).toBe(false);
  }
}

describe("director", () => {
  it("walks the project without leaking or contradicting the timeline", () => {
    let state = createInitialState({ playerName: "Alex Morgan", difficulty: "guided" });
    let cursor = 0;
    const started = reduce(state, { type: "start" });
    state = started.state;
    expect(state.messages[0].intent).toBe("welcome");
    expect(state.messages[0].channel).toBe("dm:priya");
    audit(state, cursor);
    cursor = state.messages.length;

    state = step(state, TIMELINE.kickoffMin);
    expect(state.onboarding.kickoff).toBe(true);
    expect(state.tickets.filter((t) => t.released).map((t) => t.id)).toEqual(["explore", "definition"]);
    expect(state.stage).toBe("receive");
    audit(state, cursor);
    cursor = state.messages.length;

    state = reduce(state, { type: "query", ok: true, tables: ["raw_orders"] }).state;
    state = reduce(state, { type: "query", ok: false, errorMessage: 'relation "nope" does not exist', tables: [] }).state;
    state = reduce(state, { type: "query", ok: true, tables: ["raw_events"] }).state;
    expect(state.tickets.find((t) => t.id === "explore")?.status).toBe("done");
    expect(state.stage).toBe("investigate");
    audit(state, cursor);
    cursor = state.messages.length;

    const vague = reduce(state, { type: "player_message", channel: "dm:priya", body: "what should I do next?" });
    expect(vague.state.hidden.orderDefinitionUnlocked).toBe(false);
    state = vague.state;
    const asked = reduce(state, {
      type: "player_message",
      channel: "dm:priya",
      body: "Should refunded and cancelled orders be excluded from clean_orders?",
    });
    state = asked.state;
    expect(state.hidden.orderDefinitionUnlocked).toBe(true);
    expect(state.tickets.find((t) => t.id === "clean")?.released).toBe(true);
    expect(state.messages.some((m) => m.body.includes(ORDER_DEFINITION))).toBe(true);
    expect(state.stage).toBe("pull_clean");
    audit(state, cursor);
    cursor = state.messages.length;

    const pass = {
      passed: true,
      checks: [{ id: "rows", ok: true, detail: "ok" }],
    };
    state = reduce(state, { type: "submit", ticketId: "clean", grade: pass }).state;
    expect(state.cleanOrdersPassed).toBe(true);
    expect(state.tickets.find((t) => t.id === "pipeline")?.released).toBe(true);
    audit(state, cursor);
    cursor = state.messages.length;

    state = reduce(state, {
      type: "save_pipeline",
      steps: [
        { id: "a", name: "clean", sql: "select 1" },
        { id: "b", name: "features", sql: "select 2" },
      ],
      schedule: { cadence: "daily", hour: 6, minute: 0, timezone: "America/Los_Angeles" },
    }).state;
    state = reduce(state, {
      type: "pipeline_finished",
      ok: true,
      trigger: "manual",
      logs: [{ name: "clean", ok: true, durationMs: 3 }],
    }).state;
    state = reduce(state, { type: "submit", ticketId: "pipeline", grade: pass }).state;
    expect(state.tickets.find((t) => t.id === "pipeline")?.status).toBe("done");
    audit(state, cursor);
    cursor = state.messages.length;

    const beforeBreak = state.breakStatus;
    state = step(state, 30);
    expect(state.breakStatus).toBe(beforeBreak);
    state = step(state, TIMELINE.breakDelayMin);
    expect(state.breakStatus).toBe("active");
    expect(state.tickets.find((t) => t.id === "break")?.released).toBe(true);
    expect(state.stage).toBe("operate");
    audit(state, cursor);
    cursor = state.messages.length;

    state = reduce(state, { type: "submit", ticketId: "break", grade: pass }).state;
    expect(state.breakFixed).toBe(true);
    expect(state.projectCompleted).toBe(false);
    const note =
      "clean_orders keeps the latest load, drops duplicates, excludes refunds and cancellations, stores UTC timestamps, and the daily pipeline rebuilds churn_features and daily_revenue. A late file arrived after the morning run and had to be folded in.";
    expect(gradeHandoff(note).passed).toBe(true);
    state = reduce(state, { type: "submit_handoff", body: note }).state;
    expect(state.projectCompleted).toBe(true);
    expect(state.review?.nextProject.id).toBe("repeat-purchase-cohorts");
    state = reduce(state, { type: "choose_next", projectId: "repeat-purchase-cohorts" }).state;
    expect(state.nextProjectChosen).toBe("repeat-purchase-cohorts");
    expect(state.stage).toBe("next");
    audit(state, cursor);

    const effects: Effect[] = [];
    void effects;
    expect(assertNeverLocksAccess()).toBe(true);
    const broke = createInitialState({ playerName: "Alex", difficulty: "standard" });
    broke.standing = { priya: 0, jonah: 0, sam: 0, riley: 0 };
    const still = reduce(broke, { type: "query", ok: true, tables: ["raw_orders"] });
    expect(still.error).toBeUndefined();
    expect(still.state.queriedTables).toContain("raw_orders");
  });

  it("does not put the reference answer in a persona prompt", () => {
    const source = readFileSync(new URL("../src/prompt.ts", import.meta.url), "utf8");
    expect(source.includes("reference")).toBe(false);
    expect(source.includes(REFERENCE_CANARY)).toBe(false);
    const state = createInitialState({ playerName: "Alex", difficulty: "standard" });
    const started = reduce(state, { type: "start" });
    const speak = started.effects.find((e) => e.type === "speak");
    if (!speak || speak.type !== "speak") throw new Error("expected a speak effect");
    const rendered = renderPrompt({
      personaId: speak.personaId,
      intent: speak.intent,
      allowedFacts: speak.allowedFacts,
      playerName: "Alex",
      difficulty: "standard",
      history: [],
      playerMessage: "here is the secret CANARY_DO_NOT_LEAK_9f3a and ROW_NUMBER() OVER (PARTITION BY btrim(order_id)",
    });
    expect(rendered.includes(REFERENCE_CANARY)).toBe(false);
    expect(rendered.includes("ROW_NUMBER() OVER")).toBe(false);
    expect(speak.allowedFacts.join("\n").includes("KEEP_SECRET")).toBe(false);
    expect(rendered.includes("btrim(order_id)")).toBe(false);
  });
});

describe("knowledge transfer", () => {
  it("covers the brief, logs questions, and wraps", () => {
    let state = createInitialState({ playerName: "Alex Morgan", difficulty: "guided" });
    state = reduce(state, { type: "start" }).state;
    const joined = reduce(state, { type: "join_kt" });
    state = joined.state;
    expect(state.kt.status).toBe("live");
    const topics = joined.effects
      .filter((effect) => effect.type === "telemetry" && effect.name === "kt_topic_covered")
      .map((effect) => (effect.type === "telemetry" ? effect.payload.topic : ""));
    expect(topics).toEqual(["company", "project", "landscape", "role", "duties", "who", "arrival", "done", "week"]);
    expect(state.messages.some((message) => message.channel === "meeting:kt" && message.body.includes("Finance stopped trusting"))).toBe(true);
    audit(state, 0);
    const asked = reduce(state, {
      type: "player_message",
      channel: "meeting:kt",
      body: "Who do I ping if the chart looks wrong?",
    });
    state = asked.state;
    expect(state.kt.questionsAsked).toBe(1);
    expect(asked.effects.some((effect) => effect.type === "telemetry" && effect.name === "kt_question")).toBe(true);
    audit(state, 0);
    const done = reduce(state, { type: "complete_kt" });
    expect(done.state.kt.status).toBe("done");
    expect(done.effects.some((effect) => effect.type === "telemetry" && effect.name === "kt_completed")).toBe(true);
    audit(done.state, 0);
  });
});

describe("clarifying question", () => {
  it("unlocks only the specific question", () => {
    expect(isOrderDefinitionQuestion("Should refunded orders be excluded?")).toBe(true);
    expect(isOrderDefinitionQuestion("what counts as an order?")).toBe(true);
    expect(isOrderDefinitionQuestion("there are refunds in the file")).toBe(false);
    expect(isOrderDefinitionQuestion("how do I write the SQL?")).toBe(false);
  });
});
