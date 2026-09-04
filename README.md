# ECLens AI

**Explainable Expected Credit Loss (ECL) platform for banks, microfinance institutions, NBFCs, finance teams, risk analysts, auditors, and reviewers.**

ECLens AI computes forward-looking IFRS 9 ECL allowances from PD, LGD, EAD, effective-interest discounting, and weighted macro-economic scenarios — and explains every number. AI assists (extracts, classifies, explains, recommends) but **never replaces** the deterministic, fully testable calculation engine.

> Status: **Step 3 of 5** — the governed AI copilot. Gemini accelerates analysis, document understanding, column mapping, anomaly triage and explanation, while every number still comes from the deterministic engine and stored records. The AI has no write tool of any kind, and an answer containing a figure it cannot cite is rejected server-side before anyone sees it. Without a `GEMINI_API_KEY` the whole product works unchanged and each AI surface says so honestly. See [`docs/ai-copilot.md`](docs/ai-copilot.md).

---

## Quick start

Requirements: **Node.js >= 20**, **npm >= 10**. No database server, no Docker — the
API runs on a single local SQLite file (`apps/api/prisma/dev.db`).

```bash
# 1. Install all workspace dependencies (also runs `prisma generate`)
npm install

# 2. Configure environment
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 3. Create the SQLite database and load the deterministic demo seed
npm run db:migrate
npm run db:seed

# 4. Run API (http://localhost:4000) and web app (http://localhost:5173) together
npm run dev
```

Prefer PostgreSQL (for a real deployment, not just a demo)? `apps/api/prisma-postgres-backup/`
holds the original `schema.prisma` and its migration history — copy `schema.prisma` back over
`apps/api/prisma/schema.prisma`, copy `migrations/` back the same way, point `DATABASE_URL` at a
Postgres instance, reinstall (`npm i --save-dev prisma@^5.19.1 && npm i @prisma/client@^5.19.1` in
`apps/api`), and run `npm run db:up` (docker compose) before `db:migrate`.

**Optional — enable the AI copilot.** Add `GEMINI_API_KEY=<your key>` to `apps/api/.env` and restart the API. The key is read only by the server process; it is never a `VITE_` variable, never echoed in a response, and never logged. Without it the AI surfaces report "unavailable" and everything else is unaffected — including governance-document upload, indexing and citation, which need no model at all. All other AI variables have working defaults; `docs/ai-copilot.md` lists them.

Useful commands:

```bash
npm run lint           # ESLint across all workspaces
npm test               # Vitest: shared engine + web + API (API needs the seeded database)
npm run build          # Production builds: shared -> api -> web
```

`packages/shared` is consumed two ways: the web app resolves its **source** through a Vite alias, while the API resolves its **built** `dist`. If you change shared code, run `npm run build -w packages/shared` before building or seeding the API.

### Seeded demo access

| Email                   | Password    | Role         |
| ----------------------- | ----------- | ------------ |
| `demo@eclens.ai`        | `Demo1234!` | RISK_ANALYST |
| `admin@eclens.ai`       | `Demo1234!` | ADMIN        |
| `reviewer@eclens.ai`    | `Demo1234!` | REVIEWER     |
| `auditor@eclens.ai`     | `Demo1234!` | AUDITOR      |

The seed is idempotent and deterministic: 780 fictional PKR exposures across consumer, SME, agriculture, microfinance and corporate segments with all three IFRS 9 stages represented, one APPROVED run (`RUN-MTJYELTU-EB4B41`) whose portfolio allowance is **PKR 7,068,066,313.50** at a coverage ratio of **0.0254625539**, one active model configuration and scenario set (both v1.0.0), and 122 open near-threshold exceptions. All borrowers are synthetic.

It also seeds one governance document, *"ECLens governance orientation notes"* — paraphrased orientation text that maps IFRS 9 credit-loss topics to the paragraphs governing them, already chunked and citable so retrieval has something to return on a fresh database. No copyrighted standard text is bundled anywhere in the repository; upload your institution's licensed policy material for answers grounded in your own wording.

Only `ADMIN` holds `run:review`, `override:review`, `model:write`, `scenario:write`, `report:export` and `document:delete`, so the four-eyes controls, the exports hub and document deletion are reachable only from `admin@eclens.ai`. All four roles hold `ai:use` and `document:read`; `AUDITOR` alone cannot write documents, and `REVIEWER` cannot draft a scenario version, so the **Build scenario draft** panel is ADMIN-only.

---

## Calculation methodology

For each exposure and each scenario, over every period of the exposure's horizon:

```
expected loss(period) = marginal PD(period, scenario)
                      x LGD(period, scenario)
                      x EAD(period)
                      x discount factor(period)

scenario ECL          = sum of expected loss(period) over the horizon
exposure allowance    = sum of scenario ECL x scenario weight
portfolio allowance   = sum of exposure allowances
```

- **Staging.** Stage 3 on `default_flag` or `credit_impaired_flag`, or on the configurable days-past-due backstop (seeded at 90). Stage 2 on the DPD SICR backstop (seeded at 30), material rating downgrade, PD increase relative to origination, forbearance, restructuring or watchlist status. Stage 1 otherwise. Every decision returns the stage, the primary reason, **every** rule that fired, the source fields, the rule-set version and whether an analyst override exists.
- **Horizon.** Stage 1 uses the 12-month window — documented in the UI as the *lifetime* cash shortfall from defaults possible in the next 12 months, not the shortfall occurring during those 12 months. Stages 2 and 3 use the remaining contractual lifetime.
- **PD.** A supplied term structure is converted to non-overlapping marginal probabilities by survival logic (`S(t) = S(t-1) x (1 - h(t))`, `m(t) = S(t-1) x h(t)`), and cumulative PD is validated never to exceed 1. Where only 12-month and lifetime anchors exist, a two-block term structure is derived from them.
- **Scenarios.** PD and LGD multipliers are applied **in hazard space**, so a downside multiplier cannot push a cumulative default probability past 1 by construction. Active weights must total exactly 1 within a decimal tolerance; the engine re-checks this in exact arithmetic on every save and every run.
- **EAD.** Drawn balance plus credit conversion factor times undrawn commitment. A contractual amortization schedule wins when present; otherwise a clearly labelled simplified profile (straight-line amortization or flat balance) is used and the label travels with the result.
- **Discounting.** At the original effective interest rate, end-period `(1 + EIR)^(-t/12)` or mid-period `(1 + EIR)^(-(t-0.5)/12)`. Rate values outside the configured bounds are rejected rather than clamped.
- **The single-period `PD x LGD x EAD` shortcut is never the reported figure.** It is shown once per exposure, explicitly labelled, as an educational approximation.

### Rounding policy

Displayed verbatim on every run and result, and stored in each result's lineage:

1. Each period expected loss is computed at 40-digit decimal precision and rounded **once** to 2 decimals (ROUND_HALF_UP).
2. Scenario ECL is the exact sum of the rounded period losses, so the period table always adds to the scenario total.
3. Scenario weighted ECL = scenario ECL x weight, rounded to 2 decimals.
4. Exposure allowance is the exact sum of the rounded weighted ECLs.
5. Portfolio total is the exact sum of exposure allowances, with no further rounding.

Two consequences worth knowing before you hand-check a figure:

- **Per-row EAD is rounded before it is summed**, so the portfolio `totalEad` can differ from a hand-summed EAD column by up to half a rupee per exposure. The allowance, gross carrying amount and net carrying amount totals are exact.
- **A formula trace shows the display-rounded factors**, while the expected loss was computed at full precision and rounded once. Multiplying the four printed numbers by hand can therefore land a few paisa away from the stored value. What reconciles exactly is the column: each scenario's period losses sum to its unweighted ECL, and the weighted contributions sum to the allowance.

Money and rates live in `Decimal` end to end (`decimal.js`; Prisma's `Decimal` **is** decimal.js) and cross the API as strings. The browser only ever converts a decimal string to a float for chart axes, sorting and layout — never to re-derive a reported figure.

---

## API surface

All routes are under `/api/v1`, session-authenticated by a JWT in an httpOnly cookie, organization-scoped, and permission-gated.

| Area | Endpoints |
| ---- | --------- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Imports | `POST /imports/portfolio`, `GET /imports`, `GET /imports/:id/preview`, `POST /imports/:id/mapping`, `POST /imports/:id/commit`, `GET /imports/:id/issues`, `GET /imports/:id/issues/export` |
| Templates | `GET /templates/portfolio` (blank or 750+ row synthetic sample, CSV or XLSX, JSON or raw bytes) |
| Portfolio | `GET /portfolio/exposures`, `GET /portfolio/exposures/:id`, `GET /portfolio/summary`, `GET /portfolio/snapshots` |
| Runs | `POST /ecl-runs`, `GET /ecl-runs`, `GET /ecl-runs/:id`, `POST /ecl-runs/:id/execute`, `GET /ecl-runs/:id/results`, `GET /ecl-runs/:id/results/:exposureId`, `POST /ecl-runs/:id/submit`, `POST /ecl-runs/:id/approve`, `POST /ecl-runs/:id/reject` |
| Governance | `GET`/`POST /scenario-sets`, `GET /scenario-sets/:id`, `GET`/`POST /model-configurations`, `GET /model-configurations/:id` |
| Overrides | `POST /exposures/:id/stage-override`, `GET /exposures/:id/override-history`, `GET /stage-overrides`, `POST /stage-overrides/:id/review` |
| Exceptions | `GET /exceptions`, `GET /exceptions/summary`, `POST /exceptions/:id/acknowledge`, `POST /exceptions/:id/resolve` |
| Audit | `GET /audit-events` (read-only by design — there is no write, update or delete route) |
| AI copilot | `GET /ai/status`, `POST /ai/copilot/query`, `GET /ai/copilot/threads`, `GET /ai/copilot/threads/:id`, `POST /ai/copilot/threads/:id/turns/:turnId/feedback`, `POST /ai/explain-ecl`, `POST /ai/import-mapping`, `POST /ai/investigate-quality`, `POST /ai/scenario-draft`, `POST /ai/executive-commentary` |
| Documents | `POST /documents`, `GET /documents`, `GET /documents/:id`, `DELETE /documents/:id`, `POST /documents/:id/extract`, `POST /documents/:id/signals/:signalId/decision` |
| Health | `GET /health` |

Conventions worth knowing:

- **`:id` accepts the public id or the internal id** for runs, exposures and results. Import sub-routes and the issues export resolve by **public id only**. `ExposureRecord.latestRunId` is a run's *public* id.
- **List endpoints** take `page`, `pageSize` (max 200), `sortBy`, `sortDir`, `search` plus endpoint-specific filters. Each service whitelists its sortable columns; an unlisted `sortBy` is **ignored and the default ordering applied**, not rejected — which is why the UI marks those columns display-only rather than letting a header arrow promise a sort the server will not perform.
- **Errors** arrive on one envelope, `{ error: { code, message, requestId?, details? } }`. Codes are meant to be branched on: `RUN_LOCKED`, `RUN_NOT_READY`, `RUN_SELF_APPROVAL_PROHIBITED`, `OVERRIDE_SELF_REVIEW_PROHIBITED`, `IMPORT_ALREADY_COMMITTED`, `IMPORT_NOT_VALIDATED`, `IMPORT_VALIDATION_IN_FLIGHT`, `SCENARIO_SET_VERSION_EXISTS`, `EXCEPTION_ALREADY_RESOLVED`.
- **A declined AI answer is a 200, not an error.** AI endpoints return `{ status, result, message, availability, toolActivity, … }`; when the model is unavailable, times out, or drafts a figure it cannot cite, `result` is `null` and `message` says why. A thrown error means the *request* was refused — the AI rate limit (429), a missing permission (403), an oversized upload (413) or an id from another organization (404). The client keeps those two apart rather than rendering an honest refusal as a crash. Document sub-routes resolve by **public id only**.
- **Four-eyes** is enforced against the *creator*: a run's creator cannot approve or reject it, and an override's requester cannot review it. Note that `requirePermission` runs first, so a role without `run:review` gets `403 FORBIDDEN` and never reaches the four-eyes `409`.
- `SessionUserRecord.permissions` is resolved server-side from the same `permissionsForRole` matrix the `requirePermission` middleware enforces, so the client's `can()` and the server's gate cannot disagree.

### Background jobs

Import validation and run execution go through one job abstraction. The default driver is an **in-process synchronous fallback** (`setImmediate`) so the demo never depends on Redis; set `JOB_QUEUE_DRIVER=bullmq` and `REDIS_URL` for a durable queue. Endpoints that enqueue answer **202** with `{ jobId, driver }` and the client polls — `POST /imports/portfolio`, `POST /imports/:id/commit` and `POST /ecl-runs/:id/execute`.

---

## Screens

- **Dashboard** — portfolio totals, stage distribution, trend, high-risk exposures, recent runs, open exceptions.
- **Portfolio** — server-paged, sorted, filtered and searchable exposure list.
- **Exposure detail** — five tabs: calculation (per-scenario periods with expandable formula traces), source inputs, staging and reason codes, override history, lineage. **Explain This ECL** sits above the tabs and writes the narrative a reviewer would otherwise compose by hand, from the stored trace, with a reconciliation block.
- **Imports** — upload, preview, map all 28 canonical columns against the server's deterministic suggestions, choose the percentage normalization mode, read the quarantine with raw values and suggested corrections, and commit the valid rows into an immutable snapshot. **AI mapping suggestions** appear beside the deterministic proposal for headers string scoring cannot read, flagging every column where the two disagree.
- **ECL runs** — paged run history plus a draft-run builder that locks a snapshot, model configuration version and scenario set version.
- **Run detail** — readiness checks, scenario weights, stage buckets, lineage, review trail, the paged result table, and a per-exposure drawer that drills to period-level PD, LGD, EAD, discount factor and formula trace — with **Explain This ECL** for that exposure in that run. **Executive commentary** drafts a board-ready narrative in which every movement is labelled fact, inference or recommendation.
- **Scenarios** and **Model governance** — versioned, immutable sets. Each card shows how many runs froze it, which is the visible half of the guarantee that superseding an assumption cannot rewrite history. **Build scenario draft** turns a narrative into a proposal that prefills the page's own create-version form and cannot publish itself.
- **Overrides** and **Exceptions** — the two-person review queue and the four-kind exception queue (data quality, analyst override, large ECL change, near staging threshold). **Investigate with AI** reads the stored issues behind an exception and proposes corrections it cannot apply.
- **Governance documents** — upload PDFs, watch them parse and chunk into citable retrieval, extract facts and proposed risk signals with page references, and accept or reject each signal with a note. Indexing works with no model configured; extraction needs one, and the screen says which half your deployment has.
- **Reports & exports** — the two permissioned, audited downloads: the portfolio template with its field guide, and an import batch's error report CSV.
- **Audit log** — server-paged over the immutable trail; there is no edit surface anywhere in the app.
- **AI copilot** — the conversational surface over the same eight read-only tools. It quotes only figures the engine persisted, shows which tools it called to get them, cites every source, and never calculates. Answers arrive whole rather than streamed, so the grounding guard can reject an uncitable figure before it reaches the screen.

---

## Repository layout

```
.
├── apps/
│   ├── api/           # Express + TypeScript + Prisma API (JWT httpOnly cookies)
│   └── web/           # React + Vite + Tailwind analyst workspace
├── packages/
│   └── shared/        # Pure domain: staging, PD, EAD, discounting, ECL, ingestion, contracts
├── docs/
│   ├── architecture.md
│   ├── ai-copilot.md              # AI setup, guardrails, retrieval, failure behaviour, demo questions
│   ├── ecl-domain-primer.md
│   └── data-dictionary.md
├── docker-compose.yml # Optional local PostgreSQL 16 (apps/api/prisma-postgres-backup/ has its schema)
└── package.json       # npm workspaces root
```

## Architecture decisions

- **npm-workspaces monorepo** so the ECL domain model and deterministic engine are written once and shared by the seed, the API and the UI.
- **A pure domain module in `packages/shared`** with no Express and no database dependency: small composable functions, typed inputs and outputs, deterministic rounding. This is what makes the engine unit-testable in isolation and impossible for a route handler to bend.
- **Decimal-only money and rates.** Binary floating point never touches a persisted financial total.
- **Versioned, immutable assumptions.** Scenario sets and model configurations are never edited — a change publishes a new version, and a completed run stores the version ids it executed with so later edits cannot reach it.
- **Explainability as data, not prose.** Every result carries its lineage (input version, model configuration version, staging rule-set version, scenario set version, reporting date, calculation timestamp, actor, rounding policy) and every period carries its own formula trace.
- **The audit trail is append-only.** Services write events as they act; no route can update or delete one.
- **Role-based authorization**: `ADMIN`, `RISK_ANALYST`, `REVIEWER`, `AUDITOR` behind a permission matrix, with four-eyes separation on run approval and override review. Each AI tool re-checks organization scope and the caller's permissions itself rather than trusting the route that reached it.
- **The model has no write tool.** Its eight tools are all reads. This is a capability absence, not a policy the prompt asks it to follow: there is no function it could call to change a stage, approve a run, edit an assumption, persist a mapping or produce an authoritative ECL, so no instruction — however convincing — can make it do so.
- **Grounding is enforced server-side.** Every number in a drafted answer is extracted and matched against the set of figures the tools actually returned; a claim with no match rejects the whole response with `AI_GROUNDING_REJECTED` and the user is told why. Prose is checked too, through the same guard applied to structured fields.
- **Answers arrive whole, never streamed.** Streaming would put an uncitable figure on screen before the guard had read the sentence containing it, so `streaming: false` is reported in `/ai/status` and the UI says so. This is a deliberate trade of perceived speed for a guarantee that cannot be made any other way.
- **Retrieval sits behind a provider interface.** `bm25` is the default and needs no extension and no API key, so document upload, chunking and citation all work offline; `embedding` swaps in Gemini vectors ranked by cosine similarity. Neither the copilot nor the routes know which is configured.
- **Uploaded text is data, never instructions.** Document and user content is sanitized, fence-neutralized and wrapped with an explicit untrusted-data boundary before it reaches the model, and screened for injection attempts that are recorded as warnings rather than silently dropped. No document text can call an application action.
- **Every AI proposal needs a human action, and that action is audited.** Mapping suggestions fill a form the analyst still applies; extracted risk signals sit in `PROPOSED` until someone accepts or rejects them; a scenario draft prefills the page's own create-version form and cannot publish itself. The audit event names the AI as the origin.
- **The API key never leaves the server process.** No `VITE_` variable, no response body, no log line, no client bundle — prompt bodies are not persisted either, only token counts, tools used, latency, cost estimate and the data categories that were sent.

## Testing

```bash
npm test               # all workspaces
LOG_LEVEL=fatal npm test -w apps/api   # quieter, roughly 3x faster integration run
```

- `packages/shared` — 229 unit tests over EAD, staging, PD/survival, discounting, the ECL engine, import validation and the synthetic generator.
- `apps/api` — 121 tests in four files: app-level middleware coverage, a database-backed integration suite (totals reconciling to per-exposure results, the period drill-down, overrides and four-eyes, the full ingestion flow from template download to committed snapshot, a superseded configuration leaving an approved run untouched, organization isolation and role permissions), plus two AI suites. `ai.test.ts` drives the copilot through an injected deterministic fake model — no network, no key — covering the grounding guard, structured-output validation and the single repair retry, provider failure and timeout classification, availability without a configured model, the privacy boundary (redaction and what telemetry is allowed to hold), the system instruction, untrusted document text and injection detection, parsing and budget limits, and the evidence the model is handed. `ai-integration.test.ts` exercises the real HTTP routes against the seeded database: the AI surface and its rate limit, the copilot and its threads, the scenario assistant, document upload/extraction/signal decisions, cross-organization isolation, and telemetry rows.
- `apps/web` — 33 tests over `src/lib/ai.test.ts`, the pure client-side guardrails: that a citation never links to a route that does not exist, that copied text keeps its sources and its caveats, that a scenario draft cannot arrive pre-weighted, that every enum the server can send has a human label and a tone, and that merging AI mapping suggestions never mutates the form state it was given.

The integration suite is **skipped, not failed**, when no seeded database is reachable, so a checkout that hasn't run `db:test:prepare` yet still gets a green unit run. Everything it creates it also removes, and it asserts its own teardown: the exposure count and import-batch count must return to their starting values.

## Roadmap

| Step | Scope | Status |
| ---- | ----- | ------ |
| 1 | Product foundation, architecture, premium application shell | ✅ done |
| 2 | Auditable ECL engine, portfolio ingestion, staging, calculation APIs — and, ahead of the original schedule, the versioned scenario management, model governance, overrides, exceptions, reports and disclosures that were meant to be step 3 | ✅ done |
| 3 | Governed AI copilot: grounded explanations, document intelligence, mapping suggestions, anomaly triage, scenario drafts, executive commentary | ✅ this step |
| 4 | Hardening: full audit coverage, security review, deployment readiness | planned |

The sequence moved as the build went. Step 2 absorbed the deterministic engine service that was step 3, and the AI copilot that was step 4 shipped as step 3, so one planned slot fell away; what remains is hardening, and its detailed scope is not defined yet.

See `docs/` for the architecture, the AI copilot guide, the ECL domain primer, and the data dictionary.
