/**
 * Shared vocabulary for the identifier-aware lexicon: field identity, the
 * tuning-surface shape, refusal, and the ordering rule.
 *
 * Everything here is depended on by the tokenizer, the scorer and the builder,
 * and it depends on none of them. That is the reason it is its own module: the
 * three consumers must agree on what a field is and how two terms compare, and
 * a shared definition is the only way that agreement survives an edit.
 *
 * Ordering is by UTF-16 code unit, never `localeCompare`. Collation varies by
 * ICU build, and the term table's order is what a reader binary-searches and
 * what the index's content hash is taken over — a locale-sensitive comparison
 * would make the same snapshot compile to different bytes on different
 * machines.
 */

export const CONTEXT_LEXICON_SCHEMA = 'sks.context-lexicon.v1' as const;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * Field ids double as bit positions in `fieldMask`, so the numbering is part of
 * the on-disk contract and may not be reordered.
 */
export const CONTEXT_LEXICON_FIELD = {
  CANONICAL_ID: 0,
  EXACT_LABEL: 1,
  SYMBOL_SEGMENT: 2,
  MANIFEST_NAME: 3,
  BASENAME: 4,
  PATH_SEGMENT: 5,
  PURPOSE: 6,
  EVIDENCE: 7,
  COARSE: 8,
} as const;

export type ContextLexiconFieldId = (typeof CONTEXT_LEXICON_FIELD)[keyof typeof CONTEXT_LEXICON_FIELD];

export const CONTEXT_LEXICON_FIELD_COUNT = 9;

export function lexiconFieldMask(field: ContextLexiconFieldId): number {
  return (1 << field) >>> 0;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CONTEXT_LEXICON_ERRORS = {
  field_not_lexical: 'context_lexicon_field_not_lexical',
  unknown_field: 'context_lexicon_unknown_field',
  machine_path: 'context_lexicon_machine_path',
  duplicate_node: 'context_lexicon_duplicate_node',
  node_out_of_range: 'context_lexicon_node_out_of_range',
  count_limit: 'context_lexicon_count_limit',
  score_not_finite: 'context_lexicon_score_not_finite',
  config_invalid: 'context_lexicon_config_invalid',
} as const;

export type ContextLexiconErrorCode = keyof typeof CONTEXT_LEXICON_ERRORS;

export const CONTEXT_LEXICON_REPAIR_COMMAND = 'sks align run --rebuild-index' as const;

/**
 * Integers only, for the same reason `ContextIndexFormatError` carries integers
 * only: the inputs here are workspace text, and a rejected token is exactly the
 * token you least want copied into a log line. A rejection that echoed its
 * input would be the leak it was raised to prevent.
 */
export class ContextLexiconError extends Error {
  readonly code: ContextLexiconErrorCode;
  readonly publicCode: string;
  readonly repairCommand: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextLexiconErrorCode, detail: Record<string, number> = {}) {
    super(code);
    this.name = 'ContextLexiconError';
    this.code = code;
    this.publicCode = CONTEXT_LEXICON_ERRORS[code];
    this.repairCommand = CONTEXT_LEXICON_REPAIR_COMMAND;
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (Number.isFinite(value)) numeric[key] = value;
    }
    this.detail = Object.freeze(numeric);
  }
}

export function refuseLexicon(code: ContextLexiconErrorCode, detail?: Record<string, number>): never {
  throw new ContextLexiconError(code, detail);
}

// ---------------------------------------------------------------------------
// Tuning surface
// ---------------------------------------------------------------------------

export interface ContextLexiconFieldConfig {
  /** BM25F field weight. `0` means the field is not scored by BM25F at all. */
  readonly weight: number;
  /** BM25F `b`: how strongly a long field is discounted. */
  readonly lengthNormalization: number;
  /** Field is tokenized into the lexicon. `false` means the anchor lane owns it. */
  readonly lexical: boolean;
  /** Keep the whole normalized value as one term, so a pasted label still hits. */
  readonly keepWholeValue: boolean;
  /** Value is a path; machine paths are refused rather than redacted. */
  readonly pathLike: boolean;
}

export interface ContextLexiconConfig {
  readonly schema: typeof CONTEXT_LEXICON_SCHEMA;
  /** Indexed by `ContextLexiconFieldId`; length is `CONTEXT_LEXICON_FIELD_COUNT`. */
  readonly fields: readonly ContextLexiconFieldConfig[];
  /** BM25 `k1`: how quickly repeated occurrences stop adding score. */
  readonly k1: number;

  readonly minSegmentLength: number;
  readonly minAcronymLength: number;
  readonly maxAcronymSegments: number;
  /** Longest extension still joined back onto its stem, as in `context.ts`. */
  readonly maxExtensionLength: number;
  readonly maxTokenLength: number;
  readonly maxTokensPerField: number;
  readonly preserveExactCase: boolean;

  /** Ascending; order fixes emission order, which reaches the term table. */
  readonly cjkNgramSizes: readonly number[];
  readonly maxCjkRunLength: number;
  readonly maxCjkNgramsPerRun: number;

  readonly minSecretTokenLength: number;
  readonly minHexSecretLength: number;

  readonly postingCapPerTerm: number;
  readonly maxTerms: number;
  readonly maxQueryTerms: number;
}

/**
 * The values live in `query/ranking-config.ts`, which is the only file besides
 * `profiles.ts` the bounded optimizer may edit. A weight the optimizer cannot
 * see is a weight that drifts, so there is deliberately no default anywhere in
 * this directory to fall back on: every entry point takes the config as a
 * required argument, and a second copy of `4.0` at a call site is the one
 * outcome this arrangement exists to prevent.
 */
export function lexiconFieldConfig(config: ContextLexiconConfig, field: number): ContextLexiconFieldConfig {
  const entry = config.fields[field];
  if (entry === undefined) refuseLexicon('unknown_field', { field });
  return entry;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * What the compiler chose not to index, as counts. Every field here is a place
 * where a bound was hit, and a silent bound is a recall regression nothing can
 * attribute later.
 */
export interface ContextLexiconOmissions {
  readonly secretTokens: number;
  readonly redactedSpans: number;
  readonly cappedFieldTokens: number;
  readonly cappedCjkNgrams: number;
  readonly cappedPostings: number;
  readonly cappedTerms: number;
}

export interface MutableLexiconOmissions {
  secretTokens: number;
  redactedSpans: number;
  cappedFieldTokens: number;
  cappedCjkNgrams: number;
  cappedPostings: number;
  cappedTerms: number;
}

export function emptyLexiconOmissions(): MutableLexiconOmissions {
  return {
    secretTokens: 0,
    redactedSpans: 0,
    cappedFieldTokens: 0,
    cappedCjkNgrams: 0,
    cappedPostings: 0,
    cappedTerms: 0,
  };
}

export function freezeLexiconOmissions(value: MutableLexiconOmissions): ContextLexiconOmissions {
  return Object.freeze({ ...value });
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Code-unit order. See the module header for why this is not `localeCompare`. */
export function compareLexiconTerms(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
