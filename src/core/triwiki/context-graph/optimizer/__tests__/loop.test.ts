import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contextGraphExperimentLogPath } from '../../paths.js';
import { contextGraphPatchArtifactPath } from '../artifact.js';
import { fingerprintContextGraphTuningSurface } from '../guard.js';
import { runContextGraphOptimizerLoop, type ContextGraphOptimizerOptions } from '../loop.js';
import type {
  ContextGraphExperimentCandidate,
  ContextGraphExperimentRecord,
  ContextGraphOptimizerAdapterInput
} from '../types.js';
import { fakeReport, inertAdapters, listFiles, seedGuardedSurface, tempRoot, type FakeReportInput } from './harness.js';

const BASELINE_COMPOSITE = 0.5;

function candidate(id: string, value: number): ContextGraphExperimentCandidate {
  return {
    id,
    label: `depthDecay -> ${value}`,
    rationale: 'test sweep',
    overrides: [{ target: 'ranking-config', pointer: 'depthDecay', value }]
  };
}

interface Harness {
  readonly options: ContextGraphOptimizerOptions;
  readonly seen: ContextGraphOptimizerAdapterInput[];
  readonly budgets: unknown[];
}

/** Drives the loop through an injected runner keyed on the candidate under test. */
function harness(
  root: string,
  candidates: readonly ContextGraphExperimentCandidate[],
  behaviour: (candidateId: string | null) => FakeReportInput,
  onExperiment?: (input: ContextGraphOptimizerAdapterInput) => void
): Harness {
  const seen: ContextGraphOptimizerAdapterInput[] = [];
  const budgets: unknown[] = [];
  let current: string | null = null;
  return {
    seen,
    budgets,
    options: {
      root,
      candidates,
      now: '2026-01-01T00:00:00.000Z',
      runId: 'opt-test',
      caseIds: ['case-1'],
      coldIterations: 1,
      warmIterations: 1,
      adapters: (input) => {
        seen.push(input);
        current = input.candidateId;
        onExperiment?.(input);
        return inertAdapters();
      },
      benchmark: async (_adapters, options) => {
        budgets.push(options);
        return fakeReport({ baselineComposite: 0.4, ...behaviour(current) });
      }
    }
  };
}

function readLog(root: string): ContextGraphExperimentRecord[] {
  const file = contextGraphExperimentLogPath(root);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ContextGraphExperimentRecord);
}

test('proposal artifact paths cannot escape the optimizer report directory', () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => contextGraphPatchArtifactPath(root, '../../outside'),
      /context_graph_optimizer_artifact_path_escape/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an improving candidate is kept and emits a re-runnable proposal artifact', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const winner = candidate('exp-001-win', 0.5);
    const { options } = harness(root, [winner], (id) =>
      id === null ? { composite: BASELINE_COMPOSITE } : { composite: BASELINE_COMPOSITE + 0.08, improvement: 0.31 }
    );
    const result = await runContextGraphOptimizerLoop(options);

    assert.equal(result.ok, true);
    assert.equal(result.abortReason, null);
    assert.equal(result.kept.length, 1);
    assert.equal(result.best?.candidateId, 'exp-001-win');
    assert.equal(result.reviewRequired, true);

    const artifact = result.best;
    assert.ok(artifact);
    assert.equal(artifact?.floorsOk, true);
    assert.equal(artifact?.reviewRequired, true);
    assert.equal(artifact?.baselineComposite, BASELINE_COMPOSITE);
    assert.ok((artifact?.compositeDelta ?? 0) > 0);
    assert.equal(artifact?.receipt.corpusHash, 'a'.repeat(64));
    assert.equal(artifact?.receipt.scoringCodeHash, 'b'.repeat(64));
    assert.deepEqual(artifact?.receipt.budget.caseIds, ['case-1']);
    assert.equal(artifact?.receipt.budget.coldIterations, 1);
    assert.equal(artifact?.receipt.rerunEntryPoint, 'runContextGraphOptimizerLoop');
    assert.ok(artifact?.applyInstructions.some((line) => line.includes('Human review is required')));
    assert.deepEqual(
      artifact?.overrides.map((item) => item.file),
      ['src/core/triwiki/context-graph/query/ranking-config.ts']
    );

    const written = path.join(root, '.sneakoscope', 'reports', 'context-graph-optimizer', 'exp-001-win.patch.json');
    assert.ok(fs.existsSync(written), 'the proposal must be written under the report directory');
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8')) as { reviewRequired: boolean; overrides: unknown[] };
    assert.equal(parsed.reviewRequired, true);
    assert.equal(parsed.overrides.length, 1);

    const log = readLog(root);
    assert.equal(log.length, 2);
    assert.equal(log[0]?.outcome, 'baseline');
    assert.equal(log[1]?.outcome, 'kept');
    assert.equal(log[1]?.artifactPath, '.sneakoscope/reports/context-graph-optimizer/exp-001-win.patch.json');
    assert.equal(log[1]?.reviewRequired, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a hard-floor failure discards the candidate before its score is consulted', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const before = fingerprintContextGraphTuningSurface(root);
    const filesBefore = listFiles(root);
    const loser = candidate('exp-001-floor', 0.5);
    const { options } = harness(root, [loser], (id) =>
      id === null
        ? { composite: BASELINE_COMPOSITE }
        : { composite: BASELINE_COMPOSITE + 10, floorsOk: false, failedFloor: 'protected_gate_recall_full' }
    );
    const result = await runContextGraphOptimizerLoop(options);

    assert.equal(result.kept.length, 0, 'a floor failure is never traded against a higher composite');
    assert.equal(result.best, null);
    assert.equal(result.ok, true, 'a discarded candidate is a normal outcome, not a run failure');

    const log = readLog(root);
    const record = log.find((item) => item.candidateId === 'exp-001-floor');
    assert.equal(record?.outcome, 'discarded_floor');
    assert.equal(record?.floorsOk, false);
    assert.deepEqual(record?.failedFloorIds, ['protected_gate_recall_full']);
    assert.equal(record?.artifactPath, null);

    assert.equal(fingerprintContextGraphTuningSurface(root).digest, before.digest);
    assert.deepEqual(result.surfaceDrift, []);
    const added = listFiles(root).filter((file) => !filesBefore.includes(file));
    assert.deepEqual(added, ['.sneakoscope/reports/context-graph-experiments.jsonl']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate that does not improve the composite is discarded without an artifact', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const { options } = harness(root, [candidate('exp-001-flat', 0.5)], (id) =>
      id === null ? { composite: BASELINE_COMPOSITE } : { composite: BASELINE_COMPOSITE }
    );
    const result = await runContextGraphOptimizerLoop(options);
    assert.equal(result.kept.length, 0);
    assert.equal(readLog(root).at(-1)?.outcome, 'discarded_no_gain');
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope', 'reports', 'context-graph-optimizer')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected or integrity-violating candidate never reaches the benchmark', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const forbidden: ContextGraphExperimentCandidate = {
      id: 'exp-001-forbidden',
      label: 'edit the ranker',
      rationale: 'not allowed',
      overrides: [{ target: 'src/core/triwiki/context-graph/query/rank.ts' as never, pointer: 'depthDecay', value: 0.5 }]
    };
    const tampering: ContextGraphExperimentCandidate = {
      id: 'exp-002-corpus',
      label: 'soften the corpus',
      rationale: 'not allowed',
      overrides: [{ target: 'config/context-graph-benchmark.json' as never, pointer: 'depthDecay', value: 0.5 }]
    };
    const { options, seen } = harness(root, [forbidden, tampering], () => ({ composite: BASELINE_COMPOSITE }));
    const result = await runContextGraphOptimizerLoop(options);

    assert.equal(seen.length, 1, 'only the baseline experiment may build adapters');
    assert.equal(seen[0]?.candidateId, null);
    assert.equal(result.kept.length, 0);

    const log = readLog(root);
    const rejected = log.find((item) => item.candidateId === 'exp-001-forbidden');
    const violation = log.find((item) => item.candidateId === 'exp-002-corpus');
    assert.equal(rejected?.outcome, 'rejected');
    assert.deepEqual(rejected?.rejectionCodes, ['file_not_allowlisted']);
    assert.equal(violation?.outcome, 'integrity_violation');
    assert.deepEqual(violation?.rejectionCodes, ['benchmark_integrity_violation']);
    assert.deepEqual(result.surfaceDrift, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every experiment runs under one identical corpus and iteration budget', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const { options, budgets } = harness(
      root,
      [candidate('exp-001-a', 0.5), candidate('exp-002-b', 0.7)],
      () => ({ composite: BASELINE_COMPOSITE })
    );
    await runContextGraphOptimizerLoop(options);
    assert.equal(budgets.length, 3);
    assert.deepEqual(budgets[1], budgets[0]);
    assert.deepEqual(budgets[2], budgets[0]);
    assert.equal((budgets[0] as { writeReport?: boolean }).writeReport, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an experiment that mutates the working tree aborts the run', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const target = path.join(root, 'src', 'core', 'triwiki', 'context-graph', 'query', 'ranking-config.ts');
    const { options } = harness(
      root,
      [candidate('exp-001-writes', 0.5), candidate('exp-002-never', 0.7)],
      () => ({ composite: BASELINE_COMPOSITE + 5 }),
      (input) => {
        if (input.candidateId === 'exp-001-writes') fs.writeFileSync(target, '// applied by the experiment\n', 'utf8');
      }
    );
    const result = await runContextGraphOptimizerLoop(options);

    assert.equal(result.ok, false);
    assert.equal(result.abortReason, 'working_tree_mutated');
    assert.equal(result.kept.length, 0, 'a candidate that edited the tree is never kept');
    assert.ok(result.surfaceDrift.includes('src/core/triwiki/context-graph/query/ranking-config.ts:mutated'));

    const log = readLog(root);
    assert.equal(log.at(-1)?.outcome, 'discarded_integrity');
    assert.equal(log.some((item) => item.candidateId === 'exp-002-never'), false, 'the loop stops at the first mutation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a baseline that fails a hard floor aborts before any candidate runs', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const { options, seen } = harness(root, [candidate('exp-001-a', 0.5)], () => ({
      composite: BASELINE_COMPOSITE,
      floorsOk: false
    }));
    const result = await runContextGraphOptimizerLoop(options);
    assert.equal(result.ok, false);
    assert.equal(result.abortReason, 'baseline_floor_failure');
    assert.equal(seen.length, 1);
    assert.equal(result.experiments.length, 1);
    assert.equal(result.experiments[0]?.outcome, 'baseline');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corpus hash mismatch aborts the run as a benchmark integrity failure', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const { options } = harness(root, [candidate('exp-001-a', 0.5)], () => ({
      composite: BASELINE_COMPOSITE,
      integrityOk: false
    }));
    const result = await runContextGraphOptimizerLoop(options);
    assert.equal(result.abortReason, 'benchmark_integrity_failure');
    assert.equal(result.kept.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the experiment log and the proposal carry no absolute path', async () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const { options } = harness(root, [candidate('exp-001-win', 0.5)], (id) =>
      id === null ? { composite: BASELINE_COMPOSITE } : { composite: BASELINE_COMPOSITE + 0.1 }
    );
    await runContextGraphOptimizerLoop(options);
    const logText = fs.readFileSync(contextGraphExperimentLogPath(root), 'utf8');
    const patchText = fs.readFileSync(
      path.join(root, '.sneakoscope', 'reports', 'context-graph-optimizer', 'exp-001-win.patch.json'),
      'utf8'
    );
    for (const text of [logText, patchText]) {
      assert.ok(!text.includes(root));
      assert.ok(!/(^|["'\s:=(,[])\/(Users|home|root)\//.test(text));
      assert.ok(!text.includes('~/'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
