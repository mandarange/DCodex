import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CONTEXT_GRAPH_QUERY_PROFILE_NAMES } from '../../profiles.js';
import { RETRIEVAL_LANES, fixedKernelClock, runContextKernel, type KernelRequest } from '../kernel.js';
import { GATE_ID, KERNEL_PATH, countingReader, openKernelIndex } from './kernel-fixtures.js';

const clock = fixedKernelClock(0);
const BROAD: KernelRequest = { query: `${KERNEL_PATH} ${GATE_ID} kernel retrieval`, profile: 'review', risk: 'high' };

test('the kernel never reads the wall clock', () => {
  const reader = openKernelIndex();
  const real = Date.now;
  Date.now = () => {
    throw new Error('Date.now is not available to the kernel');
  };
  try {
    const result = runContextKernel(reader, BROAD, { clock: fixedKernelClock(7) });
    assert.ok(result.selected.length > 0);
    assert.equal(result.durationMs, 0, 'a fixed clock means a zero duration, not a measured one');
  } finally {
    Date.now = real;
  }
});

test('nothing is hydrated while ranking', () => {
  const reader = openKernelIndex();
  const log = countingReader(reader);
  const result = runContextKernel(log.reader, BROAD, { clock });
  assert.ok(result.selected.length > 0);
  assert.equal(log.calls.get('hydrateNode'), undefined);
  assert.equal(log.calls.get('hydrateEdge'), undefined);
  assert.equal(log.calls.get('provenance'), undefined);
  // The one whole-section materialization the reader offers is a validation
  // path API; a query that called it would be reading the index twice.
  assert.equal(log.calls.get('sourceHashes'), undefined);
  // The bounded integer view is allowed, once per candidate at most.
  assert.ok((log.calls.get('nodeScoreFields') ?? 0) <= result.candidateCount);
});

test('the whole kernel is identical over 100 runs', () => {
  const reader = openKernelIndex();
  const shape = (): string => {
    const result = runContextKernel(reader, BROAD, { clock });
    return result.selected
      .map((entry) => [
        entry.candidate.node,
        entry.candidate.score.toString(),
        entry.candidate.depth,
        entry.candidate.parentEdge,
        entry.confidence,
        entry.lane,
        entry.parentEdges.join('>'),
      ].join(':'))
      .join('|');
  };
  const first = shape();
  assert.notEqual(first, '');
  for (let run = 1; run < 100; run += 1) assert.equal(shape(), first, `run ${run} diverged`);
});

test('every profile answers, and the lane telemetry is complete and ordered', () => {
  const reader = openKernelIndex();
  for (const profile of CONTEXT_GRAPH_QUERY_PROFILE_NAMES) {
    const result = runContextKernel(reader, { ...BROAD, profile }, { clock });
    assert.equal(result.plan.profile, profile);
    assert.deepEqual(result.lanes.map((lane) => lane.lane), [...RETRIEVAL_LANES]);
    for (const lane of result.lanes) {
      assert.ok(lane.postingsExamined >= 0);
      assert.ok(lane.candidates >= 0);
    }
    assert.ok(result.tokenCost <= result.plan.tokenBudget);
  }
});

test('a result is frozen, so a consumer cannot edit the receipt it was handed', () => {
  const reader = openKernelIndex();
  const result = runContextKernel(reader, BROAD, { clock });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.plan));
  assert.ok(Object.isFrozen(result.omissions));
  for (const entry of result.selected) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.candidate));
  }
});

/**
 * Comments are stripped before the check because every one of these modules
 * *names* the thing it must not do, in the comment explaining why. Testing the
 * emitted module rather than the source is deliberate: what ships is what runs.
 */
function emittedCode(name: string): string {
  const text = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the kernel does not reach the retired v1 seed engine, its key scan, or the wall clock', () => {
  const modules = [
    'kernel.js',
    'kernel-plan.js',
    'kernel-lanes.js',
    'kernel-candidates.js',
    'kernel-frontier.js',
    'kernel-safety.js',
    'kernel-traverse.js',
    'kernel-fuse.js',
    'kernel-select.js',
    'kernel-types.js',
  ];
  for (const name of modules) {
    const code = emittedCode(name);
    assert.ok(!code.includes('context-graph-seeds'), `${name} must not reach the v1 seed engine`);
    assert.ok(!code.includes('nodesByLabel'), `${name} must not scan the label map`);
    assert.ok(!code.includes('nodesByPath'), `${name} must not scan the path map`);
    assert.ok(!/\bDate\.now\b/.test(code), `${name} must take its clock as an argument`);
    // No reranker, no vectors, no model: the prohibitions are checkable, so they
    // are checked rather than asserted in a header comment.
    assert.ok(!/\bfetch\b|embedding|cosine|rerank/i.test(code), `${name} must stay offline and model-free`);
  }
});
