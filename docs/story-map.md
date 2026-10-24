# SQL Job Simulator — User Story Map v2 (project-based)

**Model change from v1:** the unit is a whole **project** the player lives through on a data team, not a ticket sprint. The player does real work (pull, clean, build, maintain). Manager, teammates and "the company" are one LLM voicing distinct personas whose own work is scripted fake progress. Only the player's work is real.

**Player:** career switcher, pre-job (experienced track later). **Cast:** fully LLM-voiced; rules decide *when* they speak, the LLM decides *wording*.

## Backbone (the order a player lives it)

| # | Stage | What happens |
|---|---|---|
| 01 | Set up | Choose difficulty and industry; see company, team, your role |
| 02 | Onboard | Welcome DM, access/credentials, schema + architecture walkthrough |
| 03 | Receive the project | Kickoff ticket/epic, manager brief, downstream teams named |
| 04 | Investigate | Ask teammates, read schema/docs, clarify requirements |
| 05 | Pull & clean | Explore raw data, find traps, build a clean table |
| 06 | Build the pipeline | Ordered SQL steps on a schedule feeding ML + viz consumers |
| 07 | Operate & maintain | Pipeline runs on simulated clock; a break is injected; you get paged |
| 08 | Communicate | Status updates, suggestions, delays, asking for help, handoff note |
| 09 | Get judged | Milestone rewards/penalties (recoverable), project review |
| 10 | Next project | Choose another project in the industry; standing carries over |

## Release 1 — walking skeleton of a full project
One world (e-commerce), Postgres only, one project end to end.

- **01 Set up:** pick difficulty (2 levels) and industry (only e-commerce playable; others shown as "coming soon" are *not* shown — fiction before features).
- **02 Onboard:** manager welcome DM; teammate posts schema walkthrough; credentials appear in connection manager; ERD openable anywhere.
- **03 Receive:** epic + ~5 Jira tickets land on the board with due points; manager pings pointing at the first.
- **04 Investigate:** ask any cast member in chat, get in-character, restricted answers. `risk` Teammate never does the work. `risk` Characters only name schema objects that exist. **One scripted ambiguous ticket**: hidden intent unlocked by asking one specific question.
- **05 Pull & clean:** write SQL in the workbench against your own writable Postgres DB; see real engine errors; create `clean_orders` from `raw_orders`/`raw_events`. Seed traps (duplicates, refunds, timezone edges, nulls) make wrong approaches give wrong numbers.
- **06 Build:** define a daily pipeline as ordered SQL steps; outputs feed ML team's `churn_features` and viz team's `daily_revenue`. `risk` State-based grading: tables exist, constraints hold, no dupes, consumer query runs.
- **07 Operate:** pipeline runs on the simulated clock; **one injected break** mid-project (late data *or* schema drift *or* null spike); a teammate/consumer pings that their dashboard is wrong.
- **08 Communicate:** post status, flag a delay, suggest a change; teammates appear busy with their own scripted work and proactively check in ("did your table land?").
- **09 Judged:** each milestone gives a verdict in character; standing per character moves; misses cost standing, never access.
- **10 Next:** project review + handoff note graded; offered next project (same world, second project may be stub/"next up").

## Release 2 — it starts feeling like a job
- **Set up:** 3 difficulties; experienced track gets ambiguous ticket variants.
- **Receive:** ad-hoc requests compete mid-project; two stakeholders define one metric differently.
- **Investigate:** general ambiguity mechanic (true intent never stated; right question unlocks it, guessing doesn't); stale/contradicting docs.
- **Pull & clean:** **MySQL transactional source** with real dialect differences (collation, `LIMIT`/date functions, `GROUP BY` behaviour).
- **Build/Operate:** multiple failure types per project; backfills; reruns.
- **Judged:** **approach grading** (rubric + model review); persistent visible standing; weekly performance review.
- **Next:** project board per industry; second playable industry.

## Release 3 — later, deliberately
- Warehouse storylines (DuckDB star schemas, cost meter); vector storylines (pgvector, embeddings for ML team).
- Calendar meetings that cost time; requests arising in meetings; presenting results.
- Bigger team, competing priorities, on-call rotation.
- Bring-your-own schema; portfolio export of completed projects; procedurally assisted project authoring.

## Parked, with reasons
- **Airflow/dbt-real orchestration** — too heavy; a step-list runner gives ~80% of the feel.
- **Multiplayer** — doubles state complexity before the single-player loop is proven.
- **Voice standups** — cost and latency; text proves the loop first.
- **Multiple industries in R1** — content is the bottleneck; build and time one world first.
