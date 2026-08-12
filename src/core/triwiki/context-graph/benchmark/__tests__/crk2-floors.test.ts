import test from 'node:test';
import assert from 'node:assert/strict';
import { CRK2_FLOOR_SPECS, crk2FloorCoverageGap, crk2FloorIds, evaluateCrk2Floors } from '../crk2-floors.js';
import { CRK2_FLOOR_IDS, type Crk2CaseMetrics, type Crk2EngineSummary } from '../crk2-types.js';
import { CRK2_CASES } from '../crk2-corpus.js';
import { evaluateCrk2Case, summarizeCrk2Engine } from '../crk2-metrics.js';
import { scanForLeaks } from '../floors.js';
import { perfectPlanFor } from './crk2-stub-engine.js';
import type { Crk2EngineResult } from '../crk2-types.js';

const ENGINE = { id: 'stub-v2', version: 'v2' } as const;

function resultFor(caseId: string, overrides: Partial<Crk2EngineResult> = {}): Crk2EngineResult {
  const testCase = CRK2_CASES.find((item) => item.id === caseId);
  assert.ok(testCase);
  const plan = perfectPlanFor(testCase);
  return {
    ok: plan.ok ?? true,
    errorCode: plan.errorCode ?? null,
    nodeIds: plan.nodeIds ?? [],
    provenanceNodeIds: plan.provenanceNodeIds ?? [],
    confidenceByNodeId: plan.confidenceByNodeId ?? {},
    selectedGateIds: plan.selectedGateIds ?? [],
    droppedGateIds: plan.droppedGateIds ?? [],
    conflicts: plan.conflicts ?? [],
    tokenCost: plan.tokenCost ?? 0,
    latencyMs: 3,
    cacheHit: false,
    ...overrides
  };
}

function runAll(overrideByCaseId: ReadonlyMap<string, Partial<Crk2EngineResult>> = new Map()): {
  summary: Crk2EngineSummary;
  rows: readonly Crk2CaseMetrics[];
} {
  const rows: Crk2CaseMetrics[] = [];
  const samples = new Map<string, readonly number[]>();
  for (const testCase of CRK2_CASES) {
    const override = overrideByCaseId.get(testCase.id) ?? {};
    rows.push(
      evaluateCrk2Case(testCase, ENGINE, {
        result: resultFor(testCase.id, override),
        latencySamples: [3, 3, 3],
        determinismMismatches: 0
      })
    );
    samples.set(testCase.id, [3, 3, 3]);
  }
  return { summary: summarizeCrk2Engine(ENGINE, rows, samples), rows };
}

test('every declared floor id has a spec, and every spec is an equality', () => {
  assert.deepEqual(crk2FloorCoverageGap(), []);
  assert.deepEqual([...crk2FloorIds()].sort(), [...CRK2_FLOOR_IDS].sort());
  const { summary, rows } = runAll();
  for (const result of evaluateCrk2Floors(summary, rows).results) {
    assert.equal(result.comparison, 'eq', `${result.id} must be an equality, not a threshold`);
  }
});

test('the ADR floor set is present and required at exactly 1.0 or 0', () => {
  const byId = new Map(CRK2_FLOOR_SPECS.map((spec) => [spec.id, spec]));
  assert.equal(byId.get('provenance_coverage_exact')?.required, 1);
  assert.equal(byId.get('protected_gate_recall_exact')?.required, 1);
  assert.equal(byId.get('conflict_recall_exact')?.required, 1);
  assert.equal(byId.get('corrupt_input_rejection_exact')?.required, 1);
  assert.equal(byId.get('determinism_zero_mismatch')?.required, 0);
  assert.equal(byId.get('forbidden_node_zero')?.required, 0);
  assert.equal(byId.get('unsupported_language_exact_mislabel_zero')?.required, 0);
});

test('an engine that answers the whole gold set clears every floor', () => {
  const { summary, rows } = runAll();
  const report = evaluateCrk2Floors(summary, rows);
  assert.equal(report.ok, true, report.results.filter((item) => !item.passed).map((item) => item.id).join(','));
  assert.equal(report.failed, 0);
  assert.equal(report.evaluated, CRK2_FLOOR_SPECS.length);
});

test('a provenance coverage of 0.999 is a failure, not a rounding error', () => {
  const { summary, rows } = runAll();
  const nearly: Crk2EngineSummary = { ...summary, provenanceCoverage: 0.999 };
  const report = evaluateCrk2Floors(nearly, rows);
  const floor = report.results.find((item) => item.id === 'provenance_coverage_exact');
  assert.equal(floor?.passed, false);
  assert.equal(report.ok, false);
});

test('one silently dropped protected gate fails the run and names only the case id', () => {
  const overrides = new Map([['protected-gate-release-proof', { selectedGateIds: [] }]]);
  const { summary, rows } = runAll(overrides);
  const report = evaluateCrk2Floors(summary, rows);
  const floor = report.results.find((item) => item.id === 'protected_gate_recall_exact');
  assert.equal(floor?.passed, false);
  assert.deepEqual(floor?.detail, ['protected-gate-release-proof:protected_gate_missed']);
  assert.equal(report.ok, false);
});

test('one missed conflict fails the run', () => {
  const overrides = new Map([['conflict-parallel-write-registry', { conflicts: [] }]]);
  const { summary, rows } = runAll(overrides);
  const report = evaluateCrk2Floors(summary, rows);
  assert.equal(report.results.find((item) => item.id === 'conflict_recall_exact')?.passed, false);
});

test('one corrupt index that answers instead of refusing fails the rejection floor', () => {
  const overrides = new Map([
    ['corrupt-section-checksum', { ok: true, errorCode: null, nodeIds: ['file:config/context-graph.json'] }]
  ]);
  const { summary, rows } = runAll(overrides);
  const report = evaluateCrk2Floors(summary, rows);
  const floor = report.results.find((item) => item.id === 'corrupt_input_rejection_exact');
  assert.equal(floor?.passed, false);
  assert.ok(floor && floor.observed < 1);
});

test('one mislabelled text hit fails the unsupported-language floor', () => {
  const target = CRK2_CASES.find((item) => item.id === 'jargon-naruto-fanout');
  assert.ok(target);
  const nodeId = target.gold.mustIncludeNodeIds[0];
  assert.ok(nodeId);
  const overrides = new Map([
    [target.id, { nodeIds: [nodeId], provenanceNodeIds: [nodeId], confidenceByNodeId: { [nodeId]: 'exact_definition' as const } }]
  ]);
  const { summary, rows } = runAll(overrides);
  const report = evaluateCrk2Floors(summary, rows);
  assert.equal(report.results.find((item) => item.id === 'unsupported_language_exact_mislabel_zero')?.passed, false);
});

test('a single non-reproducible repeat fails the determinism floor', () => {
  const { rows } = runAll();
  const drifted = rows.map((row, index) => (index === 0 ? { ...row, determinismMismatches: 1 } : row));
  const samples = new Map(drifted.map((row) => [row.caseId, [3, 3, 3] as readonly number[]]));
  const summary = summarizeCrk2Engine(ENGINE, drifted, samples);
  const report = evaluateCrk2Floors(summary, drifted);
  const floor = report.results.find((item) => item.id === 'determinism_zero_mismatch');
  assert.equal(floor?.passed, false);
  assert.equal(floor?.observed, 1);
});

test('a forbidden node anywhere in an answer fails the forbidden-node floor', () => {
  const target = CRK2_CASES.find((item) => item.gold.forbiddenNodeIds.length > 0);
  assert.ok(target);
  const forbidden = target.gold.forbiddenNodeIds[0];
  assert.ok(forbidden);
  const base = perfectPlanFor(target);
  const overrides = new Map([
    [target.id, { nodeIds: [...(base.nodeIds ?? []), forbidden], provenanceNodeIds: [...(base.provenanceNodeIds ?? []), forbidden] }]
  ]);
  const { summary, rows } = runAll(overrides);
  const report = evaluateCrk2Floors(summary, rows);
  assert.equal(report.results.find((item) => item.id === 'forbidden_node_zero')?.passed, false);
});

test('floor detail never carries a path outside the workspace or a raw match', () => {
  const overrides = new Map([['protected-gate-write-scope', { selectedGateIds: [] }]]);
  const { summary, rows } = runAll(overrides);
  const caseIds = new Set(CRK2_CASES.map((item) => item.id));
  for (const result of evaluateCrk2Floors(summary, rows).results) {
    for (const detail of result.detail) {
      // The framework's own leak rules, so this assertion tracks them instead of
      // keeping a second, drifting copy of what a leaky string looks like.
      const scan = scanForLeaks(detail);
      assert.deepEqual(scan.secretRules, [], detail);
      assert.deepEqual(scan.pathRules, [], detail);
      assert.ok(caseIds.has(detail.split(':')[0] ?? ''), `${detail} must start with a corpus case id`);
    }
  }
});
