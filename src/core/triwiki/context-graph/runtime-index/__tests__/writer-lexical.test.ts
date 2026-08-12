import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextGraphNode, ContextGraphSnapshot } from '../../contracts.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../../query/ranking-config.js';
import { CONTEXT_INDEX_SECTION, readContextIndexHeader, readSectionTable } from '../format.js';
import { normalizeLexiconQuery, type ContextLexiconBuildResult } from '../lexicon.js';
import { openContextIndex, type ContextIndexReader, type PostingSlice } from '../reader.js';
import { ContextIndexWriterError, encodeContextIndex, encodeContextIndexLane } from '../writer.js';
import { makeEdge, makeNode, makeSnapshot } from './reader-fixtures.js';

/**
 * The end-to-end proof that the lexicon reaches the index.
 *
 * Revision 1 shipped with `LEXICON_TABLE`, `LEXICON_POSTINGS`,
 * `COARSE_TERM_TABLE` and `COARSE_POSTINGS` declared zero-length, so only the
 * anchor lane could produce candidates and the anchor lane keys on canonical
 * node ids and whole workspace-relative paths. Measured through the reader on
 * this fixture, that meant a symbol query and a word query returned **nothing**
 * while the path query they were compared against returned its node. Those two
 * zeroes are what this suite exists to keep from coming back, so each case
 * asserts the empty-lexicon result *and* the wired one — a test that only
 * asserted the wired one would still pass if the whole lane were disconnected
 * and the fixture happened to be anchored.
 *
 * The queries are tokenized with `normalizeLexiconQuery` rather than by hand.
 * That is the same entry point the kernel plan uses, and it is the only way the
 * test proves the document side and the query side agree about what a term is;
 * a hand-written term list would prove the writer agrees with the test.
 */

const CONFIG_HASH = new Uint8Array(32).fill(0x4d);
const PLAN = { postingCapPerTerm: 64, candidateBudget: 64 } as const;

const KOREAN_LABEL = '컨텍스트 그래프 신선도';

/** Sorted by id, which is the order the writer assigns node integers in. */
const NODES: readonly ContextGraphNode[] = [
  makeNode({ id: 'file:src/other/a.ts', label: 'a.ts', path: 'src/other/a.ts', contentHash: 'sha256:a' }),
  makeNode({ id: 'file:src/other/b.ts', label: 'b.ts', path: 'src/other/b.ts', contentHash: 'sha256:b' }),
  makeNode({ id: 'file:src/service/run.ts', label: 'run.ts', path: 'src/service/run.ts', contentHash: 'sha256:r' }),
  makeNode({ id: 'gate:release:proof', kind: 'gate', label: 'release proof', risk: 'protected' }),
  makeNode({
    id: 'symbol:src/service/run.ts#runService',
    kind: 'symbol',
    label: 'runService',
    path: 'src/service/run.ts',
    line: 12,
  }),
  makeNode({
    id: 'wiki_claim:freshness',
    kind: 'wiki_claim',
    label: KOREAN_LABEL,
    metadata: { summary: '스냅샷 해시를 비교한다', weight: 3, verified: true },
  }),
];

/** Node integers, assigned in sorted node-id order by the writer. */
const OTHER_A = 0;
const OTHER_B = 1;
const RUN_FILE = 2;
const GATE = 3;
const SYMBOL = 4;
const KOREAN = 5;

function snapshot(nodes: readonly ContextGraphNode[] = NODES): ContextGraphSnapshot {
  return makeSnapshot(nodes, [
    makeEdge({ from: 'file:src/service/run.ts', to: 'symbol:src/service/run.ts#runService', type: 'defines' }),
    makeEdge({ from: 'file:src/other/a.ts', to: 'file:src/service/run.ts', type: 'imports' }),
  ]);
}

function write(withLexicon: boolean, input: ContextGraphSnapshot = snapshot()) {
  return encodeContextIndex({
    snapshot: input,
    configHash: CONFIG_HASH,
    schemaRevision: 1,
    ...(withLexicon ? { lexicon: CONTEXT_GRAPH_LEXICON_CONFIG } : {}),
  });
}

function open(withLexicon: boolean): ContextIndexReader {
  return openContextIndex(write(withLexicon).bytes);
}

function nodesOf(slice: PostingSlice): number[] {
  const out: number[] = [];
  for (let index = 0; index < slice.length; index += 1) out.push(slice.node(index));
  return out.sort((left, right) => left - right);
}

/** The kernel's own path: free text -> terms -> ids -> a merged posting slice. */
function lexicalNodesFor(reader: ContextIndexReader, query: string): number[] {
  const terms = normalizeLexiconQuery(query, CONTEXT_GRAPH_LEXICON_CONFIG).terms;
  const termIds = terms.map((term) => reader.termId(term)).filter((id) => id >= 0);
  return nodesOf(reader.lexical(termIds, PLAN));
}

function coarseNodesFor(reader: ContextIndexReader, query: string): number[] {
  const terms = normalizeLexiconQuery(query, CONTEXT_GRAPH_LEXICON_CONFIG).terms;
  const termIds = terms.map((term) => reader.termId(term)).filter((id) => id >= 0);
  return nodesOf(reader.coarse(termIds, PLAN));
}

test('a symbol query reaches its node, which an empty lexicon could not', () => {
  assert.deepEqual(lexicalNodesFor(open(false), 'runService'), [], 'the regression this fixes');

  const reader = open(true);
  const hits = lexicalNodesFor(reader, 'runService');
  assert.ok(hits.includes(SYMBOL), `expected the symbol node, got ${JSON.stringify(hits)}`);
  // The symbol's own file comes along because `run` and `service` are also path
  // segments of `src/service/run.ts`. That is a candidate, not a mistake: both
  // are `text_candidate`, and the anchor lane is what separates them.
  assert.ok(hits.includes(RUN_FILE));
  assert.equal(hits.includes(OTHER_B), false, 'an unrelated file must not match');
});

test('a bare word query reaches the nodes that contain it', () => {
  assert.deepEqual(lexicalNodesFor(open(false), 'service'), [], 'the regression this fixes');

  const hits = lexicalNodesFor(open(true), 'service');
  assert.ok(hits.includes(SYMBOL), 'the identifier split makes `runService` reachable by `service`');
  assert.ok(hits.includes(RUN_FILE), 'the path segment makes `src/service/run.ts` reachable by `service`');
  assert.equal(hits.includes(OTHER_A), false);
  assert.equal(hits.includes(GATE), false);
});

test('a Korean query returns its Korean node', () => {
  // The v1 baseline returned nothing for Korean, and the tempting fix is to let
  // a strong text match claim `exact`. This asserts the other half: the node is
  // found at all, through CJK n-grams, and it arrives on the lexical lane.
  assert.deepEqual(lexicalNodesFor(open(false), '신선도'), []);

  const reader = open(true);
  assert.deepEqual(lexicalNodesFor(reader, '신선도'), [KOREAN]);
  assert.ok(lexicalNodesFor(reader, '스냅샷 해시').includes(KOREAN), 'Korean metadata prose is indexed too');
});

test('a canonical id stays unreachable through the lexical lane', () => {
  // `CANONICAL_ID` has weight 0 and is fed by nothing, which is what makes a
  // BM25F hit structurally unable to reach exact confidence. The id string is
  // interned — the anchor lane needs it — so this is a real lookup that must
  // still return no lexical postings.
  const reader = open(true);
  const canonical = 'symbol:src/service/run.ts#runService';
  const id = reader.termId(canonical);
  assert.ok(id >= 0, 'the canonical id is interned for the anchor lane');
  assert.equal(reader.lexical([id], PLAN).length, 0, 'but it has no lexical posting');
  assert.equal(reader.coarse([id], PLAN).length, 0);
  // The same id through the anchor lane does resolve, and that is the only lane
  // §4 lets report `exact`.
  assert.deepEqual(nodesOf(reader.exact(canonical)), [SYMBOL]);
});

test('the anchor lane still answers a whole path, unchanged by the lexicon', () => {
  for (const withLexicon of [false, true]) {
    const reader = open(withLexicon);
    assert.deepEqual(nodesOf(reader.basename('src/other/a.ts')), [OTHER_A], `withLexicon=${withLexicon}`);
    assert.deepEqual(nodesOf(reader.exact('file:src/other/a.ts')), [OTHER_A]);
  }
});

test('the coarse lane indexes containment rather than names', () => {
  const reader = open(true);
  // Every node under `src/service`, and nothing under `src/other`.
  const hits = coarseNodesFor(reader, 'service');
  assert.deepEqual(hits, [RUN_FILE, SYMBOL]);
  assert.deepEqual(coarseNodesFor(reader, 'other'), [OTHER_A, OTHER_B]);
  // A label is not containment, so the coarse lane must not carry it.
  assert.deepEqual(coarseNodesFor(reader, 'runService'), [RUN_FILE, SYMBOL]);
  assert.equal(reader.coarse([reader.termId('release proof')], PLAN).length, 0);
});

test('a snapshot with lexical content encodes byte-identically across runs', () => {
  // Determinism is the writer's whole contract: the index is named by its own
  // hash, so a lexicon that leaked `Map` insertion order or a locale-sensitive
  // sort into the bytes would make one graph claim to be two.
  const first = write(true).bytes;
  for (let run = 0; run < 50; run += 1) {
    assert.deepEqual(write(true).bytes, first, `run ${run} diverged`);
  }
});

test('input order does not reach the bytes of a lexical index', () => {
  const forward = snapshot();
  const reversed = snapshot([...NODES].reverse());
  assert.deepEqual(write(true, reversed).bytes, write(true, forward).bytes);
});

test('metadata key order does not reach the bytes', () => {
  // `Object.keys` is insertion order, and a snapshot that has been through a
  // JSON round trip carries whatever order the extractor happened to emit.
  const ordered = makeNode({ id: 'file:src/m.ts', path: 'src/m.ts', metadata: { alpha: 'red', beta: 'blue' } });
  const shuffled = makeNode({ id: 'file:src/m.ts', path: 'src/m.ts', metadata: { beta: 'blue', alpha: 'red' } });
  assert.deepEqual(
    write(true, makeSnapshot([ordered], [])).bytes,
    write(true, makeSnapshot([shuffled], [])).bytes,
  );
});

test('an omitted lexicon config leaves the four sections empty rather than defaulted', () => {
  // There is deliberately no fallback config under `runtime-index/`: a weight
  // the bounded optimizer cannot see is a weight that drifts. So a caller that
  // omits it gets no lexical lane, not one tuned by numbers nobody chose.
  const result = write(false);
  assert.equal(result.lexicon, null);
  const header = readContextIndexHeader(result.bytes);
  for (const kind of [
    CONTEXT_INDEX_SECTION.LEXICON_TABLE,
    CONTEXT_INDEX_SECTION.LEXICON_POSTINGS,
    CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE,
    CONTEXT_INDEX_SECTION.COARSE_POSTINGS,
  ]) {
    const descriptor = readSectionTable(result.bytes, header).find((entry) => entry.kind === kind);
    assert.ok(descriptor);
    assert.equal(descriptor.count, 0);
    assert.equal(descriptor.length, 0n);
  }
});

test('the write result reports the lanes it built and every bound that fired', () => {
  const result = write(true);
  assert.ok(result.lexicon);
  assert.ok(result.lexicon.termCount > 0);
  assert.ok(result.lexicon.postingCount >= result.lexicon.termCount);
  assert.ok(result.lexicon.coarseTermCount > 0);
  assert.equal(result.lexicon.omissions.secretTokens, 0);

  // A pasted key is dropped rather than indexed, and the drop is counted — a
  // silent bound is a recall regression nothing can attribute later.
  const secret = 'AKIAIOSFODNN7EXAMPLEfoo9Bar4Baz2Qux7';
  const withSecret = write(true, makeSnapshot([makeNode({ id: 'file:src/k.ts', path: 'src/k.ts', metadata: { note: secret } })], []));
  assert.ok(withSecret.lexicon);
  assert.equal(withSecret.lexicon.omissions.secretTokens, 1);

  // The claim is "not *searchable*", not "not present". The metadata row still
  // carries the value verbatim, because the writer has always interned every
  // metadata value so `hydrateNode` can hand it back — that is unchanged by the
  // lexicon and is not this lane's to alter. What the lexicon guarantees is
  // that no posting was written for it, so no query can surface the node by
  // typing the key.
  const reader = openContextIndex(withSecret.bytes);
  const interned = reader.termId(secret);
  assert.ok(interned >= 0, 'the metadata row still holds the value for hydration');
  assert.equal(reader.lexical([interned], PLAN).length, 0, 'but nothing can find the node by typing it');
  assert.equal(reader.coarse([interned], PLAN).length, 0);
});

test('the term table opens, which proves its ids ascend and its runs stay in section', () => {
  // `openContextIndex` runs the whole validation pass, and `validateTermTable`
  // is the part that rejects a dictionary whose ids are not strictly ascending
  // or whose posting run leaves its section. Opening a real writer output is
  // therefore the assertion, not a separate hand-laid check.
  const reader = open(true);
  assert.equal(reader.nodeCount, NODES.length);
  assert.equal(reader.termCount, NODES.length, 'header termCount stays the exact table s count');
  assert.ok(reader.stringCount > NODES.length, 'lexicon terms were interned alongside ids and paths');
});

function builtLexicon(
  terms: readonly string[],
  postingNode: number,
): ContextLexiconBuildResult {
  return {
    schema: 'sks.context-lexicon.v1',
    documentCount: 1,
    terms: terms.map((term, position) => ({
      term,
      documentFrequency: 1,
      postingOffset: position,
      postingCount: 1,
      idfFixed: 0,
    })),
    postings: terms.map(() => ({ node: postingNode, fieldMask: 1, termFrequency: 1, score: 1 })),
    nodeDeltas: terms.map(() => postingNode),
    averageFieldLengthFixed: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    omissions: {
      secretTokens: 0,
      redactedSpans: 0,
      cappedFieldTokens: 0,
      cappedCjkNgrams: 0,
      cappedPostings: 0,
      cappedTerms: 0,
    },
  };
}

function captureWriterError(run: () => unknown): ContextIndexWriterError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ContextIndexWriterError, `expected a writer error, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the lane to be refused');
}

test('a lane whose term ids do not ascend is refused at the write site', () => {
  // The one invariant the type system cannot carry: a term id is a string-table
  // id, and the table must ascend. A descending table is not caught by anything
  // else in the writer, and the reader would reject the whole index at open
  // with `csr_not_monotonic` — a corruption code for a compiler bug, sending a
  // user to rebuild a file that would be rebuilt exactly as wrong.
  const ids = new Map([['zeta', 9], ['alpha', 2]]);
  const error = captureWriterError(() =>
    encodeContextIndexLane(builtLexicon(['zeta', 'alpha'], 0), (term) => ids.get(term) as number, 4));
  assert.equal(error.code, 'lexicon_invariant');
  for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
});

test('a lane posting outside the node table is refused rather than written', () => {
  const error = captureWriterError(() => encodeContextIndexLane(builtLexicon(['alpha'], 99), () => 1, 4));
  assert.equal(error.code, 'lexicon_invariant');
});
