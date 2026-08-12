import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../../../../fsx.js';
import {
  buildContextFragmentManifest,
  buildFragmentManifestEntry,
  computeSourceInventoryFingerprint,
  type ContextFragmentManifest,
  type FragmentManifestIdentity,
} from '../fragment-manifest.js';
import { planIncrementalBuild, type ExtractorIdentity, type IncrementalBuildPlan } from '../fragment-plan.js';
import { fixtureIdentity } from './incremental-fixtures.js';

const FILES: ExtractorIdentity = { id: 'files', revision: '1' };
const MODULES: ExtractorIdentity = { id: 'modules', revision: '1' };

function inventory(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries).map(([path, seed]) => [path, sha256(seed)]));
}

function manifestFor(
  sources: ReadonlyMap<string, string>,
  extractors: readonly ExtractorIdentity[],
  dependencies: Readonly<Record<string, readonly string[]>> = {},
  identity: FragmentManifestIdentity = fixtureIdentity(),
): ContextFragmentManifest {
  const entries = [];
  for (const extractor of extractors) {
    for (const [sourcePath, sourceHash] of sources) {
      entries.push(
        buildFragmentManifestEntry({
          extractor: extractor.id,
          extractorRevision: extractor.revision,
          sourcePath,
          sourceHash,
          fragmentHash: sha256(`${extractor.id}:${sourcePath}:${sourceHash}`),
          dependencyKeys: dependencies[sourcePath] ?? [],
          nodeCount: 1,
          edgeCount: 0,
        }),
      );
    }
  }
  return buildContextFragmentManifest({
    identity,
    sourceFingerprint: computeSourceInventoryFingerprint(sources),
    entries,
  });
}

function planFor(
  previous: ContextFragmentManifest | null,
  sources: ReadonlyMap<string, string>,
  extractors: readonly ExtractorIdentity[] = [FILES],
  identity: FragmentManifestIdentity = fixtureIdentity(),
  status: 'ok' | 'absent' | 'unreadable' = previous ? 'ok' : 'absent',
): IncrementalBuildPlan {
  return planIncrementalBuild({ previous, previousStatus: status, identity, extractors, inventory: sources });
}

function extractedPaths(plan: IncrementalBuildPlan, extractor: string): readonly string[] {
  return plan.extract.find((request) => request.extractor === extractor)?.sourcePaths ?? [];
}

const THREE = inventory({ 'src/a.ts': 'a', 'src/b.ts': 'b', 'src/c.ts': 'c' });

test('an unchanged workspace plans no work at all', () => {
  const plan = planFor(manifestFor(THREE, [FILES, MODULES]), THREE, [FILES, MODULES]);
  assert.equal(plan.mode, 'noop');
  assert.equal(plan.extractCount, 0);
  assert.equal(plan.reuseCount, 6);
  assert.deepEqual(plan.removedPaths, []);
});

test('a one-file change re-extracts that file and nothing else', () => {
  const changed = new Map(THREE).set('src/b.ts', sha256('b2'));
  const plan = planFor(manifestFor(THREE, [FILES, MODULES]), changed, [FILES, MODULES]);
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.extractCount, 2);
  assert.deepEqual(extractedPaths(plan, 'files'), ['src/b.ts']);
  assert.deepEqual(extractedPaths(plan, 'modules'), ['src/b.ts']);
  assert.equal(plan.reuseCount, 4);
  assert.deepEqual(plan.changedPaths, ['src/b.ts']);
  assert.deepEqual(plan.invalidated.map((item) => item.reason), ['source_changed', 'source_changed']);
});

test('the closure follows declared read sets and stops there', () => {
  // c reads b, b reads a. Changing a invalidates a (itself) and b (declared), and
  // must leave c alone: c never opened a, so nothing it recorded can be stale.
  const previous = manifestFor(THREE, [FILES], { 'src/b.ts': ['src/a.ts'], 'src/c.ts': ['src/b.ts'] });
  const plan = planFor(previous, new Map(THREE).set('src/a.ts', sha256('a2')));
  assert.deepEqual(extractedPaths(plan, 'files'), ['src/a.ts', 'src/b.ts']);
  assert.equal(plan.reuseCount, 1);
  assert.deepEqual(
    plan.invalidated.map((item) => `${item.sourcePath}:${item.reason}`),
    ['src/a.ts:source_changed', 'src/b.ts:dependency_moved'],
  );
});

test('a deletion drops the entry instead of carrying it, and invalidates its declared readers', () => {
  const previous = manifestFor(THREE, [FILES], { 'src/a.ts': ['src/b.ts'] });
  const remaining = new Map(THREE);
  remaining.delete('src/b.ts');
  const plan = planFor(previous, remaining);
  assert.deepEqual(plan.removedPaths, ['src/b.ts']);
  assert.deepEqual(extractedPaths(plan, 'files'), ['src/a.ts']);
  assert.equal(plan.reuse.some((entry) => entry.sourcePath === 'src/b.ts'), false);
  assert.equal(plan.invalidated.some((item) => item.sourcePath === 'src/b.ts' && item.reason === 'source_removed'), true);
});

test('a rename is a removal plus an addition, and both halves reach the closure', () => {
  const previous = manifestFor(THREE, [FILES], { 'src/a.ts': ['src/b.ts'] });
  const renamed = new Map(THREE);
  renamed.delete('src/b.ts');
  renamed.set('src/renamed.ts', sha256('b'));
  const plan = planFor(previous, renamed);
  assert.deepEqual(plan.removedPaths, ['src/b.ts']);
  assert.deepEqual(plan.addedPaths, ['src/renamed.ts']);
  assert.deepEqual(extractedPaths(plan, 'files'), ['src/a.ts', 'src/renamed.ts']);
  assert.equal(plan.reuseCount, 1);
});

test('a fragment that probed for a path gets re-extracted when that path appears', () => {
  const previous = manifestFor(THREE, [FILES], { 'src/a.ts': ['src/later.ts'] });
  const plan = planFor(previous, new Map(THREE).set('src/later.ts', sha256('later')));
  assert.deepEqual(extractedPaths(plan, 'files'), ['src/a.ts', 'src/later.ts']);
});

test('every rulebook change forces a full rebuild with its own reason', () => {
  const previous = manifestFor(THREE, [FILES]);
  const cases: Array<[Partial<FragmentManifestIdentity>, string]> = [
    [{ schemaRevision: '2.0.0' }, 'schema_revision_changed'],
    [{ configFingerprint: sha256('config-2') }, 'config_fingerprint_changed'],
    [{ tokenizerFingerprint: sha256('tokenizer-2') }, 'tokenizer_fingerprint_changed'],
  ];
  for (const [overrides, reason] of cases) {
    const plan = planFor(previous, THREE, [FILES], fixtureIdentity(overrides));
    assert.equal(plan.mode, 'full_rebuild', reason);
    assert.equal(plan.rebuildReason, reason);
    assert.equal(plan.reuseCount, 0);
    assert.equal(plan.extractCount, 3);
  }
});

test('a missing or damaged manifest rebuilds rather than guessing', () => {
  assert.equal(planFor(null, THREE).rebuildReason, 'manifest_absent');
  assert.equal(planFor(null, THREE, [FILES], fixtureIdentity(), 'unreadable').rebuildReason, 'manifest_unreadable');
});

test('a manifest whose fingerprint contradicts its entries is not half-believed', () => {
  const previous = manifestFor(THREE, [FILES]);
  const lying = buildContextFragmentManifest({
    identity: previous.identity,
    // Claims the workspace below, carries entries hashed from a different one.
    sourceFingerprint: computeSourceInventoryFingerprint(new Map(THREE).set('src/a.ts', sha256('a2'))),
    entries: previous.entries,
  });
  const plan = planFor(lying, new Map(THREE).set('src/a.ts', sha256('a2')));
  assert.equal(plan.mode, 'full_rebuild');
  assert.equal(plan.rebuildReason, 'source_fingerprint_divergent');
});

test('an extractor upgrade re-extracts that extractor only', () => {
  const previous = manifestFor(THREE, [FILES, MODULES]);
  const plan = planFor(previous, THREE, [{ id: 'files', revision: '2' }, MODULES]);
  assert.equal(plan.mode, 'incremental');
  assert.deepEqual(extractedPaths(plan, 'files'), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(extractedPaths(plan, 'modules'), []);
  assert.equal(plan.reuseCount, 3);
});

test('an extractor that is gone takes its entries with it', () => {
  const previous = manifestFor(THREE, [FILES, MODULES]);
  const plan = planFor(previous, THREE, [FILES]);
  // Not a no-op: the workspace stood still, but the modules nodes have to leave the graph.
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.extractCount, 0);
  assert.equal(plan.reuseCount, 3);
  assert.equal(plan.invalidated.filter((item) => item.reason === 'extractor_removed').length, 3);
  assert.equal(plan.reuse.some((entry) => entry.extractor === 'modules'), false);
});
