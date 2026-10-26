import { describe, expect, it } from "vitest";
import { createInitialState, reduce } from "../src/director.js";
import { applyRowCap } from "../src/sql.js";
import { nullSpikeSql, schemaDriftSql } from "../src/seed.js";
import { EXPERIMENTAL_LABEL, contentHash, errorClass, groupSignals, isProfilingQuery } from "../src/signals.js";
import type { Effect } from "../src/types.js";

function names(effects: Effect[]) {
  return effects.filter((effect) => effect.type === "telemetry").map((effect) => (effect.type === "telemetry" ? effect.name : ""));
}

function payload(effects: Effect[], name: string) {
  const found = effects.find((effect) => effect.type === "telemetry" && effect.name === name);
  if (!found || found.type !== "telemetry") throw new Error(`missing ${name}`);
  return found.payload;
}

describe("row cap", () => {
  it("pushes the cap into the read and leaves writes alone", () => {
    const open = applyRowCap("SELECT generate_series(1, 800) AS n", 500);
    expect(open.capApplied).toBe(true);
    expect(open.sql).toMatch(/LIMIT 501\s*$/);

    const small = applyRowCap("SELECT 1 LIMIT 10", 500);
    expect(small.capApplied).toBe(false);
    expect(small.sql).toBe("SELECT 1 LIMIT 10");

    const large = applyRowCap("SELECT 1 LIMIT 800", 500);
    expect(large.capApplied).toBe(true);
    expect(large.sql).toContain("LIMIT 501");
    expect(large.sql).not.toContain("800");

    const other = applyRowCap("SELECT 1 LIMIT ALL", 500);
    expect(other.capApplied).toBe(true);
    expect(other.sql).toContain("_row_cap");

    const write = applyRowCap("INSERT INTO clean_orders SELECT * FROM raw_orders", 500);
    expect(write.capApplied).toBe(false);
    expect(write.sql).not.toMatch(/LIMIT/);
  });
});

describe("signal index", () => {
  it("groups evidence and does not score it", () => {
    const grouped = groupSignals([
      {
        id: 1,
        event_name: "query_run",
        sim_time: "2024-06-03T16:00:00.000Z",
        wall_time: "2026-10-26T00:00:00.000Z",
        scenario_version: "marlow-commerce-2024-06",
        seed: "seed-v1",
        payload: { sqlHash: "abc" },
      },
      { id: 2, event_name: "clarifying_question", payload: { beforeFirstQuery: true } },
      { id: 3, event_name: "consent_recorded", payload: { retentionDays: 90 } },
    ]);
    expect(grouped.scored).toBe(false);
    expect(grouped.experimental).toBe(true);
    expect(grouped.label).toBe(EXPERIMENTAL_LABEL);
    expect(grouped.dimensions).toHaveLength(6);
    expect(grouped.dimensions.find((dimension) => dimension.id === "technical")?.eventCount).toBe(1);
    expect(grouped.dimensions.find((dimension) => dimension.id === "curiosity")?.events[0]?.payload).toMatchObject({
      beforeFirstQuery: true,
    });
    expect(grouped.integrity).toHaveLength(1);
    for (const dimension of grouped.dimensions) {
      expect(dimension).not.toHaveProperty("score");
      expect(dimension).not.toHaveProperty("percentile");
    }
  });

  it("hashes content and classifies engine errors", () => {
    expect(contentHash("same")).toBe(contentHash("same"));
    expect(contentHash("same")).not.toBe(contentHash("other"));
    expect(errorClass("57014")).toBe("statement_timeout");
    expect(errorClass("42P01")).toBe("undefined_table");
    expect(errorClass(undefined)).toBe("rejected");
    expect(isProfilingQuery("SELECT COUNT(*) FROM raw_orders")).toBe(true);
    expect(isProfilingQuery("SELECT * FROM raw_orders")).toBe(false);
  });
});

describe("hiring events on the director", () => {
  it("records a clarifying question asked before the first query", () => {
    let state = createInitialState({ playerName: "Alex", difficulty: "guided" });
    state = reduce(state, { type: "start" }).state;
    const asked = reduce(state, {
      type: "player_message",
      channel: "dm:priya",
      body: "Should refunded and cancelled orders be excluded from clean_orders?",
      wallLatencyMs: 1200,
    });
    expect(names(asked.effects)).toContain("clarifying_question");
    expect(names(asked.effects)).toContain("clarifying_question_asked");
    expect(payload(asked.effects, "clarifying_question")).toMatchObject({
      beforeFirstQuery: true,
      hiddenIntentUnlocked: true,
      ticketId: "definition",
    });
    expect(payload(asked.effects, "message_sent")).toMatchObject({ wallLatencyMs: 1200, toneFeatures: null });
    expect(names(asked.effects)).not.toContain("consent_recorded");
    const started = reduce(createInitialState({ playerName: "Alex", difficulty: "guided" }), { type: "start" });
    expect(payload(started.effects, "consent_recorded")).toMatchObject({ retentionDays: 90, practiceTelemetry: true });
    expect(payload(started.effects, "project_started")).toMatchObject({
      scenarioVersion: "marlow-commerce-2024-06",
      seed: "seed-v1",
    });
  });

  it("gives the standard track its own ticket text", () => {
    const guided = createInitialState({ playerName: "Alex", difficulty: "guided" });
    const standard = createInitialState({ playerName: "Alex", difficulty: "standard" });
    for (const id of ["explore", "definition", "clean", "pipeline", "break", "cohort"]) {
      const left = guided.tickets.find((ticket) => ticket.id === id);
      const right = standard.tickets.find((ticket) => ticket.id === id);
      expect(right?.body).toBeTruthy();
      expect(right?.body).not.toBe(left?.body);
      expect(right?.coachNotes).toBeNull();
      expect(left?.coachNotes).toBeTruthy();
    }
    const clean = standard.tickets.find((ticket) => ticket.id === "clean");
    expect(clean?.body).not.toMatch(/repeated/);
    expect(clean?.body).not.toMatch(/ordered_at_local/);
    expect(standard.tickets.find((ticket) => ticket.id === "cohort")?.key).toBe("RC-1");
  });

  it("records a suggestion, an escalation, and a priority choice", () => {
    let state = createInitialState({ playerName: "Alex", difficulty: "standard" });
    state = reduce(state, { type: "start" }).state;
    for (const id of ["explore", "definition"]) {
      const ticket = state.tickets.find((item) => item.id === id);
      if (ticket) ticket.released = true;
    }
    const opened = reduce(state, { type: "open_ticket", ticketId: "explore" });
    expect(payload(opened.effects, "priority_decision")).toMatchObject({
      chosen: "explore",
      competing: ["definition"],
    });
    const suggested = reduce(state, {
      type: "player_message",
      channel: "dm:priya",
      body: "We should add a monitor on null amounts. I'm stuck and need help.",
    });
    expect(names(suggested.effects)).toContain("suggestion_made");
    expect(payload(suggested.effects, "suggestion_made")).toMatchObject({ accepted: true, persona: "priya" });
    expect(typeof payload(suggested.effects, "suggestion_made").contentHash).toBe("string");
    expect(payload(suggested.effects, "improvement_beyond_scope")).toMatchObject({ accepted: false });
    expect(payload(suggested.effects, "escalation")).toMatchObject({ why: "player_asked_for_help", persona: "priya" });
  });

  it("injects schema drift and a null spike with the late file", () => {
    expect(schemaDriftSql()).toMatch(/promo_code/);
    expect(schemaDriftSql()).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(nullSpikeSql()).toMatch(/orders_2024_06_null_spike\.csv/);
    let state = createInitialState({ playerName: "Alex", difficulty: "guided" });
    state = reduce(state, { type: "start" }).state;
    state.pipelineEverSucceeded = true;
    state.pipelineSucceededAtSim = state.simNow;
    state.simNow = new Date(Date.parse(state.simNow) + 121 * 60_000).toISOString();
    const broken = reduce(state, { type: "tick", simNow: state.simNow, realNow: Date.now(), paused: false });
    const kinds = broken.effects.filter((effect) => effect.type === "inject_break").map((effect) => (effect.type === "inject_break" ? effect.kind : ""));
    expect(kinds).toEqual(["late_data", "schema_drift", "null_spike"]);
    expect(payload(broken.effects, "pressure_window_start")).toMatchObject({
      trigger: "injected_break",
      kinds: ["late_data", "schema_drift", "null_spike"],
    });
    expect(broken.state.pressureOpen).toBe(true);
  });
});
