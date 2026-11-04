"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Session } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { SystemNote } from "@/components/system-note";
import { Textarea } from "@/components/ui/textarea";

const PYODIDE_VERSION = "0.27.5";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

type Cell = { id: string; source: string };
type Frame = { columns: string[]; rows: Record<string, unknown>[] };
type Output = { text: string; error?: string; frame?: Frame; images: string[] };

type PyodideApi = {
  loadPackage: (names: string[]) => Promise<void>;
  globals: { set: (name: string, value: unknown) => void; get: (name: string) => unknown };
  runPythonAsync: (code: string) => Promise<unknown>;
};

declare global {
  interface Window {
    loadPyodide?: (opts: { indexURL: string }) => Promise<PyodideApi>;
  }
}

const BOOTSTRAP = `
import io, sys, json, base64
import pandas
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

nb_images = []

def _show(*args, **kwargs):
    buf = io.BytesIO()
    plt.savefig(buf, format="png", bbox_inches="tight")
    plt.close("all")
    nb_images.append(base64.b64encode(buf.getvalue()).decode("ascii"))

plt.show = _show

def sql(query):
    payload = json.loads(sqlSync(str(query)))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error") or "Query failed.")
    return pandas.DataFrame(payload.get("rows") or [])

def write_table(df, name):
    columns = [{"name": str(col), "dtype": str(df[col].dtype)} for col in list(df.columns)]
    safe = df.astype(object).where(df.notna(), None)
    rows = json.loads(safe.to_json(orient="values", date_format="iso"))
    payload = json.loads(writeTableSync(json.dumps({"name": str(name), "columns": columns, "rows": rows})))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error") or "Write failed.")
    return payload.get("table")

nb_text = ""
nb_frame = None

def run_cell(source):
    global nb_text, nb_frame
    import ast
    tree = ast.parse(source)
    body = list(tree.body)
    glob = globals()
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        value = None
        if body and isinstance(body[-1], ast.Expr):
            last = body.pop()
            if body:
                exec(compile(ast.Module(body=body, type_ignores=[]), "<cell>", "exec"), glob)
            value = eval(compile(ast.Expression(body=last.value), "<cell>", "eval"), glob)
        else:
            exec(compile(tree, "<cell>", "exec"), glob)
        nb_text = buf.getvalue()
        if hasattr(value, "to_json"):
            nb_frame = value.head(40).to_json(orient="split", date_format="iso")
        elif value is not None:
            nb_text += "" if nb_text.endswith("\\n") or nb_text == "" else "\\n"
            nb_text += str(value)
            nb_frame = None
        else:
            nb_frame = None
    finally:
        sys.stdout = old
`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.loadPyodide) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.getAttribute("data-loaded") === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Python.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.setAttribute("data-loaded", "1");
      resolve();
    };
    script.onerror = () => reject(new Error("Could not load Python. The notebook downloads it the first time you open this tab."));
    document.head.appendChild(script);
  });
}

export function NotebookPane({
  session,
  active,
  onSession,
}: {
  session: Session;
  active: boolean;
  onSession: (mine: number, session: Session) => void;
}) {
  const [cells, setCells] = useState<Cell[]>(session.notebook?.cells ?? []);
  const [outputs, setOutputs] = useState<Record<string, Output>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const pyodide = useRef<PyodideApi | null>(null);
  const saveTimer = useRef<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (session.notebook?.cells?.length) setCells(session.notebook.cells);
  }, [session.notebook]);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    let cancelled = false;
    setStatus("loading");
    setLoadError(null);
    (async () => {
      try {
        await loadScript(`${PYODIDE_BASE}pyodide.js`);
        if (!window.loadPyodide) throw new Error("Python did not start.");
        const runtime = await window.loadPyodide({ indexURL: PYODIDE_BASE });
        await runtime.loadPackage(["pandas", "matplotlib"]);
        runtime.globals.set("sqlSync", (query: string) => sqlSync(session.id, session.token, query));
        runtime.globals.set("writeTableSync", (payload: string) => writeSync(session.id, session.token, payload));
        await runtime.runPythonAsync(BOOTSTRAP);
        if (cancelled) return;
        pyodide.current = runtime;
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setLoadError(err instanceof Error ? err.message : "Could not load Python.");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (!pyodide.current) started.current = false;
    };
  }, [active, session.id, session.token]);

  function updateCell(id: string, source: string) {
    const next = cells.map((cell) => (cell.id === id ? { ...cell, source } : cell));
    setCells(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persist(next);
    }, 500);
  }

  async function persist(next: Cell[]) {
    try {
      const value = await api<Session>(`/api/sessions/${session.id}/notebook`, session.token, {
        method: "PUT",
        body: JSON.stringify({ cells: next }),
      });
      onSession(0, value);
    } catch {
      // The next successful save stores the cells. A failed save leaves them on screen.
    }
  }

  async function runCell(cell: Cell) {
    const runtime = pyodide.current;
    if (!runtime) return;
    setRunning(cell.id);
    const callsSql = /\bsql\s*\(/.test(cell.source);
    const callsWrite = /\bwrite_table\s*\(/.test(cell.source);
    let ok = true;
    try {
      runtime.globals.set("cell_source", cell.source);
      await runtime.runPythonAsync("run_cell(cell_source)");
      const printed = String(runtime.globals.get("nb_text") ?? "");
      const frameJson = runtime.globals.get("nb_frame");
      const images = runtime.globals.get("nb_images") as { toJs?: () => string[] } | undefined;
      const imageList = images?.toJs?.() ?? [];
      let frame: Frame | undefined;
      if (typeof frameJson === "string" && frameJson) {
        const raw = JSON.parse(frameJson) as { columns: string[]; index: unknown[]; data: unknown[][] };
        const columns = ["", ...raw.columns];
        frame = {
          columns,
          rows: raw.data.map((row, index) => {
            const record: Record<string, unknown> = { "": raw.index[index] };
            raw.columns.forEach((column, columnIndex) => {
              record[column] = row[columnIndex];
            });
            return record;
          }),
        };
      }
      setOutputs((current) => ({
        ...current,
        [cell.id]: {
          text: printed,
          frame,
          images: imageList.map((item) => `data:image/png;base64,${item}`),
        },
      }));
      await runtime.runPythonAsync("nb_images = []\nnb_frame = None");
    } catch (err) {
      ok = false;
      setOutputs((current) => ({
        ...current,
        [cell.id]: { text: "", error: err instanceof Error ? err.message : String(err), images: [] },
      }));
    } finally {
      setRunning(null);
      void api(`/api/sessions/${session.id}/notebook/run`, session.token, {
        method: "POST",
        body: JSON.stringify({ cellId: cell.id, ok, callsSql, callsWrite }),
      }).catch(() => undefined);
    }
  }

  async function runAll() {
    for (const cell of cells) {
      await runCell(cell);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-serif text-2xl">Notebook</h2>
          <p className="text-sm text-muted">Python runs in this browser. sql() uses your player role. write_table saves into your schema, not the raw files.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={status !== "ready" || running != null} onClick={() => void runAll()}>
            Run all
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCells((current) => [...current, { id: `cell-${Date.now()}`, source: "" }])}
          >
            Add cell
          </Button>
        </div>
      </div>
      {status === "loading" || status === "idle" ? (
        <SystemNote>Loading Python, pandas, and matplotlib. The first open downloads them into this tab. Later opens reuse that copy.</SystemNote>
      ) : null}
      {status === "error" ? <SystemNote>{loadError}</SystemNote> : null}
      {cells.map((cell, index) => {
        const output = outputs[cell.id];
        return (
          <section key={cell.id} className="rounded-md border border-line bg-card">
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
              <span>In [{index + 1}]</span>
              <Button size="sm" disabled={status !== "ready" || running != null} onClick={() => void runCell(cell)}>
                {running === cell.id ? "Running…" : "Run"}
              </Button>
            </div>
            <Textarea
              value={cell.source}
              onChange={(event) => updateCell(cell.id, event.target.value)}
              className="min-h-28 rounded-none border-0 font-mono text-xs"
              spellCheck={false}
            />
            {output ? (
              <div className="space-y-2 border-t border-line p-3 text-sm">
                {output.error ? <pre className="whitespace-pre-wrap text-xs text-clay">{output.error}</pre> : null}
                {output.text ? <pre className="whitespace-pre-wrap font-mono text-xs">{output.text}</pre> : null}
                {output.frame ? (
                  <div className="max-h-64 overflow-auto">
                    <table className="min-w-full text-left text-xs">
                      <thead>
                        <tr>
                          {output.frame.columns.map((column) => (
                            <th key={column} className="px-2 py-1 font-medium">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {output.frame.rows.map((row, rowIndex) => (
                          <tr key={rowIndex} className="border-t border-line/70 font-mono">
                            {output.frame?.columns.map((column) => (
                              <td key={column} className="px-2 py-1">
                                {row[column] == null ? "" : String(row[column])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {output.images.map((src) => (
                  <img key={src.slice(0, 48)} src={src} alt="matplotlib plot" className="max-w-full" />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function sqlSync(sessionId: string, token: string, query: string): string {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/sessions/${sessionId}/query`, false);
  xhr.setRequestHeader("content-type", "application/json");
  xhr.setRequestHeader("authorization", `Bearer ${token}`);
  xhr.send(JSON.stringify({ sql: query, notebook: true }));
  if (xhr.status < 200 || xhr.status >= 300) {
    return JSON.stringify({ ok: false, error: xhr.responseText || `HTTP ${xhr.status}` });
  }
  const body = JSON.parse(xhr.responseText) as {
    result?: { ok: boolean; error?: { message: string } | null; statements?: { fields: string[]; rows: Record<string, unknown>[] }[] };
  };
  const statement = body.result?.statements?.at(-1);
  if (!body.result?.ok) return JSON.stringify({ ok: false, error: body.result?.error?.message || "Query failed." });
  return JSON.stringify({ ok: true, columns: statement?.fields ?? [], rows: statement?.rows ?? [] });
}

function writeSync(sessionId: string, token: string, payload: string): string {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/sessions/${sessionId}/notebook/write`, false);
  xhr.setRequestHeader("content-type", "application/json");
  xhr.setRequestHeader("authorization", `Bearer ${token}`);
  xhr.send(payload);
  if (xhr.status < 200 || xhr.status >= 300) {
    try {
      const parsed = JSON.parse(xhr.responseText) as { error?: string };
      return JSON.stringify({ ok: false, error: parsed.error || xhr.responseText });
    } catch {
      return JSON.stringify({ ok: false, error: xhr.responseText || `HTTP ${xhr.status}` });
    }
  }
  const body = JSON.parse(xhr.responseText) as { table?: string };
  return JSON.stringify({ ok: true, table: body.table });
}
