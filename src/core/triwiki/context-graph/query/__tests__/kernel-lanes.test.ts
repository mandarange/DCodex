import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_FLAG,
  CandidateTable,
  fixedKernelClock,
  isExactKernelConfidence,
  resolveQueryPlan,
  runSeedLanes,
  type KernelRequest,
} from '../kernel.js';
import { GATE, GATE_ID, KERNEL, KERNEL_PATH, MODULE, SYMBOL, openKernelIndex } from './kernel-fixtures.js';
import type { ContextIndexReader } from '../../runtime-index/reader.js';

const clock = fixedKernelClock(0);

function seed(reader: ContextIndexReader, request: KernelRequest) {
  const context = resolveQueryPlan(reader, request, { clock });
  const table = new CandidateTable(context.plan.candidateBudget);
  const lanes = runSeedLanes(reader, context, request, table);
  return { context, table, lanes };
}

test('the anchor lane resolves a canonical id and is the only source of exact confidence', () => {
  const reader = openKernelIndex();
  const { table, lanes } = seed(reader, { query: GATE_ID });

  const slot = table.slotOf(GATE);
  assert.notEqual(slot, -1, 'a canonical id must resolve without any text scan');
  assert.equal(table.laneOf(slot), 'anchor');
  assert.ok(isExactKernelConfidence(table.confidenceOf(slot)));
  assert.ok(table.has(slot, CANDIDATE_FLAG.EXACT_SEED));
  assert.equal(lanes[0]?.lane, 'anchor');
  assert.ok((lanes[0]?.postingsExamined ?? 0) > 0, 'the scan budget is counted in postings');
});

test('an exact path anchors every node that lives at it', () => {
  const reader = openKernelIndex();
  const { table } = seed(reader, { query: KERNEL_PATH });
  for (const node of [KERNEL, SYMBOL]) {
    const slot = table.slotOf(node);
    assert.notEqual(slot, -1);
    assert.equal(table.confidenceOf(slot), 'file_path');
    assert.ok(table.has(slot, CANDIDATE_FLAG.EXACT_SEED));
  }
});

test('a BM25F hit is a text candidate at any magnitude', () => {
  const reader = openKernelIndex();
  const { table, lanes } = seed(reader, { query: 'kernel' });
  const slot = table.slotOf(KERNEL);
  assert.notEqual(slot, -1);
  assert.equal(table.laneOf(slot), 'lexical');
  assert.equal(table.confidenceOf(slot), 'text_candidate');
  assert.ok(!table.has(slot, CANDIDATE_FLAG.EXACT_SEED));
  // The score really is large; the confidence is not a function of it.
  assert.ok(table.scoreIn(slot, 'lexical') > 0);
  assert.equal(lanes[1]?.lane, 'lexical');
  assert.equal(lanes[1]?.matchedTerms, 1);
});

test('the coarse lane has the same ceiling as the lexical one', () => {
  const reader = openKernelIndex();
  const { table, lanes } = seed(reader, { query: 'retrieval' });
  const slot = table.slotOf(MODULE);
  assert.notEqual(slot, -1);
  assert.equal(table.confidenceOf(slot), 'text_candidate');
  assert.equal(lanes[2]?.lane, 'coarse');
  assert.ok((lanes[2]?.candidates ?? 0) > 0);
});

test('one node reached by two lanes is one candidate carrying both contributions', () => {
  const reader = openKernelIndex();
  const { table } = seed(reader, { query: `${KERNEL_PATH} kernel retrieval` });
  const slot = table.slotOf(KERNEL);
  assert.notEqual(slot, -1);
  assert.ok(table.rankIn(slot, 'anchor') >= 0);
  assert.ok(table.rankIn(slot, 'lexical') >= 0);
  assert.ok(table.rankIn(slot, 'coarse') >= 0);
  // Deduped on the integer node, and the strongest claim wins regardless of the
  // order the lanes happened to run in.
  assert.equal(table.confidenceOf(slot), 'file_path');
  let occurrences = 0;
  for (let at = 0; at < table.size; at += 1) if ((table.node[at] as number) === KERNEL) occurrences += 1;
  assert.equal(occurrences, 1);
});

test('the anchor receipt names the term that actually resolved the node', () => {
  const reader = openKernelIndex();
  // Both terms name the same node: one is its canonical id, the other its path.
  // The id wins the rank because it is looked up first, so it must also be the
  // term the receipt reports.
  const { table } = seed(reader, { query: `file:src/core/kernel.ts ${KERNEL_PATH}` });
  const slot = table.slotOf(KERNEL);
  assert.equal(table.rankIn(slot, 'anchor'), 0);
  assert.equal(table.anchorTerm[slot], reader.termId('file:src/core/kernel.ts'));
  assert.notEqual(table.anchorTerm[slot], reader.termId(KERNEL_PATH));
  // The second term still does its own work: it is what brings in the symbol.
  assert.notEqual(table.slotOf(SYMBOL), -1);
});

test('a caller seed the caller resolved is exact; a caller seed it guessed is not', () => {
  const reader = openKernelIndex();
  const resolved = seed(reader, {
    query: 'unrelated',
    seeds: [{ nodeId: GATE_ID, confidence: 'exact_definition' }],
  });
  const gateSlot = resolved.table.slotOf(GATE);
  assert.equal(resolved.table.confidenceOf(gateSlot), 'exact_definition');
  assert.equal(resolved.table.laneOf(gateSlot), 'anchor');
  assert.ok(resolved.table.has(gateSlot, CANDIDATE_FLAG.PROVIDED));

  const guessed = seed(reader, {
    query: 'unrelated',
    seeds: [{ nodeId: GATE_ID, confidence: 'text_candidate' }],
  });
  const guessedSlot = guessed.table.slotOf(GATE);
  assert.equal(guessed.table.confidenceOf(guessedSlot), 'text_candidate');
  assert.ok(!guessed.table.has(guessedSlot, CANDIDATE_FLAG.EXACT_SEED));

  // An explicit `verified: false` overrides an exact-looking confidence: the
  // caller is the one who knows whether it resolved or guessed.
  const declared = seed(reader, {
    query: 'unrelated',
    seeds: [{ nodeId: GATE_ID, confidence: 'exact_definition', verified: false }],
  });
  assert.equal(declared.table.confidenceOf(declared.table.slotOf(GATE)), 'text_candidate');
});

test('a caller seed this index does not know is warned about, not silently dropped', () => {
  const reader = openKernelIndex();
  const { context, table } = seed(reader, {
    query: GATE_ID,
    seeds: [{ nodeId: 'file:does/not/exist.ts', confidence: 'exact_reference' }],
  });
  assert.equal(context.omissions.unknown_seed, 1);
  assert.equal(context.warnings.filter((line) => line.includes('not present in this index')).length, 1);
  assert.notEqual(table.slotOf(GATE), -1, 'an unknown seed must not cost the known ones');
});

test('a focus path anchors its own nodes and marks the focus component', () => {
  const reader = openKernelIndex();
  const { table } = seed(reader, { query: 'kernel', focusPaths: [KERNEL_PATH] });
  const slot = table.slotOf(KERNEL);
  assert.ok(table.has(slot, CANDIDATE_FLAG.FOCUS));
  assert.ok(table.has(table.slotOf(SYMBOL), CANDIDATE_FLAG.FOCUS));
});

test('a query that matches nothing says so rather than reaching for a text fallback', () => {
  const reader = openKernelIndex();
  const { context, table } = seed(reader, { query: 'zzzz' });
  assert.equal(table.size, 0);
  assert.equal(context.warnings.filter((line) => line.includes('no text fallback')).length, 1);
});

test('the candidate budget is a bound, and overflow is counted rather than absorbed', () => {
  const reader = openKernelIndex();
  const request: KernelRequest = { query: `${KERNEL_PATH} kernel retrieval` };
  const context = resolveQueryPlan(reader, request, { clock });
  const table = new CandidateTable(1);
  runSeedLanes(reader, context, request, table);
  assert.equal(table.size, 1);
  assert.ok((context.omissions.candidate_budget ?? 0) > 0);
});
