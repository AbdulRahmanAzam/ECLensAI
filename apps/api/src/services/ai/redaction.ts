/**
 * Redaction and pseudonymization between the database and the model.
 *
 * Two problems are solved here. First, direct identifiers: a borrower's legal
 * name is not needed to reason about concentration or stage migration, so it
 * leaves the process as a stable alias token instead. Second, accountability:
 * every tool declares which categories of data it contributed, and those
 * categories — not the values — are what get persisted on `AiRequest`.
 *
 * Aliases are restored on the way back. That is safe because the reader of the
 * answer is the same authenticated, permissioned user whose organisation owns
 * the record, and the alias token is a bracketed symbol the model cannot
 * plausibly invent around a real name.
 */
import { env } from '../../config/env';

export type DataCategory =
  | 'PORTFOLIO_AGGREGATES'
  | 'EXPOSURE_IDENTIFIERS'
  | 'EXPOSURE_BALANCES'
  | 'RUN_RESULTS'
  | 'SCENARIO_WEIGHTS'
  | 'STAGE_MIGRATION'
  | 'DATA_QUALITY_ISSUES'
  | 'STAGING_OVERRIDES'
  | 'DOCUMENT_TEXT'
  | 'GOVERNANCE_KNOWLEDGE';

export type RedactionProfile = typeof env.AI_REDACTION_PROFILE;

const ALIAS_PREFIX = '[[BORROWER_';
const ALIAS_SUFFIX = ']]';

export class Redactor {
  private readonly aliases = new Map<string, string>();
  private readonly reverse = new Map<string, string>();
  private readonly categories = new Set<DataCategory>();

  constructor(public readonly profile: RedactionProfile = env.AI_REDACTION_PROFILE) {}

  note(...categories: DataCategory[]): void {
    for (const category of categories) this.categories.add(category);
  }

  get dataCategories(): string[] {
    return [...this.categories].sort();
  }

  get aliasCount(): number {
    return this.aliases.size;
  }

  /**
   * Returns the token that should appear in the prompt in place of a borrower
   * name. With `none` the name passes through unchanged, which is only
   * appropriate for a deployment whose data is already de-identified.
   */
  pseudonymize(name: string | null | undefined): string {
    if (!name) return 'Unknown borrower';
    if (this.profile === 'none') return name;

    const existing = this.aliases.get(name);
    if (existing) return existing;
    const alias = `${ALIAS_PREFIX}${this.aliases.size + 1}${ALIAS_SUFFIX}`;
    this.aliases.set(name, alias);
    this.reverse.set(alias, name);
    return alias;
  }

  /**
   * Sweeps free text — most importantly uploaded document text, where names are
   * not in a known column — for any borrower already pseudonymized in this
   * request, so the two cannot disagree.
   */
  applyToText(text: string): string {
    if (this.profile === 'none' || this.aliases.size === 0) return text;
    let out = text;
    for (const [name, alias] of this.aliases) {
      out = out.split(name).join(alias);
    }
    return out;
  }

  /** Turns alias tokens back into names for the authorized requesting user. */
  restore(text: string): string {
    if (this.reverse.size === 0) return text;
    let out = text;
    for (const [alias, name] of this.reverse) {
      out = out.split(alias).join(name);
    }
    return out;
  }

  restoreAll(values: string[]): string[] {
    return values.map((value) => this.restore(value));
  }

  /**
   * Restores every string leaf of a structured response.
   *
   * An alias can land anywhere in the validated object — in the answer, a
   * caveat, a rationale, a citation quote — so the response boundary needs one
   * call that walks the whole shape rather than one per known field. Key order,
   * array order and non-string leaves are preserved exactly.
   */
  restoreDeep<T>(value: T): T {
    if (this.reverse.size === 0) return value;
    return restoreValue(value, this) as T;
  }
}

function restoreValue(value: unknown, redactor: Redactor): unknown {
  if (typeof value === 'string') return redactor.restore(value);
  if (Array.isArray(value)) return value.map((item) => restoreValue(item, redactor));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = restoreValue(item, redactor);
    }
    return out;
  }
  return value;
}

export function createRedactor(profile: RedactionProfile = env.AI_REDACTION_PROFILE): Redactor {
  return new Redactor(profile);
}

/**
 * Guard for log lines and audit detail. Prompt text can carry balances and
 * names, so nothing that contains a prompt body is ever written to the log;
 * this strips anything that looks like an alias token or a long digit run
 * before a string is safe to log.
 */
export function toLogSafe(value: string, maxLength = 200): string {
  return value
    .replace(/\[\[BORROWER_\d+\]\]/g, '[borrower]')
    .replace(/\d{4,}(?:[.,]\d+)?/g, '[figure]')
    .slice(0, maxLength);
}
