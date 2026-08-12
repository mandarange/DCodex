import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../../../../fsx.js';
import { encodeContextIndex } from '../../runtime-index/writer.js';
import { countDanglingEdges } from '../fragment-merge.js';
import { runIncrementalBuild, type IncrementalBuildResult } from '../incremental-build.js';
import {
  countingFragmentStore,
  fixtureExtractor,
  fixtureIdentity,
  inventoryOf,
  makeFixtureRoot,
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
  'README.md': '# fixture\n',
};

const SOURCES = Object.keys(WORKSPACE);

function extractors(): CountingSourceExtractor[] {
  return [
    // Reads only its own bytes.
    fixtureExtractor('files', '1'),
    // Opens what it imports, so an import's change reaches the importer.
    fixtureExtractor('modules', '1', { declareImportDependencies: true, shape: 'module' }),
  ];
}

async function build(
  root: string,
  registry: readonly CountingSourceExtractor[],
  overrides: { tokenizer?: string | undefined; store?: ReturnType<typeof countingFragmentStore> | undefined } = {},
): Promise<IncrementalBuildResult> {
  return runIncrementalBuild({
    root,
    extractors: registry,
    inventory: inventoryOf(root, SOURCES),
    identity: fixtureIdentity(overrides.tokenizer ? { tokenizerFingerprint: sha256(overrides.tokenizer) } : {}),
    observedAt: OBSERVED_AT,
    ...(overrides.store ? { store: overrides.store } : {}),
  });
}

function indexBytes(result: IncrementalBuildResult): Uint8Array {
  return encodeContextIndex({
    snapshot: result.snapshot!,
    configHash: new Uint8Array(32),
    schemaRevision: 1,
  }).bytes;
}

test('the first build extracts everything, and the manifest it leaves is total', async () => {
  const root = makeFixtureRoot('cg-incremental-first');
  try {
    seedWorkspace(root, WORKSPACE);
    const registry = extractors();
    const result = await build(root, registry);

    assert.equal(result.status, 'built');
    assert.equal(result.plan.mode, 'full_rebuild');
    assert.equal(result.plan.rebuildReason, 'manifest_absent');
    assert.equal(result.manifest!.entries.length, SOURCES.length * 2);
    assert.deepEqual(registry[0]!.extracted.sort(), [...SOURCES].sort());
    assert.equal(countDanglingEdges(result.merged!.nodes, result.merged!.edges), 0);
    // README.md imports nothing and is still recorded by both extractors, or it
    // would look like a new source on every run and never reach the no-op path.
    const readme = result.manifest!.entries.filter((entry) => entry.sourcePath === 'README.md');
    assert.deepEqual(readme.map((entry) => entry.extractor), ['files', 'modules']);
    assert.equal(readme.find((entry) => entry.extractor === 'files')!.edgeCount, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('an unchanged workspace touches neither an extractor nor the fragment cache', async () => {
  const root = makeFixtureRoot('cg-incremental-noop');
  try {
    seedWorkspace(root, WORKSPACE);
    await build(root, extractors());

    const registry = extractors();
    const store = countingFragmentStore(root);
    const second = await build(root, registry, { store });

    assert.equal(second.status, 'unchanged');
    assert.equal(second.plan.mode, 'noop');
    assert.equal(second.plan.extractCount, 0);
    assert.equal(store.loads, 0);
    assert.equal(store.saves, 0);
    for (const extractor of registry) assert.deepEqual(extractor.calls, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a one-file change re-extracts that file and its declared readers, and nothing else', async () => {
  const root = makeFixtureRoot('cg-incremental-one-file');
  try {
    seedWorkspace(root, WORKSPACE);
    await build(root, extractors());

    writeFixtureFile(root, 'src/c.ts', 'const c = 2;\n');
    const registry = extractors();
    const result = await build(root, registry);

    assert.equal(result.status, 'built');
    assert.equal(result.plan.mode, 'incremental');
    // `files` never opened c from b, so only c itself moves for it.
    assert.deepEqual(registry[0]!.extracted, ['src/c.ts']);
    // `modules` declared that b reads c, so b comes along — and a does not.
    assert.deepEqual(registry[1]!.extracted, ['src/b.ts', 'src/c.ts']);
    assert.equal(result.stats.extracted, 3);
    assert.equal(result.stats.reused, SOURCES.length * 2 - 3);
    assert.equal(countDanglingEdges(result.merged!.nodes, result.merged!.edges), 0);
    assert.deepEqual(result.issues, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test('an incremental build and a full rebuild of the same workspace produce the same index bytes', async () => {
  const incrementalRoot = makeFixtureRoot('cg-incremental-parity-a');
  const scratchRoot = makeFixtureRoot('cg-incremental-parity-b');
  try {
    seedWorkspace(incrementalRoot, WORKSPACE);
    await build(incrementalRoot, extractors());
    writeFixtureFile(incrementalRoot, 'src/c.ts', 'const c = 2;\n');
    const incremental = await build(incrementalRoot, extractors());

    seedWorkspace(scratchRoot, { ...WORKSPACE, 'src/c.ts': 'const c = 2;\n' });
    const scratch = await build(scratchRoot, extractors());

    assert.equal(scratch.plan.mode, 'full_rebuild');
    assert.equal(incremental.plan.mode, 'incremental');
    assert.equal(incremental.snapshot!.snapshotHash, scratch.snapshot!.snapshotHash);
    assert.deepEqual(indexBytes(incremental), indexBytes(scratch));
    // The manifest is a content address too: same workspace, same rulebook, same hash.
    assert.equal(incremental.manifestHash, scratch.manifestHash);
  } finally {
    removeFixtureRoot(incrementalRoot);
    removeFixtureRoot(scratchRoot);
  }
});

test('repeating the same incremental build is idempotent down to the bytes', async () => {
  const root = makeFixtureRoot('cg-incremental-repeat');
  try {
    seedWorkspace(root, WORKSPACE);
    await build(root, extractors());
    writeFixtureFile(root, 'src/a.ts', 'import "src/c.ts";\n');

    const first = await build(root, extractors());
    const second = await build(root, extractors());
    assert.equal(first.status, 'built');
    assert.equal(second.status, 'unchanged');
    assert.equal(second.manifestHash, first.manifestHash);

    // Rebuilding from scratch on top of the same manifest must land on the same bytes.
    const third = await runIncrementalBuild({
      root,
      extractors: extractors(),
      inventory: inventoryOf(root, SOURCES),
      identity: fixtureIdentity(),
      observedAt: '2026-03-09T12:00:00.000Z',
      previous: { status: 'absent', manifest: null },
      persist: false,
    });
    assert.equal(third.plan.mode, 'full_rebuild');
    assert.deepEqual(indexBytes(third), indexBytes(first));
  } finally {
    removeFixtureRoot(root);
  }
});
