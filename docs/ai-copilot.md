# AI copilot and document intelligence

Step 3 adds Gemini-backed assistance to ECLens AI. The design constraint is not
"make it useful" — it is **make it useful without letting a language model
become the source of a financial number**. Every figure an AI answer contains is
copied from a deterministic tool result or a stored record, and an answer that
contains a figure the model cannot point at is rejected server-side before the
user sees it.

---

## 1. Setup

Nothing here is required for the product to run. Without a key, ECLens AI is the
Step 2 product with an honest "AI unavailable" notice on every AI surface.

```bash
# apps/api/.env — server process only
GEMINI_API_KEY=<your key>
```

That is the whole of it. Every other AI variable has a working default; see
`apps/api/.env.example` for the annotated list and §6 for what each one changes.

The key is read **only** by the Express server:

- it is not a `VITE_` variable, so Vite never inlines it into a bundle;
- it is not echoed in any API response, including `GET /api/v1/ai/status`, which
  reports the model *id* and availability but never the credential;
- it is not written to logs — AI telemetry records token counts, latency, cost
  estimate, tools used and data categories sent, never a prompt body.

To confirm a build is clean:

```bash
npm run build -w apps/web
grep -oiE "GEMINI[_A-Z]*|AIza[0-9A-Za-z_-]{10,}|api[_-]?key" apps/web/dist/assets/*.js
# no output means the bundle carries no key material
```

Retrieval works with **no key at all** on the default `bm25` provider, so
governance-document citations are available in an offline demo. Only extraction
(facts and proposed signals) needs a model.

---

## 2. What the AI can and cannot do

### Cannot, by construction

There is no tool on the server that would let it. This is not a policy the model
is asked to follow; it is an absence of capability.

| Blocked | Why it cannot happen |
| --- | --- |
| Change a staging decision | No write tool exists. Overrides stay on `POST /exposures/:id/stage-override`, permissioned and four-eyes reviewed. |
| Approve, submit or reject a run | No run-mutation tool. `run:review` and the self-approval guard are untouched. |
| Edit a model assumption or scenario weight | No governance-write tool. Scenario sets and model configurations remain immutable and versioned. |
| Calculate an authoritative ECL | The engine in `packages/shared` is the only thing that computes an allowance. The model can *describe* a stored trace. |
| Apply an import mapping | `mergeAiMappingSuggestions` writes React form state. Only the existing "Apply mapping and re-validate" button persists anything. |
| Act on a document signal | Accepting a proposed signal writes a decision and an audit event and **nothing else**. No exception is raised, no stage changes, no exposure row is touched. |
| Run SQL, read the filesystem, call arbitrary HTTP | Tools are a closed allowlist of eight typed service functions. |

Every AI proposal — a mapping, a scenario draft, a document signal, a
correction — requires an explicit human action, and that action is recorded in
the immutable audit trail with the actor's name.

### Can

Eight read-only tools, each of which enforces organization scope and role
permission **inside the tool**, not only at the route. A tool call the actor
could not have made through the REST API is a tool call the model cannot make.

| Tool | Returns |
| --- | --- |
| `getPortfolioSummary(filters)` | Stored portfolio totals and stage buckets |
| `getExposureDetails(exposureId)` | One exposure's stored record |
| `getCalculationTrace(exposureId, runId)` | The persisted period-level trace and formula strings |
| `compareRuns(baseRunId, comparisonRunId)` | Stored run-to-run deltas |
| `getScenarioComparison(runId)` | Per-scenario weighted contributions for a run |
| `getStageMigration(fromSnapshotId, toSnapshotId)` | Stored stage movement between snapshots |
| `getDataQualityIssues(importId \| snapshotId)` | Persisted validation issues and quarantine rows |
| `searchGovernanceKnowledge(query)` | Ranked chunks from this organization's documents |

The model receives the minimum necessary, organization-scoped records those
functions return. It never sees a database handle.

---

## 3. The seven features

| Feature | Route | Where it appears |
| --- | --- | --- |
| Portfolio Copilot | `POST /ai/copilot/query` | `/copilot` — conversation history, suggestion chips, tool-activity indicators, citations, copy, thumbs feedback |
| Explain This ECL | `POST /ai/explain-ecl` | Exposure detail page, and the per-exposure drawer on run detail |
| Smart Import Mapper | `POST /ai/import-mapping` | Imports → batch drawer → Column mapping, beside the deterministic proposal |
| Data Quality Investigator | `POST /ai/investigate-quality` | Exception queue drawer ("Investigate with AI") |
| Scenario Assistant | `POST /ai/scenario-draft` | `/scenarios` ("Build scenario draft") |
| Document Intelligence | `POST /documents`, `POST /documents/:id/extract` | `/documents` |
| Executive Commentary | `POST /ai/executive-commentary` | Run detail page |

Supporting endpoints: `GET /ai/status`, `GET /ai/copilot/threads`,
`GET /ai/copilot/threads/:threadId`,
`POST /ai/copilot/threads/:threadId/turns/:turnId/feedback`,
`GET /documents`, `GET /documents/:id`, `DELETE /documents/:id`,
`POST /documents/:id/signals/:signalId/decision`.

Each feature has an explicit JSON Schema sent to the model **and** a Zod schema
that re-validates the response before anything reads it. On a validation failure
the service retries once with a repair instruction; if the second attempt also
fails it returns a structured error rather than a best-effort object.

Two contract details worth knowing when reading the UI:

- **`requiresApproval: true`** is a field on scenario proposals and mapping
  suggestion sets, not decoration. It is rendered.
- **Executive commentary labels every claim** `FACT`, `INFERENCE` or
  `RECOMMENDATION`, and the copy action writes those labels into the pasted text
  — because a board pack has no badges and would otherwise read as uniformly
  authoritative.

---

## 4. Grounding: how a hallucinated number is prevented

Three layers, all server-side.

1. **Evidence collection.** Each tool result is rendered into a bounded evidence
   string (`AI_MAX_EVIDENCE_CHARS`, default 24 000) and carries its source
   identifiers. The model is instructed to copy figures from it verbatim.
2. **Numeric claim extraction.** `extractNumericClaims` pulls every number out
   of the drafted prose, and `groundedNumberSet` builds the set of numbers
   present in the evidence.
3. **Verdict.** `findUngroundedClaims` compares them. A claim that appears in the
   prose but not in the evidence fails the request with `AI_GROUNDING_REJECTED`,
   which surfaces to the user as a declined answer with a reason — not as a
   plausible-looking number.

The same check runs recursively over structured fields
(`findUngroundedClaimsInValue`), so a figure smuggled into a `caveats` array is
caught too.

Because the check runs on the **complete** response, streaming is deliberately
not implemented. `GET /ai/status` reports `streaming: false`. A streamed answer
reaches the user token by token, which means an ungrounded figure would already
be on screen before the guard could reject it. This is a considered deviation
from a "stream when supported" instruction, not an omission.

Redaction runs before evidence leaves the process. `AI_REDACTION_PROFILE`
defaults to `redact`, replacing borrower names with pseudonyms; `pseudonymize`
keeps a stable per-request alias; `none` is only appropriate for data that is
already de-identified. The profile used and the data categories sent are
recorded on every `AiRequest` row.

---

## 5. Documents and prompt injection

Upload accepts **PDF only**, validated by MIME type and by file signature before
the bytes are buffered, capped at `DOCUMENT_AI_MAX_BYTES` (default 10 MB).
Storage is in memory and the parsed text goes to PostgreSQL — nothing lands on
the filesystem. CSV and XLSX are deliberately *not* accepted here: tabular data
belongs in the portfolio import pipeline, where it is parsed and validated column
by column.

Two halves of the feature have different requirements, and the UI says which half
a deployment has:

- **Indexing** is deterministic PostgreSQL work. A document is parsed, chunked
  (`DOCUMENT_AI_CHUNK_CHARS`, default 1 800) and made citable with **no model
  configured**. `INDEXED` is a real terminal state; retrieval answers work
  offline.
- **Extraction** calls the model and produces facts, proposed signals and a
  summary. Without a key the document stays indexed and the extract button
  explains why it will not do anything.

Uploaded text is **untrusted data**. `sanitizeUntrustedText` and `neutralizeFences`
strip the markers that would let document prose close its own container, and
`wrapUntrusted` labels it as data before it reaches a prompt. `findInjectionAttempts`
screens for instruction-shaped content and reports findings as warnings on the
extraction rather than acting on them. Document text can never override the
system policy or invoke an application action, because there is no action for it
to invoke.

An extracted fact carries `verbatim: true` only when the value is written in the
document. A ratio the model assembled from figures that *are* present is marked
**derived · not written in the document** in the UI, and a ratio the document
never states is not extracted at all.

Copyrighted full text of IFRS 9 is **not bundled**. The seeded library
(`ECLens governance orientation notes`, category `GUIDANCE`, `seeded: true`) is
paraphrased orientation mapping topics to the paragraphs that govern them.
Upload your institution's licensed policy material for grounded answers against
your own text.

---

## 6. Model configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `GEMINI_API_KEY` | unset | Unset ⇒ every AI endpoint answers `AI_UNAVAILABLE` |
| `AI_ENABLED` | `true` | `false` kills the AI surface even with a key present |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | The generation model |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-2` | Used only by the `embedding` retrieval provider |
| `GEMINI_RETRIEVAL_PROVIDER` | `bm25` | `bm25` needs no key or extension; `embedding` ranks by cosine similarity |
| `AI_TIMEOUT_MS` | `20000` | Per-call timeout ⇒ `AI_TIMEOUT` |
| `AI_MAX_RETRIES` | `2` | Bounded retries with exponential backoff, transient failures only |
| `AI_MAX_TOOL_ROUNDS` | `4` | Cap on the evidence loop so a chatty model cannot spin |
| `AI_MAX_OUTPUT_TOKENS` | `2048` | Generation cap |
| `AI_MAX_INPUT_CHARS` | `8000` | Question length ⇒ `AI_INPUT_TOO_LARGE` |
| `AI_MAX_EVIDENCE_CHARS` | `24000` | Evidence handed to the synthesis call |
| `AI_RATE_LIMIT_WINDOW_MS` / `AI_RATE_LIMIT_MAX` | `60000` / `20` | Per-user bucket shared by both AI routers ⇒ real HTTP 429 |
| `AI_COST_MICRO_PER_1K_INPUT` / `_OUTPUT` | `75` / `300` | Telemetry only; not billed through the app |
| `AI_REDACTION_PROFILE` | `redact` | What leaves the process |
| `DOCUMENT_AI_MAX_BYTES` | `10485760` | Upload cap ⇒ 413 `UPLOAD_TOO_LARGE` |
| `DOCUMENT_AI_CHUNK_CHARS` | `1800` | Retrieval chunk size |

`GET /api/v1/ai/status` reports availability, the model id, the per-feature
list, the effective limits, `streaming: false` and the disclaimer text — so the
client and the server cannot disagree about what is configured.

Retrieval is behind a provider interface (`retrieval.ts`), so swapping `bm25`
for `embedding`, or either for Gemini File Search, does not touch the tools or
the features.

---

## 7. Failure behaviour

The distinction the UI is built around:

- **`isError` / a thrown `ApiError`** means the *request was refused* — 429 rate
  limit, 403 permission, 404 cross-organization id, 413 oversized upload.
- **HTTP 200 with `result: null`** means the AI *declined to answer*. The
  envelope carries `status`, `message` and `availability`, and the message is
  shown verbatim.

Conflating the two would render an honest refusal as a crash, so
`AiResponseFrame` keeps them apart and every panel routes through it.

| Condition | What the user sees |
| --- | --- |
| No `GEMINI_API_KEY` | "AI unavailable" with the reason; the rest of the product is unaffected and document indexing still works |
| Timeout, rate limit, oversized input | A declined answer naming the cause and the `aiRequestId` to quote |
| Ungrounded figure | `AI_GROUNDING_REJECTED` — a refusal, never a fabricated number |
| Invalid structure after one repair attempt | `AI_SCHEMA_INVALID` with the reason |
| Missing evidence | `AI_EVIDENCE_MISSING` rather than an answer from nothing |
| Unsupported document type | `DOCUMENT_UNSUPPORTED_TYPE`; the file is refused before buffering |
| Signal decided twice | `DOCUMENT_SIGNAL_ALREADY_DECIDED` — a decision is one-way |

Every one of those is a **200** except the rate limit (429), the upload size
(413) and genuine authorization/not-found failures (403/404).

The visible disclaimer on every AI surface:

> AI can make mistakes. Figures are copied from this organisation's stored
> records at their stored precision — verify against the cited source before
> relying on them. Nothing here changes a staging decision, approves a run, or
> edits a model assumption.

---

## 8. Demo questions

Against the seeded organization (*Meridian Demo Bank Ltd*, snapshot
`SNAP-SEED-001`, one approved run) with a key configured:

**Copilot**

- What is the total loss allowance and coverage ratio for the latest approved run?
- How are exposures distributed across stages 1, 2 and 3?
- Which segment carries the largest allowance, and what is its coverage?
- What does our governance material say about a significant increase in credit risk?
- Which open data-quality exceptions affect the most records?

**Explain This ECL** — open any exposure from `/portfolio`, or any row of the
run's per-exposure table, and press *Explain this ECL*. The answer carries a
reconciliation block: the part an auditor replays.

**Smart Import Mapper** — download a sample template from `/imports`, edit a few
column headers to something ambiguous
(`Outstanding Principal (PKR '000)`, `Recovery Severity`), upload it, and compare
the AI proposal against the deterministic one. Where they disagree the row is
badged.

**Investigate with AI** — `/exceptions`, open any near-threshold exception. The
suggested corrections are read-only by design; there is no apply button and no
server tool that could supply one.

**Build Scenario Draft** — `/scenarios`. Describe a downturn in the narrative
box. The draft arrives with `requiresApproval` rendered, and *Use in new version*
prefills the page's own create-version modal with the version field **left
blank** — the model proposes weightings, never the identity of the version they
would be published under. A weight the model declined to propose arrives as `0`,
so the form's own "weights must total 100%" validation blocks the submit until a
person supplies it.

**Executive Commentary** — open the approved run and draft a commentary for
"ALCO". Copy it: the claim labels and the source list travel with the text.

**Documents** — upload any licensed PDF policy, wait for `indexed · citable`,
then *Extract facts and signals* and accept or reject a proposed signal with a
note. The decision and your name land in `/audit-log`.

To see the honest degraded state, unset `GEMINI_API_KEY` and restart the API:
every surface above reports unavailability, document upload and indexing still
work, and nothing else in the product changes.

---

## 9. Permissions

| Role | `ai:use` | `document:read` | `document:write` | `document:delete` |
| --- | :-: | :-: | :-: | :-: |
| `ADMIN` | ✅ | ✅ | ✅ | ✅ |
| `RISK_ANALYST` | ✅ | ✅ | ✅ | — |
| `REVIEWER` | ✅ | ✅ | ✅ | — |
| `AUDITOR` | ✅ | ✅ | — | — |

An auditor can read and question the AI but cannot upload a document or decide a
signal. Deletion is `ADMIN`-only, and the confirmation dialog names the
consequences: retrieval removal, citations that will no longer resolve, and
undecided signals destroyed with the document.

Every AI request writes an `AiRequest` telemetry row (feature, status, model,
latency, attempts, token counts, cost estimate, tools used, source refs, data
categories sent, redaction profile, grounding-rejected flag, error code) and
every consequential human decision writes an audit event. Neither is editable.
