import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_LEXICON_FIELD_COUNT,
  ContextLexiconError,
  decodeLexiconPostingDeltas,
  encodeLexiconPostingDeltas,
  lexiconFieldMask,
  lookupLexiconTerm,
  normalizeLexiconQuery,
  type ContextLexiconConfig,
} from '../lexicon.js';
import { CONFIG, FIELD, build, docs, postingsFor, serialize, termRow } from './lexicon-fixtures.js';

/**
 * The builder produces the artifact everything downstream reads, so the
 * assertions here are about the shape of that artifact rather than about any
 * one score:
 *
 *   - The same corpus compiles to the same index, byte for byte. The generation
 *     is named by its own hash, so this is what makes the name meaningful.
 *   - The term table is sorted by code unit. That is what makes the binary
 *     search legal, and the binary search is what replaces the v1 per-query key
 *     scan — an unsorted table would still "work" by degrading to a scan, which
 *     is exactly the silent downgrade the contract forbids.
 *   - The two cases the whole index exists for — a Korean query and a jargon
 *     acronym — retrieve the right node and only the right node. The v1
 *     baseline returned nothing for both.
 */

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('building the same corpus repeatedly yields an identical index', () => {
  const corpus = docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'queryContextGraphSnapshot' }] },
    { node: 1, fields: [{ field: FIELD.PATH_SEGMENT, text: 'src/core/triwiki/context-graph/query/index.ts' }] },
    { node: 2, fields: [{ field: FIELD.PURPOSE, text: '컨텍스트 그래프 스냅샷을 조회한다' }] },
    { node: 3, fields: [{ field: FIELD.EVIDENCE, text: 'the writer refuses a graph that failed lint' }] },
  ]);
  const first = serialize(build(corpus));
  for (let iteration = 0; iteration < 25; iteration += 1) {
    assert.equal(serialize(build(corpus)), first);
  }
});

test('the term table is ordered by code unit, not by locale', () => {
  // `localeCompare` in most ICU builds sorts `contextGraph` before
  // `ContextGraph`; code-unit order is the opposite. Asserting the code-unit
  // answer is what pins the table against an ICU upgrade.
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'ContextGraph' }] },
    { node: 1, fields: [{ field: FIELD.EXACT_LABEL, text: 'contextgraph' }] },
  ]));
  const list = built.terms.map((row) => row.term);
  assert.ok(list.includes('ContextGraph'));
  assert.ok(list.includes('contextgraph'));
  assert.ok(list.indexOf('ContextGraph') < list.indexOf('contextgraph'));
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1] as string;
    const current = list[index] as string;
    assert.ok(previous < current, `term table not sorted at ${index}`);
  }
});

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

test('postings are node-ascending and delta encoding round-trips', () => {
  assert.deepEqual(encodeLexiconPostingDeltas([3, 5, 9, 40]), [3, 2, 4, 31]);
  assert.deepEqual(decodeLexiconPostingDeltas([3, 2, 4, 31]), [3, 5, 9, 40]);
  assert.deepEqual(encodeLexiconPostingDeltas([]), []);

  const built = build(docs([
    { node: 7, fields: [{ field: FIELD.PURPOSE, text: 'shared token' }] },
    { node: 2, fields: [{ field: FIELD.PURPOSE, text: 'shared token' }] },
    { node: 91, fields: [{ field: FIELD.PURPOSE, text: 'shared token' }] },
  ]));
  assert.deepEqual([...postingsFor(built, 'shared')], [2, 7, 91]);
  const row = termRow(built, 'shared');
  assert.deepEqual(
    decodeLexiconPostingDeltas(built.nodeDeltas, row.postingOffset, row.postingCount),
    [2, 7, 91],
  );
  assert.equal(built.nodeDeltas.length, built.postings.length);
});

test('the per-term posting cap keeps the strongest postings and reports the rest', () => {
  const config: ContextLexiconConfig = { ...CONFIG, postingCapPerTerm: 2 };
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EVIDENCE, text: 'compaction and a great deal of unrelated filler text here' }] },
    { node: 1, fields: [{ field: FIELD.EXACT_LABEL, text: 'compaction' }] },
    { node: 2, fields: [{ field: FIELD.MANIFEST_NAME, text: 'compaction' }] },
  ]), config);
  const kept = postingsFor(built, 'compaction');
  assert.equal(kept.length, 2);
  assert.equal(built.omissions.cappedPostings, 1);
  // The two strongest fields win; the diluted evidence hit is the one dropped.
  assert.deepEqual([...kept], [1, 2]);
});

test('the dictionary cap drops the most common terms, not the rarest', () => {
  // Dropping rare terms would delete exactly the identifiers the index exists
  // to find while keeping the ones whose IDF already makes them worthless.
  const config: ContextLexiconConfig = { ...CONFIG, maxTerms: 2 };
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.PURPOSE, text: 'common rareone' }] },
    { node: 1, fields: [{ field: FIELD.PURPOSE, text: 'common raretwo' }] },
    { node: 2, fields: [{ field: FIELD.PURPOSE, text: 'common' }] },
  ]), config);
  const kept = built.terms.map((row) => row.term);
  assert.deepEqual(kept, ['rareone', 'raretwo']);
  assert.equal(built.omissions.cappedTerms, 1);
});

test('binary search finds every indexed term and rejects the rest', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'queryContextGraphSnapshot' }] },
    { node: 1, fields: [{ field: FIELD.PATH_SEGMENT, text: 'src/core/context.ts' }] },
    { node: 2, fields: [{ field: FIELD.PURPOSE, text: '컨텍스트 그래프' }] },
  ]));
  // Query time does a binary search per term instead of a key scan; the sorted
  // table above is what makes that legal.
  built.terms.forEach((row, index) => assert.equal(lookupLexiconTerm(built.terms, row.term), index));
  for (const absent of ['', 'zzzz', 'Context', '없음']) {
    assert.equal(lookupLexiconTerm(built.terms, absent), -1, absent);
  }
});

// ---------------------------------------------------------------------------
// Build invariants
// ---------------------------------------------------------------------------

test('document frequency counts nodes, not occurrences', () => {
  const built = build(docs([
    { node: 0, fields: [
      { field: FIELD.EXACT_LABEL, text: 'compaction' },
      { field: FIELD.EVIDENCE, text: 'compaction compaction compaction' },
    ] },
    { node: 1, fields: [{ field: FIELD.EVIDENCE, text: 'compaction' }] },
    { node: 2, fields: [{ field: FIELD.EVIDENCE, text: 'unrelated' }] },
  ]));
  assert.equal(termRow(built, 'compaction').documentFrequency, 2);
  assert.equal(built.documentCount, 3);
  const row = built.postings[termRow(built, 'compaction').postingOffset];
  assert.ok(row);
  assert.equal(row.termFrequency, 4);
  assert.equal(
    row.fieldMask,
    lexiconFieldMask(FIELD.EXACT_LABEL) | lexiconFieldMask(FIELD.EVIDENCE),
  );
});

test('average field length is stored as the fixed-point value the scores used', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EVIDENCE, text: 'alpha beta' }] },
    { node: 1, fields: [{ field: FIELD.EVIDENCE, text: 'gamma' }] },
  ]));
  assert.equal(built.averageFieldLengthFixed.length, CONTEXT_LEXICON_FIELD_COUNT);
  assert.equal(built.averageFieldLengthFixed[FIELD.EVIDENCE], 1500);
  assert.equal(built.averageFieldLengthFixed[FIELD.CANONICAL_ID], 0);
  for (const value of built.averageFieldLengthFixed) assert.ok(Number.isInteger(value));
});

test('a repeated or negative node index is refused', () => {
  assert.throws(
    () => build(docs([
      { node: 4, fields: [{ field: FIELD.PURPOSE, text: 'one' }] },
      { node: 4, fields: [{ field: FIELD.PURPOSE, text: 'two' }] },
    ])),
    (error: unknown) => error instanceof ContextLexiconError && error.code === 'duplicate_node',
  );
  assert.throws(
    () => build(docs([{ node: -1, fields: [{ field: FIELD.PURPOSE, text: 'one' }] }])),
    (error: unknown) => error instanceof ContextLexiconError && error.code === 'node_out_of_range',
  );
});

test('a config with the wrong field count is refused rather than half-applied', () => {
  const broken = { ...CONFIG, fields: CONFIG.fields.slice(0, 3) };
  assert.throws(
    () => build(docs([{ node: 0, fields: [] }]), broken),
    (error: unknown) => error instanceof ContextLexiconError && error.code === 'config_invalid',
  );
});

test('an empty corpus builds an empty index rather than failing', () => {
  const built = build(docs([]));
  assert.equal(built.documentCount, 0);
  assert.equal(built.terms.length, 0);
  assert.equal(built.postings.length, 0);
});

// ---------------------------------------------------------------------------
// The cases the index exists to fix
// ---------------------------------------------------------------------------

test('a Korean query retrieves the node the v1 baseline returned nothing for', () => {
  const built = build(docs([
    { node: 0, fields: [
      { field: FIELD.EXACT_LABEL, text: 'queryContextGraphSnapshot' },
      { field: FIELD.PURPOSE, text: '컨텍스트 그래프 스냅샷을 조회한다' },
    ] },
    { node: 1, fields: [{ field: FIELD.PURPOSE, text: 'release gate proof aggregation' }] },
  ]));
  const hits = new Set<number>();
  for (const term of normalizeLexiconQuery('컨텍스트를 조회하는 함수', CONFIG).terms) {
    const at = lookupLexiconTerm(built.terms, term);
    if (at === -1) continue;
    const row = built.terms[at];
    assert.ok(row);
    for (const posting of built.postings.slice(row.postingOffset, row.postingOffset + row.postingCount)) {
      hits.add(posting.node);
    }
  }
  assert.ok(hits.has(0), 'the Korean query must reach the Korean document');
  assert.ok(!hits.has(1), 'and must not drag in an unrelated node');
});

test('a jargon acronym query retrieves the identifier it abbreviates', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'ContextGraphQuery' }] },
    { node: 1, fields: [{ field: FIELD.EXACT_LABEL, text: 'ReleaseGateProof' }] },
  ]));
  assert.deepEqual([...postingsFor(built, 'cgq')], [0]);
  assert.deepEqual([...postingsFor(built, 'rgp')], [1]);
});
