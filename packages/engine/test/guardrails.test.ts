import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkG1, checkG4 } from "../src/guardrails.js";
import { runProbeSuite } from "../src/probes.js";
import { freshDb } from "./helpers.js";

describe("guardrail probe harness", () => {
  it("passes G1–G4 on the probe set", async () => {
    const { exec } = await freshDb();
    const report = await runProbeSuite(exec);
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ ok: true });
    expect(report.g1.probes).toBeGreaterThanOrEqual(50);
    expect(report.g1.shownViolations).toBe(0);
    expect(report.g2.completeLeaksShown).toBe(0);
    expect(report.g2.paraphrasesBlocked).toBe(report.g2.paraphrases);
    expect(report.g2.acceptableBlocked).toBe(0);
    expect(report.g3.prompts).toBe(20);
    expect(report.g3.shownOutOfFrame).toBe(0);
    expect(report.g4.shownContradictions).toBe(0);
    expect(report.g2.note.length).toBeGreaterThan(20);
  });

  it("flags unmarked schema identifiers and ignores prose words", () => {
    expect(checkG1("What is the status of the date?").ok).toBe(true);
    expect(checkG1("Look at raw_orders today.").ok).toBe(false);
    expect(checkG1("Look at `raw_orders` today.").ok).toBe(true);
    expect(checkG1("Use `fact_orders`.").ok).toBe(false);
    expect(checkG4("Jonah has finished the catalog refresh.", [
      { id: "catalog_refresh", person: "Jonah", noun: "catalog refresh", done: false },
    ]).ok).toBe(false);
    expect(checkG4("I have not finished the catalog refresh.", [
      { id: "catalog_refresh", person: "Jonah", noun: "catalog refresh", done: false },
    ]).ok).toBe(true);
  });

  it("keeps the answer out of the prompt module", () => {
    const prompt = readFileSync(new URL("../src/prompt.ts", import.meta.url), "utf8");
    const director = readFileSync(new URL("../src/director.ts", import.meta.url), "utf8");
    expect(prompt.includes("CANARY_DO_NOT_LEAK")).toBe(false);
    expect(prompt.includes("reference.js")).toBe(false);
    expect(director.includes("CANARY_DO_NOT_LEAK")).toBe(false);
    expect(director.includes("ROW_NUMBER")).toBe(false);
  });
});
