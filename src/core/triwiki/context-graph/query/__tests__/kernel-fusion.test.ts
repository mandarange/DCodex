import assert from 'node:assert/strict';
import test from 'node:test';
import { CANDIDATE_FLAG, fixedKernelClock, isExactKernelConfidence, runContextKernel, type KernelRequest } from '../kernel.js';
import {
  GATE,
  GATE_ID,
  INVALID,
  KERNEL,
  KERNEL_PATH,
  MODULE,
  STALE,
  UNKNOWN,
  openKernelIndex,
  openSharedGroupIndex,
} from './kernel-fixtures.js';
import type { ContextIndexReader } from '../../runtime-index/reader.js';

const clock = fixedKernelClock(0);

function run(reader: ContextIndexReader, request: KernelRequest) {
  return runContextKernel(reader, request, { clock });
}

function nodes(result: ReturnType<typeof run>): number[] {
  return result.selected.map((entry) => entry.candidate.node);
}

test('an exact anchor outranks every text candidate, at any text score', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: `${GATE_ID} kernel retrieval` });
  assert.equal(result.selected[0]?.candidate.node, GATE);
  assert.ok(isExactKernelConfidence(result.selected[0]?.confidence as never));
  const gateScore = result.selected[0]?.candidate.score as bigint;
  for (const entry of result.selected.slice(1)) {
    assert.ok(entry.candidate.score < gateScore);
    assert.ok(!isExactKernelConfidence(entry.confidence) || entry.lane === 'anchor');
  }
});

test('stale, invalidated and ungroundable candidates are excluded, and each is counted', () => {
  const reader = openKernelIndex();
  const result = run(reader, {
    query: KERNEL_PATH,
    seeds: [
      { nodeId: 'proof:stale', confidence: 'exact_definition' },
      { nodeId: 'proof:unknown', confidence: 'exact_definition' },
    ],
  });
  assert.ok(!nodes(result).includes(STALE));
  assert.ok(!nodes(result).includes(UNKNOWN));
  assert.ok(!nodes(result).includes(INVALID), 'an invalidated proof is excluded before any reserve sees it');
  assert.equal(result.omissions.stale_node, 1);
  assert.equal(result.omissions.no_provenance, 1);
  assert.ok((result.omissions.invalidated_proof ?? 0) >= 1);
});

test('the token budget is never exceeded, at any budget', () => {
  const reader = openKernelIndex();
  for (let budget = 0; budget <= 200; budget += 7) {
    const result = run(reader, { query: `${KERNEL_PATH} kernel retrieval`, tokenBudget: budget });
    assert.ok(result.tokenCost <= budget, `budget ${budget} overran by ${result.tokenCost - budget}`);
    const summed = result.selected.reduce((total, entry) => total + entry.tokenCost, 0);
    assert.equal(summed, result.tokenCost, 'the reported cost is the cost of what was selected');
  }
});

test('a protected gate is reserved before the greedy fill on a safety-relevant query', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: KERNEL_PATH, profile: 'review', risk: 'high', tokenBudget: 14 });
  assert.ok(result.guarantees.protectedGatesReachable > 0);
  assert.equal(result.guarantees.protectedGatesSelected, result.guarantees.protectedGatesReachable);
  assert.ok(nodes(result).includes(GATE));
  // The budget only fits the gate, so the exact seed is the omission — the
  // reserve order decides which guarantee survives a budget too small for both.
  assert.ok(result.warnings.some((line) => line.includes('exact seed')));
});

test('conflict recall is an equality on a review query', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: KERNEL_PATH, profile: 'review' });
  assert.ok(result.guarantees.conflictsReachable > 0);
  assert.equal(result.guarantees.conflictsSelected, result.guarantees.conflictsReachable);
});

test('an implementation query reserves a reachable test or gate', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: KERNEL_PATH, profile: 'implementation' });
  assert.equal(result.guarantees.testOrGateReachable, true);
  assert.equal(result.guarantees.testOrGateSelected, true);
});

test('the selection cap holds and reports what it dropped', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: `${KERNEL_PATH} kernel retrieval`, maxSelected: 2 });
  assert.ok(result.selected.length <= 2);
  assert.ok((result.omissions.max_selected ?? 0) > 0);
  assert.equal(result.truncated, true);
});

test('one structural group may not monopolize the answer', () => {
  const reader = openSharedGroupIndex();
  const result = runContextKernel(reader, {
    query: `${KERNEL_PATH} kernel retrieval`,
    maxSelected: 6,
  }, { clock });
  assert.ok((result.omissions.redundant_sibling ?? 0) > 0, 'the share cap must bind when a group crowds');
  // The gate keeps its own group, so diversity is genuinely being applied
  // rather than disabled by there being only one group to choose from.
  assert.ok(new Set(result.selected.map((entry) => entry.group)).size > 1);
});

test('nothing sorts the candidate set, and the selected set is sorted exactly once', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: `${KERNEL_PATH} kernel retrieval` });
  assert.equal(result.fullCandidateSorts, 0);
  assert.equal(result.selectedSorts, 1);
  assert.ok(result.candidateCount > result.selected.length, 'more candidates were scored than selected');
  for (let at = 1; at < result.selected.length; at += 1) {
    const previous = result.selected[at - 1]?.candidate as { score: bigint; node: number };
    const current = result.selected[at]?.candidate as { score: bigint; node: number };
    assert.ok(
      previous.score > current.score || (previous.score === current.score && previous.node < current.node),
      'presentation order is score DESC then stable node id ASC',
    );
  }
});

test('a candidate carries the receipt of every lane that produced it', () => {
  const reader = openKernelIndex();
  const result = run(reader, { query: `${KERNEL_PATH} kernel retrieval` });
  const withLanes = result.selected.find((entry) => entry.contributions.length > 1);
  assert.ok(withLanes, 'at least one node is reached by more than one lane');
  for (const contribution of withLanes.contributions) {
    assert.ok(contribution.rank >= 0);
    assert.equal(typeof contribution.score, 'bigint');
    if (contribution.lane === 'lexical' || contribution.lane === 'coarse') {
      assert.deepEqual([...contribution.termIds], [...result.plan.termIds]);
    }
  }
  const anchored = result.selected.find((entry) => entry.lane === 'anchor');
  assert.ok(anchored, 'the anchor lane produced a selected candidate');
  assert.notEqual(anchored.candidate.flags & CANDIDATE_FLAG.EXACT_SEED, 0);
});

/**
 * Every lane resolves through one string table, so the same id always denotes
 * the same string — but *not* the same kind of thing. The anchor lane's key is a
 * whole identifier (`src/core/kernel.ts`); the text lanes' keys are tokenizer
 * terms (`kernel`). Both are valid ids in one space and they denote different
 * strings, so a receipt that merged or deduped ids across lanes would silently
 * claim a node was resolved by a term that never resolved it.
 */
test('lane term ids are reported per lane and never merged across lanes', () => {
  const reader = openKernelIndex();
  const pathTerm = reader.termId(KERNEL_PATH);
  const wordTerm = reader.termId('kernel');
  assert.ok(pathTerm >= 0 && wordTerm >= 0);
  assert.notEqual(pathTerm, wordTerm, 'an identifier and a token are different strings');

  const result = run(reader, { query: `${KERNEL_PATH} kernel` });
  const entry = result.selected.find((candidate) => candidate.candidate.node === KERNEL);
  assert.ok(entry, 'the node is reached by both an anchor and a text lane');

  const anchor = entry.contributions.find((contribution) => contribution.lane === 'anchor');
  const lexical = entry.contributions.find((contribution) => contribution.lane === 'lexical');
  assert.deepEqual([...(anchor?.termIds ?? [])], [pathTerm]);
  assert.ok((lexical?.termIds ?? []).includes(wordTerm));
  assert.ok(
    !(lexical?.termIds ?? []).some((id) => (anchor?.termIds ?? []).includes(id)),
    'the two lanes resolved different strings and must report them separately',
  );
});

test('focus filtering keeps the answer inside the requested component', () => {
  const reader = openKernelIndex();
  const open = run(reader, { query: 'kernel retrieval' });
  // `src/core/deep.ts` is three hops from the text hits, so the focus component
  // genuinely excludes them; focusing on the hits themselves would exclude
  // nothing and prove nothing.
  const focused = run(reader, { query: 'kernel retrieval', focusPaths: ['src/core/deep.ts'] });
  assert.ok(focused.selected.length < open.selected.length);
  assert.ok((focused.omissions.focus_filtered ?? 0) > 0);
  assert.ok(focused.warnings.some((line) => line.includes('focus paths')));
  assert.ok(!focused.selected.some((entry) => entry.candidate.node === MODULE));
});
