import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_INDEX_SECTION } from '../format.js';
import { openContextIndex } from '../reader.js';
import {
  A,
  B,
  FIXTURE_BYTES,
  GATE,
  SYMBOL,
  rejects,
  rewriteSections,
  termTable,
} from './reader-fixtures.js';

/**
 * The lexical and coarse lanes read a term dictionary that revision 1's writer
 * declares empty — CG2-04 fills it without moving the layout. So the merge is
 * exercised against a hand-laid section in the writer's own row format, which
 * also proves the reader rejects a dictionary whose invariants are broken
 * rather than binary-searching a table that is not sorted.
 */

const RARE = 4;
const COMMON = 5;

function readerWithLexicon(entries: readonly (readonly [number, readonly number[]])[]) {
  const built = termTable(entries);
  return openContextIndex(rewriteSections(FIXTURE_BYTES, new Map([
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, built.table],
    [CONTEXT_INDEX_SECTION.LEXICON_POSTINGS, built.postings],
  ])));
}

test('the lexical lane merges postings, ranks by weight, and reports its cuts', () => {
  const reader = readerWithLexicon([
    [RARE, [SYMBOL]],
    [COMMON, [A, B, GATE, SYMBOL]],
  ]);

  const merged = reader.lexical([COMMON, RARE], { postingCapPerTerm: 16, candidateBudget: 16 });
  assert.equal(merged.matchedTerms, 2);
  assert.equal(merged.truncated, false);
  assert.equal(merged.length, 4);
  // The node matching both terms outranks the ones matching only the common
  // term, and the rest tie-break on the integer node — which is the sorted
  // node id.
  assert.equal(merged.node(0), SYMBOL);
  assert.deepEqual([merged.node(1), merged.node(2), merged.node(3)], [A, B, GATE]);
  assert.ok(merged.score(0) > merged.score(1), 'two term hits must outrank one');
  assert.equal(merged.score(1), merged.score(2));
  assert.throws(() => merged.score(4), RangeError);

  const capped = reader.lexical([COMMON], { postingCapPerTerm: 2, candidateBudget: 16 });
  assert.equal(capped.length, 2);
  assert.equal(capped.truncated, true);

  const budgeted = reader.lexical([COMMON], { postingCapPerTerm: 16, candidateBudget: 1 });
  assert.equal(budgeted.length, 1);
  assert.equal(budgeted.truncated, true);

  assert.equal(reader.lexical([9_999], { postingCapPerTerm: 16, candidateBudget: 16 }).matchedTerms, 0);
  assert.equal(reader.lexical([COMMON], { postingCapPerTerm: 0, candidateBudget: 16 }).length, 0);
  assert.equal(reader.lexical([COMMON], { postingCapPerTerm: 16, candidateBudget: 0 }).length, 0);
  // The coarse lane is still empty in this fixture and must say so, not guess.
  assert.equal(reader.coarse([COMMON], { postingCapPerTerm: 16, candidateBudget: 16 }).length, 0);
});

test('a lexical merge does not depend on the order the caller listed its terms', () => {
  const reader = readerWithLexicon([[RARE, [SYMBOL]], [COMMON, [A, B, GATE, SYMBOL]]]);
  const plan = { postingCapPerTerm: 16, candidateBudget: 16 };
  const forward = reader.lexical([RARE, COMMON], plan);
  const reverse = reader.lexical([COMMON, RARE, COMMON], plan);
  assert.equal(forward.length, reverse.length);
  for (let index = 0; index < forward.length; index += 1) {
    assert.equal(forward.node(index), reverse.node(index));
    assert.equal(forward.score(index), reverse.score(index));
  }
});

test('an unsorted term table is rejected, not searched with a broken invariant', () => {
  const built = termTable([[COMMON, [A]], [RARE, [B]]]);
  const bytes = rewriteSections(FIXTURE_BYTES, new Map([
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, built.table],
    [CONTEXT_INDEX_SECTION.LEXICON_POSTINGS, built.postings],
  ]));
  rejects(bytes, 'csr_not_monotonic');
});

test('a posting run that leaves its section is rejected', () => {
  const built = termTable([[RARE, [A]]]);
  const view = new DataView(built.table.payload.buffer);
  view.setUint32(8, 99, true);
  const bytes = rewriteSections(FIXTURE_BYTES, new Map([
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, built.table],
    [CONTEXT_INDEX_SECTION.LEXICON_POSTINGS, built.postings],
  ]));
  rejects(bytes, 'reference_out_of_range');
});
