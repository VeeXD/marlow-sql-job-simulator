import { describe, expect, it } from "vitest";
import { createInitialState, reduce } from "../src/director.js";
import {
  PREVIEW_ROW_CAP,
  assertWritableTable,
  bucketLabel,
  dropCreateSql,
  previewSql,
  previewWindow,
  scalarProfileSql,
} from "../src/profile.js";
import { DESK_TOUR_IDS } from "../src/tour.js";

describe("preview and notebook tables", () => {
  it("pages inside the 500 row cap and refuses raw writes", () => {
    expect(previewWindow(0).limit).toBe(100);
    expect(previewWindow(450).limit).toBe(50);
    expect(() => previewWindow(PREVIEW_ROW_CAP)).toThrow(/500/);
    const sql = previewSql("raw_orders", { sort: "order_id", dir: "asc", offset: 100, limit: 100 });
    expect(sql).toContain('public."raw_orders"');
    expect(sql).toContain('ORDER BY "order_id" ASC');
    expect(sql).toContain("LIMIT 100 OFFSET 100");
    expect(() => previewSql("raw_orders;drop", { sort: "order_id", dir: "asc", offset: 0, limit: 100 })).toThrow();
    expect(() => assertWritableTable("raw_orders")).toThrow(/read-only/);
    expect(() => assertWritableTable("raw_events")).toThrow(/read-only/);
    const built = dropCreateSql("order_sample", [
      { name: "order_id", dtype: "int64" },
      { name: "amount", dtype: "float64" },
    ]);
    expect(built.drop).toBe('DROP TABLE IF EXISTS public."order_sample"');
    expect(built.create).toContain('"order_id" bigint');
    expect(built.create).toContain('"amount" double precision');
    expect(scalarProfileSql("raw_orders", [{ name: "amount_cents", dataType: "bigint" }])).toContain("percentile_cont");
    expect(bucketLabel(1, 0, 80)).toBe("0–10");
  });

  it("walks the desk tour from chat through grading feedback", () => {
    let state = createInitialState({ playerName: "Alex", difficulty: "guided" });
    state = reduce(state, { type: "start" }).state;
    expect(state.tour).toEqual({ status: "active", step: "chat" });
    expect(DESK_TOUR_IDS[0]).toBe("chat");
    expect(DESK_TOUR_IDS.at(-1)).toBe("feedback");
    expect(DESK_TOUR_IDS).toEqual([
      "chat",
      "kt",
      "calendar",
      "board",
      "connections",
      "preview",
      "workbench",
      "notebook",
      "run-query",
      "submit",
      "feedback",
    ]);
    for (const step of DESK_TOUR_IDS.slice(1)) {
      state = reduce(state, { type: "tour", action: "step", step }).state;
      expect(state.tour).toEqual({ status: "active", step });
    }
    state = reduce(state, { type: "tour", action: "complete" }).state;
    expect(state.tour.status).toBe("completed");
    const replayed = reduce(state, { type: "tour", action: "replay", step: "chat" });
    expect(replayed.state.tour).toEqual({ status: "active", step: "chat" });
    const saved = reduce(replayed.state, {
      type: "save_notebook",
      cells: [{ id: "cell-9", source: 'df = sql("SELECT 1 AS n")' }],
    });
    expect(saved.state.notebook.cells).toEqual([{ id: "cell-9", source: 'df = sql("SELECT 1 AS n")' }]);
  });
});