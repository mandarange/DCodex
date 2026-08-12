import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import test from 'node:test';
import { sha256 } from '../../../../fsx.js';
import { countDanglingEdges } from '../fragment-merge.js';
import { sourceFragmentPath } from '../fragment-store.js';
import { runIncrementalBuild, type IncrementalBuildResult } from '../incremental-build.js';
import {
  fixtureExtractor,
  fixtureIdentity,
  inventoryOf,
  makeFixtureRoot,
  removeFixtureFile,
  removeFixtureRoot,
  seedWorkspace,
  writeFixtureFile,
  type CountingSourceExtractor,
} from './incremental-fixtures.js';

const OBSERVED_AT = '2026-02-01T00:00:00.000Z';

const WORKSPACE: Readonly<Record<string, string>> = {
  'src/a.ts': 'import "src/b.ts";\n',
  'src/b.ts': 'import "src/c.ts";\n',
  'src/c.ts': 'const c = 1;\n',
};

const ALL_SOURCES = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];

function extractors(): CountingSourceExtractor[] {
  return [
    fixtureExtractor('files', '1'),
    fixtureExtractor('modules', '1', { declareImportDependencies: true, shape: 'module' }),
  ];
}

async function build(
  root: string,
  registry: readonly CountingSourceExtractor[],
  tokenizer?: string,
): Promise<IncrementalBuildResult> {
  return runIncrementalBuild({
    root,
    extractors: registry,
    inventory: inventoryOf(root, ALL_SOURCES),
    identity: fixtureIdentity(tokenizer ? { tokenizerFingerprint: sha256(tokenizer) } : {}),
    observedAt: OBSERVED_AT,
  });
}

function referencesPath(result: IncrementalBuildResult, needle: string): boolean {
  const nodes = result.merged!.nodes.some((node) => node.id.includes(needle) || node.path === needle);
  const edges = result.merged!.edges.some((edge) => edge.to.includes(needle) || edge.from.includes(needle));
  return nodes || edges;
}

test('a deleted source leaves no node, no edge into it, and no dangling edge', async () => {
  const root = makeFixtureRoot('cg-incremental-delete');
  try {
    seedWorkspace(root, WORKSPACE);
    const before = await build(root, extractors());
    assert.equal(referencesPath(before, 'src/c.ts'), true);

    removeFixtureFile(root, 'src/c.ts');
    const registry = extractors();
    const after = await build(root, registry);

    assert.deepEqual(after.plan.removedPaths, ['src/c.ts']);
    assert.equal(countDanglingEdges(after.merged!.nodes, after.merged!.edges), 0);
    assert.equal(referencesPath(after, 'src/c.ts'), false);
    // The importer's own bytes did not move, so `files` reused its fragment — and
    // the reused import edge lost its target. Pruned as a fact, not as an error.
    assert.deepEqual(
      after.merged!.pruned.map((edge) => `${edge.extractor}:${edge.sourcePath}:${edge.reason}`),
      ['files:src/b.ts:reused_endpoint_missing'],
    );
    assert.deepEqual(after.issues, []);
    assert.equal(after.manifest!.entries.some((entry) => entry.sourcePath === 'src/c.ts'), false);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a rename whose importer was not updated still lands on the full-rebuild graph', async () => {
  const root = makeFixtureRoot('cg-incremental-rename');
  const scratch = makeFixtureRoot('cg-incremental-rename-scratch');
  try {
    seedWorkspace(root, WORKSPACE);
    await build(root, extractors());

    removeFixtureFile(root, 'src/c.ts');
    writeFixtureFile(root, 'src/d.ts', 'const c = 1;\n');
    const renamed = await build(root, extractors());

    seedWorkspace(scratch, {
      'src/a.ts': WORKSPACE['src/a.ts'] as string,
      'src/b.ts': WORKSPACE['src/b.ts'] as string,
      'src/d.ts': 'const c = 1;\n',
    });
    const fresh = await build(scratch, extractors());

    assert.deepEqual(renamed.plan.removedPaths, ['src/c.ts']);
    assert.deepEqual(renamed.plan.addedPaths, ['src/d.ts']);
    assert.equal(countDanglingEdges(renamed.merged!.nodes, renamed.merged!.edges), 0);
    assert.equal(referencesPath(renamed, 'src/c.ts'), false);
    assert.equal(referencesPath(renamed, 'src/d.ts'), true);
    // Pruning is not a different answer from rebuilding: it is the same answer,
    // cheaper. The manifests differ on purpose — the reused fragment still records
    // the import, which is what makes restoring the file cheap rather than a
    // rebuild — but nothing about that reaches the graph.
    assert.equal(renamed.snapshot!.snapshotHash, fresh.snapshot!.snapshotHash);
  } finally {
    removeFixtureRoot(root);
    removeFixtureRoot(scratch);
  }
});

test('a tokenizer change rebuilds everything rather than reusing across rulebooks', async () => {
  const root = makeFixtureRoot('cg-incremental-tokenizer');
  try {
    seedWorkspace(root, WORKSPACE);
    await build(root, extractors());

    const registry = extractors();
    const rebuilt = await build(root, registry, 'tokenizer-v2');
    assert.equal(rebuilt.plan.mode, 'full_rebuild');
    assert.equal(rebuilt.plan.rebuildReason, 'tokenizer_fingerprint_changed');
    assert.equal(rebuilt.stats.reused, 0);
    assert.deepEqual(registry[0]!.extracted, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual(registry[1]!.extracted, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.equal(rebuilt.manifest!.identity.tokenizerFingerprint, sha256('tokenizer-v2'));

    // And the new manifest is what the next build reuses from, so the rebuild is not permanent.
    const settled = await build(root, extractors(), 'tokenizer-v2');
    assert.equal(settled.plan.mode, 'noop');
  } finally {
    removeFixtureRoot(root);
  }
});

test('a corrupt cached payload is re-extracted instead of trusted', async () => {
  const root = makeFixtureRoot('cg-incremental-corrupt');
  const scratch = makeFixtureRoot('cg-incremental-corrupt-scratch');
  try {
    seedWorkspace(root, WORKSPACE);
    const first = await build(root, extractors());
    const victim = first.manifest!.entries.find(
      (entry) => entry.extractor === 'files' && entry.sourcePath === 'src/a.ts',
    );
    await fsp.writeFile(sourceFragmentPath(root, victim!.fragmentHash), 'not a fragment', 'utf8');

    writeFixtureFile(root, 'src/c.ts', 'const c = 2;\n');
    const registry = extractors();
    const repaired = await build(root, registry);

    assert.equal(repaired.stats.reuseFailures, 1);
    assert.deepEqual(registry[0]!.extracted, ['src/a.ts', 'src/c.ts']);
    assert.deepEqual(repaired.issues, []);

    seedWorkspace(scratch, { ...WORKSPACE, 'src/c.ts': 'const c = 2;\n' });
    const fresh = await build(scratch, extractors());
    assert.equal(repaired.snapshot!.snapshotHash, fresh.snapshot!.snapshotHash);
  } finally {
    removeFixtureRoot(root);
    removeFixtureRoot(scratch);
  }
});

test('an extraction that blocks writes no manifest, so the next build still knows what is missing', async () => {
  const root = makeFixtureRoot('cg-incremental-blocked');
  try {
    seedWorkspace(root, WORKSPACE);
    const failing: CountingSourceExtractor = {
      ...fixtureExtractor('files', '1'),
      async extractSources() {
        throw new Error('extractor exploded');
      },
    };
    const blocked = await runIncrementalBuild({
      root,
      extractors: [failing],
      inventory: inventoryOf(root, ALL_SOURCES),
      identity: fixtureIdentity(),
      observedAt: OBSERVED_AT,
    });

    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.blockers, ['source_extractor_failed:files']);
    assert.equal(blocked.manifest, null);
    // A retry starts from the same place rather than from a manifest that claims
    // sources were handled by a run that never produced them.
    const retry = await build(root, extractors());
    assert.equal(retry.plan.mode, 'full_rebuild');
    assert.equal(retry.plan.rebuildReason, 'manifest_absent');
  } finally {
    removeFixtureRoot(root);
  }
});
