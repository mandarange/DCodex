import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../../../../fsx.js';
import { CONTEXT_GRAPH_META_SCHEMA, CONTEXT_GRAPH_SCHEMA_REVISION, type ContextGraphMeta, type ContextGraphSnapshot } from '../../contracts.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { contextGraphFragmentCacheDir, contextGraphSnapshotPath } from '../../paths.js';
import { fileNode, makeFixtureRoot, removeFixtureRoot } from '../../compiler/__tests__/graph-test-fixtures.js';
import { fragmentCacheKey, readCachedFragmentWithReason, writeCachedFragment } from '../fragment-cache.js';
import { contextGraphCurrentFileHash, stageAndCommitContextGraphSnapshot, writeContextGraphSnapshot } from '../snapshot-store.js';
import { withEvidenceWriterLock } from '../evidence-write-lock.js';

function snapshot(label: string): ContextGraphSnapshot {
  return buildContextGraphSnapshot({ nodes: [fileNode('src/a.ts', sha256(label))], edges: [], cycles: [], extractors: [] });
}

function meta(value: ContextGraphSnapshot): ContextGraphMeta {
  return {
    schema: CONTEXT_GRAPH_META_SCHEMA, schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: value.snapshotHash, previousSnapshotHash: null, generatedAt: '2026-08-02T00:00:00.000Z',
    cacheKey: sha256('cache'), cacheKeyParts: {
      workspaceIdentity: sha256('project'), head: null, gitState: 'unknown', trackedDirtyFingerprint: 'unknown',
      untrackedFingerprint: 'unknown', schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION, tsconfigHash: sha256('tsconfig'),
      commandManifestHash: sha256('commands'), gateManifestHash: sha256('gates'), proofIndexHash: sha256('proofs'), wikiContextHash: sha256('wiki')
    }, inputHashes: {}, nodeCount: value.nodeCount, edgeCount: value.edgeCount,
    lint: { ok: true, errors: 0, warnings: 0 }, skipped: [], durationMs: 1
  };
}

test('staging validates references and crash before replace leaves current byte-identical', async () => {
  const root = makeFixtureRoot('cgs-architecture-staging');
  try {
    const first = snapshot('first');
    await writeContextGraphSnapshot({ root, snapshot: first, meta: meta(first) });
    const before = await fsp.readFile(contextGraphSnapshotPath(root));
    const next = snapshot('next');
    await assert.rejects(() => stageAndCommitContextGraphSnapshot({
      root, snapshot: next, meta: meta(next), projectId: 'project-1',
      expectedCurrentFileHash: sha256(before), beforeReplace: () => { throw new Error('crash_injected'); }
    }), /crash_injected/);
    assert.deepEqual(await fsp.readFile(contextGraphSnapshotPath(root)), before);

    const invalid = await stageAndCommitContextGraphSnapshot({
      root, snapshot: next, meta: { ...meta(next), snapshotHash: 'bad-reference' }, projectId: 'project-1',
      expectedCurrentFileHash: sha256(before)
    });
    assert.equal(invalid.status, 'invalid_staging');
    assert.deepEqual(await fsp.readFile(contextGraphSnapshotPath(root)), before);
  } finally { removeFixtureRoot(root); }
});

test('one project writer runs at a time while readers remain available', async () => {
  const root = makeFixtureRoot('cgs-architecture-lock');
  try {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withEvidenceWriterLock({ root, projectId: 'project-1', run: async () => { order.push('first:start'); await gate; order.push('first:end'); } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reader = fsp.stat(root);
    const second = withEvidenceWriterLock({ root, projectId: 'project-1', run: async () => { order.push('second:start'); } });
    await reader;
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  } finally { removeFixtureRoot(root); }
});

test('a stale provenance expectation reports conflict instead of overwriting user edits', async () => {
  const root = makeFixtureRoot('cgs-architecture-conflict');
  try {
    const first = snapshot('first');
    await writeContextGraphSnapshot({ root, snapshot: first, meta: meta(first) });
    const expected = await contextGraphCurrentFileHash(root);
    await fsp.writeFile(contextGraphSnapshotPath(root), `${JSON.stringify(snapshot('user-edit'))}\n`);
    const next = snapshot('next');
    const result = await stageAndCommitContextGraphSnapshot({ root, snapshot: next, meta: meta(next), projectId: 'project-1', expectedCurrentFileHash: expected });
    assert.equal(result.status, 'conflict');
    assert.match(await fsp.readFile(contextGraphSnapshotPath(root), 'utf8'), /snapshotHash/);
  } finally { removeFixtureRoot(root); }
});

test('fragment cache exposes deterministic HIT and MISS reasons', async () => {
  const root = makeFixtureRoot('cgs-architecture-fragment');
  try {
    const key = fragmentCacheKey({ extractorId: 'fixture', extractorRevision: 'v1', cacheKey: sha256('cache'), changedPaths: [] });
    assert.equal((await readCachedFragmentWithReason(root, key, 'fixture')).reason, 'entry_absent');
    const fragment = { schema: 'sks.context-graph-fragment.v1' as const, extractor: 'fixture', extractorRevision: 'v1', nodes: [], edges: [], issues: [], skipped: [], inputHashes: {} };
    await writeCachedFragment(root, key, fragment);
    assert.equal((await readCachedFragmentWithReason(root, key, 'fixture')).status, 'HIT');
    assert.equal((await readCachedFragmentWithReason(root, key, 'other')).reason, 'extractor_mismatch');
    await fsp.writeFile(path.join(contextGraphFragmentCacheDir(root), `${key}.json`), '{bad');
    assert.equal((await readCachedFragmentWithReason(root, key, 'fixture')).reason, 'invalid_json');
  } finally { removeFixtureRoot(root); }
});
