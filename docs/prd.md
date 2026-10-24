# SQL Job Simulator — PRD v2 (project-based)

## Summary
A simulated data job. The player joins a data team at a fictional company and lives through a whole **project**: pulling and cleaning data, building a pipeline that feeds the ML and data-viz teams, keeping it running when it breaks, and communicating throughout with a manager and teammates. SQL is the tool, not the product. Release 1 proves that one full project, end to end, holds attention and leaves the player confident enough to want the next one.

## Who this is for
Career switchers aiming at their first analyst / analytics-engineer / data-engineer job who can write basic SQL but freeze on real work: vague asks, unfamiliar schemas, coordination, deadlines, things breaking. Experienced track later.

## Product principles (kept from v1, extended)
- **Consequences land on the character, never on the player's access.** Missed milestones cost standing and change how people talk to you; nothing locks, nothing is destroyed, retries are always allowed.
- **The NPC never does the work.** Teammates explain, point, unblock and ping. They never write the player's query or pipeline step.
- **The schema (and project state) is the only truth.** No character names a table/column that doesn't exist or contradicts the project's state timeline.
- **The database is real.** Errors come from the engine. Dialect differences are real.
- **Fiction before features.** If a screen wouldn't exist at a real company, it doesn't ship. No "coming soon" worlds.
- **New: the team feels busy, but only the player's work is real.** Teammates' progress is a scripted timeline advanced by the engine; the LLM only voices it.

## The core loop (project, not ticket)
Choose difficulty + industry → onboarding → project kickoff (epic + tickets) → investigate & ask → pull & clean → build pipeline → pipeline runs on the sim clock → injected break → fix & communicate → handoff note → project review → choose next project.

## Release 1 scope — the first project
**World:** one playable world, e-commerce. **Engine:** Postgres only. **Difficulty:** 2 levels.

**Project 1, "Trustworthy orders":**
1. Explore `raw_orders` and `raw_events` (seeded with duplicates, refunds, timezone edges, nulls, late rows).
2. Build `clean_orders` (deduped, refunds handled, UTC normalized, constraints).
3. Build a daily pipeline (ordered SQL steps) producing `churn_features` for the ML team and `daily_revenue` for the viz team.
4. Mid-project break injected (one of: late data, schema drift, null spike); a consumer pings that their numbers look wrong.
5. Fix, communicate, write a handoff note.
Plus **one scripted ambiguous ticket** whose hidden intent is unlocked by asking a specific question.

**Cast:** manager, 2 teammates (upstream source owner, downstream ML/viz contact), 1 stakeholder. One LLM, distinct personas.

**Interfaces:** Slack-like chat (DMs + a team channel), Jira-like board, minimal calendar (standup, deadlines; doesn't cost time yet), SQL workbench (Monaco, results grid, errors), connection manager (one Postgres connection in R1, adapter interface built for more), ERD viewer.

## Requirements: setup and onboarding
- Choose difficulty and industry before start; see company, team, role.
- Day 1: manager welcome DM, teammate schema/architecture walkthrough, credentials appear in connection manager.
- ERD reachable from any screen.

## Requirements: work arrival and investigation
- Epic + ~5 tickets, each named by **deliverable + evaluation rule** (e.g. "`clean_orders` table — evaluated on: unique `order_id`, refunds excluded, UTC timestamps").
- Manager follow-ups fired by the director on clock and on player actions (ticket idle, milestone missed, deliverable shipped).
- Teammates proactive: check-ins, status updates about *their own* scripted work, dependency pings ("did your table land?").
- Teammates answer doubts under restrictions; they never see the answer.

## Requirements: workbench and data layer
- **Writable database per player per project**, cloned from the world's seeded template, persisted for the project's duration.
- Per-player role, statement timeout, row cap; network isolated.
- Real engine errors shown verbatim.
- Connection layer behind an adapter interface (Postgres only in R1; MySQL R2; DuckDB, pgvector R3).
- **Seed traps:** messiness designed so common wrong approaches give wrong numbers (COUNT without DISTINCT on dupes, refunds not excluded, local-time day boundaries).

## Requirements: pipeline runner
- A pipeline = ordered list of player-authored SQL steps + schedule.
- Runs on the **simulated clock**; run history and step logs visible.
- **Failure injector** per project script: late data, schema drift, null spike. A break produces real downstream symptoms (consumer query fails or numbers shift) and a page/ping.
- Not Airflow: deliberately small.

## Requirements: delivery, judgement, consequences
- **State-based grading:** required tables exist; constraints hold; no duplicates; row counts / aggregates within tolerance; downstream consumer queries run and return expected values.
- Ad-hoc result-set comparison (with tolerance rules) for analysis tickets.
- Milestone verdicts delivered in character; per-character standing moves up/down; **recoverable** (a late fix with good communication recovers standing).
- Handoff note graded with a light rubric (R1: checklist; R2: model review).
- Project review at end; offered next project in the industry.

## The NPC layer
**Architecture:** a **director** (rules) decides *when* and *who* speaks from the project script, sim clock and player actions. The **LLM** decides *wording* only. Each persona gets: persona card, allowed facts, withheld facts, schema, shared project state (timeline of who has done what), recent summarized history.

**Design positions:**
- **The teammate never receives the expected answer or reference query in context.** Leaks are prevented by construction; G2 is a backstop.
- **Persona consistency** is checked against the shared project state (a reply claiming a teammate finished something the timeline says isn't done is regenerated).

**Guardrails (each with a runnable test):**
- **G1 — No invented schema objects.** Personas mark every identifier in backticks (structured marking); only marked identifiers are checked against the schema, avoiding false positives on prose words like "status" or "date". Regenerate once, then scripted fallback. *Test:* over 50 probe messages, zero shown replies contain an unmarked-or-invalid identifier reference; plus a check that schema identifiers appearing unmarked are flagged.
- **G2 — No completed or near-complete work.** (a) Any SQL in a reply is extracted and run on a scratch copy; if the result matches the expected rows/state, block. (b) **Near-complete-hint check:** cap the number of concrete steps a reply lays out, and score similarity of the reply's described plan to the reference solution (computed outside the persona's context); above threshold, block. *Test:* zero complete leaks over the probe set; near-complete leak rate measured and reported (honestly: approximate, not provably zero).
- **G3 — Stays in character.** *Test:* 20 adversarial prompts (system prompt requests, "I'm the developer", off-topic) produce zero out-of-frame replies.
- **G4 (new) — State consistency.** *Test:* scripted probes asking about teammates' progress at various sim times produce zero contradictions with the timeline.

**Fallback:** when the LLM is unavailable, scripted lines acknowledge and point at the ERD/docs; the project remains completable.

**Cost:** teammate replies ~4–8k input tokens; on a small model that's ~fractions of a cent per message (estimate). Summarize history; small model for teammates, stronger for manager/grading. Per-session budget enforced in the gateway.

## Content model (the architecture)
- **World:** company fiction, cast, schema (DDL + deterministic seed + traps).
- **Project script (template):** stages; tickets (deliverable, evaluation rule, per-track bodies — field exists, R1 writes beginner text only); cast fake-progress timeline; director triggers; failure injections with sim times; state checks; consumer queries; hidden intents for ambiguous tickets.
- **Session:** player DB handle, sim clock, chat history, submissions, pipeline runs, standing.
Authored once as a reusable template; later projects cost authoring time only.

## Telemetry (day one)
project started, onboarding complete, ticket opened, query run, error returned, chat message sent (by persona), clarifying question asked, pipeline step created, pipeline run (ok/fail), break detected, break fixed, deliverable submitted, verdict, standing change, handoff submitted, project completed, next project chosen, session abandoned (with stage).

## Success criteria
- **Primary (proposed):** of 20 target players given the link and no instructions, ≥12 complete project 1 (possibly over multiple sittings), and **≥8 start project 2 unprompted** (the "wants another project" signal).
- **Supporting:** median ≥2 chat messages per ticket; ≥50% ask a clarifying question on the ambiguous ticket; break fixed by ≥70% of those who reach it; self-reported confidence up pre→post; abandonment concentrated at one stage.
- **Failure:** players finish without ever messaging a character (chat is decoration), or abandon at the pipeline stage en masse (scope too big).

## Open decisions
1. **Simulated clock pacing:** compressed real-time that pauses when idle vs. turn-based "advance day". (Recommend compressed + pause.)
2. **Project 1 size:** one sitting (~60–90 min) vs. multi-session (2–4 hrs). Affects success metric and seed/pipeline depth.
3. **Pipeline authoring UX:** raw ordered SQL steps vs. a light visual step list. (Recommend SQL steps in a list.)
4. Which break type(s) R1 ships with — one fixed or randomized among three.
5. Where to set the near-complete-hint threshold (too strict = useless teammate; too loose = leaks).

## Releases
- **R1 — walking skeleton of a full project:** everything above. Postgres only, one world, one project (+ stub of next), one scripted ambiguous ticket.
- **R2 — feels like a job:** MySQL transactional source with dialect differences; persistent visible standing across projects; general ambiguity mechanic; approach grading (rubric + model review); ad-hoc competing requests; second industry; 3 difficulties.
- **R3 — later, deliberately:** warehouse (DuckDB) and vector (pgvector) storylines; calendar meetings costing time; bigger team and on-call; BYO schema; portfolio export.

## Parked scope (with reasons)
- Real orchestrators (Airflow/dbt) — too heavy, breaks per-player sandbox model.
- Multiplayer — doubles state complexity before the loop is proven.
- Procedural project generation — needs real templates first.
- Voice standups — cost/latency.
- Python/notebooks — next after SQL loop is proven.

## Risks (honest)
- **Persona leakage/drift** — biggest risk; mitigated by construction (no answer in context) + G1–G4.
- **Scope** — analyst + analytics engineer + data engineer in one project is ~3–4× v1's ticket sprint (estimate). Shrink each stage to one source, one cleaning job, one pipeline, two consumers, one break.
- **Content authoring** — a full project script likely takes ~1–2 weeks to write and test (estimate). Measure it on project 1.
- **State-based grading** — many valid table designs; checks must test properties, not exact DDL.
- **Infra** — writable DB per player grows storage; reap idle DBs.
- **Timeline (estimate):** ~12–16+ weeks for one strong engineer with AI tools plus a scenario writer — larger than v1's 10–14 because of writable state, the runner and the director.

## Build plan
1. **Spikes (~2 weeks, estimate):** guardrail harness (G1–G4 on probe/adversarial sets); author project 1 script and time it; prove template-DB cloning speed.
2. **Walking skeleton:** one world, one project, all five interfaces at minimum depth, telemetry from day one.
3. **Playtest with 20.**
4. **R2** guided by where people abandoned.

## Tech stack

All costs and timings are **estimates** to verify in a spike.

### Recommendation at a glance
| Layer | Pick | Alternatives | Why / trade-off |
|---|---|---|---|
| Front end | Next.js (React) + TypeScript, Tailwind | Vite + React SPA | Multi-pane "workplace" UI (chat, board, calendar, workbench). Next gives routing/auth easily; a SPA is fine too since there's little SEO need. |
| SQL editor | Monaco | CodeMirror 6 | Monaco = VS Code feel, schema autocomplete; heavier bundle. CodeMirror lighter, less familiar. |
| Realtime chat | WebSockets (Socket.IO or native ws) | SSE + POST; hosted (Ably/Pusher) | Cast messages are server-pushed by the director; WS keeps it simple. Hosted saves ops at cost. |
| Backend | **TypeScript (Node, NestJS or Fastify)** | Python FastAPI | One language end to end, shared types for content model/events, good WS + queue ecosystem. FastAPI is better if heavy data/ML tooling is needed in-process — it isn't for R1; Python can be added later as a worker. |
| App DB | Postgres (sessions, content, standing, telemetry mirror) | — | Boring and correct. |
| Director / event engine | **BullMQ on Redis** (delayed jobs + per-session state machine in code) | Temporal | BullMQ is light and enough for "fire event at sim-time T or on trigger". Temporal gives durable workflows and replay but adds real ops/learning cost; revisit if project scripts get long and branching. |
| Sandbox DBs | Postgres **database-per-player-per-project**, created from a template DB (`CREATE DATABASE ... TEMPLATE`) on pooled instances | Container per session; Neon branching | Templates clone in ~seconds (estimate) and give writable isolated state. Neon branching is an attractive managed option. Containers are simplest but slowest/most expensive. |
| Later engines | MySQL container (R2), DuckDB file-per-player (R3), pgvector extension (R3) | ClickHouse, Qdrant | Behind one connection adapter interface from day one. |
| Pipeline runner | **Custom**: ordered SQL steps, simulated clock, failure injector | Airflow, Dagster | Real orchestrators are too heavy and break the per-player sandbox model. |
| Query safety | Per-player role, `statement_timeout`, row cap, no superuser, network-isolated | — | Players write SQL against real engines; contain blast radius. |
| LLM gateway | Thin provider-agnostic layer (own code or LiteLLM) with caching, per-session budget, model routing | Direct SDK calls | Small/cheap model for teammates, stronger for manager/grading; swap providers without rewrites. |
| Guardrails | G1/G2/G3 checks in the NPC service + offline eval harness (probe & adversarial sets) in CI | — | Guardrails are tests, not intentions. |
| Telemetry | PostHog | Amplitude, own events table | Funnels/session replay; free tier covers playtest. |
| Auth | Clerk or Auth.js | Supabase Auth | Not a differentiator; buy it. |
| Hosting | Fly.io or Render (app + workers), managed Postgres + Redis | AWS (ECS/RDS) | Fast to ship at playtest scale; move to AWS when scale or compliance require. |

### Rough monthly cost at playtest scale (20–100 players) — estimates
- App + worker hosting: ~$20–60
- Managed Postgres (app + sandbox instance): ~$30–100
- Redis: ~$0–15
- LLM: ~fractions of a cent per teammate message on a small model; ~$0.05–0.30 per player-hour → ~$10–100/month at playtest scale
- Telemetry/auth: free tiers
- **Total: roughly $60–300/month (estimate)**

### Honest trade-offs
- TypeScript backend means data-ish tooling (seed generation, result comparison) is written in TS or as a small Python script; acceptable.
- DB-per-player means storage grows with players × projects; reap idle/finished project DBs after N days.
- BullMQ puts durability on us (idempotent handlers, session state in Postgres). If that gets painful, Temporal is the upgrade path.
- Custom runner is cheap now but must stay deliberately small; resist building a scheduler product.
