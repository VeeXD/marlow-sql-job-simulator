# SQL Job Simulator — Tech Stack (recommendation)

All costs and timings are **estimates** to verify in a spike.

## Recommendation at a glance
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

## Rough monthly cost at playtest scale (20–100 players) — estimates
- App + worker hosting: ~$20–60
- Managed Postgres (app + sandbox instance): ~$30–100
- Redis: ~$0–15
- LLM: ~fractions of a cent per teammate message on a small model; ~$0.05–0.30 per player-hour → ~$10–100/month at playtest scale
- Telemetry/auth: free tiers
- **Total: roughly $60–300/month (estimate)**

## Honest trade-offs
- TypeScript backend means data-ish tooling (seed generation, result comparison) is written in TS or as a small Python script; acceptable.
- DB-per-player means storage grows with players × projects; reap idle/finished project DBs after N days.
- BullMQ puts durability on us (idempotent handlers, session state in Postgres). If that gets painful, Temporal is the upgrade path.
- Custom runner is cheap now but must stay deliberately small; resist building a scheduler product.
