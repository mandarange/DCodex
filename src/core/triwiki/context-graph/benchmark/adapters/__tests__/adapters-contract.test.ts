/**
 * Contract, cold/warm and refusal behaviour for the two benchmark adapters.
 *
 * Every fixture is materialized under a temp directory this file owns, so the
 * "nothing is left behind" assertion is a real directory listing rather than a
 * hope. The real HOME is never touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contextGraphDir } from '../../../paths.js';
import { materializeFixture, type FixtureHandle } from '../../fixtures/index.js';
import type {
  ContextGraphBenchmarkFixtureFamily,
  ContextGraphBenchmarkMode,
  ContextGraphBenchmarkQuery,
  ContextGraphBenchmarkRun
} from '../../types.js';
import {
  BASELINE_LEXICAL_ADAPTER_ID,
  CANDIDATE_GRAPH_ADAPTER_ID,
  contextGraphBenchmarkAdapters,
  createBaselineLexicalAdapter,
  createCandidateGraphAdapter,
  lexicalAlternationPattern,
  lexicalQueryTerms
} from '../index.js';

const NOW = '2026-01-01T00:00:00.000Z';

interface QueryOverrides {
  readonly caseId?: string;
  readonly query?: string;
  readonly profile?: ContextGraphBenchmarkQuery['profile'];
  readonly changedPaths?: readonly string[];
  readonly focusPaths?: readonly string[];
  readonly mode?: ContextGraphBenchmarkMode;
  readonly iteration?: number;
}

function buildQuery(
  root: string,
  fixture: ContextGraphBenchmarkFixtureFamily,
  overrides: QueryOverrides = {}
): ContextGraphBenchmarkQuery {
  return {
    caseId: overrides.caseId ?? 'adapter-contract',
    root,
    fixture,
    query: overrides.query ?? 'where is the search command handler and its pipeline',
    profile: overrides.profile ?? 'implementation',
    changedPaths: overrides.changedPaths ?? [],
    focusPaths: overrides.focusPaths ?? [],
    tokenBudget: 6000,
    risk: 'normal',
    k: 8,
    mode: overrides.mode ?? 'cold',
    iteration: overrides.iteration ?? 0,
    now: NOW
  };
}

/** A fixture plus the temp directory it lives in, so cleanliness is verifiable. */
interface OwnedFixture {
  readonly handle: FixtureHandle;
  readonly tmpDir: string;
}

function openFixture(family: ContextGraphBenchmarkFixtureFamily): OwnedFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-adapter-test-'));
  return { handle: materializeFixture(family, { tmpDir, skipGit: true }), tmpDir };
}

function closeFixture(owned: OwnedFixture): void {
  owned.handle.dispose();
  fs.rmSync(owned.tmpDir, { recursive: true, force: true });
}

function assertWellFormedRun(run: ContextGraphBenchmarkRun, query: ContextGraphBenchmarkQuery, adapterId: string): void {
  assert.equal(run.caseId, query.caseId);
  assert.equal(run.adapterId, adapterId);
  assert.equal(run.mode, query.mode);
  assert.equal(run.iteration, query.iteration);
  assert.equal(typeof run.ok, 'boolean');
  assert.ok(run.errorCode === null || typeof run.errorCode === 'string');
  assert.ok(Array.isArray(run.matchedPaths));
  assert.ok(Array.isArray(run.matchedNodeIds));
  assert.ok(Array.isArray(run.selectedGateIds));
  assert.ok(Array.isArray(run.selectedTestPaths));
  assert.ok(Array.isArray(run.writeScopeConflicts));
  assert.ok(Number.isFinite(run.tokenCost) && run.tokenCost >= 0);
  assert.ok(Number.isFinite(run.latencyMs) && run.latencyMs >= 0);
  assert.equal(typeof run.cacheHit, 'boolean');
  assert.ok(run.provenanceCoverage >= 0 && run.provenanceCoverage <= 1);
  assert.ok(Array.isArray(run.staleIncluded));
  assert.ok(Array.isArray(run.invalidatedIncluded));
  assert.ok(Array.isArray(run.exactSeedsPreserved));
  assert.equal(run.safety.silentTextFallback, false);
  assert.equal(run.safety.projectCodeExecutions, 0);
  assert.ok(run.safety.scannedFiles <= run.safety.scanBudget);
  for (const candidate of [...run.matchedPaths, ...run.selectedTestPaths]) {
    assert.ok(!candidate.startsWith('/'), `result path must stay workspace-relative: ${candidate}`);
    assert.ok(!candidate.includes(os.tmpdir()), 'result path must not carry the fixture root');
  }
}

test('the adapter set is one baseline and one candidate with stable ids', () => {
  const adapters = contextGraphBenchmarkAdapters();
  assert.equal(adapters.length, 2);
  assert.deepEqual(adapters.map((adapter) => adapter.kind), ['baseline', 'candidate']);
  assert.deepEqual(adapters.map((adapter) => adapter.id), [BASELINE_LEXICAL_ADAPTER_ID, CANDIDATE_GRAPH_ADAPTER_ID]);
});

test('both adapters answer a real fixture with a well-formed run', async () => {
  const owned = openFixture('command-route-pipeline-gate');
  const candidate = createCandidateGraphAdapter();
  try {
    const query = buildQuery(owned.handle.root, 'command-route-pipeline-gate', {
      changedPaths: ['src/cli/commands/search.ts']
    });
    const baselineRun = await createBaselineLexicalAdapter().run(query);
    const candidateRun = await candidate.run(query);

    assertWellFormedRun(baselineRun, query, BASELINE_LEXICAL_ADAPTER_ID);
    assertWellFormedRun(candidateRun, query, CANDIDATE_GRAPH_ADAPTER_ID);
    assert.equal(baselineRun.ok, true);
    assert.equal(candidateRun.ok, true);
    assert.ok(baselineRun.matchedPaths.length > 0, 'the control must actually retrieve something');
    assert.ok(candidateRun.matchedPaths.length > 0);
    // The caller-named path is the strongest signal both sides are given.
    assert.equal(baselineRun.matchedPaths[0], 'src/cli/commands/search.ts');
    assert.ok(candidateRun.matchedPaths.includes('src/cli/commands/search.ts'));
  } finally {
    candidate.reset();
    closeFixture(owned);
  }
});

test('the candidate grounds every selected node and the lexical control grounds none', async () => {
  const owned = openFixture('proof-invalidation');
  const candidate = createCandidateGraphAdapter();
  try {
    const query = buildQuery(owned.handle.root, 'proof-invalidation', {
      caseId: 'provenance',
      query: 'what graph and release cache surfaces depend on proof invalidation',
      profile: 'review'
    });
    const candidateRun = await candidate.run(query);
    const baselineRun = await createBaselineLexicalAdapter().run(query);

    assert.equal(candidateRun.provenanceCoverage, 1);
    assert.equal(baselineRun.provenanceCoverage, 0);
    assert.equal(candidateRun.safety.edgesWithoutProvenance, 0);
    assert.equal(candidateRun.safety.danglingEdges, 0);
    // The control cannot label anything an exact reference, so it preserves none.
    assert.deepEqual(baselineRun.exactSeedsPreserved, []);
    assert.equal(baselineRun.safety.unsupportedLanguageExactClaims.length, 0);
  } finally {
    candidate.reset();
    closeFixture(owned);
  }
});

test('a warm iteration reuses the compiled root and never recompiles it', async () => {
  const owned = openFixture('test-production-binding');
  const candidate = createCandidateGraphAdapter();
  try {
    const cold = await candidate.run(
      buildQuery(owned.handle.root, 'test-production-binding', { caseId: 'warm-split', mode: 'cold' })
    );
    assert.equal(cold.cacheHit, false, 'a cold run must not report a cache hit');
    assert.equal(candidate.compiledRoots(), 1);

    const warmOne = await candidate.run(
      buildQuery(owned.handle.root, 'test-production-binding', { caseId: 'warm-split', mode: 'warm', iteration: 0 })
    );
    const warmTwo = await candidate.run(
      buildQuery(owned.handle.root, 'test-production-binding', { caseId: 'warm-split', mode: 'warm', iteration: 1 })
    );
    assert.equal(warmOne.cacheHit, true);
    assert.equal(warmTwo.cacheHit, true);
    assert.equal(candidate.compiledRoots(), 1, 'a warm iteration must not compile');
    assert.deepEqual(warmOne.matchedPaths, cold.matchedPaths);
    assert.deepEqual(warmTwo.matchedPaths, cold.matchedPaths);
    assert.equal(warmOne.safety.snapshotHash, cold.safety.snapshotHash);
    assert.equal(warmOne.safety.processSpawns, 0, 'the warm answer path must not spawn');
  } finally {
    candidate.reset();
    closeFixture(owned);
  }
});

test('a second cold root compiles again and reports no cache hit', async () => {
  const first = openFixture('reexport-chain');
  const second = openFixture('reexport-chain');
  const candidate = createCandidateGraphAdapter();
  try {
    const one = await candidate.run(buildQuery(first.handle.root, 'reexport-chain', { caseId: 'cold-twice' }));
    const two = await candidate.run(buildQuery(second.handle.root, 'reexport-chain', { caseId: 'cold-twice' }));
    assert.equal(one.cacheHit, false);
    assert.equal(two.cacheHit, false);
    assert.equal(candidate.compiledRoots(), 2);
    // Same tree, same clock, two independent temp roots: identical snapshot.
    assert.equal(one.safety.snapshotHash, two.safety.snapshotHash);
    assert.deepEqual(one.matchedPaths, two.matchedPaths);
  } finally {
    candidate.reset();
    closeFixture(first);
    closeFixture(second);
  }
});

const CYCLIC_QUERY: QueryOverrides = {
  query: 'which release gates are affected when a gate input module changes inside an import cycle',
  profile: 'planning',
  changedPaths: ['src/core/release/gate-inputs.ts']
};

test('the candidate recompiles each root once and the hashes agree', async () => {
  const owned = openFixture('cyclic-modules');
  const candidate = createCandidateGraphAdapter();
  try {
    const run = await candidate.run(
      buildQuery(owned.handle.root, 'cyclic-modules', { ...CYCLIC_QUERY, caseId: 'determinism' })
    );
    assert.ok(run.safety.snapshotHash);
    assert.equal(run.safety.determinismHash, run.safety.snapshotHash);
  } finally {
    candidate.reset();
    closeFixture(owned);
  }
});

test('determinism verification can be switched off without changing the answer', async () => {
  const owned = openFixture('cyclic-modules');
  const verifying = createCandidateGraphAdapter();
  const quiet = createCandidateGraphAdapter({ session: { verifyDeterminism: false } });
  try {
    const query = buildQuery(owned.handle.root, 'cyclic-modules', { ...CYCLIC_QUERY, caseId: 'no-verify' });
    const verified = await verifying.run(query);
    const run = await quiet.run(query);
    assert.equal(run.safety.determinismHash, null);
    assert.equal(run.safety.snapshotHash, verified.safety.snapshotHash);
    assert.ok(run.matchedPaths.length > 0);
    assert.deepEqual(run.matchedPaths, verified.matchedPaths);
  } finally {
    verifying.reset();
    quiet.reset();
    closeFixture(owned);
  }
});

test('a graph that disappears is surfaced, never answered from text', async () => {
  const owned = openFixture('ts-path-alias');
  const candidate = createCandidateGraphAdapter();
  try {
    const query = buildQuery(owned.handle.root, 'ts-path-alias', {
      caseId: 'refusal',
      query: 'what freshness preflight and wiki validate surfaces depend on the code pack builder',
      profile: 'review',
      changedPaths: ['src/core/triwiki/code-pack.ts']
    });
    const cold = await candidate.run(query);
    assert.equal(cold.ok, true);
    assert.ok(cold.matchedPaths.length > 0);

    // Wipe the compiled artifacts behind the adapter's back. The root is still
    // in its compile memo, so the next answer has to resolve the snapshot and
    // will find nothing there.
    fs.rmSync(contextGraphDir(owned.handle.root), { recursive: true, force: true });
    const afterWipe = await candidate.run({ ...query, mode: 'warm', iteration: 0 });

    assert.equal(afterWipe.ok, false);
    assert.equal(afterWipe.errorCode, 'context_graph_missing');
    assert.deepEqual(afterWipe.matchedPaths, []);
    assert.deepEqual(afterWipe.matchedNodeIds, []);
    assert.equal(afterWipe.provenanceCoverage, 0);
    assert.equal(afterWipe.safety.silentTextFallback, false);
  } finally {
    candidate.reset();
    closeFixture(owned);
  }
});

test('query terms drop stop words and build one bounded alternation', () => {
  const terms = lexicalQueryTerms('what tests and gates are affected if src/core/search/context.ts changes');
  assert.ok(terms.includes('tests'));
  assert.ok(terms.includes('gates'));
  assert.ok(terms.includes('context'));
  assert.ok(!terms.includes('what'));
  assert.ok(!terms.includes('and'));
  assert.ok(!terms.includes('are'));
  assert.ok(terms.length <= 12);
  assert.deepEqual(terms, lexicalQueryTerms('what tests and gates are affected if src/core/search/context.ts changes'));

  const pattern = lexicalAlternationPattern(['a.b', 'c*d']);
  assert.equal(pattern, 'a\\.b|c\\*d');
  assert.equal(lexicalAlternationPattern([]), '');
});

test('both adapters leave nothing behind in the temp directory they were given', async () => {
  const owned = openFixture('dynamic-import-literal');
  const candidate = createCandidateGraphAdapter();
  const query = buildQuery(owned.handle.root, 'dynamic-import-literal', { caseId: 'cleanliness' });
  await createBaselineLexicalAdapter().run(query);
  await candidate.run(query);
  await candidate.run({ ...query, mode: 'warm' });
  candidate.reset();

  owned.handle.dispose();
  assert.equal(fs.existsSync(owned.handle.root), false);
  assert.deepEqual(fs.readdirSync(owned.tmpDir), [], 'the adapters must not create siblings of the fixture');
  fs.rmSync(owned.tmpDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(owned.tmpDir), false);
});
