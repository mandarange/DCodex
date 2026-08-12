/**
 * BM25F scoring arithmetic, and the fixed-point conversion that gets a score
 * into a posting row.
 *
 * Every number here is computed from IEEE-754 add, subtract, multiply and
 * divide only. Those four operations are exactly specified, so they are
 * bit-identical on every engine; `Math.log`, `Math.pow` and `Math.exp` are
 * explicitly permitted to be implementation-approximated. That distinction
 * matters because these values are rounded to integers and written into an
 * index addressed by its own content hash: one differing ULP landing on a
 * rounding boundary changes a byte, and a changed byte changes the identity of
 * the whole generation. Hence `deterministicLn` rather than `Math.log`.
 *
 * Scores are also the only thing that decides result order, so the conversion
 * to fixed point saturates rather than wrapping. A wrapped score does not
 * merely mis-rank: it inverts the ranking, turning the strongest match into the
 * weakest.
 */
import {
  CONTEXT_INDEX_FIXED_POINT_SCALE,
  clampScore,
  fromFixedPoint,
  toFixedPoint,
} from './format.js';
import {
  CONTEXT_LEXICON_FIELD_COUNT,
  lexiconFieldConfig,
  refuseLexicon as refuse,
  type ContextLexiconConfig,
} from './lexicon-contract.js';

const LN_2 = 0.6931471805599453;
const LN_SERIES_TERMS = 25;

/**
 * `ln` built from IEEE-754 add/sub/mul/div only — see the module header for why
 * `Math.log` is not used.
 *
 * Halving and doubling by two are exact in binary floating point, so reducing
 * the mantissa to [1, 2) introduces no error at all, and the atanh series
 * converges to well under a ULP over that range.
 */
export function deterministicLn(value: number): number {
  if (!Number.isFinite(value) || value <= 0) refuse('score_not_finite', {});
  let mantissa = value;
  let exponent = 0;
  while (mantissa >= 2) {
    mantissa /= 2;
    exponent += 1;
  }
  while (mantissa < 1) {
    mantissa *= 2;
    exponent -= 1;
  }
  const z = (mantissa - 1) / (mantissa + 1);
  const zSquared = z * z;
  let term = z;
  let sum = z;
  for (let k = 3; k <= LN_SERIES_TERMS; k += 2) {
    term *= zSquared;
    sum += term / k;
  }
  return exponent * LN_2 + 2 * sum;
}

/**
 * Lucene's BM25 IDF. Monotonically decreasing in document frequency and always
 * positive, so a term present in nearly every node contributes almost nothing
 * instead of contributing a negative score that would push a matching node
 * below a non-matching one.
 */
export function lexiconIdf(documentCount: number, documentFrequency: number): number {
  if (documentCount <= 0) return 0;
  const df = documentFrequency < 0 ? 0 : documentFrequency > documentCount ? documentCount : documentFrequency;
  return deterministicLn(1 + (documentCount - df + 0.5) / (df + 0.5));
}

/**
 * BM25F weighted term frequency: fields are normalized individually and then
 * summed, rather than summing raw frequencies and normalizing once. The
 * difference matters here because a one-word label and a paragraph of evidence
 * text share a document.
 *
 * A field with zero weight is skipped entirely. That is what keeps the
 * canonical-id field out of the score: §4 of the contract gives exact
 * confidence to the anchor lane alone, so a canonical id BM25F could reach
 * would be a text overlap reported as a relation.
 */
export function bm25fWeightedTermFrequency(
  fieldTermFrequency: readonly number[],
  fieldLength: readonly number[],
  averageFieldLength: readonly number[],
  config: ContextLexiconConfig,
): number {
  let accumulated = 0;
  for (let field = 0; field < CONTEXT_LEXICON_FIELD_COUNT; field += 1) {
    const settings = lexiconFieldConfig(config, field);
    if (!settings.lexical || settings.weight <= 0) continue;
    const frequency = fieldTermFrequency[field] ?? 0;
    if (frequency <= 0) continue;
    const average = averageFieldLength[field] ?? 0;
    const length = fieldLength[field] ?? 0;
    const b = settings.lengthNormalization;
    const normalizer = average > 0 ? 1 - b + (b * length) / average : 1;
    accumulated += (settings.weight * frequency) / (normalizer > 0 ? normalizer : 1);
  }
  return accumulated;
}

export function bm25fScore(
  weightedTermFrequency: number,
  idf: number,
  config: ContextLexiconConfig,
): number {
  if (weightedTermFrequency <= 0) return 0;
  return (idf * weightedTermFrequency) / (config.k1 + weightedTermFrequency);
}

// ---------------------------------------------------------------------------
// Fixed point
// ---------------------------------------------------------------------------

/** Widest score a posting row can carry; the row field is 32 bits. */
export const CONTEXT_LEXICON_SCORE_MAX = 0x7fff_ffff;

/** Saturating, never wrapping — see the module header. */
export function toLexiconFixedScore(value: number): number {
  if (Number.isNaN(value)) refuse('score_not_finite', {});
  if (value === Number.POSITIVE_INFINITY) return CONTEXT_LEXICON_SCORE_MAX;
  if (value <= 0) return 0;
  const scaled = toFixedPoint(value, CONTEXT_INDEX_FIXED_POINT_SCALE);
  if (!Number.isFinite(scaled) || scaled >= CONTEXT_LEXICON_SCORE_MAX) return CONTEXT_LEXICON_SCORE_MAX;
  return scaled;
}

export function fromLexiconFixedScore(value: number): number {
  return fromFixedPoint(value, CONTEXT_INDEX_FIXED_POINT_SCALE);
}

/**
 * The kernel sums per-term scores in 64-bit, because a query with many terms
 * over a large posting cap can exceed what a single posting row holds. The
 * accumulator saturates at the i64 boundary for the same reason the row
 * saturates at the i32 one.
 */
export function accumulateLexiconScores(values: Iterable<number>): bigint {
  let total = 0n;
  for (const value of values) {
    if (!Number.isFinite(value)) refuse('score_not_finite', {});
    total = clampScore(total + BigInt(Math.trunc(value)));
  }
  return total;
}
