# Data Dictionary

Field-level definitions for the exposure-level data used across ECLens AI (import templates, API payloads, Prisma `Exposure` model, and UI tables).

| Field                     | Type        | Description                                                                                          | Example                      |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| `exposureId`              | string      | Unique, human-readable exposure identifier.                                                           | `EX-1007`                    |
| `borrowerId`              | string      | Identifier of the borrowing entity/customer.                                                          | `BRW-2007`                   |
| `borrowerName`            | string      | Borrower display name (synthetic in demo data).                                                       | `Margalla Traders`           |
| `segment`                 | string      | Portfolio segment: Corporate, SME, Retail Mortgage, Auto Finance, Microfinance, Credit Card.          | `SME`                        |
| `productType`             | string      | Product within the segment (e.g., Term Loan, Working Capital, Mortgage).                              | `Working Capital Finance`    |
| `originationDate`         | date        | Date the exposure was originated.                                                                     | `2023-04-18`                 |
| `maturityDate`            | date        | Contractual maturity.                                                                                 | `2027-04-18`                 |
| `reportingDate`           | date        | Reporting date the snapshot refers to.                                                                | `2026-08-31`                 |
| `currency`                | string      | ISO 4217 currency code of the exposure.                                                               | `PKR`                        |
| `grossCarryingAmount`     | decimal     | Amortized-cost balance before allowance.                                                              | `25,000,000`                 |
| `undrawnCommitment`       | decimal     | Committed but undrawn amount (off-balance sheet).                                                     | `5,000,000`                  |
| `creditConversionFactor`  | number 0–1  | CCF applied to undrawn commitment to estimate drawdown at default.                                    | `0.5`                        |
| `effectiveInterestRate`   | number      | Annual effective interest rate (decimal, e.g., 0.185 = 18.5%). Used for discounting.                  | `0.185`                      |
| `daysPastDue`             | integer     | Days past due at reporting date.                                                                      | `0`                          |
| `originalCreditRating`    | string      | Internal rating at origination.                                                                       | `A`                          |
| `currentCreditRating`     | string      | Internal rating at reporting date.                                                                    | `BBB`                        |
| `twelveMonthPd`           | number 0–1  | 12-month probability of default (point-in-time).                                                      | `0.012`                      |
| `lifetimePd`              | number 0–1  | Lifetime probability of default.                                                                      | `0.048`                      |
| `lgd`                     | number 0–1  | Loss given default, net of expected recoveries.                                                       | `0.42`                       |
| `collateralValue`         | decimal     | Latest collateral valuation (same currency).                                                          | `12,000,000`                 |
| `defaultFlag`             | boolean     | True if the exposure meets the institution's definition of default.                                   | `false`                      |
| `forbearanceFlag`         | boolean     | True if concessional restructuring/forbearance was granted.                                           | `false`                      |
| `watchlistFlag`           | boolean     | True if on the early-warning watchlist.                                                               | `true`                       |
| `region`                  | string      | Borrower region.                                                                                      | `Islamabad`                  |
| `industry`                | string      | Borrower industry.                                                                                    | `Wholesale Trade`            |

## Derived fields

| Field         | Definition                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `stage`       | IFRS 9 stage from staging rules — see `ecl-domain-primer.md`.                                  |
| `ead`         | `grossCarryingAmount + undrawnCommitment × creditConversionFactor`.                             |
| `weightedEcl` | Scenario-weighted PD × LGD × EAD × DF; the allowance contribution of the exposure.             |

## Conventions

- Money is stored as `Decimal` (Prisma) and rendered via `Intl.NumberFormat` with the organization's configured currency (default `PKR`).
- Rates and ratios are decimals (0.12 = 12%), shown as percentages in the UI.
- All demo records are synthetic; identifiers are stable across seed runs for reproducibility.
