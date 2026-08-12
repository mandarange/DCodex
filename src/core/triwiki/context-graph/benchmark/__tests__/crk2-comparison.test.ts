import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Crk2ComparisonError, compareRetrievalEngines, type Crk2ComparisonOptions } from '../crk2-comparison.js';
import { CRK2_CASES } from '../crk2-corpus.js';
import type { Crk2Case } from '../crk2-types.js';
import { engineWithMutatedCase, perfectEngine, perfectPlanFor, stubEngine } from './crk2-stub-engine.js';

const OPTIONS: Crk2ComparisonOptions = {
  retrievalRoot: '/fixture/retrieval',
  faultRoot: '/fixture/fault',
  repeats: 4,
  warmups: 1,
  now: '2026-08-12T00:00:00.000Z'
};

function sample(ids: readonly string[]): readonly Crk2Case[] {
  const wanted = new Set(ids);
  return CRK2_CASES.filter((item) => wanted.has(item.id));
}

/** An engine that returns nothing, quickly — the v1 `korean`/`jargon` behaviour. */
function emptyEngine(id: string, version: 'v1' | 'v2', latencyMs: number) {
  return stubEngine(id, version, new Map(CRK2_CASES.map((item) => [item.id, { nodeIds: [], tokenCost: 0, latencyMs }])));
}

test('the seam takes one v1 engine and one v2 engine, in that order', async () => {
  const v1 = perfectEngine('legacy', 'v1', CRK2_CASES);
  const v2 = perfectEngine('kernel', 'v2', CRK2_CASES);
  await assert.rejects(
    () => compareRetrievalEngines(v2 as never, v1 as never, { ...OPTIONS, cases: sample(['exact-path-kernel']) }),
    (error: unknown) => error instanceof Crk2ComparisonError && error.code === 'engine_version_mismatch'
  );
});

test('comparing an engine with itself is refused rather than reported as no regression', async () => {
  const v1 = perfectEngine('same', 'v1', CRK2_CASES);
  const v2 = perfectEngine('same', 'v2', CRK2_CASES);
  await assert.rejects(
    () => compareRetrievalEngines(v1, v2, { ...OPTIONS, cases: sample(['exact-path-kernel']) }),
    (error: unknown) => error instanceof Crk2ComparisonError && error.code === 'engine_identity_collision'
  );
});

test('the comparison module reaches no environment variable or config file', () => {
  const compiled = fileURLToPath(new URL('../crk2-comparison.js', import.meta.url));
  const source = fs.readFileSync(compiled, 'utf8');
  for (const forbidden of ['process.env', 'getenv', 'readFileSync', 'loadConfig']) {
    assert.ok(!source.includes(forbidden), `the seam must not reach ${forbidden}; a configurable seam is a fallback`);
  }
});

test('a v2 that answers the gold set beats a v1 that answers nothing', async () => {
  const cases = sample(['korean-budget-question', 'jargon-naruto-fanout', 'exact-path-kernel']);
  const v1 = emptyEngine('legacy', 'v1', 1.2);
  const v2 = perfectEngine('kernel', 'v2', CRK2_CASES);
  const report = await compareRetrievalEngines(v1, v2, { ...OPTIONS, cases });

  assert.equal(report.caseCount, cases.length);
  assert.equal(report.cases.length, cases.length);
  for (const pair of report.cases) {
    assert.equal(pair.verdict, 'improved', `${pair.caseId} should improve`);
    assert.ok(pair.mustIncludeRecallDelta > 0);
  }
  assert.equal(report.v1.mustIncludeRecall, 0);
  assert.equal(report.v2.mustIncludeRecall, 1);
  assert.deepEqual(report.regressions, []);
});

test('a faster v2 that still finds nothing is called fast_but_empty, not a win', async () => {
  const cases = sample(['korean-budget-question', 'jargon-align-run-repair']);
  const v1 = emptyEngine('legacy', 'v1', 12);
  const v2 = emptyEngine('kernel', 'v2', 0.4);
  const report = await compareRetrievalEngines(v1, v2, { ...OPTIONS, cases });

  for (const pair of report.cases) {
    assert.equal(pair.verdict, 'fast_but_empty');
    assert.ok(pair.latencyP95Delta < 0, 'v2 really is faster');
    assert.equal(pair.mustIncludeRecallDelta, 0, 'and it found exactly as little');
  }
  assert.equal(report.ok, false);
  assert.ok(report.notes.includes('fast_but_empty_cases:2'));
  assert.equal(report.regressions.length, 2);
});

test('losing recall that v1 had is a regression however fast v2 is', async () => {
  const cases = sample(['exact-symbol-read-section-descriptor']);
  const v1 = perfectEngine('legacy', 'v1', CRK2_CASES);
  const v2 = stubEngine(
    'kernel',
    'v2',
    new Map([['exact-symbol-read-section-descriptor', { nodeIds: [], tokenCost: 0, latencyMs: 0.1 }]])
  );
  const report = await compareRetrievalEngines(v1, v2, { ...OPTIONS, cases });
  assert.equal(report.cases[0]?.verdict, 'recall_regression');
  assert.equal(report.ok, false);
});

test('latency is only ever published beside the recall for the same scope', async () => {
  const cases = sample(['korean-budget-question', 'exact-path-kernel']);
  const report = await compareRetrievalEngines(
    emptyEngine('legacy', 'v1', 2),
    perfectEngine('kernel', 'v2', CRK2_CASES),
    { ...OPTIONS, cases }
  );
  for (const stat of report.v2.categories) {
    assert.equal(typeof stat.mustIncludeRecall, 'number');
    assert.equal(typeof stat.recallAtK, 'number');
    assert.ok(stat.latency.samples > 0);
  }
  for (const pair of report.cases) {
    assert.equal(pair.v1.caseId, pair.caseId);
    assert.equal(pair.v2.caseId, pair.caseId);
    assert.ok(pair.v2.latency.p99 >= pair.v2.latency.p95);
    assert.ok(pair.v2.latency.p95 >= pair.v2.latency.p50);
  }
});

test('an engine that answers differently on a repeat fails the determinism floor', async () => {
  const cases = sample(['determinism-repeat-identical-answer']);
  const v1 = perfectEngine('legacy', 'v1', CRK2_CASES);
  const v2 = engineWithMutatedCase('kernel', 'v2', CRK2_CASES, 'determinism-repeat-identical-answer', (plan) => ({
    ...plan,
    driftFromIteration: 2
  }));
  const report = await compareRetrievalEngines(v1, v2, { ...OPTIONS, cases, repeats: 6 });
  assert.ok(report.v2.determinismMismatches > 0);
  assert.equal(report.floors.results.find((item) => item.id === 'determinism_zero_mismatch')?.passed, false);
  assert.equal(report.ok, false);
});

test('a v2 that salvages bytes from a corrupt index fails the rejection floor', async () => {
  const cases = sample(['corrupt-truncated-binary']);
  const v1 = perfectEngine('legacy', 'v1', CRK2_CASES);
  const v2 = engineWithMutatedCase('kernel', 'v2', CRK2_CASES, 'corrupt-truncated-binary', (plan) => ({
    ...plan,
    ok: true,
    errorCode: null,
    nodeIds: ['file:config/context-graph.json']
  }));
  const report = await compareRetrievalEngines(v1, v2, { ...OPTIONS, cases });
  assert.equal(report.floors.results.find((item) => item.id === 'corrupt_input_rejection_exact')?.passed, false);
  assert.equal(report.ok, false);
});

test('warmup iterations are discarded rather than measured', async () => {
  const seen: number[] = [];
  const cases = sample(['exact-path-kernel']);
  const target = cases[0];
  assert.ok(target);
  const plan = perfectPlanFor(target);
  const v2 = {
    id: 'kernel',
    version: 'v2' as const,
    run(request: { iteration: number }) {
      seen.push(request.iteration);
      return Promise.resolve({
        ok: true,
        errorCode: null,
        nodeIds: [...(plan.nodeIds ?? [])],
        provenanceNodeIds: [...(plan.provenanceNodeIds ?? [])],
        confidenceByNodeId: plan.confidenceByNodeId ?? {},
        selectedGateIds: [...(plan.selectedGateIds ?? [])],
        droppedGateIds: [],
        conflicts: [],
        tokenCost: plan.tokenCost ?? 0,
        latencyMs: request.iteration < 0 ? 900 : 3,
        cacheHit: request.iteration > 0
      });
    }
  };
  const report = await compareRetrievalEngines(perfectEngine('legacy', 'v1', CRK2_CASES), v2, {
    ...OPTIONS,
    cases,
    repeats: 5,
    warmups: 2
  });
  assert.deepEqual(seen, [-1, -2, 0, 1, 2, 3, 4]);
  assert.equal(report.v2.latency.samples, 5, 'only the measured repeats are sampled');
  assert.equal(report.v2.latency.max, 3, 'the 900 ms warmups never reach the percentiles');
});

test('an empty case list is refused instead of producing a vacuous pass', async () => {
  await assert.rejects(
    () => compareRetrievalEngines(perfectEngine('legacy', 'v1', CRK2_CASES), perfectEngine('kernel', 'v2', CRK2_CASES), {
      ...OPTIONS,
      cases: []
    }),
    (error: unknown) => error instanceof Crk2ComparisonError && error.code === 'no_cases'
  );
});

test('the full corpus runs end to end and a perfect v2 clears every floor', async () => {
  const report = await compareRetrievalEngines(
    emptyEngine('legacy', 'v1', 1.2),
    perfectEngine('kernel', 'v2', CRK2_CASES),
    { ...OPTIONS, repeats: 2, warmups: 0 }
  );
  assert.equal(report.caseCount, CRK2_CASES.length);
  assert.equal(
    report.floors.ok,
    true,
    report.floors.results.filter((item) => !item.passed).map((item) => `${item.id}=${item.observed}`).join(',')
  );
  assert.equal(report.v2.rejectionRate, 1);
  assert.equal(report.v2.provenanceCoverage, 1);
});
