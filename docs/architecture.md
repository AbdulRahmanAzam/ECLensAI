# ECLens AI — Architecture

## Goals

1. Be credible to a real financial institution: auditability, explainability, and role separation are first-class.
2. Keep the ECL computation **deterministic and testable**; AI may explain, extract, classify, and recommend — it is never the authoritative calculator.
3. Let a hackathon team iterate fast without painting themselves into a corner.

## System overview

```
┌────────────────────────┐        HTTPS (JSON)        ┌──────────────────────────┐
│  apps/web              │ ─────────────────────────► │  apps/api                │
│  React 18 + Vite       │   /api/v1 (JWT in httpOnly │  Express + TypeScript    │
│  TanStack Query/Table  │   cookie)                  │  Zod validation          │
│  Tailwind design system│ ◄───────────────────────── │  Pino logs, rate limits  │
└──────────┬─────────────┘                            └────────────┬─────────────┘
           │ Step 1 only:                                          │ Prisma ORM
           │ typed mock repository                                 ▼
           │ (apps/web/src/api)                        ┌──────────────────────────┐
           │                                           │  SQLite (single file)   │
           └──────────────► packages/shared ◄──────────┤  apps/api/prisma/dev.db  │
                    domain types, deterministic ECL    └──────────────────────────┘
                    engine, synthetic data generator
```

## Workspaces

| Workspace          | Responsibility                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/web`         | Analyst workspace. React Router routes, TanStack Query data layer, design system, charts.        |
| `apps/api`         | REST API under `/api/v1`. Authentication (JWT in secure httpOnly cookies), RBAC middleware.       |
| `packages/shared`  | `@eclens/shared`: domain types, IFRS 9 staging rules, ECL math, formatters, seeded synthetic data. |

## Key decisions

### 1. Deterministic engine in `@eclens/shared`

- `computeStage` applies IFRS 9 staging proxies: default flag or DPD ≥ 90 ⇒ Stage 3; significant-increase-in-credit-risk signals (rating downgraded ≥ 2 notches, DPD ≥ 30, forbearance, watchlist) ⇒ Stage 2; otherwise Stage 1.
- `computeEad` = gross carrying amount + undrawn commitment × credit conversion factor.
- Scenario-weighted ECL = Σ weight × (PD × scenario PD multiplier × LGD × EAD × DF), where DF discounts at the effective interest rate over the loss-emergence horizon. Stage 1 uses 12-month PD; Stages 2–3 use lifetime PD.
- Every function is pure and unit-tested in `packages/shared/test`.

### 2. AI boundary

AI features (copilot, insights) are advisory. They never emit authoritative ECL figures; deterministic code owns the numbers and the audit trail records who/what produced each artifact.

### 3. Mock-first frontend transport

`apps/web/src/api/client.ts` exposes a typed repository interface (`Api`). Step 1 binds it to `mockApi` (in-memory, built from `@eclens/shared` synthetic generators, ~300 ms simulated latency). Step 2 binds the same interface to `fetch` against `/api/v1` — pages and hooks do not change.

### 4. Authentication & authorization

- API: bcryptjs password hashing; short-lived JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production); `/api/v1/auth/me` restores sessions.
- Roles: `ADMIN`, `RISK_ANALYST`, `REVIEWER`, `AUDITOR`. `requireRole(...)` middleware guards routes; the web app mirrors the matrix in Settings.

### 5. Multi-tenancy readiness

Every Prisma model carries `organizationId` + indexes, so later steps can scope all queries per organization.

## Data model (summary)

`Organization`, `User`, `Role`, `Borrower`, `Exposure`, `PortfolioSnapshot`, `MacroScenario`, `ModelConfiguration`, `EclRun`, `EclResult`, `AiInsight`, `Document`, `AuditEvent` — full field-level detail in `data-dictionary.md` and `apps/api/prisma/schema.prisma`.

## Environments & configuration

- Config is read from environment variables only (`apps/api/.env.example`, `apps/web/.env.example` document every variable). No secrets in source control.
- Local SQLite, a single file at `apps/api/prisma/dev.db` — no server to start; deterministic seed via Prisma (`npm run db:seed`). `apps/api/prisma-postgres-backup/` holds the original PostgreSQL schema and migrations for a real deployment.

## Quality gates

- TypeScript `strict` in every workspace.
- ESLint + Prettier at the root; Vitest for the shared engine and API; Supertest for HTTP-level API tests.
- Production builds: `tsc` for shared/api, Vite build for web (`npm run build`).
