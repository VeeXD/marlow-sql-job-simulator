import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { referencePipelineSteps } from "@sim/engine";
import { pool } from "../src/db.js";

process.env.ENABLE_WORKER = "false";
process.env.LOG_LEVEL = "silent";
process.env.LLM_PROVIDER = "mock";
process.env.ALLOW_DEBUG_CLOCK = "true";
process.env.STATEMENT_TIMEOUT_MS = "4000";

type Dto = {
  id: string;
  token: string;
  tickets: { id: string; status: string; released: boolean; evaluationRule: string }[];
  messages: { intent: string; body: string; author: string }[];
  stage: string;
  projectCompleted: boolean;
  breakStatus: string;
  nextProjectChosen: string | null;
  orderDefinitionUnlocked: boolean;
  connection: { database: string; user: string };
  review: { nextProject: { id: string } } | null;
};

let base = "";
let close: () => Promise<void> = async () => {};
let shutdown: () => Promise<void> = async () => {};

async function api(path: string, token: string | null, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path} ${text}`);
  return body;
}

describe("project 1 happy path", () => {
  beforeAll(async () => {
    const started = await import("../src/index.js");
    const server = await started.start(0);
    base = server.url;
    close = server.close;
    shutdown = started.shutdownPool;
  });

  afterAll(async () => {
    await close();
    await shutdown();
  });

  it("plays Trustworthy orders from onboarding through the next-project offer", async () => {
    const world = await api("/api/world", null);
    expect(world.company.name).toBe("Marlow");
    expect(world.difficulties).toHaveLength(2);
    expect(world.project.id).toBe("trustworthy-orders");

    await expect(
      api("/api/sessions", null, {
        method: "POST",
        body: JSON.stringify({ playerName: "Alex Morgan", difficulty: "standard" }),
      }),
    ).rejects.toThrow(/400/);

    const created = (await api("/api/sessions", null, {
      method: "POST",
      body: JSON.stringify({ playerName: "Alex Morgan", difficulty: "standard", consent: true }),
    })) as Dto;
    const token = created.token;
    expect(created.tickets).toHaveLength(0);
    expect(created.messages.some((message) => message.intent === "welcome")).toBe(true);
    expect(created.connection.database.startsWith("sandbox_")).toBe(true);

    const kicked = (await api(`/api/sessions/${created.id}/clock`, token, {
      method: "POST",
      body: JSON.stringify({ advanceMinutes: 30 }),
    })) as Dto;
    expect(kicked.messages.some((message) => message.intent === "walkthrough")).toBe(true);
    expect(kicked.messages.some((message) => message.intent === "kickoff")).toBe(true);
    expect(kicked.tickets.map((ticket) => ticket.id)).toEqual(["explore", "definition"]);
    expect(kicked.tickets.find((ticket) => ticket.id === "definition")?.evaluationRule).toMatch(/Hidden/);

    const bad = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM not_a_table" }),
    });
    expect(bad.result.ok).toBe(false);
    expect(bad.result.error.message).toMatch(/not_a_table/);
    expect(bad.result.error.code).toBe("42P01");

    const blocked = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "DROP TABLE raw_orders" }),
    });
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.error.message).toMatch(/read-only/);

    const capped = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT generate_series(1, 800) AS n" }),
    });
    expect(capped.result.ok).toBe(true);
    expect(capped.result.statements[0].rows).toHaveLength(500);
    expect(capped.result.statements[0].truncated).toBe(true);

    await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*) FROM raw_orders" }),
    });
    const explored = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*) FROM raw_events" }),
    });
    expect(explored.session.tickets.find((ticket: { id: string }) => ticket.id === "explore").status).toBe("done");

    const vague = (await api(`/api/sessions/${created.id}/chat`, token, {
      method: "POST",
      body: JSON.stringify({ channel: "dm:priya", body: "what should I do next?" }),
    })) as Dto;
    expect(vague.orderDefinitionUnlocked).toBe(false);

    const unlocked = (await api(`/api/sessions/${created.id}/chat`, token, {
      method: "POST",
      body: JSON.stringify({
        channel: "dm:priya",
        body: "Should refunded and cancelled orders be excluded from clean_orders?",
      }),
    })) as Dto;
    expect(unlocked.orderDefinitionUnlocked).toBe(true);
    expect(unlocked.tickets.map((ticket) => ticket.id)).toContain("clean");
    expect(unlocked.messages.some((message) => message.body.includes("ROW_NUMBER"))).toBe(false);

    const steps = referencePipelineSteps().map((step, index) => ({ id: `s${index}`, name: step.name, sql: step.sql }));
    await api(`/api/sessions/${created.id}/pipeline`, token, {
      method: "PUT",
      body: JSON.stringify({
        steps,
        schedule: { cadence: "daily", hour: 6, minute: 0, timezone: "America/Los_Angeles" },
      }),
    });
    await api(`/api/sessions/${created.id}/pipeline/run`, token, { method: "POST" });
    const clean = (await api(`/api/sessions/${created.id}/tickets/clean/submit`, token, { method: "POST" })) as Dto;
    expect(clean.tickets.find((ticket) => ticket.id === "clean")?.status).toBe("done");
    expect(clean.tickets.map((ticket) => ticket.id)).toContain("pipeline");

    const pipeline = (await api(`/api/sessions/${created.id}/tickets/pipeline/submit`, token, { method: "POST" })) as Dto;
    expect(pipeline.tickets.find((ticket) => ticket.id === "pipeline")?.status).toBe("done");

    const broken = (await api(`/api/sessions/${created.id}/clock`, token, {
      method: "POST",
      body: JSON.stringify({ advanceMinutes: 150 }),
    })) as Dto;
    expect(broken.breakStatus).toBe("active");
    expect(broken.tickets.map((ticket) => ticket.id)).toContain("break");
    const late = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*)::int AS n FROM raw_orders WHERE source_file = 'orders_2024_06_late.csv'" }),
    });
    expect(Number(late.result.statements.at(-1).rows[0].n)).toBeGreaterThan(0);
    const promo = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT column_name FROM information_schema.columns WHERE table_name = 'raw_orders' AND column_name = 'promo_code'",
      }),
    });
    expect(promo.result.statements.at(-1).rows).toHaveLength(1);
    const spike = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT COUNT(*)::int AS n FROM raw_orders WHERE source_file = 'orders_2024_06_null_spike.csv'",
      }),
    });
    expect(Number(spike.result.statements.at(-1).rows[0].n)).toBeGreaterThan(0);

    await api(`/api/sessions/${created.id}/pipeline/run`, token, { method: "POST" });
    const fixed = (await api(`/api/sessions/${created.id}/tickets/break/submit`, token, { method: "POST" })) as Dto;
    expect(fixed.breakStatus).toBe("fixed");
    expect(fixed.projectCompleted).toBe(false);

    const note =
      "clean_orders keeps the latest load, drops duplicates, excludes refunds and cancellations, and stores UTC timestamps. The daily pipeline rebuilds churn_features and daily_revenue. A late file landed after a run and had to be folded back in before the exec meeting.";
    const done = (await api(`/api/sessions/${created.id}/handoff`, token, {
      method: "POST",
      body: JSON.stringify({ body: note }),
    })) as Dto;
    expect(done.projectCompleted).toBe(true);
    expect(done.stage).toBe("judged");
    expect(done.review?.nextProject.id).toBe("repeat-purchase-cohorts");

    const next = (await api(`/api/sessions/${created.id}/next-project`, token, {
      method: "POST",
      body: JSON.stringify({ projectId: "repeat-purchase-cohorts" }),
    })) as Dto;
    expect(next.nextProjectChosen).toBe("repeat-purchase-cohorts");
    expect(next.stage).toBe("next");
    expect(next.tickets.map((ticket) => ticket.id)).toContain("cohort");

    await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({
        sql: `CREATE TABLE repeat_cohorts AS
SELECT customer_id, COUNT(*)::int AS order_count, (COUNT(*) >= 2) AS repeat_buyer
FROM clean_orders GROUP BY customer_id;
ALTER TABLE repeat_cohorts ADD PRIMARY KEY (customer_id);`,
      }),
    });
    const cohort = (await api(`/api/sessions/${created.id}/tickets/cohort/submit`, token, { method: "POST" })) as Dto & {
      cohort: { completed: boolean };
    };
    expect(cohort.tickets.find((ticket) => ticket.id === "cohort")?.status).toBe("done");
    expect(cohort.cohort.completed).toBe(true);

    const events = (await api(`/api/sessions/${created.id}/telemetry`, token)) as {
      event_name: string;
      scenario_version: string;
      seed: string;
      wall_time: string;
      sim_time: string;
      payload: { sqlHash?: string };
    }[];
    const names = new Set(events.map((event) => event.event_name));
    for (const required of [
      "project_started",
      "onboarding_complete",
      "query_run",
      "error_returned",
      "chat_message_sent",
      "clarifying_question_asked",
      "pipeline_step_created",
      "pipeline_run",
      "break_detected",
      "break_fixed",
      "deliverable_submitted",
      "verdict",
      "standing_change",
      "handoff_submitted",
      "project_completed",
      "next_project_chosen",
      "consent_recorded",
      "clarifying_question",
      "pressure_window_start",
      "pressure_window_end",
      "schema_explored",
      "message_sent",
      "deadline_event",
    ]) {
      expect(names.has(required), required).toBe(true);
    }
    const queryRun = events.find((event) => event.event_name === "query_run");
    expect(queryRun?.payload.sqlHash).toBeTruthy();
    expect(queryRun?.scenario_version).toBe("marlow-commerce-2024-06");
    expect(queryRun?.seed).toBe("seed-v1");
    expect(queryRun?.wall_time).toBeTruthy();
    expect(queryRun?.sim_time).toBeTruthy();

    const grouped = (await api(`/api/sessions/${created.id}/signals`, token)) as {
      experimental: boolean;
      scored: boolean;
      label: string;
      dimensions: { id: string; eventCount: number; events: unknown[]; score?: number }[];
    };
    expect(grouped.experimental).toBe(true);
    expect(grouped.scored).toBe(false);
    expect(grouped.label).toMatch(/Experimental/);
    expect(grouped.dimensions).toHaveLength(6);
    for (const dimension of grouped.dimensions) {
      expect(dimension).not.toHaveProperty("score");
      expect(dimension.eventCount).toBe(dimension.events.length);
    }

    const slept = await api(`/api/sessions/${created.id}/query`, token, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT pg_sleep(5)" }),
    });
    expect(slept.result.ok).toBe(false);
    expect(slept.result.error.message.toLowerCase()).toMatch(/statement timeout|canceling statement/);

    await pool.query(`DROP DATABASE IF EXISTS ${created.connection.database}`);
    await pool.query(`DROP ROLE IF EXISTS ${created.connection.user}`);
  });
});
