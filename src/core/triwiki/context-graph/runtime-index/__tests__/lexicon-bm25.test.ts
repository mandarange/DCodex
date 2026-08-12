import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_LEXICON_FIELD_COUNT,
  CONTEXT_LEXICON_SCORE_MAX,
  ContextLexiconError,
  accumulateLexiconScores,
  bm25fScore,
  bm25fWeightedTermFrequency,
  deterministicLn,
  fromLexiconFixedScore,
  lexiconIdf,
  toLexiconFixedScore,
} from '../lexicon.js';
import { CONFIG, FIELD, build, docs, scoreFor } from './lexicon-fixtures.js';

/**
 * Scores decide result order, and they are computed once at compile time and
 * written into an index addressed by its own content hash. Two things follow,
 * and both are asserted here:
 *
 *   - The arithmetic must be bit-identical across engines, so `deterministicLn`
 *     is checked against `Math.log` for accuracy *and* against itself for
 *     stability. A one-ULP difference on a rounding boundary changes a stored
 *     integer and therefore the identity of the whole generation.
 *   - The conversion to fixed point must saturate, never wrap. A wrapped score
 *     does not merely mis-rank: it inverts the ranking, turning the best match
 *     into the worst.
 */

function tf(field: number, value: number): number[] {
  const array = new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(0);
  array[field] = value;
  return array;
}

function lengths(value: number): number[] {
  return new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(value);
}

// ---------------------------------------------------------------------------
// BM25F arithmetic
// ---------------------------------------------------------------------------

test('the deterministic logarithm matches Math.log and never varies', () => {
  for (const value of [1, 1.5, 2, 7, 1000, 26973, 1e12]) {
    assert.ok(Math.abs(deterministicLn(value) - Math.log(value)) < 1e-12, `ln(${value})`);
  }
  const repeated = deterministicLn(26_973);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    assert.equal(deterministicLn(26_973), repeated);
  }
  assert.throws(() => deterministicLn(0), ContextLexiconError);
  assert.throws(() => deterministicLn(Number.NaN), ContextLexiconError);
});

test('IDF falls monotonically as a term becomes common, and stays positive', () => {
  let previous = Number.POSITIVE_INFINITY;
  for (let df = 1; df <= 1000; df += 1) {
    const idf = lexiconIdf(1000, df);
    assert.ok(idf < previous, `idf must fall at df=${df}`);
    assert.ok(idf > 0, `idf must stay positive at df=${df}`);
    previous = idf;
  }
  assert.ok(lexiconIdf(1000, 999) < lexiconIdf(1000, 1) / 100, 'a near-universal term must be worth almost nothing');
  assert.equal(lexiconIdf(0, 0), 0);
});

test('field weight orders two otherwise identical matches', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'compaction' }] },
    { node: 1, fields: [{ field: FIELD.EVIDENCE, text: 'compaction' }] },
  ]));
  assert.ok(scoreFor(built, 'compaction', 0) > scoreFor(built, 'compaction', 1));
});

test('length normalization discounts a term buried in a long field', () => {
  const long = `compaction ${Array.from({ length: 40 }, (_value, index) => `filler${index}`).join(' ')}`;
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EVIDENCE, text: 'compaction' }] },
    { node: 1, fields: [{ field: FIELD.EVIDENCE, text: long }] },
  ]));
  assert.ok(scoreFor(built, 'compaction', 0) > scoreFor(built, 'compaction', 1));
});

test('term frequency outranks a single mention at equal field length', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EVIDENCE, text: 'compaction compaction alpha beta' }] },
    { node: 1, fields: [{ field: FIELD.EVIDENCE, text: 'compaction gamma delta epsilon' }] },
  ]));
  assert.ok(scoreFor(built, 'compaction', 0) > scoreFor(built, 'compaction', 1));
});

test('a repeated term saturates rather than accumulating without bound', () => {
  const once = bm25fScore(bm25fWeightedTermFrequency(tf(FIELD.EVIDENCE, 1), lengths(20), lengths(20), CONFIG), 5, CONFIG);
  const many = bm25fScore(bm25fWeightedTermFrequency(tf(FIELD.EVIDENCE, 100), lengths(20), lengths(20), CONFIG), 5, CONFIG);
  assert.ok(many > once);
  assert.ok(many < 5, 'BM25 must stay below the IDF ceiling however often a term repeats');
});

// ---------------------------------------------------------------------------
// Fixed point
// ---------------------------------------------------------------------------

test('fixed-point scores saturate instead of wrapping', () => {
  // A wrapped score does not merely mis-rank: it inverts the ranking, so the
  // best match becomes the worst.
  assert.equal(toLexiconFixedScore(1.5), 1500);
  assert.equal(toLexiconFixedScore(0), 0);
  assert.equal(toLexiconFixedScore(-5), 0);
  assert.equal(toLexiconFixedScore(1e308), CONTEXT_LEXICON_SCORE_MAX);
  assert.equal(toLexiconFixedScore(Number.POSITIVE_INFINITY), CONTEXT_LEXICON_SCORE_MAX);
  assert.equal(toLexiconFixedScore(CONTEXT_LEXICON_SCORE_MAX), CONTEXT_LEXICON_SCORE_MAX);
  assert.throws(() => toLexiconFixedScore(Number.NaN), ContextLexiconError);
  assert.ok(Math.abs(fromLexiconFixedScore(toLexiconFixedScore(3.25)) - 3.25) < 1e-9);
});

test('the 64-bit accumulator clamps at the signed 64-bit boundary', () => {
  const i64Max = (1n << 63n) - 1n;
  assert.equal(accumulateLexiconScores([1000, 2000, 3]), 3003n);
  assert.equal(accumulateLexiconScores(new Array<number>(10).fill(1e18)), i64Max);
  assert.equal(accumulateLexiconScores([]), 0n);
  assert.throws(() => accumulateLexiconScores([Number.POSITIVE_INFINITY]), ContextLexiconError);
});

test('a real build never produces a score outside the posting row', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'compaction compaction compaction' }] },
    { node: 1, fields: [{ field: FIELD.MANIFEST_NAME, text: 'compaction' }] },
  ]));
  for (const posting of built.postings) {
    assert.ok(Number.isInteger(posting.score));
    assert.ok(posting.score >= 0 && posting.score <= CONTEXT_LEXICON_SCORE_MAX);
  }
});
