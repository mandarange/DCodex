import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import test from 'node:test';
import { sha256 } from '../../../../fsx.js';
import {
  ContextFragmentManifestError,
  buildContextFragmentManifest,
  buildFragmentManifestEntry,
  computeSourceInventoryFingerprint,
  contextFragmentManifestHash,
  parseContextFragmentManifest,
  serializeContextFragmentManifest,
  type FragmentManifestEntry,
} from '../fragment-manifest.js';
import {
  contextFragmentManifestPath,
  readContextFragmentManifest,
  writeContextFragmentManifest,
} from '../fragment-manifest-store.js';
import { fixtureIdentity, makeFixtureRoot, removeFixtureRoot } from './incremental-fixtures.js';

function entry(overrides: Partial<FragmentManifestEntry> = {}): FragmentManifestEntry {
  return buildFragmentManifestEntry({
    extractor: 'files',
    extractorRevision: '1',
    sourcePath: 'src/a.ts',
    sourceHash: sha256('a'),
    fragmentHash: sha256('fragment-a'),
    dependencyKeys: [],
    nodeCount: 1,
    edgeCount: 0,
    ...overrides,
  });
}

function manifestOf(entries: readonly FragmentManifestEntry[]) {
  return buildContextFragmentManifest({
    identity: fixtureIdentity(),
    sourceFingerprint: sha256('inventory'),
    entries,
  });
}

test('a manifest entry refuses every path that could leave the workspace', () => {
  for (const unsafe of ['/etc/passwd', '~/secret.ts', '../outside.ts', 'src/../../up.ts', 'C:/win.ts', 'src\\a.ts', 'src/./a.ts', '']) {
    assert.throws(() => entry({ sourcePath: unsafe }), ContextFragmentManifestError, `accepted ${unsafe}`);
  }
  assert.throws(() => entry({ dependencyKeys: ['/abs/dep.ts'] }), ContextFragmentManifestError);
});

test('an error names the field by number and never echoes the value', () => {
  try {
    entry({ sourcePath: '/Users/someone/secret.ts' });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof ContextFragmentManifestError);
    assert.equal(error.publicCode, 'context_fragment_manifest_corrupt');
    for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
    assert.equal(JSON.stringify(error.detail).includes('secret'), false);
  }
});

test('dependency keys are normalized on build and required canonical on parse', () => {
  const built = entry({ dependencyKeys: ['src/z.ts', 'src/b.ts', 'src/b.ts'] });
  assert.deepEqual(built.dependencyKeys, ['src/b.ts', 'src/z.ts']);

  const raw = JSON.parse(serializeContextFragmentManifest(manifestOf([built]))) as Record<string, unknown>;
  (raw.entries as Array<Record<string, unknown>>)[0]!.dependencyKeys = ['src/z.ts', 'src/b.ts'];
  assert.throws(() => parseContextFragmentManifest(raw), ContextFragmentManifestError);
});

test('the manifest hash is order-independent on build and clock-free across builds', () => {
  const first = entry({ sourcePath: 'src/a.ts' });
  const second = entry({ sourcePath: 'src/b.ts', sourceHash: sha256('b'), fragmentHash: sha256('fragment-b') });
  const forward = contextFragmentManifestHash(manifestOf([first, second]));
  const reversed = contextFragmentManifestHash(manifestOf([second, first]));
  assert.equal(forward, reversed);
  assert.equal(forward, contextFragmentManifestHash(manifestOf([first, second])));
  assert.equal(serializeContextFragmentManifest(manifestOf([first, second])).includes('generatedAt'), false);
});

test('a manifest that describes two workspace states at once is refused', () => {
  const files = entry({ extractor: 'files' });
  const modules = entry({ extractor: 'modules', sourceHash: sha256('a-different') });
  assert.throws(() => manifestOf([files, modules]), ContextFragmentManifestError);
  assert.throws(() => manifestOf([files, entry({ extractor: 'files' })]), ContextFragmentManifestError);
});

test('entry order is part of the document, not a rendering choice', () => {
  const first = entry({ sourcePath: 'src/a.ts' });
  const second = entry({ sourcePath: 'src/b.ts', sourceHash: sha256('b'), fragmentHash: sha256('fragment-b') });
  const raw = JSON.parse(serializeContextFragmentManifest(manifestOf([first, second]))) as Record<string, unknown>;
  raw.entries = [(raw.entries as unknown[])[1], (raw.entries as unknown[])[0]];
  assert.throws(() => parseContextFragmentManifest(raw), ContextFragmentManifestError);
});

test('the inventory fingerprint moves with content and with membership', () => {
  const base = new Map([['src/a.ts', sha256('a')], ['src/b.ts', sha256('b')]]);
  const reordered = new Map([['src/b.ts', sha256('b')], ['src/a.ts', sha256('a')]]);
  assert.equal(computeSourceInventoryFingerprint(base), computeSourceInventoryFingerprint(reordered));
  const changed = new Map(base).set('src/a.ts', sha256('a2'));
  const removed = new Map(base);
  removed.delete('src/b.ts');
  assert.notEqual(computeSourceInventoryFingerprint(base), computeSourceInventoryFingerprint(changed));
  assert.notEqual(computeSourceInventoryFingerprint(base), computeSourceInventoryFingerprint(removed));
});

test('the store round-trips, reports damage without throwing, and writes no host path', async () => {
  const root = makeFixtureRoot('cg-fragment-manifest');
  try {
    assert.equal((await readContextFragmentManifest(root)).status, 'absent');

    const manifest = manifestOf([entry(), entry({ sourcePath: 'src/b.ts', sourceHash: sha256('b'), fragmentHash: sha256('fragment-b') })]);
    await writeContextFragmentManifest(root, manifest);
    const loaded = await readContextFragmentManifest(root);
    assert.equal(loaded.status, 'ok');
    assert.equal(contextFragmentManifestHash(loaded.manifest!), contextFragmentManifestHash(manifest));

    const text = await fsp.readFile(contextFragmentManifestPath(root), 'utf8');
    assert.equal(text.includes(root), false);
    assert.equal(/"[^"]*(?:\/Users\/|\/tmp\/|\/var\/folders\/|~\/)/.test(text), false);

    await fsp.writeFile(contextFragmentManifestPath(root), '{ not json', 'utf8');
    const damaged = await readContextFragmentManifest(root);
    assert.equal(damaged.status, 'unreadable');
    assert.equal(damaged.manifest, null);
  } finally {
    removeFixtureRoot(root);
  }
});
