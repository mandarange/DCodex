import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import { compileContextGraph } from '../index.js';
import { contextGraphNodeId } from '../../ids.js';
import { contextGraphFragmentCacheDir, contextGraphSnapshotPath } from '../../paths.js';
import { readContextGraphMeta, readContextGraphSnapshot } from '../../store/snapshot-store.js';
import {
  FIXED_OBSERVED_AT,
  edgeBetween,
  fileGraphExtractor,
  fileNode,
  fragmentOf,
  gitAvailable,
  initGitRepo,
  makeFixtureRoot,
  recordingExtractor,
  removeFixtureRoot,
  writeFixtureFile
} from './graph-test-fixtures.js';

const FILES = ['src/a.ts', 'src/b.ts'];

function seedRepo(prefix: string): string {
  const root = makeFixtureRoot(prefix);
  writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
  writeFixtureFile(root, 'src/b.ts', "import { A } from './a.js';\nexport const B = A;\n");
  return root;
}

test('three compiles of the same input produce an identical snapshot hash and identical bytes', async () => {
  const root = seedRepo('cg-deterministic');
  try {
    const hashes: string[] = [];
    const bytes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await compileContextGraph({
        root,
        extractors: [fileGraphExtractor('code', '1.0.0', FILES)],
        observedAt: FIXED_OBSERVED_AT
      });
      assert.equal(result.ok, true, `compile ${attempt} should succeed: ${result.blockers.join(',')}`);
      assert.equal(result.wrote, true);
      assert.ok(result.snapshotHash);
      hashes.push(result.snapshotHash ?? '');
      bytes.push(fs.readFileSync(contextGraphSnapshotPath(root), 'utf8'));
    }
    assert.equal(new Set(hashes).size, 1, `snapshot hash drifted across compiles: ${hashes.join(' ')}`);
    assert.equal(new Set(bytes).size, 1, 'serialized snapshot bytes drifted across compiles');
  } finally {
    removeFixtureRoot(root);
  }
});

test('an unknown git state makes the cache non-reusable and disables the fragment cache', async () => {
  const root = seedRepo('cg-git-unknown');
  try {
    const result = await compileContextGraph({
      root,
      extractors: [fileGraphExtractor('code', '1.0.0', FILES)],
      observedAt: FIXED_OBSERVED_AT
    });
    assert.equal(result.ok, true);
    assert.equal(result.cacheReusable, false, 'a fixture directory is not a git repo, so git state is unknown');
    assert.equal(fs.existsSync(contextGraphFragmentCacheDir(root)), false, 'no fragment may be cached under an unknown git state');
  } finally {
    removeFixtureRoot(root);
  }
});

test('a repair compile can bypass a stale fragment for a generated input excluded from the cache key', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is required to prove the generated input does not change the reusable cache key');
    return;
  }

  const root = makeFixtureRoot('cg-generated-input-repair');
  const generated = '.sneakoscope/wiki/context-pack.json';
  try {
    writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
    const firstHash = writeFixtureFile(root, generated, '{"generation":1}\n');
    initGitRepo(root);

    const extractor = fileGraphExtractor('evidence', '1.0.0', [generated]);
    const first = await compileContextGraph({
      root,
      extractors: [extractor],
      observedAt: FIXED_OBSERVED_AT
    });
    assert.equal(first.ok, true);
    assert.equal(extractor.calls.length, 1);
    assert.equal(first.meta?.inputHashes[generated], firstHash);

    const secondHash = writeFixtureFile(root, generated, '{"generation":2}\n');
    const cached = await compileContextGraph({
      root,
      extractors: [extractor],
      observedAt: FIXED_OBSERVED_AT
    });
    assert.equal(cached.ok, true);
    assert.equal(extractor.calls.length, 1, 'the unchanged cache key replays the previous fragment by default');
    assert.equal(cached.meta?.inputHashes[generated], firstHash);

    const repaired = await compileContextGraph({
      root,
      extractors: [extractor],
      observedAt: FIXED_OBSERVED_AT,
      useFragmentCache: false
    });
    assert.equal(repaired.ok, true);
    assert.equal(extractor.calls.length, 2, 'the explicit repair compile must re-run the extractor');
    assert.equal(repaired.meta?.inputHashes[generated], secondHash);
    assert.equal((await readContextGraphMeta(root)).meta?.inputHashes[generated], secondHash);
  } finally {
    removeFixtureRoot(root);
  }
});

test('one changed file re-extracts only that file and carries the rest of the graph forward', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is required: an incremental compile may only reuse a snapshot when git state is known');
    return;
  }
  const root = seedRepo('cg-incremental');
  initGitRepo(root);
  try {
    const extractor = fileGraphExtractor('code', '1.0.0', FILES);
    const first = await compileContextGraph({ root, extractors: [extractor], observedAt: FIXED_OBSERVED_AT });
    assert.equal(first.ok, true);
    assert.equal(first.snapshot?.nodeCount, 2);
    assert.equal(first.snapshot?.edgeCount, 1);

    writeFixtureFile(root, 'src/b.ts', "import { A } from './a.js';\nexport const B = A + 1;\n");
    const second = await compileContextGraph({
      root,
      extractors: [extractor],
      changedPaths: ['src/b.ts'],
      observedAt: FIXED_OBSERVED_AT
    });
    assert.equal(second.ok, true, second.blockers.join(','));
    assert.deepEqual(extractor.calls[1], ['src/b.ts'], 'the changed-path set must reach the extractor unchanged');
    assert.equal(second.incremental, true);

    const nodeIds = (second.snapshot?.nodes ?? []).map((node) => node.id).sort();
    assert.deepEqual(nodeIds, [
      contextGraphNodeId({ kind: 'file', path: 'src/a.ts' }),
      contextGraphNodeId({ kind: 'file', path: 'src/b.ts' })
    ].sort(), 'the untouched file must be carried forward');

    const changed = second.snapshot?.nodes.find((node) => node.path === 'src/b.ts');
    assert.equal(changed?.contentHash, sha256(fs.readFileSync(path.join(root, 'src/b.ts'))));
    assert.notEqual(changed?.contentHash, first.snapshot?.nodes.find((node) => node.path === 'src/b.ts')?.contentHash);
  } finally {
    removeFixtureRoot(root);
  }
});

test('two concurrent compiles: exactly one commits, the other reports the lock', async () => {
  const root = seedRepo('cg-lock');
  try {
    const slow = recordingExtractor('code', '1.0.0', async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const hash = sha256(fs.readFileSync(path.join(input.root, 'src/a.ts')));
      return fragmentOf('code', '1.0.0', {
        nodes: [fileNode('src/a.ts', hash)],
        inputHashes: { 'src/a.ts': hash }
      });
    });
    const [left, right] = await Promise.all([
      compileContextGraph({ root, extractors: [slow], observedAt: FIXED_OBSERVED_AT }),
      compileContextGraph({ root, extractors: [slow], observedAt: FIXED_OBSERVED_AT })
    ]);
    const committed = [left, right].filter((result) => result.wrote);
    const blocked = [left, right].filter((result) => !result.wrote);
    assert.equal(committed.length, 1, 'exactly one compile may commit');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.reason, 'lock_held');
    assert.deepEqual(blocked[0]?.blockers, ['lock_held']);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a dangling edge blocks the write and leaves the existing snapshot intact', async () => {
  const root = seedRepo('cg-dangling');
  try {
    const good = fileGraphExtractor('code', '1.0.0', FILES);
    const first = await compileContextGraph({ root, extractors: [good], observedAt: FIXED_OBSERVED_AT });
    assert.equal(first.wrote, true);
    const before = fs.readFileSync(contextGraphSnapshotPath(root), 'utf8');

    const broken = recordingExtractor('code', '1.0.0', (input) => {
      const hash = sha256(fs.readFileSync(path.join(input.root, 'src/a.ts')));
      const node = fileNode('src/a.ts', hash);
      return fragmentOf('code', '1.0.0', {
        nodes: [node],
        edges: [edgeBetween(node.id, 'file:src/does-not-exist.ts', { hash, extractor: 'code' })],
        inputHashes: { 'src/a.ts': hash }
      });
    });
    const second = await compileContextGraph({ root, extractors: [broken], observedAt: FIXED_OBSERVED_AT });
    assert.equal(second.ok, false);
    assert.equal(second.wrote, false);
    assert.equal(second.reason, 'lint_error');
    assert.ok(second.blockers.includes('lint:dangling_edge'), second.blockers.join(','));
    assert.equal(fs.readFileSync(contextGraphSnapshotPath(root), 'utf8'), before, 'a blocked compile must not touch the artifact');
  } finally {
    removeFixtureRoot(root);
  }
});

test('a secret-like value and an absolute path are both blocked before the write', async () => {
  const root = seedRepo('cg-secret');
  try {
    const leaky = recordingExtractor('code', '1.0.0', (input) => {
      const hash = sha256(fs.readFileSync(path.join(input.root, 'src/a.ts')));
      const secretNode = fileNode('src/a.ts', hash, {
        metadata: { note: 'api_key=AKIA1234567890abcdefghijklmn' }
      });
      const absoluteNode = fileNode('src/b.ts', hash, {
        id: contextGraphNodeId({ kind: 'file', path: 'src/b.ts' }),
        path: '/etc/passwd'
      });
      return fragmentOf('code', '1.0.0', {
        nodes: [secretNode, absoluteNode],
        inputHashes: { 'src/a.ts': hash }
      });
    });
    const result = await compileContextGraph({ root, extractors: [leaky], observedAt: FIXED_OBSERVED_AT });
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.ok(result.blockers.includes('lint:secret_like_value'), result.blockers.join(','));
    assert.ok(result.blockers.includes('lint:absolute_or_escaping_path'), result.blockers.join(','));
    assert.equal(fs.existsSync(contextGraphSnapshotPath(root)), false, 'nothing may be written when lint fails');
  } finally {
    removeFixtureRoot(root);
  }
});

test('a derived edge with no exact or manifest support is dropped with a recorded reason', async () => {
  const root = seedRepo('cg-derived');
  try {
    const extractor = recordingExtractor('code', '1.0.0', (input) => {
      const aHash = sha256(fs.readFileSync(path.join(input.root, 'src/a.ts')));
      const bHash = sha256(fs.readFileSync(path.join(input.root, 'src/b.ts')));
      const a = fileNode('src/a.ts', aHash);
      const b = fileNode('src/b.ts', bHash);
      return fragmentOf('code', '1.0.0', {
        nodes: [a, b],
        edges: [
          edgeBetween(a.id, b.id, { type: 'cochanged_with', confidence: 'derived', hash: aHash, extractor: 'code' }),
          edgeBetween(b.id, a.id, { type: 'imports', confidence: 'exact', path: 'src/b.ts', hash: bHash, extractor: 'code' })
        ],
        inputHashes: { 'src/a.ts': aHash, 'src/b.ts': bHash }
      });
    });
    const result = await compileContextGraph({ root, extractors: [extractor], observedAt: FIXED_OBSERVED_AT });
    assert.equal(result.ok, true, result.blockers.join(','));
    assert.equal(result.snapshot?.edgeCount, 1, 'only the exact edge survives');
    assert.equal(result.droppedEdges.length, 1);
    assert.equal(result.droppedEdges[0]?.reason, 'derived_without_exact_or_manifest_support');
  } finally {
    removeFixtureRoot(root);
  }
});

test('a failing extractor blocks the compile instead of writing a partial graph', async () => {
  const root = seedRepo('cg-extractor-failure');
  try {
    const exploding = recordingExtractor('code', '1.0.0', () => {
      throw new Error('extractor blew up');
    });
    const result = await compileContextGraph({ root, extractors: [exploding], observedAt: FIXED_OBSERVED_AT });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'extractor_failed');
    assert.deepEqual(result.blockers, ['extractor_failed:code']);
    assert.equal((await readContextGraphSnapshot(root)).status, 'missing');
  } finally {
    removeFixtureRoot(root);
  }
});
