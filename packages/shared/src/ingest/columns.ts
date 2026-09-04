/**
 * Canonical portfolio column specification and automatic header mapping.
 *
 * The canonical field keys are the single source of truth shared by the CSV /
 * XLSX template, the mapping UI, the Zod row validator and the Prisma schema.
 * Header suggestion is deterministic string scoring — no model inference — so
 * the same file always produces the same proposal.
 */

export const PORTFOLIO_FIELDS = [
  'exposureId',
  'borrowerId',
  'borrowerName',
  'segment',
  'productType',
  'originationDate',
  'maturityDate',
  'reportingDate',
  'currency',
  'grossCarryingAmount',
  'undrawnCommitment',
  'creditConversionFactor',
  'effectiveInterestRate',
  'daysPastDue',
  'originalCreditRating',
  'currentCreditRating',
  'twelveMonthPd',
  'lifetimePd',
  'lgd',
  'collateralValue',
  'defaultFlag',
  'creditImpairedFlag',
  'forbearanceFlag',
  'restructuringFlag',
  'watchlistFlag',
  'pdAtOrigination',
  'region',
  'industry',
] as const;

export type PortfolioField = (typeof PORTFOLIO_FIELDS)[number];

export const FIELD_KINDS = [
  'TEXT',
  'MONEY',
  'RATE',
  'INTEGER',
  'ISO_DATE',
  'BOOLEAN',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldSpec {
  key: PortfolioField;
  /** Header text used in the downloadable template. */
  label: string;
  kind: FieldKind;
  required: boolean;
  description: string;
  /** Alternative header spellings accepted by the automatic suggester. */
  aliases: string[];
  /** Value applied when the column is absent or the cell is blank. */
  defaultValue?: string;
}

export const FIELD_SPECS: Record<PortfolioField, FieldSpec> = {
  exposureId: {
    key: 'exposureId',
    label: 'exposure_id',
    kind: 'TEXT',
    required: true,
    description: 'Unique loan/account identifier within the organisation.',
    aliases: ['loan_id', 'account_number', 'loan_account_no', 'facility_id', 'contract_id', 'exposure'],
  },
  borrowerId: {
    key: 'borrowerId',
    label: 'borrower_id',
    kind: 'TEXT',
    required: false,
    description: 'Obligor identifier. Defaults to exposure_id when absent.',
    aliases: ['customer_id', 'client_id', 'obligor_id', 'cif'],
    defaultValue: '',
  },
  borrowerName: {
    key: 'borrowerName',
    label: 'borrower_name',
    kind: 'TEXT',
    required: true,
    description: 'Obligor name. Synthetic in demo data.',
    aliases: ['customer_name', 'client_name', 'obligor_name', 'borrower'],
  },
  segment: {
    key: 'segment',
    label: 'segment',
    kind: 'TEXT',
    required: true,
    description: 'Portfolio segment: consumer, sme, agriculture, microfinance or corporate.',
    aliases: ['portfolio_segment', 'book', 'segment_name', 'borrower_segment'],
  },
  productType: {
    key: 'productType',
    label: 'product_type',
    kind: 'TEXT',
    required: true,
    description: 'Product name, e.g. auto_loan, revolving_credit, term_loan.',
    aliases: ['product', 'facility_type', 'loan_type', 'product_name'],
  },
  originationDate: {
    key: 'originationDate',
    label: 'origination_date',
    kind: 'ISO_DATE',
    required: true,
    description: 'Date the facility was booked, ISO YYYY-MM-DD.',
    aliases: ['booking_date', 'disbursement_date', 'start_date', 'origination'],
  },
  maturityDate: {
    key: 'maturityDate',
    label: 'maturity_date',
    kind: 'ISO_DATE',
    required: true,
    description: 'Contractual maturity, ISO YYYY-MM-DD. Must be after the reporting date.',
    aliases: ['due_date', 'end_date', 'expiry_date', 'maturity'],
  },
  reportingDate: {
    key: 'reportingDate',
    label: 'reporting_date',
    kind: 'ISO_DATE',
    required: true,
    description: 'As-of date of the balances in this row, ISO YYYY-MM-DD.',
    aliases: ['as_of_date', 'snapshot_date', 'observation_date', 'data_date'],
  },
  currency: {
    key: 'currency',
    label: 'currency',
    kind: 'TEXT',
    required: true,
    description: 'ISO 4217 code, e.g. PKR.',
    aliases: ['ccy', 'currency_code', 'iso_currency'],
    defaultValue: 'PKR',
  },
  grossCarryingAmount: {
    key: 'grossCarryingAmount',
    label: 'gross_carrying_amount',
    kind: 'MONEY',
    required: true,
    description: 'Drawn outstanding balance before any loss allowance.',
    aliases: ['outstanding_balance', 'principal_outstanding', 'drawn_balance', 'gross_balance', 'balance'],
  },
  undrawnCommitment: {
    key: 'undrawnCommitment',
    label: 'undrawn_commitment',
    kind: 'MONEY',
    required: false,
    description: 'Committed but undrawn limit. 0 for fully drawn term loans.',
    aliases: ['undrawn_limit', 'undrawn', 'available_limit', 'commitment_undrawn'],
    defaultValue: '0',
  },
  creditConversionFactor: {
    key: 'creditConversionFactor',
    label: 'credit_conversion_factor',
    kind: 'RATE',
    required: false,
    description: 'CCF as a decimal 0..1 applied to the undrawn commitment.',
    aliases: ['ccf', 'conversion_factor', 'undrawn_ccf'],
    defaultValue: '0',
  },
  effectiveInterestRate: {
    key: 'effectiveInterestRate',
    label: 'effective_interest_rate',
    kind: 'RATE',
    required: true,
    description: 'Original EIR used for discounting, as a decimal (0.185 = 18.5%).',
    aliases: ['eir', 'effective_rate', 'interest_rate', 'contract_rate', 'apr'],
  },
  daysPastDue: {
    key: 'daysPastDue',
    label: 'days_past_due',
    kind: 'INTEGER',
    required: true,
    description: 'Days past due at the reporting date. 0 when current.',
    aliases: ['dpd', 'days_delinquent', 'past_due_days', 'arrears_days'],
    defaultValue: '0',
  },
  originalCreditRating: {
    key: 'originalCreditRating',
    label: 'original_credit_rating',
    kind: 'TEXT',
    required: true,
    description: 'Internal rating grade at origination (AAA..D).',
    aliases: ['origination_rating', 'rating_at_origination', 'original_rating', 'grade_at_booking'],
  },
  currentCreditRating: {
    key: 'currentCreditRating',
    label: 'current_credit_rating',
    kind: 'TEXT',
    required: true,
    description: 'Current internal rating grade (AAA..D).',
    aliases: ['current_rating', 'rating', 'current_grade', 'rating_grade'],
  },
  twelveMonthPd: {
    key: 'twelveMonthPd',
    label: 'twelve_month_pd',
    kind: 'RATE',
    required: true,
    description: '12-month point-in-time PD as a decimal (0.0125 = 1.25%).',
    aliases: ['pd_12m', 'pd12', 'one_year_pd', 'pit_pd_12m', 'pd_1yr'],
  },
  lifetimePd: {
    key: 'lifetimePd',
    label: 'lifetime_pd',
    kind: 'RATE',
    required: true,
    description: 'Lifetime PD over the remaining contractual term, as a decimal.',
    aliases: ['pd_lifetime', 'lifetime_pd_pct', 'pd_life', 'ltv_pd'],
  },
  lgd: {
    key: 'lgd',
    label: 'lgd',
    kind: 'RATE',
    required: true,
    description: 'Loss given default as a decimal (0.45 = 45%).',
    aliases: ['loss_given_default', 'lgd_pct', 'downturn_lgd'],
  },
  collateralValue: {
    key: 'collateralValue',
    label: 'collateral_value',
    kind: 'MONEY',
    required: false,
    description: 'Latest appraised collateral value. Informational for coverage analysis.',
    aliases: ['collateral', 'security_value', 'collateral_appraised_value'],
    defaultValue: '0',
  },
  defaultFlag: {
    key: 'defaultFlag',
    label: 'default_flag',
    kind: 'BOOLEAN',
    required: false,
    description: 'True when the exposure meets the definition of default. Drives Stage 3.',
    aliases: ['is_default', 'default', 'defaulted'],
    defaultValue: 'false',
  },
  creditImpairedFlag: {
    key: 'creditImpairedFlag',
    label: 'credit_impaired_flag',
    kind: 'BOOLEAN',
    required: false,
    description: 'True when objective evidence of impairment exists. Drives Stage 3.',
    aliases: ['credit_impaired', 'impaired', 'is_impaired', 'poci_flag'],
    defaultValue: 'false',
  },
  forbearanceFlag: {
    key: 'forbearanceFlag',
    label: 'forbearance_flag',
    kind: 'BOOLEAN',
    required: false,
    description: 'True when a concession has been granted. SICR (Stage 2) trigger.',
    aliases: ['forbearance', 'is_forbearance', 'concession_granted'],
    defaultValue: 'false',
  },
  restructuringFlag: {
    key: 'restructuringFlag',
    label: 'restructuring_flag',
    kind: 'BOOLEAN',
    required: false,
    description: 'True when terms were modified due to borrower distress. SICR trigger.',
    aliases: ['restructured', 'is_restructured', 'restructuring'],
    defaultValue: 'false',
  },
  watchlistFlag: {
    key: 'watchlistFlag',
    label: 'watchlist_flag',
    kind: 'BOOLEAN',
    required: false,
    description: 'True when the exposure is on the early-warning watchlist. SICR trigger.',
    aliases: ['watchlist', 'on_watchlist', 'early_warning_flag'],
    defaultValue: 'false',
  },
  pdAtOrigination: {
    key: 'pdAtOrigination',
    label: 'pd_at_origination',
    kind: 'RATE',
    required: false,
    description:
      '12-month PD at origination, used by the PD-increase SICR test. Defaults to twelve_month_pd when absent, which disables that test for the row.',
    aliases: ['origination_pd', 'pd_origination', 'pd_at_booking', 'original_pd'],
    defaultValue: '',
  },
  region: {
    key: 'region',
    label: 'region',
    kind: 'TEXT',
    required: false,
    description: 'Geographic region of the obligor.',
    aliases: ['province', 'territory', 'geo_region', 'branch_region'],
    defaultValue: 'Unspecified',
  },
  industry: {
    key: 'industry',
    label: 'industry',
    kind: 'TEXT',
    required: false,
    description: 'Industry classification of the obligor.',
    aliases: ['sector', 'industry_code', 'business_sector', 'niche'],
    defaultValue: 'Unspecified',
  },
};

export const FIELD_SPEC_LIST: FieldSpec[] = PORTFOLIO_FIELDS.map((key) => FIELD_SPECS[key]);
export const REQUIRED_FIELDS: PortfolioField[] = PORTFOLIO_FIELDS.filter((key) => FIELD_SPECS[key].required);

/** Lowercase alphanumerics only, so "Gross Carrying Amount" == "gross_carrying_amount". */
export function normalizeHeaderText(header: string): string {
  return header
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface HeaderSuggestion {
  field: PortfolioField;
  header: string;
  /** 0..1. >= 0.9 is an exact alias/label match; lower scores need review. */
  confidence: number;
  matchedOn: 'LABEL' | 'KEY' | 'ALIAS' | 'TOKEN_OVERLAP' | 'SUBSTRING';
}

export type SuggestedMapping = Record<PortfolioField, HeaderSuggestion | null>;

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  );
}

/**
 * Proposes a header for every canonical field.
 *
 * A header can only be suggested for one field: candidates are scored, sorted
 * deterministically, then greedily assigned so two fields never claim the same
 * column.
 */
export function suggestHeaderMapping(headers: string[]): SuggestedMapping {
  const mapping = PORTFOLIO_FIELDS.reduce((acc, field) => {
    acc[field] = null;
    return acc;
  }, {} as SuggestedMapping);

  interface Candidate {
    field: PortfolioField;
    header: string;
    headerIndex: number;
    confidence: number;
    matchedOn: HeaderSuggestion['matchedOn'];
  }
  const candidates: Candidate[] = [];

  headers.forEach((header, headerIndex) => {
    const normalizedHeader = normalizeHeaderText(header);
    if (normalizedHeader.length === 0) return;
    const headerTokens = tokenSet(header);

    for (const field of PORTFOLIO_FIELDS) {
      const spec = FIELD_SPECS[field];
      const normalizedLabel = normalizeHeaderText(spec.label);
      const normalizedKey = normalizeHeaderText(spec.key);

      if (normalizedHeader === normalizedLabel) {
        candidates.push({ field, header, headerIndex, confidence: 1, matchedOn: 'LABEL' });
        continue;
      }
      if (normalizedHeader === normalizedKey) {
        candidates.push({ field, header, headerIndex, confidence: 0.98, matchedOn: 'KEY' });
        continue;
      }
      const aliasHit = spec.aliases.map(normalizeHeaderText).includes(normalizedHeader);
      if (aliasHit) {
        candidates.push({ field, header, headerIndex, confidence: 0.95, matchedOn: 'ALIAS' });
        continue;
      }

      const fieldTokens = tokenSet(`${spec.label} ${spec.key} ${spec.aliases.join(' ')}`);
      const overlap = [...headerTokens].filter((token) => fieldTokens.has(token)).length;
      if (overlap > 0 && headerTokens.size > 0) {
        const score = 0.4 + 0.4 * (overlap / Math.max(headerTokens.size, 1));
        candidates.push({ field, header, headerIndex, confidence: Number(score.toFixed(4)), matchedOn: 'TOKEN_OVERLAP' });
        continue;
      }

      if (
        normalizedHeader.length >= 6 &&
        (normalizedHeader.includes(normalizedLabel) || normalizedLabel.includes(normalizedHeader))
      ) {
        candidates.push({ field, header, headerIndex, confidence: 0.55, matchedOn: 'SUBSTRING' });
      }
    }
  });

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.field !== b.field) return a.field.localeCompare(b.field);
    return a.headerIndex - b.headerIndex;
  });

  const claimedHeaders = new Set<string>();
  for (const candidate of candidates) {
    if (mapping[candidate.field]) continue;
    if (claimedHeaders.has(candidate.header)) continue;
    claimedHeaders.add(candidate.header);
    mapping[candidate.field] = {
      field: candidate.field,
      header: candidate.header,
      confidence: candidate.confidence,
      matchedOn: candidate.matchedOn,
    };
  }

  return mapping;
}

/** Fields whose canonical header was not found in the uploaded file. */
export function missingRequiredHeaders(mapping: SuggestedMapping): PortfolioField[] {
  return REQUIRED_FIELDS.filter((field) => !mapping[field]);
}
