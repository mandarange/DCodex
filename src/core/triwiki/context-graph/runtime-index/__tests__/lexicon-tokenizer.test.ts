import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLexiconQuery,
  splitLatinSegments,
  tokenizeLexiconField,
  type ContextLexiconConfig,
} from '../lexicon.js';
import { CONFIG, FIELD, serialize, terms } from './lexicon-fixtures.js';

/**
 * The tokenizer decides what a term *is*, and both the compiler and the query
 * path go through it. Two properties are asserted here rather than assumed:
 *
 *   - The same input yields the same term sequence, in the same order. The
 *     index is content-addressed, so a tokenizer that varied by locale, Unicode
 *     version or map ordering would break the generation's identity, not merely
 *     its ranking.
 *   - A query and a document tokenize identically. Any rule that lived on only
 *     one side would produce terms the other side can never match, which is a
 *     recall hole no test of either side alone would catch.
 */

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('tokenizing the same text repeatedly yields an identical term sequence', () => {
  const input = 'queryContextGraphSnapshot src/core/context.ts 컨텍스트 그래프 HTTPServer utf8Decoder';
  const first = serialize(tokenizeLexiconField(input, FIELD.PURPOSE, CONFIG));
  for (let iteration = 0; iteration < 50; iteration += 1) {
    assert.equal(serialize(tokenizeLexiconField(input, FIELD.PURPOSE, CONFIG)), first);
  }
});

// ---------------------------------------------------------------------------
// Identifier splitting
// ---------------------------------------------------------------------------

test('camelCase and PascalCase split on the capital', () => {
  assert.deepEqual(splitLatinSegments('queryContextGraph'), ['query', 'Context', 'Graph']);
  assert.deepEqual(splitLatinSegments('ContextGraphQuery'), ['Context', 'Graph', 'Query']);
});

test('an acronym run keeps its own boundary', () => {
  // Splitting after the last capital instead of before it yields `HTTPS` and
  // `erver`, and neither `http` nor `server` is then searchable.
  assert.deepEqual(splitLatinSegments('HTTPServer'), ['HTTP', 'Server']);
  assert.deepEqual(splitLatinSegments('parseJSONBody'), ['parse', 'JSON', 'Body']);
});

test('digits are a boundary but the joined run survives', () => {
  assert.deepEqual(splitLatinSegments('utf8Decoder'), ['utf', '8', 'Decoder']);
  const emitted = terms('u32 p95 v2 utf8Decoder');
  assert.ok(emitted.includes('u32'), 'a bare version-like run must stay searchable');
  assert.ok(emitted.includes('p95'));
  assert.ok(emitted.includes('v2'));
  assert.ok(!emitted.includes('95'), 'a pure-digit segment matches every percentile in the workspace');
  assert.ok(!emitted.includes('32'));
});

test('snake_case and kebab-case split into their words', () => {
  assert.deepEqual(terms('release_gate_proof', FIELD.SYMBOL_SEGMENT), ['release', 'gate', 'proof']);
  assert.deepEqual(terms('context-graph-query', FIELD.SYMBOL_SEGMENT), ['context', 'graph', 'query']);
});

test('an acronym is synthesized from at least two segments', () => {
  assert.ok(terms('ContextGraphQuery', FIELD.SYMBOL_SEGMENT).includes('cgq'));
  assert.ok(terms('queryContextGraphSnapshot', FIELD.SYMBOL_SEGMENT).includes('qcgs'));
  // One letter would match everything and rank nothing.
  assert.ok(!terms('Context', FIELD.SYMBOL_SEGMENT).includes('c'));
});

test('a path yields its segments, its basename and the bare stem', () => {
  const emitted = terms('src/core/search/context.ts', FIELD.PATH_SEGMENT);
  for (const expected of ['src', 'core', 'search', 'context', 'context.ts']) {
    assert.ok(emitted.includes(expected), `missing path token: ${expected}`);
  }
});

test('the basename rule is in the shared tokenizer, so a query reproduces it', () => {
  // A dotted-pair rule living only in a basename branch would mean the document
  // holds `context.ts` and a query typed as `context.ts` never produces it.
  assert.ok(terms('context.ts', FIELD.BASENAME).includes('context.ts'));
  assert.ok(normalizeLexiconQuery('context.ts', CONFIG).terms.includes('context.ts'));
  // A long trailing segment is a name, not an extension, so it is not rejoined.
  assert.ok(!terms('sks.contextgraph', FIELD.PURPOSE).includes('sks.contextgraph'));
});

test('the exact-cased original survives alongside its lowercase form', () => {
  const emitted = terms('ContextGraphQuery', FIELD.EXACT_LABEL);
  assert.ok(emitted.includes('ContextGraphQuery'));
  assert.ok(emitted.includes('contextgraphquery'));
});

// ---------------------------------------------------------------------------
// Non-Latin scripts
// ---------------------------------------------------------------------------

test('Korean produces the whole word and bounded n-grams', () => {
  const emitted = terms('컨텍스트');
  assert.ok(emitted.includes('컨텍스트'));
  for (const gram of ['컨텍', '텍스', '스트', '컨텍스', '텍스트']) {
    assert.ok(emitted.includes(gram), `missing n-gram: ${gram}`);
  }
});

test('an attached Korean particle still overlaps the bare noun', () => {
  // This is the v1 `korean` failure: `컨텍스트를` and `컨텍스트` share no
  // whitespace token, so a whitespace-only tokenizer returns nothing at all.
  const document = new Set(terms('컨텍스트 조회'));
  const query = normalizeLexiconQuery('컨텍스트를 조회한다', CONFIG).terms;
  const overlap = query.filter((term) => document.has(term));
  assert.ok(overlap.length >= 3, `expected the n-grams to overlap, got ${overlap.length}`);
});

test('Japanese and Chinese are segmented, not discarded', () => {
  const japanese = terms('文脈グラフ');
  assert.ok(japanese.includes('文脈'));
  assert.ok(japanese.includes('グラフ'));
  const chinese = terms('上下文图谱查询');
  assert.ok(chinese.length > 0);
  assert.ok(chinese.includes('上下'));
});

test('scripts with spaces are kept whole rather than dropped', () => {
  assert.deepEqual(terms('поиск графа'), ['поиск', 'графа']);
  assert.deepEqual(terms('γράφημα'), ['γράφημα']);
  assert.deepEqual(terms('café'), ['café']);
});

test('a mixed-script identifier preserves both halves separately', () => {
  const emitted = terms('컨텍스트queryGraph');
  assert.ok(emitted.includes('컨텍스트'));
  assert.ok(emitted.includes('query'));
  assert.ok(emitted.includes('graph'));
});

test('a long unspaced CJK run is capped and reported', () => {
  const config: ContextLexiconConfig = { ...CONFIG, maxCjkNgramsPerRun: 4, maxCjkRunLength: 2 };
  const tokenized = tokenizeLexiconField('컨텍스트그래프조회스냅샷', FIELD.PURPOSE, config);
  assert.equal(tokenized.omissions.cappedCjkNgrams, 1);
  assert.ok(tokenized.terms.length <= 4, 'the n-gram cap must bound the term count');
  // A sentence-length run is not kept whole: it would be a df-1 term no query
  // could ever reproduce.
  assert.ok(!tokenized.terms.includes('컨텍스트그래프조회스냅샷'));
});

test('NFKC folds fullwidth input onto its ASCII identifier', () => {
  assert.deepEqual(terms('ｑｕｅｒｙＧｒａｐｈ'), terms('queryGraph'));
});

// ---------------------------------------------------------------------------
// One normalization API
// ---------------------------------------------------------------------------

test('the query API and the field tokenizer agree term for term', () => {
  // Two tokenizers would be two definitions of what a term is, and the second
  // one would drift until queries stopped matching documents.
  for (const input of ['queryContextGraphSnapshot', 'src/core/context.ts', '컨텍스트 그래프', 'HTTP_SERVER v2']) {
    assert.deepEqual(normalizeLexiconQuery(input, CONFIG).terms, terms(input, FIELD.PURPOSE), input);
  }
});

test('a document keeps repetition while a query collapses it', () => {
  // Term frequency is the whole input to BM25's saturation curve, so a
  // document that deduped per field would report every tf as 0 or 1 and reduce
  // BM25F to a field-weight lookup. A query has no frequency to express.
  const repeated = 'compaction compaction compaction';
  assert.deepEqual(terms(repeated, FIELD.EVIDENCE), ['compaction', 'compaction', 'compaction']);
  assert.deepEqual(normalizeLexiconQuery(repeated, CONFIG).terms, ['compaction']);
  // Within one run the derived forms are still deduped: a camel split and an
  // acronym that agree must not double-count.
  assert.deepEqual(terms('AA', FIELD.EVIDENCE), ['aa', 'AA']);
});

test('the query API caps its term count', () => {
  const config: ContextLexiconConfig = { ...CONFIG, maxQueryTerms: 3 };
  const normalized = normalizeLexiconQuery('alpha beta gamma delta epsilon zeta', config);
  assert.equal(normalized.terms.length, 3);
  assert.deepEqual([...normalized.terms], ['alpha', 'beta', 'gamma']);
  assert.equal(normalized.omissions.cappedFieldTokens, 1);
});
