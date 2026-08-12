import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_FLAG,
  CandidateTable,
  TraversalFrontier,
  fixedKernelClock,
  isExactKernelConfidence,
  resolveQueryPlan,
  runSafetyClosure,
  runSeedLanes,
  traverseKernelGraph,
  type KernelRequest,
} from '../kernel.js';
import { CONTEXT_GRAPH_RANKING_CONFIG } from '../ranking-config.js';
import { GATE, INVALID, KERNEL, KERNEL_PATH, LANES, MODULE, SYMBOL, TEST, openKernelIndex } from './kernel-fixtures.js';
import { countingReader } from './kernel-fixtures.js';
import type { ContextIndexReader } from '../../runtime-index/reader.js';

const clock = fixedKernelClock(0);

function walk(reader: ContextIndexReader, request: KernelRequest, safety = true) {
  const context = resolveQueryPlan(reader, request, { clock });
  const table = new CandidateTable(context.plan.candidateBudget);
  runSeedLanes(reader, context, request, table);
  const closure = safety ? runSafetyClosure(reader, context, table) : null;
  const outcome = traverseKernelGraph(reader, context, table, closure !== null && !closure.capHit);
  return { context, table, outcome, closure };
}

test('the frontier order is total, so insertion order cannot reach the answer', () => {
  const order = (inserts: ReadonlyArray<readonly [number, number, number, number]>): number[] => {
    const frontier = new TraversalFrontier(16);
    for (const [node, score, depth, priority] of inserts) {
      frontier.push(node, score, depth, priority, node, -1, -1, 0);
    }
    const popped: number[] = [];
    while (frontier.pop()) popped.push(frontier.node);
    return popped;
  };
  // Same four states, four insertion orders: identical pop order every time.
  const states: ReadonlyArray<readonly [number, number, number, number]> = [
    [7, 100, 1, 5],
    [3, 100, 1, 5],
    [9, 100, 0, 5],
    [4, 200, 2, 1],
  ];
  const expected = order(states);
  assert.deepEqual(expected, [4, 9, 3, 7], 'score, then depth, then priority, then node id');
  assert.deepEqual(order([...states].reverse()), expected);
  assert.deepEqual(order([states[2] as never, states[0] as never, states[3] as never, states[1] as never]), expected);
});

test('the frontier refuses past its budget and counts the refusals', () => {
  const frontier = new TraversalFrontier(2);
  assert.ok(frontier.push(1, 10, 0, 0, 1, -1, -1, 0));
  assert.ok(frontier.push(2, 20, 0, 0, 2, -1, -1, 0));
  assert.ok(!frontier.push(3, 30, 0, 0, 3, -1, -1, 0));
  assert.equal(frontier.rejected, 1);
  // A popped slot is reusable, and reusing it must not corrupt a live state.
  assert.ok(frontier.pop());
  assert.equal(frontier.node, 2);
  assert.ok(frontier.push(4, 5, 0, 0, 4, -1, -1, 0));
  assert.ok(frontier.pop());
  assert.equal(frontier.node, 1);
  assert.ok(frontier.pop());
  assert.equal(frontier.node, 4);
});

test('the walk records a parent chain, and a graph neighbour is never exact', () => {
  const reader = openKernelIndex();
  const { table } = walk(reader, { query: KERNEL_PATH });

  const seedSlot = table.slotOf(KERNEL);
  assert.ok(isExactKernelConfidence(table.confidenceOf(seedSlot)));

  const neighbour = table.slotOf(LANES);
  assert.notEqual(neighbour, -1);
  assert.equal(table.depth[neighbour], 1);
  assert.equal(table.parentNode[neighbour], KERNEL);
  assert.ok((table.parentEdge[neighbour] as number) >= 0, 'a parent pointer, not an explanation object');
  assert.ok(
    !isExactKernelConfidence(table.confidenceOf(neighbour)),
    'a neighbour of an exact seed is a candidate, not an exact match',
  );
  assert.equal(table.confidenceOf(neighbour), 'syntactic_reference');
  assert.deepEqual(table.parentChain(neighbour, 3), [table.parentEdge[neighbour] as number]);
});

test('an edge the profile excludes is never traversed', () => {
  const reader = openKernelIndex();
  const request: KernelRequest = {
    query: 'zzzz',
    profile: 'answer',
    seeds: [{ nodeId: 'file:src/core/kernel.ts', confidence: 'exact_definition' }],
  };
  const { table } = walk(reader, request);

  // `contains` is an answer edge, so the module is reached by the walk.
  assert.ok(table.rankIn(table.slotOf(MODULE), 'local_graph') >= 0);
  // `imports` and `defines` are not, so neither neighbour is a graph candidate —
  // even though the safety closure may have put one of them in the table.
  const graphRank = (node: number): number => {
    const slot = table.slotOf(node);
    return slot === -1 ? -1 : table.rankIn(slot, 'local_graph');
  };
  assert.equal(graphRank(SYMBOL), -1);
  assert.equal(graphRank(LANES), -1);
});

test('the depth cap stops the walk and is reported', () => {
  const reader = openKernelIndex();
  const { context, outcome } = walk(reader, { query: KERNEL_PATH });
  assert.ok(outcome.depthLimited > 0);
  assert.equal(context.omissions.depth_limit, outcome.depthLimited);
});

test('the deadline is read from the injected clock and reported as a timeout', () => {
  const reader = openKernelIndex();
  let now = 0;
  const request: KernelRequest = { query: KERNEL_PATH, timeoutMs: 5 };
  const context = resolveQueryPlan(reader, request, {
    clock: () => now,
    // The real interval is 512 edges, which this fixture never reaches; the
    // deadline logic under test is the same either way.
    config: { ...CONTEXT_GRAPH_RANKING_CONFIG, timeoutCheckInterval: 1 },
  });
  const table = new CandidateTable(context.plan.candidateBudget);
  runSeedLanes(reader, context, request, table);
  now = 1_000;
  const outcome = traverseKernelGraph(reader, context, table, true);
  assert.equal(outcome.timedOut, true);
  assert.equal(context.omissions.timeout, 1);
  assert.ok(context.warnings.some((line) => line.includes('deadline')));
});

test('the safety closure reaches a protected gate and a conflict the profile excludes', () => {
  const reader = openKernelIndex();
  const { table, context } = walk(reader, { query: KERNEL_PATH, profile: 'implementation' });

  const gate = table.slotOf(GATE);
  assert.notEqual(gate, -1, 'protectedGateRecall is an equality, not a target');
  assert.ok(table.has(gate, CANDIDATE_FLAG.SAFETY));
  assert.ok(table.has(gate, CANDIDATE_FLAG.PROTECTED));

  const conflict = table.slotOf(LANES);
  assert.ok(table.has(conflict, CANDIDATE_FLAG.CONFLICT), 'conflicts_with is not an implementation edge');
  assert.ok(table.has(table.slotOf(INVALID), CANDIDATE_FLAG.CONFLICT));
  assert.ok(table.has(table.slotOf(TEST), CANDIDATE_FLAG.TEST_OR_GATE));
  assert.equal(context.omissions.safety_cap, undefined);
});

test('without the closure a low-scoring protected gate is exactly what the frontier drops', () => {
  const reader = openKernelIndex();
  const { table } = walk(reader, { query: KERNEL_PATH, profile: 'planning' }, false);
  // `verified_by` is not a planning edge, so relevance alone cannot reach the
  // gate. This is the failure the separate closure exists to prevent.
  assert.equal(table.slotOf(GATE), -1);
  const withClosure = walk(reader, { query: KERNEL_PATH, profile: 'planning' }, true);
  assert.notEqual(withClosure.table.slotOf(GATE), -1);
});

test('the walk allocates no per-node neighbour array and no edge object', () => {
  const reader = openKernelIndex();
  const log = countingReader(reader);
  const { outcome, closure } = walk(log.reader, { query: KERNEL_PATH });
  const cursors = (log.calls.get('outgoing') ?? 0) + (log.calls.get('incoming') ?? 0);
  const visited = outcome.visitedNodes + (closure?.visitedNodes ?? 0);
  assert.ok(cursors <= visited * 2, 'one cursor per visited node per direction, never per edge');
  assert.equal(log.calls.get('hydrateEdge'), undefined, 'an edge is four integers on a cursor');
  assert.equal(log.calls.get('hydrateNode'), undefined, 'nothing is hydrated during ranking');
});

test('the traversal result is identical over 100 runs', () => {
  const reader = openKernelIndex();
  const request: KernelRequest = { query: `${KERNEL_PATH} kernel retrieval`, profile: 'review', risk: 'high' };
  const shape = (): string => {
    const { table } = walk(reader, request);
    const rows: string[] = [];
    for (let slot = 0; slot < table.size; slot += 1) {
      rows.push([
        table.node[slot],
        table.depth[slot],
        table.parentNode[slot],
        table.parentEdge[slot],
        table.graphScore[slot],
        table.confidenceOf(slot),
      ].join(':'));
    }
    return rows.join('|');
  };
  const first = shape();
  for (let run = 1; run < 100; run += 1) assert.equal(shape(), first, `run ${run} diverged`);
});
