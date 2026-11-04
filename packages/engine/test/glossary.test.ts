import { describe, expect, it } from "vitest";
import { GLOSSARY, glossaryEntry, glossarySpans } from "../src/glossary.js";
import { SCHEMA_CATALOG } from "../src/world.js";
import { REFERENCE_CANARY } from "../src/reference.js";

describe("glossary", () => {
  it("defines the words a new analyst meets, without the reference answer", () => {
    const ids = GLOSSARY.map((entry) => entry.id);
    for (const id of ["churn", "etl", "dag", "grain", "cohort", "join", "cte", "null", "dedupe", "backfill", "sla", "feature"]) {
      expect(ids, id).toContain(id);
    }
    const tables = new Set(SCHEMA_CATALOG.map((table) => table.table));
    for (const entry of GLOSSARY) {
      expect(entry.definition.length).toBeGreaterThan(12);
      expect(entry.definition.toLowerCase()).not.toContain("row_number");
      expect(entry.definition).not.toContain(REFERENCE_CANARY);
      if (entry.table) expect(tables.has(entry.table), entry.id).toBe(true);
      expect(glossaryEntry(entry.id)?.term).toBe(entry.term);
    }
  });

  it("marks prose terms and leaves code and SQL alone", () => {
    const churn = glossarySpans("Sam is sketching the churn model.");
    expect(churn.filter((span) => span.type === "term").map((span) => (span.type === "term" ? span.id : ""))).toEqual(["churn"]);

    const code = glossarySpans("Look at `churn_features` and `raw_orders`.");
    expect(code.some((span) => span.type === "term")).toBe(false);
    expect(code.some((span) => span.type === "code" && span.text === "churn_features")).toBe(true);

    const sql = glossarySpans("SELECT customer_id FROM churn_features JOIN raw_orders");
    expect(sql).toEqual([{ type: "sql", text: "SELECT customer_id FROM churn_features JOIN raw_orders" }]);

    const landing = glossarySpans("Start in the landing zone.");
    expect(landing.filter((span) => span.type === "term").map((span) => span.text)).toEqual(["landing zone"]);

    const deduped = glossarySpans("Those rows were deduped.");
    expect(deduped.some((span) => span.type === "term" && span.id === "dedupe")).toBe(true);
  });

  it("does not treat joining a meeting as a SQL join", () => {
    const meeting = glossarySpans("Join the knowledge transfer from the calendar reminder.");
    expect(meeting.some((span) => span.type === "term")).toBe(false);

    const sqlish = glossarySpans("Use a join when an event needs its order.");
    expect(sqlish.some((span) => span.type === "term" && span.id === "join")).toBe(true);
  });
});
