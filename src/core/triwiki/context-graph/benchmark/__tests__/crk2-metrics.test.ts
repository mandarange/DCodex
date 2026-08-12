import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRK2_EMPTY_LATENCY,
  crk2ConfidenceViolations,
  crk2ConflictRecall,
  crk2LatencyProfile,
  crk2MatcherKey,
  crk2MatcherMatches,
  crk2ProvenanceCoverage,
  crk2ResultSignature,
  crk2SetRecall,
  evaluateCrk2Case,
  summarizeCrk2Engine
} from '../crk2-metrics.js';
import { CRK2_CASES } from '../crk2-corpus.js';
import type { Crk2Case, Crk2EngineResult } from '../crk2-types.js';
import { perfectPlanFor } from './crk2-stub-engine.js';

const ENGINE = { id: 'stub-v2', version: 'v2' } as const;

function result(overrides: Partial<Crk2EngineResult> = {}): Crk2EngineResult {
  return {
    ok: true,
    errorCode: null,
    nodeIds: [],
    provenanceNodeIds: [],
    confidenceByNodeId: {},
    selectedGateIds: [],
    droppedGateIds: [],
    conflicts: [],
    tokenCost: 0,
    latencyMs: 1,
    cacheHit: false,
    ...overrides
  };
}

function caseById(id: string): Crk2Case {
  const found = CRK2_CASES.find((item) => item.id === id);
  assert.ok(found, `missing corpus case ${id}`);
  return found;
}

function fromPlan(testCase: Crk2Case, overrides: Partial<Crk2EngineResult> = {}): Crk2EngineResult {
  const plan = perfectPlanFor(testCase);
  return result({
    ok: plan.ok ?? true,
    errorCode: plan.errorCode ?? null,
    nodeIds: plan.nodeIds ?? [],
    provenanceNodeIds: plan.provenanceNodeIds ?? [],
    confidenceByNodeId: plan.confidenceByNodeId ?? {},
    selectedGateIds: plan.selectedGateIds ?? [],
    droppedGateIds: plan.droppedGateIds ?? [],
    conflicts: plan.conflicts ?? [],
    tokenCost: plan.tokenCost ?? 0,
    ...overrides
  });
}

test('latency reports p50, p95 and p99 by nearest rank', () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1);
  const profile = crk2LatencyProfile(samples);
  assert.equal(profile.samples, 100);
  assert.equal(profile.p50, 50);
  assert.equal(profile.p95, 95);
  assert.equal(profile.p99, 99);
  assert.equal(profile.min, 1);
  assert.equal(profile.max, 100);
  assert.equal(profile.mean, 50.5);
  assert.deepEqual(crk2LatencyProfile([]), CRK2_EMPTY_LATENCY);
});

test('a tail spike moves p99 while p50 and p95 stay flat', () => {
  // Nearest rank over 100 samples: p95 is the 95th smallest and p99 the 99th, so
  // two slow runs are what a p99 sees and a p95 does not.
  const flat = Array.from({ length: 100 }, () => 5);
  const spiked = [...flat.slice(0, 98), 900, 900];
  const before = crk2LatencyProfile(flat);
  const after = crk2LatencyProfile(spiked);
  assert.equal(after.p50, before.p50);
  assert.equal(after.p95, before.p95);
  assert.equal(after.p99, 900);
  assert.ok(after.p99 > before.p99, 'a tail that only p99 can see is exactly what an unbounded scan looks like');
});

test('a symbol matcher ignores the compiler-assigned offset but not the name', () => {
  const matcher = { kind: 'symbol', path: 'src/a/b.ts', name: 'hydrateNode' } as const;
  assert.equal(crk2MatcherMatches(matcher, 'symbol:src/a/b.ts#function:hydrateNode@412'), true);
  assert.equal(crk2MatcherMatches(matcher, 'symbol:src/a/b.ts#method:hydrateNode@0'), true);
  assert.equal(crk2MatcherMatches(matcher, 'symbol:src/a/b.ts#function:hydrateNodes@0'), false);
  assert.equal(crk2MatcherMatches(matcher, 'symbol:src/a/other.ts#function:hydrateNode@0'), false);
  assert.equal(crk2MatcherMatches(matcher, 'file:src/a/b.ts'), false);
  assert.equal(crk2MatcherKey(matcher), 'symbol:src/a/b.ts#hydrateNode');
});

test('path and id prefix matchers read the right half of the id', () => {
  const byPath = { kind: 'path_prefix', prefix: 'src/core/triwiki/' } as const;
  assert.equal(crk2MatcherMatches(byPath, 'file:src/core/triwiki/context-graph/ids.ts'), true);
  assert.equal(crk2MatcherMatches(byPath, 'file:src/cli/commands/search-context.ts'), false);
  const byId = { kind: 'id_prefix', prefix: 'claim:' } as const;
  assert.equal(crk2MatcherMatches(byId, 'claim:deadbeef'), true);
  assert.equal(crk2MatcherMatches(byId, 'file:claim:deadbeef'), false);
});

test('recall respects the rank cutoff and forbidden nodes do not', () => {
  const testCase = caseById('basename-index-ts-collision');
  const gold = testCase.gold.mustIncludeNodeIds;
  const truncated = evaluateCrk2Case(testCase, ENGINE, {
    result: fromPlan(testCase, { nodeIds: gold.slice(0, 2), provenanceNodeIds: gold.slice(0, 2) }),
    latencySamples: [3],
    determinismMismatches: 0
  });
  assert.equal(truncated.mustIncludeRecall, 2 / 3);
  assert.deepEqual(truncated.missingMustInclude, [gold[2]]);
});

test('a forbidden node found past k is still a violation', () => {
  const testCase = caseById('focus-path-restricted-answer');
  const forbidden = testCase.gold.forbiddenNodeIds[0];
  assert.ok(forbidden);
  const padding = Array.from({ length: testCase.k + 3 }, (_, index) => `file:src/core/pad-${index}.ts`);
  const metrics = evaluateCrk2Case(testCase, ENGINE, {
    result: fromPlan(testCase, { nodeIds: [...padding, forbidden], provenanceNodeIds: [...padding, forbidden] }),
    latencySamples: [3],
    determinismMismatches: 0
  });
  assert.deepEqual(metrics.forbiddenViolations, [forbidden]);
});

test('provenance coverage is derived from the returned sets, not reported by the engine', () => {
  const covered = result({ nodeIds: ['file:a.ts', 'file:b.ts'], provenanceNodeIds: ['file:a.ts', 'file:b.ts'] });
  const partial = result({ nodeIds: ['file:a.ts', 'file:b.ts'], provenanceNodeIds: ['file:a.ts'] });
  assert.equal(crk2ProvenanceCoverage(covered), 1);
  assert.equal(crk2ProvenanceCoverage(partial), 0.5);
  assert.equal(crk2ProvenanceCoverage(result()), 1, 'an empty answer has nothing to attest to');
});

test('a text hit relabelled as an exact relation trips the confidence ceiling', () => {
  const testCase = caseById('korean-budget-question');
  const nodeId = testCase.gold.mustIncludeNodeIds[0];
  assert.ok(nodeId);
  const honest = crk2ConfidenceViolations(
    testCase,
    result({ nodeIds: [nodeId], confidenceByNodeId: { [nodeId]: 'text_candidate' } })
  );
  assert.deepEqual(honest, []);
  const inflated = crk2ConfidenceViolations(
    testCase,
    result({ nodeIds: [nodeId], confidenceByNodeId: { [nodeId]: 'exact_definition' } })
  );
  assert.deepEqual(inflated, [`${nodeId}:above_ceiling_text_candidate`]);
});

test('a node that misses its required confidence is a violation even when it is returned', () => {
  const testCase = caseById('exact-path-kernel');
  const nodeId = Object.keys(testCase.gold.requiredConfidence ?? {})[0];
  assert.ok(nodeId);
  const violations = crk2ConfidenceViolations(
    testCase,
    result({ nodeIds: [nodeId], confidenceByNodeId: { [nodeId]: 'text_candidate' } })
  );
  assert.deepEqual(violations, [`${nodeId}:expected_file_path`]);
});

test('set and conflict recall score an empty gold set as satisfied', () => {
  assert.equal(crk2SetRecall([], ['anything']), 1);
  assert.equal(crk2SetRecall(['a', 'b'], ['a']), 0.5);
  assert.equal(crk2ConflictRecall([], []), 1);
  assert.equal(
    crk2ConflictRecall(
      [{ path: 'src/core/shared/registry.ts', slices: ['b', 'a'] }],
      [{ path: 'src/core/shared/registry.ts', slices: ['a', 'b'] }]
    ),
    1,
    'slice order is not part of a conflict identity'
  );
});

test('a rejection case is only correct when the exact code comes back with no results', () => {
  const testCase = caseById('corrupt-truncated-binary');
  const expected = String(testCase.gold.expectedErrorCode);
  const correct = evaluateCrk2Case(testCase, ENGINE, {
    result: result({ ok: false, errorCode: expected }),
    latencySamples: [1],
    determinismMismatches: 0
  });
  assert.equal(correct.rejectionCorrect, true);
  const salvaged = evaluateCrk2Case(testCase, ENGINE, {
    result: result({ ok: false, errorCode: expected, nodeIds: ['file:config/context-graph.json'] }),
    latencySamples: [1],
    determinismMismatches: 0
  });
  assert.equal(salvaged.rejectionCorrect, false, 'a best-effort partial read is not a rejection');
  const wrongCode = evaluateCrk2Case(testCase, ENGINE, {
    result: result({ ok: false, errorCode: 'context_index_missing' }),
    latencySamples: [1],
    determinismMismatches: 0
  });
  assert.equal(wrongCode.rejectionCorrect, false);
});

test('a protected gate that vanishes without a warning is reported separately from its recall', () => {
  const testCase = caseById('protected-gate-budget-squeeze');
  const silent = evaluateCrk2Case(testCase, ENGINE, {
    result: fromPlan(testCase, { selectedGateIds: [] }),
    latencySamples: [2],
    determinismMismatches: 0
  });
  assert.equal(silent.protectedGateRecall, 0);
  assert.equal(silent.droppedGateWarned, false);
  const warned = evaluateCrk2Case(testCase, ENGINE, {
    result: fromPlan(testCase, { selectedGateIds: [], droppedGateIds: [...testCase.gold.protectedGateIds] }),
    latencySamples: [2],
    determinismMismatches: 0
  });
  assert.equal(warned.droppedGateWarned, true);
});

test('the case metrics record how much each case asked for', () => {
  const testCase = caseById('conflict-parallel-write-registry');
  const metrics = evaluateCrk2Case(testCase, ENGINE, {
    result: fromPlan(testCase),
    latencySamples: [2],
    determinismMismatches: 0
  });
  assert.equal(metrics.declaredConflictCount, testCase.gold.conflicts.length);
  assert.equal(metrics.declaredProtectedGateCount, testCase.gold.protectedGateIds.length);
  assert.equal(metrics.conflictRecall, 1);
  assert.equal(metrics.protectedGateRecall, 1);
});

test('one missed protected gate is not diluted by cases that never declared one', () => {
  const withGate = caseById('protected-gate-release-proof');
  const withoutGate = caseById('basename-reader-ts');
  const missed = evaluateCrk2Case(withGate, ENGINE, {
    result: fromPlan(withGate, { selectedGateIds: [] }),
    latencySamples: [2],
    determinismMismatches: 0
  });
  const silent = evaluateCrk2Case(withoutGate, ENGINE, {
    result: fromPlan(withoutGate),
    latencySamples: [2],
    determinismMismatches: 0
  });
  const samples = new Map<string, readonly number[]>([
    [missed.caseId, [2]],
    [silent.caseId, [2]]
  ]);
  const summary = summarizeCrk2Engine(ENGINE, [missed, silent], samples);
  assert.equal(summary.protectedGateRecall, 0, 'averaging over every case would have reported 0.5');
});

test('category stats carry recall and latency in the same record', () => {
  const testCase = caseById('korean-budget-question');
  const metrics = evaluateCrk2Case(testCase, ENGINE, {
    result: result(),
    latencySamples: [1, 1, 1],
    determinismMismatches: 0
  });
  const summary = summarizeCrk2Engine(ENGINE, [metrics], new Map([[testCase.id, [1, 1, 1]]]));
  const korean = summary.categories.find((item) => item.category === 'korean');
  assert.ok(korean);
  assert.equal(korean.latency.p95, 1, 'the fastest possible answer');
  assert.equal(korean.mustIncludeRecall, 0, 'and it found nothing, which is the point');
});

test('the answer signature changes when the answer changes, not when the timing does', () => {
  const base = result({ nodeIds: ['file:a.ts'], provenanceNodeIds: ['file:a.ts'], latencyMs: 4 });
  const slower = result({ nodeIds: ['file:a.ts'], provenanceNodeIds: ['file:a.ts'], latencyMs: 400, cacheHit: true });
  const different = result({ nodeIds: ['file:b.ts'], provenanceNodeIds: ['file:b.ts'], latencyMs: 4 });
  assert.equal(crk2ResultSignature(base), crk2ResultSignature(slower));
  assert.notEqual(crk2ResultSignature(base), crk2ResultSignature(different));
});
