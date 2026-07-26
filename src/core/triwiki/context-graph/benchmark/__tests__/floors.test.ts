import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkFloorSpecIds, evaluateBenchmarkFloors, scanForLeaks, type BenchmarkFloorInput } from '../floors.js';
import { evaluateCase } from '../metrics.js';
import { defaultCorpusPath, loadContextGraphBenchmarkCorpus } from '../corpus.js';
import { runContextGraphBenchmark } from '../runner.js';
import { FIXTURE_ABSOLUTE_PATH, FIXTURE_SECRET_TOKEN } from '../fixtures/index.js';
import {
  CONTEXT_GRAPH_BENCHMARK_FLOOR_IDS,
  emptyBenchmarkSafety,
  type ContextGraphBenchmarkCase,
  type ContextGraphBenchmarkRun
} from '../types.js';
import { behaviour, stubAdapter, STRONG_CANDIDATE, WEAK_BASELINE } from './adapters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = defaultCorpusPath(path.join(__dirname, '..'));

const CASE: ContextGraphBenchmarkCase = {
  id: 'floor-case',
  title: 'floor case',
  query: 'q',
  profile: 'review',
  fixture: 'secret-and-path-redaction',
  changedPaths: [],
  focusPaths: [],
  tokenBudget: 1000,
  risk: 'high',
  k: 8,
  gold: {
    paths: ['src/core/security/token-guard.ts'],
    nodeIds: [],
    gateIds: ['security_protected_paths'],
    protectedGateIds: ['security_protected_paths'],
    testPaths: [],
    conflicts: [{ path: 'src/core/shared/registry.ts', slices: ['slice-a', 'slice-b'] }],
    mustExcludePaths: ['notes/leaky-notes.md'],
    stalePaths: [],
    invalidatedPaths: [],
    exactSeedPaths: []
  }
};

function run(overrides: Partial<ContextGraphBenchmarkRun> = {}): ContextGraphBenchmarkRun {
  return {
    caseId: CASE.id,
    adapterId: 'candidate-graph',
    mode: 'cold',
    iteration: 0,
    ok: true,
    errorCode: null,
    matchedPaths: CASE.gold.paths,
    matchedNodeIds: [],
    selectedGateIds: CASE.gold.gateIds,
    selectedTestPaths: [],
    writeScopeConflicts: CASE.gold.conflicts,
    tokenCost: 500,
    latencyMs: 10,
    cacheHit: false,
    provenanceCoverage: 1,
    staleIncluded: [],
    invalidatedIncluded: [],
    exactSeedsPreserved: [],
    safety: emptyBenchmarkSafety({ snapshotHash: 'snap', determinismHash: 'snap', scanBudget: 100, scannedFiles: 10 }),
    ...overrides
  };
}

function inputsFor(runs: readonly ContextGraphBenchmarkRun[]): BenchmarkFloorInput[] {
  return [
    {
      adapterId: 'candidate-graph',
      adapterKind: 'candidate',
      runs,
      rows: [evaluateCase(CASE, 'candidate-graph', 'candidate', runs)]
    }
  ];
}

function floor(results: ReturnType<typeof evaluateBenchmarkFloors>, id: string) {
  const found = results.results.find((result) => result.id === id);
  assert.ok(found, `expected floor ${id} to be evaluated`);
  return found;
}

test('every declared floor id has a spec and is evaluated for a candidate', () => {
  assert.deepEqual([...benchmarkFloorSpecIds()].sort(), [...CONTEXT_GRAPH_BENCHMARK_FLOOR_IDS].sort());
  const report = evaluateBenchmarkFloors(inputsFor([run()]));
  assert.equal(report.evaluated, CONTEXT_GRAPH_BENCHMARK_FLOOR_IDS.length);
  assert.equal(report.ok, true);
  assert.equal(report.failed, 0);
});

test('capability floors are only asked of the candidate side', () => {
  const report = evaluateBenchmarkFloors([
    {
      adapterId: 'baseline-lexical',
      adapterKind: 'baseline',
      runs: [run({ adapterId: 'baseline-lexical', selectedGateIds: [], writeScopeConflicts: [] })],
      rows: [
        evaluateCase(CASE, 'baseline-lexical', 'baseline', [
          run({ adapterId: 'baseline-lexical', selectedGateIds: [], writeScopeConflicts: [] })
        ])
      ]
    }
  ]);
  assert.equal(report.results.some((result) => result.id === 'protected_gate_recall_full'), false);
  assert.equal(report.ok, true, 'a lexical baseline is not required to be capable, only safe');
});

test('the leak scanner names the rule without repeating the leaked value', () => {
  const secret = scanForLeaks(`token=${FIXTURE_SECRET_TOKEN}`);
  assert.ok(secret.secretRules.includes('fixture_secret_canary'));
  assert.ok(!secret.secretRules.some((rule) => rule.includes(FIXTURE_SECRET_TOKEN)));

  const leakedPath = scanForLeaks(`"${FIXTURE_ABSOLUTE_PATH}"`);
  assert.ok(leakedPath.pathRules.includes('fixture_absolute_path_canary'));
  assert.ok(leakedPath.pathRules.includes('absolute_posix_user_home'));

  assert.deepEqual(scanForLeaks('src/core/search/context.ts'), { secretRules: [], pathRules: [] });
});

test('a leaked absolute path in a result fails the path floor', () => {
  const report = evaluateBenchmarkFloors(inputsFor([run({ matchedPaths: [FIXTURE_ABSOLUTE_PATH] })]));
  const result = floor(report, 'path_leak_zero');
  assert.equal(result.passed, false);
  assert.ok(result.observed > 0);
  assert.equal(report.ok, false);
});

test('a missed protected gate fails the protected-gate floor', () => {
  const report = evaluateBenchmarkFloors(inputsFor([run({ selectedGateIds: [] })]));
  assert.equal(floor(report, 'protected_gate_recall_full').passed, false);
  assert.equal(report.ok, false);
});

test('a missed write-scope conflict fails the conflict floor', () => {
  const report = evaluateBenchmarkFloors(inputsFor([run({ writeScopeConflicts: [] })]));
  assert.equal(floor(report, 'write_scope_conflict_recall_full').passed, false);
});

test('a silent text fallback, a spawn and a dangling edge each fail their own floor', () => {
  const fallback = evaluateBenchmarkFloors(inputsFor([run({ safety: emptyBenchmarkSafety({ silentTextFallback: true }) })]));
  assert.equal(floor(fallback, 'stale_graph_silent_fallback_zero').passed, false);

  const spawned = evaluateBenchmarkFloors(inputsFor([run({ safety: emptyBenchmarkSafety({ processSpawns: 1 }) })]));
  assert.equal(floor(spawned, 'project_code_execution_zero').passed, false);

  const dangling = evaluateBenchmarkFloors(inputsFor([run({ safety: emptyBenchmarkSafety({ danglingEdges: 2 }) })]));
  assert.equal(floor(dangling, 'dangling_edge_zero').passed, false);

  const unbounded = evaluateBenchmarkFloors(
    inputsFor([run({ safety: emptyBenchmarkSafety({ scanBudget: 50, scannedFiles: 900 }) })])
  );
  assert.equal(floor(unbounded, 'unbounded_hot_path_scan_zero').passed, false);
});

test('an answer that changes between runs fails the determinism floor', () => {
  const report = evaluateBenchmarkFloors(
    inputsFor([
      run({ mode: 'cold', matchedPaths: ['src/a.ts'] }),
      run({ mode: 'warm', matchedPaths: ['src/b.ts'] })
    ])
  );
  assert.equal(floor(report, 'deterministic_snapshot_zero_mismatch').passed, false);
});

test('a failing hard floor withholds the composite score entirely', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const caseIds = ['protected-security-and-release-paths'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-bench-root-'));
  try {
    const report = await runContextGraphBenchmark(
      [
        stubAdapter('baseline-lexical', 'baseline', parsed.corpus.cases, WEAK_BASELINE),
        stubAdapter(
          'candidate-graph',
          'candidate',
          parsed.corpus.cases,
          behaviour({ safety: { silentTextFallback: true } }, STRONG_CANDIDATE)
        )
      ],
      { root, caseIds, coldIterations: 1, warmIterations: 1 }
    );
    assert.equal(report.integrity.ok, true);
    assert.equal(report.floors.ok, false);
    assert.equal(report.score, null, 'floors are evaluated first and block scoring');
    assert.ok(report.notes.includes('composite_score_withheld:hard_floor_failed'));
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
