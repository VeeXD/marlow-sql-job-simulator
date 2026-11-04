"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SchemaPayload, Session } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Preview = {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  offset: number;
  limit: number;
  total: number;
  browseCap: number;
  sort: string;
  dir: "asc" | "desc";
  readOnly: boolean;
};

type ProfileColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  rows: number;
  nulls: number;
  nullPct: number;
  distinct: number;
  min: string | null;
  max: string | null;
  mean: number | null;
  median: number | null;
  top: { value: string; n: number }[];
  histogram: { label: string; n: number }[];
};

type Profile = { table: string; rows: number; columns: ProfileColumn[]; readOnly: boolean };

function cell(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SchemaBrowser({
  session,
  selected,
  onSelect,
}: {
  session: Session;
  selected: string | null;
  onSelect: (table: string) => void;
}) {
  const [schema, setSchema] = useState<SchemaPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "profile">("preview");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<SchemaPayload>(`/api/sessions/${session.id}/schema`, session.token)
      .then((payload) => {
        if (!cancelled) setSchema(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not read the schema.");
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.token]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const path =
      tab === "preview"
        ? `/api/sessions/${session.id}/tables/${encodeURIComponent(selected)}/preview?offset=0`
        : `/api/sessions/${session.id}/tables/${encodeURIComponent(selected)}/profile`;
    api<Preview | Profile>(path, session.token)
      .then((payload) => {
        if (cancelled) return;
        if (tab === "preview") setPreview(payload as Preview);
        else setProfile(payload as Profile);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not read the table.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, tab, session.id, session.token]);

  async function loadPreview(offset: number, sort: string, dir: "asc" | "desc") {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await api<Preview>(
        `/api/sessions/${session.id}/tables/${encodeURIComponent(selected)}/preview?offset=${offset}&sort=${encodeURIComponent(sort)}&dir=${dir}`,
        session.token,
      );
      setPreview(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the table.");
    } finally {
      setLoading(false);
    }
  }

  const live = new Set(schema?.tables.map((table) => table.table) ?? []);
  const shown = Math.min(preview?.total ?? 0, preview?.browseCap ?? 500);

  return (
    <div data-tour="tour-preview" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(schema?.tables ?? []).map((table) => (
          <button
            key={table.table}
            type="button"
            onClick={() => {
              setTab("preview");
              onSelect(table.table);
            }}
            className={`rounded-md border px-2 py-1 font-mono text-xs ${selected === table.table ? "border-[#464EB8] bg-[#e8ebfa]" : "border-line"}`}
          >
            {table.table}
          </button>
        ))}
        {(schema?.tables ?? []).length === 0 ? <p className="text-sm text-muted">Reading tables…</p> : null}
      </div>
      {selected ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm">{selected}</h3>
            {live.has(selected) ? <Badge variant="done">in database</Badge> : null}
            {preview?.readOnly || profile?.readOnly ? <Badge variant="outline">read-only</Badge> : null}
            <Button size="sm" variant={tab === "preview" ? "default" : "outline"} onClick={() => setTab("preview")}>
              Preview
            </Button>
            <Button size="sm" variant={tab === "profile" ? "default" : "outline"} onClick={() => setTab("profile")}>
              Profile
            </Button>
          </div>
          {loading ? <p className="text-sm text-muted">Reading {selected}…</p> : null}
          {error ? <p className="text-sm text-clay">{error}</p> : null}
          {tab === "preview" && preview ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Rows {preview.offset + 1}–{preview.offset + preview.rows.length} of the first {shown}
                {preview.total > preview.browseCap ? ` (${preview.total} in the table)` : ""}. Page size {preview.limit}. The workbench cap is {preview.browseCap}.
              </p>
              <div className="max-h-72 overflow-auto rounded-md border border-line">
                <table className="min-w-full text-left text-xs">
                  <thead className="sticky top-0 bg-paper">
                    <tr>
                      {preview.columns.map((column) => (
                        <th key={column} className="px-2 py-1 font-medium">
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            onClick={() =>
                              void loadPreview(0, column, preview.sort === column && preview.dir === "asc" ? "desc" : "asc")
                            }
                          >
                            {column}
                            {preview.sort === column ? (preview.dir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, index) => (
                      <tr key={index} className="border-t border-line/70 font-mono">
                        {preview.columns.map((column) => (
                          <td key={column} className="max-w-xs truncate px-2 py-1">
                            {cell(row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={preview.offset === 0 || loading}
                  onClick={() => void loadPreview(Math.max(0, preview.offset - preview.limit), preview.sort, preview.dir)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || preview.offset + preview.rows.length >= shown}
                  onClick={() => void loadPreview(preview.offset + preview.limit, preview.sort, preview.dir)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
          {tab === "profile" && profile ? (
            <div className="max-h-96 space-y-3 overflow-auto">
              <p className="text-xs text-muted">{profile.rows} rows. Stats come from SQL on your player role.</p>
              {profile.columns.map((column) => (
                <section key={column.name} className="rounded-md border border-line p-3 text-sm">
                  <h4 className="font-mono text-xs">
                    {column.name} · {column.dataType}
                    {column.nullable ? "" : " · not null"}
                  </h4>
                  <p className="mt-1 text-xs text-muted">
                    null {column.nullPct}% · distinct {column.distinct}
                    {column.min != null ? ` · min ${column.min}` : ""}
                    {column.max != null ? ` · max ${column.max}` : ""}
                    {column.mean != null ? ` · mean ${Math.round(column.mean * 100) / 100}` : ""}
                    {column.median != null ? ` · median ${Math.round(column.median * 100) / 100}` : ""}
                  </p>
                  <div className="mt-2 flex h-14 items-end gap-1" aria-label={`${column.name} histogram`}>
                    {column.histogram.map((bin) => {
                      const peak = Math.max(1, ...column.histogram.map((item) => item.n));
                      return (
                      <div key={bin.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                        <div className="w-full rounded-sm bg-[#464EB8]" style={{ height: `${Math.max(4, (bin.n / peak) * 48)}px` }} title={`${bin.label}: ${bin.n}`} />
                        <span className="w-full truncate text-center text-[10px] text-muted">{bin.label}</span>
                      </div>
                      );
                    })}
                  </div>
                  <ul className="mt-2 space-y-0.5 text-xs text-muted">
                    {column.top.map((item) => (
                      <li key={item.value}>
                        {item.value} · {item.n}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">Click a table for a preview of the first 100 rows, or a profile of each column.</p>
      )}
    </div>
  );
}
