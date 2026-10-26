# SQL Job Simulator

Release 1 is a walking skeleton of a simulated analytics-engineer job at **Marlow**, a home-goods e-commerce company. It is one full project, not a SQL quiz. The product spec, story map, and stack notes are in `docs/`.

You get a writable Postgres database, a Jira-like board, a Slack-like thread with four people, a Monaco workbench, and a small pipeline runner on a simulated clock. The people answer under restrictions. They do not write the transform.

With `LLM_PROVIDER=mock` (the default) the whole project is playable and testable with no API key. The director decides when someone speaks. The model, when you attach one, only words the line the director already chose.

## Run with Docker

```bash
docker compose up --build
```

Open [http://localhost:3847](http://localhost:3847). That port is a proxy: the page, `/api`, and the websocket all share it.

Postgres is published on `localhost:5432` (`sim` / `sim`, database `sim`). The connection manager shows a player role and password for your sandbox database. Redis is on `localhost:6379`.

The first request creates `marlow_template` and clones it into `sandbox_<id>` owned by `player_<id>`. Landing tables are readable. The player role can create objects in `public` and cannot write `raw_orders` or `raw_events`.

## Run without Docker

You need Node 22, Postgres 16, and Redis.

```bash
createuser -s sim || true
psql -d postgres -c "ALTER USER sim PASSWORD 'sim'"
psql -d postgres -c "CREATE DATABASE sim OWNER sim"
npm ci
cp .env.example .env   # optional; the defaults match the commands above
npm run seed           # builds marlow_template; the server also does this on boot
npm run dev
```

`npm run dev` starts the API on 3848, Next.js on 3846, and the proxy on **3847**. Use 3847 in the browser. Relative `/api` calls only work through the proxy.

## Tests

```bash
npm test
```

- `npm run test:unit` — grading, the pipeline runner, and the G1–G4 probe harness. Grading runs on PGlite.
- `npm run test:e2e` — one happy path through Trustworthy orders on the local Postgres from `.env` / the defaults (`postgres://sim:sim@127.0.0.1:5432/sim`). The worker is off; the debug clock steps the project.
- `npm run probe` — the same guardrail suite as a CLI. Exits 1 if a probe fails.

## What you can do in the desk

1. Put your name on the offer and pick Guided or Standard. The only industry is e-commerce.
2. Read Priya's welcome. Jonah's schema walkthrough and the kickoff follow on the simulated clock (about a quarter of a real minute at the default speed).
3. Open the ERD from any screen. Credentials live under Connections. Test connection runs `SELECT current_user`.
4. Work the board. Tickets appear when the story releases them. MO-2 stays closed until you ask Priya, in your own words, whether refunded or cancelled orders belong in the clean table.
5. Run SQL in the workbench. Postgres errors come back with the engine message, code, detail, hint, and position. Statements that would write the landing zone are rejected before they run. Read statements are capped inside the SQL (`LIMIT` of the cap plus one, then the extra row is dropped) so Postgres does not return the rest of the result. A statement timeout cancels the query. Opening a desk requires the practice-mode notice.
6. Build `clean_orders`, then a daily pipeline that fills `churn_features` and `daily_revenue`. Save the steps and run them. Submit a ticket for a state check: the tables, the constraints, and the rows.
7. After a successful pipeline run, three things land together: a late file, a new nullable `promo_code` column on `raw_orders`, and a spike of null amounts. Rebuild and write the handoff note.
8. Priya offers Repeat purchase cohorts. Accepting it puts RC-1 on the same board: one table, `repeat_cohorts`, built from `clean_orders`. The rest of that brief is not staffed.

Guided difficulty adds margin notes on tickets and shorter idle gaps before a nudge. The contract for done is the same. Standing starts at 72 with each person, moves, and can move back. It never locks chat or the database.

The clock runs at `SIM_SPEED` simulated seconds per real second and pauses after `IDLE_PAUSE_MS` without activity. The week view does not spend meeting time.

## Architecture

```mermaid
flowchart LR
  browser[Browser on :3847]
  proxy[Proxy]
  web[Next.js workplace]
  api[Fastify API and Socket.IO]
  engine[Engine: director, grading, guardrails]
  pg[(Postgres: app DB, template, sandboxes)]
  redis[(Redis and BullMQ)]
  llm[LLM gateway]

  browser --> proxy
  proxy --> web
  proxy --> api
  api --> engine
  api --> pg
  api --> redis
  api --> llm
```

| Piece | Where | Role |
| --- | --- | --- |
| Workplace | `apps/web` | Setup, board, chat, Monaco workbench, pipeline, week, ERD, connections |
| API | `apps/server` | Sessions, sandbox clone, queries, pipeline, sockets |
| Engine | `packages/engine` | Pure director, seed, grading, guardrails, LLM gateway |
| Proxy | `apps/server/src/proxy.ts` | One public port for the page, API, and websocket |
| Worker | `apps/server/src/worker.ts` | BullMQ scan every 2 seconds so the clock moves with the tab closed |

A session row holds the director state as JSON. Reads and writes take `SELECT … FOR UPDATE`. The director is a pure reducer: it returns the next state plus effects (telemetry, a line to word, a break to inject). The server performs the effects. Persona prompts are built from allowed facts and the real schema. They do not import the reference SQL.

Each player gets `CREATE DATABASE … TEMPLATE marlow_template` and a login role with `statement_timeout` and `timezone=UTC`. Queries are split on the client side of the engine (quotes, comments, and dollar quotes respected). `SET`, `COPY`, role changes, functions, and writes to `raw_orders` / `raw_events` are rejected. Other SQL hits Postgres as written.

The pipeline runner executes saved steps in order on that same role and stops at the first error. A daily schedule fires when the simulated clock crosses the chosen Pacific minute. Breaks run as the admin role and are idempotent: the late file on `source_file`, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS promo_code`, then a separate null-amount spike. A correct clean step still drops the null amounts, so the graded set does not change.

Every director effect is inserted into `telemetry_events` with the session id, scenario version (`marlow-commerce-2024-06`), seed (`seed-v1`), simulated time, and wall-clock time. The same row is queryable through `GET /api/sessions/:id/telemetry`. If `POSTHOG_KEY` is set, the events are also posted to PostHog after commit. This is practice-mode evidence for a later hiring signal. It is not a score. Retention is recorded as 90 days; nothing deletes rows when that window passes. `rowsScannedEstimate` is a planner estimate from `EXPLAIN` without `ANALYZE`. Message tone features are stored as null until a later pass.

In development, `/signals` groups one session's events under the six dimensions (technical knowledge, curiosity, creativity and innovation, task completion, reaction to pressure, working style and values). Each row links back to the event. The banner says the grouping is experimental. The production image sets `ALLOW_SIGNALS_PAGE=false`, and the API then returns 404.

### LLM gateway

`LLM_PROVIDER` is `mock` (default), `openai`, or `anthropic`.

| Variable | Use |
| --- | --- |
| `LLM_API_KEY` | Required for openai and anthropic |
| `LLM_BASE_URL` | Optional. OpenAI-compatible hosts, or an Anthropic base URL |
| `LLM_MODEL_MANAGER` | Priya. Default `gpt-4o-mini` |
| `LLM_MODEL_TEAMMATE` | Jonah, Sam, Riley |

Mock mode returns the director's fallback line, including when the player pastes an adversarial prompt. Real providers get two attempts. A reply is dropped if it invents schema identifiers, leaks a near-complete plan, reproduces the graded result, leaves character, or contradicts the timeline. The fallback is checked the same way. A last-resort line is hard-coded if the fallback itself fails. Successful wordings can be cached in Redis for an hour. Each session has a character budget (`LLM_SESSION_BUDGET_TOKENS`).

### Guardrails

- **G1.** Backtick-marked identifiers must exist in the schema catalog. Unmarked real identifiers are flagged. Ordinary words are not.
- **G2.** Persona context never contains the reference SQL or the canary that marks it. A reply that is too close to the reference plan is blocked. SQL in a reply is executed on a rolled-back scratch connection and blocked if the result matches the graded set.
- **G3.** The person stays in the job. A fixed set of adversarial prompts is in the probe suite.
- **G4.** Lines have to match timeline facts (catalog refresh, churn wiring, dashboard hookup).

`npm run probe` is the automated harness. It fails if a bad draft would be shown, if an acceptable line is blocked, or if the prompt modules contain the reference canary.

## How to add a project script

There is no JSON loader in this release. A project script is the set of TypeScript modules below. Trustworthy orders is the only one wired to a session (`projectId: "trustworthy-orders"`). A second project copies this shape and branches `createInitialState` on the id.

1. **World.** Company, cast, schema catalog, and the epic summary in `packages/engine/src/world.ts`. The catalog is the only identifier list G1 trusts. Put every table and column a person may mention there.
2. **Seed.** Deterministic DDL, inserts, traps, and the break file in `packages/engine/src/seed.ts`. Keep it a pure function of a version number so `marlow_template` rebuilds when the version changes. Do not use `random()`.
3. **Director.** Tickets, release order, the hidden intent, timeline facts, and fallback lines in `packages/engine/src/director.ts`. The reducer must stay pure: no SQL, no clock IO, no model calls. Emit `speak` with a fallback that is already safe to show. Emit `inject_break` when the failure should land. Hidden ticket rules stay off the ticket until the player earns them, and unreleased tickets are stripped in `toDto`.
4. **Hidden intent.** A question detector belongs in `packages/engine/src/clarify.ts`. Wire it in the `player_message` branch. The written rule is added to the ticket only after it matches. Do not put that rule in the system prompt beforehand.
5. **Reference and grading.** The expected transform lives in `packages/engine/src/reference.ts`. `packages/engine/src/prompt.ts` and `director.ts` must not import it. State checks (table, types, constraints, row set, consumer tables) live in `packages/engine/src/grading.ts` and compare the player's tables to that reference inside a transaction that rolls back.
6. **Handoff.** Checklist items in `packages/engine/src/handoff.ts`. This release grades the note with the checklist, not with a model.
7. **Failure injection.** Add the SQL in `packages/engine/src/seed.ts` and run it from `injectBreak` in `apps/server/src/sandbox.ts` as the admin role. The director emits `inject_break` with a kind: `late_data`, `schema_drift`, or `null_spike`.
8. **Prove it.** Extend `packages/engine/test` for the reducer and the grader. Extend `apps/server/test/happy-path.e2e.ts` so a scripted player can finish the project with the mock provider. Run `npm run probe` after any prompt or fallback change.

Fallback lines should say what is true in the timeline using the same phrases G4 checks (`finished` / `not finished` plus the fact's noun). Mark schema names with backticks.

## Configuration

See `.env.example`. Defaults are enough for local Postgres on 5432 and Redis on 6379.

`ALLOW_DEBUG_CLOCK` (default on) exposes `POST /api/sessions/:id/clock` with `{ "advanceMinutes": 30 }`. The e2e test uses it. Set it to `false` if you don't want that endpoint.

`ENABLE_WORKER=false` skips BullMQ. The clock still moves when the API reads the session, which is what the workplace poll does.

## Release 1 limits

- Auth is the display name plus a bearer token stored in the browser. There is no Clerk or Auth.js.
- Practice mode only. There is no candidate mode and no employer report. The signals page must not be treated as a hiring score.
- PostHog is optional. Events are always stored in Postgres. The 90-day retention flag is recorded and not enforced.
- The handoff is a checklist, not a model review.
- Three injected breaks fire together: late file, schema drift (`promo_code`), and a null-amount spike. They are idempotent and do not change the canonical clean set.
- Repeat purchase cohorts is a short stub on the same database (RC-1 only). There is no second company and no third project.
- MySQL and DuckDB adapters throw. Only Postgres runs.
- G2's "near complete" score and G4's phrase check are heuristics. The probe suite states that.
- `rowsScannedEstimate` is a planner estimate, not rows actually read. Tone features on messages are null.
- The week view does not cost simulated time.
- Standard tickets are shorter than Guided and have no margin notes. The evaluation rule and the pipeline column contract are still on the ticket.
- Sandboxes for finished or abandoned sessions are eligible to be dropped after 7 days, during the worker's morning pass. Session telemetry is not deleted on that pass.
- The workplace is functional. Visual polish is later.

`docker compose up --build` waits for Postgres, runs migrations, and builds `marlow_template` on boot. The app healthcheck allows 90 seconds before it starts failing. This image turns the signals page off.
