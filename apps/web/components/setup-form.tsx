"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api, readStoredSession } from "@/lib/api";
import type { Difficulty, World } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { SystemNote } from "@/components/system-note";
import { Input } from "@/components/ui/input";

export function SetupForm() {
  const router = useRouter();
  const [world, setWorld] = useState<World | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("Alex Morgan");
  const [difficulty, setDifficulty] = useState<Difficulty>("guided");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [hasDesk, setHasDesk] = useState(false);
  const [consent, setConsent] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      setWorld(await api<World>("/api/world", null));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load Marlow.");
    }
  }

  useEffect(() => {
    setHasDesk(Boolean(readStoredSession()));
    void load();
  }, []);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api<{ id: string; token: string }>("/api/sessions", null, {
        method: "POST",
        body: JSON.stringify({ playerName: name.trim(), difficulty, consent: true }),
      });
      const { writeStoredSession } = await import("@/lib/api");
      writeStoredSession({ id: created.id, token: created.token });
      router.push("/play");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not open a desk.");
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-10 sm:px-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-pine">SQL job simulator</p>
      <h1 className="mt-2 font-serif text-4xl text-ink sm:text-5xl">Marlow</h1>
      <p className="mt-3 max-w-xl text-base leading-relaxed text-muted">
        A simulated analytics-engineer seat. One commerce company, one Postgres landing zone, one project that has to
        survive a late file. Nobody on the team will write the SQL for you.
      </p>

      {hasDesk ? (
        <p className="mt-6 flex flex-wrap gap-4 text-sm font-medium">
          <Link href="/play" className="text-pine underline-offset-4 hover:underline">
            Back to the desk you already opened
          </Link>
          {world?.signalsPage ? (
            <Link href="/signals" className="text-pine underline-offset-4 hover:underline">
              Signals (experimental)
            </Link>
          ) : null}
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-8 rounded-lg border border-clay/40 bg-card p-4">
          <p className="text-sm text-clay">{loadError}</p>
          <Button className="mt-3" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {!world && !loadError ? <p className="mt-10 text-sm text-muted">Opening the Marlow brief…</p> : null}

      {world ? (
        <form onSubmit={start} className="mt-8 space-y-6">
          <section className="rounded-lg border border-line bg-card p-5">
            <p className="text-xs uppercase tracking-wide text-muted">Industry</p>
            <h2 className="mt-1 font-serif text-2xl">{world.company.industry}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink/90">{world.company.blurb}</p>
            <p className="mt-3 text-sm text-muted">
              {world.company.role.title}, reporting to {world.company.role.reportsTo}. {world.company.role.summary}
            </p>
          </section>

          <section className="rounded-lg border border-line bg-card p-5">
            <h2 className="font-serif text-2xl">{world.project.title}</h2>
            <p className="mt-2 text-sm leading-relaxed">{world.project.summary}</p>
            <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              {world.cast.map((person) => (
                <li key={person.id} className="rounded-md bg-paper px-3 py-2">
                  <span className="font-medium">{person.name}</span>
                  <span className="block text-muted">
                    {person.role} · {person.pronouns}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <label htmlFor="name" className="text-sm font-medium">
              Name on the offer
            </label>
            <Input
              id="name"
              className="mt-2 max-w-sm"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </section>

          <fieldset>
            <legend className="text-sm font-medium">How much scaffolding</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {world.difficulties.map((option) => {
                const selected = difficulty === option.id;
                return (
                  <label
                    key={option.id}
                    className={`cursor-pointer rounded-lg border p-4 ${selected ? "border-[#464EB8] bg-[#e8ebfa]" : "border-line bg-card"}`}
                  >
                    <input
                      type="radio"
                      name="difficulty"
                      className="sr-only"
                      checked={selected}
                      onChange={() => setDifficulty(option.id)}
                    />
                    <span className="font-medium">{option.label}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-muted">{option.description}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <SystemNote>
            <label className="flex items-start gap-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                required
              />
              <span>
                Practice mode records queries, messages, and timings. Checking this also records paste size, when the
                window loses focus, and a typing-cadence summary — not the text you paste or the keys themselves.
                Experimental. Not a hiring score. Kept with the session for 90 days. Nothing deletes it automatically yet.
              </span>
            </label>
          </SystemNote>

          {submitError ? <p className="text-sm text-clay">{submitError}</p> : null}

          <Button type="submit" size="lg" disabled={submitting || name.trim().length === 0 || !consent}>
            {submitting ? "Setting up your database…" : "Sit down at the desk"}
          </Button>
        </form>
      ) : null}
    </main>
  );
}
