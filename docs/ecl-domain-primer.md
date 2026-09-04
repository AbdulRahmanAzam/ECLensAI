# ECL Domain Primer

A plain-language introduction to Expected Credit Loss as implemented in ECLens AI.

## What is ECL?

Expected Credit Loss (ECL) is a **forward-looking estimate of credit losses** on loans and other eligible financial exposures. Instead of waiting for a loss event (the old "incurred loss" world), IFRS 9 requires institutions to recognize an allowance based on what they expect could happen — including reasonable macro-economic forecasts.

## The three-stage model

| Stage | Definition | Loss allowance | Interest revenue |
| ----- | ---------- | -------------- | ---------------- |
| **Stage 1** | Performing assets without a significant increase in credit risk (SICR) since origination | **12-month ECL** (losses from defaults possible in the next 12 months) | On gross carrying amount |
| **Stage 2** | Significant increase in credit risk, but not credit-impaired | **Lifetime ECL** | On gross carrying amount |
| **Stage 3** | Credit-impaired assets (evidence of default, forbearance, DPD ≥ 90, etc.) | **Lifetime ECL** | *Reporting consideration:* interest is recognized on the net amount (gross less allowance) rather than the gross amount |

### Staging proxies used by ECLens AI

The deterministic engine assigns stages from observable fields:

- **Stage 3** — `defaultFlag` is set or `daysPastDue ≥ 90`.
- **Stage 2** — any SICR signal: credit rating downgraded ≥ 2 notches vs origination, `daysPastDue ≥ 30`, `forbearanceFlag`, or `watchlistFlag`.
- **Stage 1** — everything else.

## Core parameters

- **PD — Probability of Default.** Chance the borrower defaults over the horizon. `twelveMonthPd` for Stage 1; `lifetimePd` for Stages 2–3.
- **LGD — Loss Given Default.** Share of exposure lost if default occurs, net of recoveries (e.g., collateral).
- **EAD — Exposure at Default.** Expected balance at default: `grossCarryingAmount + undrawnCommitment × creditConversionFactor`.
- **DF — Discount Factor.** Losses are discounted at the exposure's **effective interest rate** over the expected loss-emergence period.
- **Forward-looking scenario weights.** Each exposure's loss is computed under **base**, **upside**, and **downside** macro scenarios, then combined using approved weights (they must sum to 1).

## The calculation (what the engine actually does)

For each exposure and each scenario *s* with weight *wₛ* and PD multiplier *mₛ*:

```
EAD        = grossCarryingAmount + undrawnCommitment × creditConversionFactor
ECLₛ       = (PD × mₛ) × LGD × EAD × DF(EIR, horizon)
WeightedECL = Σₛ wₛ × ECLₛ
```

- `PD` = `twelveMonthPd` for Stage 1, else `lifetimePd`.
- `DF` discounts at the effective interest rate over half the loss horizon (12 months for Stage 1, the configured lifetime horizon otherwise) — an explainable simplification documented per run.
- Scenario multipliers express how each macro view shifts PD (downside > 1, upside < 1) and come from the approved `ModelConfiguration`.

The **allowance** for a portfolio is the sum of weighted ECLs. **Coverage ratio** = total ECL allowance ÷ total gross exposure.

## The AI boundary

AI in ECLens AI may: explain a result, extract data from documents, classify exposures, and recommend reviews. It **never** computes the authoritative ECL — that is the deterministic engine's job, and every run stores the exact inputs so auditors can reproduce every figure.
