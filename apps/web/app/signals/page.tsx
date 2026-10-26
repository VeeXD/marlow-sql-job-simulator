"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, api, formatSim, readStoredSession } from "@/lib/api";
import { SystemNote } from "@/components/system-note";

type Evidence = {
  eventId: number | string | null;
  name: string;
  simTime: string | null;
  wallTime: string | null;
  stage: string | null;
  scenarioVersion: string | null;
  seed: string | null;
  payload: Record<string, unknown>;
};

type SignalIndex = {
  experimental: true;
  label: string;
  scored: false;
  dimensions: { id: string; label: string; eventCount: number; events: Evidence[] }[];
  integrity: Evidence[];
  other: Evidence[];
};

export default function SignalsPage() {
  const [data, setData] = useState<SignalIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) {
      setLoading(false);
      setError("Open a desk first. This page reads the session in this browser.");
      return;
    }
    api<SignalIndex>(`/api/sessions/${stored.id}/signals`, stored.token)
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setError("The signals page is off in this environment.");
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load signals.");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-4 py-8 sm:px-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-pine">Internal · dev</p>
      <h1 className="mt-2 font-serif text-4xl">Signals</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Evidence captured for this desk, grouped by the six hiring dimensions. Experimental. This page does not score,
        rank, or recommend anyone.
      </p>
      <p className="mt-3 text-sm">
        <Link href="/play" className="text-pine underline-offset-4 hover:underline">
          Back to the desk
        </Link>
      </p>

      {loading ? <p className="mt-8 text-sm text-muted">Reading the session log…</p> : null}
      {error ? <p className="mt-8 rounded-lg border border-clay/40 bg-card p-4 text-sm text-clay">{error}</p> : null}

      {data ? (
        <div className="mt-8 space-y-6">
          <SystemNote>{data.label}</SystemNote>
          {data.dimensions.map((dimension) => (
            <section key={dimension.id} className="rounded-lg border border-line bg-card p-4">
              <header className="flex items-baseline justify-between gap-3">
                <h2 className="font-serif text-2xl">{dimension.label}</h2>
                <p className="text-xs text-muted">
                  {dimension.eventCount} {dimension.eventCount === 1 ? "event" : "events"}
                </p>
              </header>
              {dimension.events.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Nothing in this dimension yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {dimension.events.map((event, index) => (
                    <EvidenceRow key={`${event.eventId ?? "e"}-${index}`} event={event} />
                  ))}
                </ul>
              )}
            </section>
          ))}
          <section className="rounded-lg border border-line bg-card p-4">
            <h2 className="font-serif text-2xl">Consent and integrity</h2>
            <p className="mt-1 text-sm text-muted">Recorded with notice. Not one of the six dimensions, and not a score.</p>
            {data.integrity.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No consent or integrity events stored.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.integrity.map((event, index) => (
                  <EvidenceRow key={`${event.eventId ?? "i"}-${index}`} event={event} />
                ))}
              </ul>
            )}
          </section>
          {data.other.length > 0 ? (
            <section className="rounded-lg border border-dashed border-line p-4">
              <h2 className="font-serif text-xl">Other stored events</h2>
              <ul className="mt-3 space-y-2">
                {data.other.map((event, index) => (
                  <EvidenceRow key={`${event.eventId ?? "o"}-${index}`} event={event} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function EvidenceRow({ event }: { event: Evidence }) {
  return (
    <li className="rounded-md bg-paper px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs">{event.name}</span>
        <span className="text-xs text-muted">{event.simTime ? formatSim(event.simTime) : "no sim time"}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {event.stage ?? "no stage"} · {event.scenarioVersion ?? "no scenario"} · {event.seed ?? "no seed"}
        {event.wallTime ? ` · wall ${event.wallTime}` : ""}
      </p>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink/80">
        {JSON.stringify(event.payload)}
      </pre>
    </li>
  );
}
