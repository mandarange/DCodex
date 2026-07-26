/**
 * The measurement the benchmark exists to make.
 *
 * `reexport-chain` publishes `AttentionSlice` through a barrel. Two consumers
 * depend on it transitively and never name it, and a prose file talks about
 * attention without depending on anything. Answering "what depends on
 * AttentionSlice" therefore needs a reverse dependency hop through the barrel —
 * a relation a text scan cannot see at any budget.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeFixture } from '../../fixtures/index.js';
import type { ContextGraphBenchmarkMode, ContextGraphBenchmarkQuery } from '../../types.js';
import { createBaselineLexicalAdapter, createCandidateGraphAdapter } from '../index.js';

/** Reachable only by walking `imports` / `reexports` backwards from the seed. */
const REVERSE_DEPENDENTS = ['src/core/naruto/slice-planner.ts', 'src/core/wiki/validation.ts'] as const;

/** Bound to the dependents by `tests` edges; neither file mentions the query. */
const BOUND_TESTS = [
  'src/core/naruto/__tests__/slice-planner.test.ts',
  'src/core/wiki/__tests__/validation.test.ts'
] as const;

const LEXICAL_DECOY = 'docs/attention-notes.md';

function buildQuery(root: string, mode: ContextGraphBenchmarkMode = 'cold'): ContextGraphBenchmarkQuery {
  return {
    caseId: 'reverse-dependency-hop',
    root,
    fixture: 'reexport-chain',
    query: 'AttentionSlice',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: 8,
    mode,
    iteration: 0,
    now: '2026-01-01T00:00:00.000Z'
  };
}

function recallOf(gold: readonly string[], ranked: readonly string[], k: number): number {
  const top = [...new Set(ranked)].slice(0, k);
  let hits = 0;
  for (const item of new Set(gold)) if (top.includes(item)) hits += 1;
  return hits / new Set(gold).size;
}

test('the graph answers a reverse dependency hop the lexical control cannot', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-reverse-test-'));
  const handle = materializeFixture('reexport-chain', { tmpDir, skipGit: true });
  const candidate = createCandidateGraphAdapter();
  try {
    const query = buildQuery(handle.root);
    const candidateRun = await candidate.run(query);
    const baselineRun = await createBaselineLexicalAdapter().run(query);

    assert.equal(candidateRun.ok, true);
    assert.equal(baselineRun.ok, true);

    const candidateRecall = recallOf(REVERSE_DEPENDENTS, candidateRun.matchedPaths, query.k);
    const baselineRecall = recallOf(REVERSE_DEPENDENTS, baselineRun.matchedPaths, query.k);
    assert.equal(candidateRecall, 1, 'the graph must reach both reverse dependents');
    assert.equal(baselineRecall, 0, 'a text scan cannot reach a dependent that never names the symbol');
    assert.ok(candidateRecall > baselineRecall);

    // The control does find the seed itself, so this is a hop deficit, not a
    // retrieval failure: it is measurably worse on exactly the relation.
    assert.ok(baselineRun.matchedPaths.includes('src/core/triwiki/attention.ts'));

    // Same story for the tests bound to those dependents.
    for (const testPath of BOUND_TESTS) {
      assert.ok(candidateRun.selectedTestPaths.includes(testPath), `graph must bind ${testPath}`);
    }
    assert.deepEqual(baselineRun.selectedTestPaths, []);

    // Prose about the same subject is a decoy: neither engine should be paid
    // for it, and the graph in particular must not pick it up.
    assert.ok(!candidateRun.matchedPaths.includes(LEXICAL_DECOY));

    assert.equal(candidateRun.provenanceCoverage, 1);
    assert.equal(baselineRun.provenanceCoverage, 0);
    assert.deepEqual(candidateRun.exactSeedsPreserved, ['src/core/triwiki/attention.ts']);
    assert.deepEqual(baselineRun.exactSeedsPreserved, []);
  } finally {
    candidate.reset();
    handle.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('the warm answer is byte-identical to the cold one and costs no compile', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-reverse-warm-'));
  const handle = materializeFixture('reexport-chain', { tmpDir, skipGit: true });
  const candidate = createCandidateGraphAdapter();
  try {
    const cold = await candidate.run(buildQuery(handle.root, 'cold'));
    const warm = await candidate.run(buildQuery(handle.root, 'warm'));

    assert.equal(cold.cacheHit, false);
    assert.equal(warm.cacheHit, true);
    assert.equal(candidate.compiledRoots(), 1);
    assert.deepEqual(warm.matchedPaths, cold.matchedPaths);
    assert.deepEqual(warm.matchedNodeIds, cold.matchedNodeIds);
    assert.deepEqual(warm.selectedTestPaths, cold.selectedTestPaths);
    assert.equal(warm.tokenCost, cold.tokenCost);
    assert.equal(warm.safety.processSpawns, 0);
    assert.equal(warm.safety.snapshotHash, cold.safety.snapshotHash);
  } finally {
    candidate.reset();
    handle.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(tmpDir), false);
  }
});
