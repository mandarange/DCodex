import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictRecall,
  evaluateCase,
  latencyOf,
  percentile,
  precisionAtK,
  recallAtK,
  runSignature,
  setRecall,
  summarizeAdapter,
  uniqueOrdered
} from '../metrics.js';
import { emptyBenchmarkSafety, type ContextGraphBenchmarkCase, type ContextGraphBenchmarkRun } from '../types.js';

const CASE: ContextGraphBenchmarkCase = {
  id: 'hand-computed',
  title: 'hand computed fixture',
  query: 'q',
  profile: 'implementation',
  fixture: 'test-production-binding',
  changedPaths: ['src/a.ts'],
  focusPaths: [],
  tokenBudget: 1000,
  risk: 'normal',
  k: 4,
  gold: {
    paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    nodeIds: ['file:src/a.ts', 'file:src/b.ts'],
    gateIds: ['gate_one', 'gate_two'],
    protectedGateIds: ['gate_one'],
    testPaths: ['src/__tests__/a.test.ts'],
    conflicts: [{ path: 'src/shared.ts', slices: ['slice-a', 'slice-b'] }],
    mustExcludePaths: ['docs/decoy.md'],
    stalePaths: [],
    invalidatedPaths: [],
    exactSeedPaths: ['src/a.ts']
  }
};

function run(overrides: Partial<ContextGraphBenchmarkRun> = {}): ContextGraphBenchmarkRun {
  return {
    caseId: CASE.id,
    adapterId: 'stub',
    mode: 'cold',
    iteration: 0,
    ok: true,
    errorCode: null,
    matchedPaths: [],
    matchedNodeIds: [],
    selectedGateIds: [],
    selectedTestPaths: [],
    writeScopeConflicts: [],
    tokenCost: 1000,
    latencyMs: 10,
    cacheHit: false,
    provenanceCoverage: 1,
    staleIncluded: [],
    invalidatedIncluded: [],
    exactSeedsPreserved: [],
    safety: emptyBenchmarkSafety(),
    ...overrides
  };
}

test('recall@k and precision@k match hand-computed values', () => {
  const gold = ['a', 'b', 'c', 'd'];
  const ranked = ['a', 'x', 'b', 'y'];
  assert.equal(recallAtK(gold, ranked, 8), 0.5);
  assert.equal(precisionAtK(gold, ranked, 8), 0.5);
  assert.equal(recallAtK(gold, ranked, 1), 0.25);
  assert.equal(precisionAtK(gold, ranked, 1), 1);
  assert.equal(precisionAtK(gold, ranked, 2), 0.5);
  assert.equal(recallAtK(gold, [], 8), 0);
  assert.equal(precisionAtK(gold, [], 8), 0);
  assert.equal(recallAtK([], ranked, 8), 1, 'an empty gold set is trivially recalled');
});

test('duplicate results neither inflate recall nor hide imprecision', () => {
  assert.deepEqual(uniqueOrdered(['a', 'a', 'b', '']), ['a', 'b']);
  assert.equal(recallAtK(['a', 'b'], ['a', 'a', 'a', 'a'], 4), 0.5);
  assert.equal(precisionAtK(['a', 'b'], ['a', 'a', 'a', 'a'], 4), 1);
});

test('set recall and conflict recall are order independent', () => {
  assert.equal(setRecall(['g1', 'g2'], ['g2', 'g1', 'g3']), 1);
  assert.equal(setRecall(['g1', 'g2'], ['g2']), 0.5);
  assert.equal(
    conflictRecall(
      [{ path: 'src/shared.ts', slices: ['slice-a', 'slice-b'] }],
      [{ path: 'src/shared.ts', slices: ['slice-b', 'slice-a'] }]
    ),
    1
  );
  assert.equal(
    conflictRecall([{ path: 'src/shared.ts', slices: ['slice-a', 'slice-b'] }], [{ path: 'src/other.ts', slices: ['slice-a', 'slice-b'] }]),
    0
  );
});

test('percentiles use nearest rank on a sorted copy', () => {
  const samples = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  assert.equal(percentile(samples, 0.5), 5);
  assert.equal(percentile(samples, 0.95), 10);
  assert.equal(percentile([], 0.5), 0);
  const latency = latencyOf([4, 1, 3]);
  assert.equal(latency.samples, 3);
  assert.equal(latency.min, 1);
  assert.equal(latency.max, 4);
  assert.equal(latency.p50, 3);
});

test('a perfect answer scores task-context success', () => {
  const metrics = evaluateCase(CASE, 'candidate-graph', 'candidate', [
    run({
      matchedPaths: CASE.gold.paths,
      selectedGateIds: CASE.gold.gateIds,
      selectedTestPaths: CASE.gold.testPaths,
      writeScopeConflicts: CASE.gold.conflicts,
      exactSeedsPreserved: CASE.gold.exactSeedPaths
    })
  ]);
  assert.equal(metrics.recallAtK, 1);
  assert.equal(metrics.precisionAtK, 1);
  assert.equal(metrics.protectedGateRecall, 1);
  assert.equal(metrics.conflictRecall, 1);
  assert.equal(metrics.exclusionCorrect, true);
  assert.equal(metrics.taskContextSuccess, true);
  assert.equal(metrics.usefulEvidence, 4 + 2 + 1 + 1);
});

test('returning a must-exclude path fails the exclusion check and task-context success', () => {
  const metrics = evaluateCase(CASE, 'baseline-lexical', 'baseline', [
    run({
      matchedPaths: [...CASE.gold.paths, 'docs/decoy.md'],
      selectedGateIds: CASE.gold.gateIds,
      selectedTestPaths: CASE.gold.testPaths,
      writeScopeConflicts: CASE.gold.conflicts,
      exactSeedsPreserved: CASE.gold.exactSeedPaths
    })
  ]);
  assert.deepEqual(metrics.mustExcludeViolations, ['docs/decoy.md']);
  assert.equal(metrics.exclusionCorrect, false);
  assert.equal(metrics.taskContextSuccess, false);
});

test('including a stale item fails exclusion even when every gold item is present', () => {
  const metrics = evaluateCase(CASE, 'candidate-graph', 'candidate', [
    run({
      matchedPaths: CASE.gold.paths,
      selectedGateIds: CASE.gold.gateIds,
      selectedTestPaths: CASE.gold.testPaths,
      writeScopeConflicts: CASE.gold.conflicts,
      exactSeedsPreserved: CASE.gold.exactSeedPaths,
      staleIncluded: ['.sneakoscope/wiki/claims/old.md']
    })
  ]);
  assert.equal(metrics.exclusionCorrect, false);
  assert.equal(metrics.taskContextSuccess, false);
});

test('losing an exact symbol seed fails task-context success', () => {
  const metrics = evaluateCase(CASE, 'baseline-lexical', 'baseline', [
    run({
      matchedPaths: CASE.gold.paths,
      selectedGateIds: CASE.gold.gateIds,
      selectedTestPaths: CASE.gold.testPaths,
      writeScopeConflicts: CASE.gold.conflicts,
      exactSeedsPreserved: []
    })
  ]);
  assert.equal(metrics.exactSeedPreservation, 0);
  assert.equal(metrics.taskContextSuccess, false);
});

test('cold and warm samples stay in separate latency buckets', () => {
  const metrics = evaluateCase(CASE, 'candidate-graph', 'candidate', [
    run({ mode: 'cold', iteration: 0, latencyMs: 200, cacheHit: false }),
    run({ mode: 'warm', iteration: 0, latencyMs: 20, cacheHit: true }),
    run({ mode: 'warm', iteration: 1, latencyMs: 30, cacheHit: true })
  ]);
  assert.equal(metrics.coldRuns, 1);
  assert.equal(metrics.warmRuns, 2);
  assert.equal(metrics.coldLatency.p95, 200);
  assert.equal(metrics.warmLatency.p95, 30);
  assert.equal(metrics.coldCacheHits, 0);
  assert.equal(metrics.warmCacheHits, 2);
});

test('run signatures ignore ordering of unordered fields but not of ranked ones', () => {
  const left = run({ matchedPaths: ['a', 'b'], selectedGateIds: ['g2', 'g1'] });
  const right = run({ matchedPaths: ['a', 'b'], selectedGateIds: ['g1', 'g2'] });
  const flipped = run({ matchedPaths: ['b', 'a'], selectedGateIds: ['g1', 'g2'] });
  assert.equal(runSignature(left), runSignature(right));
  assert.notEqual(runSignature(left), runSignature(flipped));
});

test('evidence density divides useful evidence by thousands of tokens', () => {
  const metrics = evaluateCase(CASE, 'candidate-graph', 'candidate', [
    run({ matchedPaths: CASE.gold.paths, tokenCost: 2000 })
  ]);
  const summary = summarizeAdapter('candidate-graph', 'candidate', [metrics], [10], [5, 6]);
  assert.equal(summary.meanTokenCost, 2000);
  assert.equal(summary.usefulEvidencePerKiloToken, 4 / 2);
  assert.equal(summary.warmLatency.samples, 2);
  assert.equal(summary.coldLatency.samples, 1);
});
