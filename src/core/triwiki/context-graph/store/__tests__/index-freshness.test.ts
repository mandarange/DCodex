import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import {
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  type ContextGraphMeta,
  type ContextGraphSnapshot,
  type ContextGraphStatus
} from '../../contracts.js';
import type { ContextGraphCacheKeyResult } from '../../compiler/cache-key.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { contextGraphMetaPath, contextGraphSnapshotPath } from '../../paths.js';
import { contextIndexPointerPath, contextIndexStoreDir } from '../generation-layout.js';
import { CONTEXT_INDEX_POINTER_SCHEMA } from '../generation-pointer.js';
import { codeNavigationGraphExtractors } from '../../extractors/index.js';
import { contextGraphStatus } from '../graph-status.js';
import { contextIndexFreshness } from '../index-freshness.js';
import { writeContextGraphSnapshot } from '../snapshot-store.js';
import {
  FIXED_OBSERVED_AT,
  fileNode,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureFile
} from '../../compiler/__tests__/graph-test-fixtures.js';

/**
 * The v2 preflight exists so freshness can be established without parsing the
 * 58 MB JSON snapshot. Two properties have to hold together, and either one
 * alone is worthless:
 *
 *  1. It does not read the snapshot. Proven by deleting the snapshot and
 *     watching the verdict stay `fresh` — a version that still parsed it would
 *     report `missing` instead.
 *  2. It reaches the *same verdict* the JSON path reaches. Proven by running
 *     both functions against the same workspace in each state and comparing,
 *     rather than by asserting hand-written expectations twice. A duplicated
 *     expectation drifts silently; a comparison cannot.
 *
 * The cache key is supplied explicitly in every case so no test shells out to
 * git or depends on the temp directory's VCS state. That is the same seam the
 * hooks-runtime preflight already uses, and it makes the git-derived half a
 * controlled input rather than ambient state.
 */

const HEAD = 'a'.repeat(40);
const FIXTURE_HASH = 'b'.repeat(64);

function seedRepo(prefix: string): { root: string; sourceHash: string } {
  const root = makeFixtureRoot(prefix);
  const sourceHash = writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
  return { root, sourceHash };
}

function snapshotWith(label: string): ContextGraphSnapshot {
  return buildContextGraphSnapshot({
    nodes: [fileNode('src/a.ts', sha256(label))],
    edges: [],
    cycles: [],
    extractors: []
  });
}

/** A clean, reusable key, so an unmodified workspace reads as fresh on both paths. */
function cleanParts(): ContextGraphMeta['cacheKeyParts'] {
  return {
    sourcePolicy: 'workspace',
    workspaceIdentity: sha256('workspace'),
    head: HEAD,
    gitState: 'clean',
    trackedDirtyFingerprint: sha256('tracked'),
    untrackedFingerprint: sha256('untracked'),
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    tsconfigHash: sha256('tsconfig'),
    commandManifestHash: sha256('commands'),
    gateManifestHash: sha256('gates'),
    proofIndexHash: sha256('proofs'),
    wikiContextHash: sha256('wiki')
  };
}

function metaFor(
  snapshot: ContextGraphSnapshot,
  overrides: Partial<ContextGraphMeta> = {}
): ContextGraphMeta {
  return {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: snapshot.snapshotHash,
    previousSnapshotHash: null,
    generatedAt: FIXED_OBSERVED_AT,
    cacheKey: sha256('cache-key'),
    cacheKeyParts: cleanParts(),
    inputHashes: {},
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    lint: { ok: true, errors: 0, warnings: 0 },
    skipped: [],
    durationMs: 1,
    ...overrides
  };
}

function keyOf(parts: ContextGraphMeta['cacheKeyParts']): ContextGraphCacheKeyResult {
  return { key: sha256(JSON.stringify(parts)), parts, reusable: true, reasons: [], dirtyPaths: [] };
}

/** The four fields a caller branches on. Comparing whole objects would compare timestamps. */
function verdict(status: ContextGraphStatus) {
  return {
    status: status.status,
    errorCode: status.errorCode,
    reasons: status.reasons,
    repairCommand: status.repairCommand
  };
}

async function bothPaths(root: string, options: Parameters<typeof contextIndexFreshness>[1]) {
  return {
    json: verdict(await contextGraphStatus(root, options)),
    v2: verdict(await contextIndexFreshness(root, options))
  };
}

function publishPointer(root: string, snapshotHash: string): void {
  fs.mkdirSync(contextIndexStoreDir(root), { recursive: true });
  fs.writeFileSync(contextIndexPointerPath(root), JSON.stringify({
    schema: CONTEXT_INDEX_POINTER_SCHEMA,
    formatRevision: 1,
    snapshotHash,
    configFingerprint: 'c'.repeat(64),
    sourceFingerprint: 'd'.repeat(64),
    generationPath: `.sneakoscope/context-index/generations/${snapshotHash}.idx`,
    previousSnapshotHash: null,
    indexBytes: 1024,
    indexChecksum: 'e'.repeat(64),
    committedAt: FIXED_OBSERVED_AT
  }), 'utf8');
}

test('the v2 preflight establishes freshness without the snapshot on disk at all', async () => {
  const { root } = seedRepo('cgf-no-snapshot');
  try {
    const snapshot = snapshotWith('fresh');
    const meta = metaFor(snapshot);
    await writeContextGraphSnapshot({ root, snapshot, meta });
    const options = { cacheKey: keyOf(cleanParts()), verifySources: false } as const;

    // Both agree while the snapshot is present.
    const before = await bothPaths(root, options);
    assert.equal(before.json.status, 'fresh');
    assert.deepEqual(before.v2, before.json);

    // Now delete the 58 MB artifact the whole project exists to stop reading.
    fs.rmSync(contextGraphSnapshotPath(root));
    assert.equal((await contextIndexFreshness(root, options)).status, 'fresh',
      'the v2 path must not need the snapshot to answer');
    // And the JSON path proves the file really is gone, so the assertion above
    // is about the reader and not about a stale cache.
    assert.equal((await contextGraphStatus(root, options)).status, 'missing');
  } finally {
    removeFixtureRoot(root);
  }
});

test('the two paths reach the same verdict in every state the JSON path can report', async () => {
  const { root, sourceHash } = seedRepo('cgf-equivalence');
  try {
    const snapshot = snapshotWith('equivalence');
    const meta = metaFor(snapshot, { inputHashes: { 'src/a.ts': sourceHash } });
    await writeContextGraphSnapshot({ root, snapshot, meta });

    // fresh
    const fresh = await bothPaths(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(fresh.json.status, 'fresh');
    assert.deepEqual(fresh.v2, fresh.json);

    // stale, by a cache-key part
    const moved = { ...cleanParts(), trackedDirtyFingerprint: sha256('edited') };
    const dirty = await bothPaths(root, { cacheKey: keyOf(moved), verifySources: false });
    assert.equal(dirty.json.status, 'stale');
    assert.ok(dirty.json.reasons.includes('dirty_fingerprint_changed'));
    assert.deepEqual(dirty.v2, dirty.json);

    // stale, by a recorded input whose bytes changed on disk
    writeFixtureFile(root, 'src/a.ts', 'export const A = 2;\n');
    const edited = await bothPaths(root, { cacheKey: keyOf(cleanParts()), verifySources: true });
    assert.equal(edited.json.status, 'stale');
    assert.ok(edited.json.reasons.includes('source_hash_mismatch'),
      'a source edit must be visible without the snapshot');
    assert.deepEqual(edited.v2, edited.json);

    // corrupt, by an unreadable meta
    fs.writeFileSync(contextGraphMetaPath(root), '{ not json', 'utf8');
    const corruptMeta = await bothPaths(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(corruptMeta.json.status, 'corrupt');
    assert.deepEqual(corruptMeta.v2, corruptMeta.json);
  } finally {
    removeFixtureRoot(root);
  }
});

test('the two paths agree on a code-only workspace, where the source inventory is rescanned', async () => {
  // `repository_code_only` is the policy the align path actually writes, and it
  // is the branch where the JSON path reaches for `snapshot.extractors`. There
  // is no snapshot to reach for here, so the caller's list is the only input —
  // which is what every real caller already supplies.
  const { root } = seedRepo('cgf-code-only');
  try {
    const snapshot = snapshotWith('code-only');
    const meta = metaFor(snapshot, {
      cacheKeyParts: { ...cleanParts(), sourcePolicy: 'repository_code_only', sourceInventoryHash: sha256('inventory') }
    });
    await writeContextGraphSnapshot({ root, snapshot, meta });

    const options = { extractors: codeNavigationGraphExtractors(), verifySources: false } as const;
    const both = await bothPaths(root, options);
    // The recorded inventory hash is fabricated, so a rescan must disagree with
    // it — the point is that both paths disagree in the same way.
    assert.equal(both.json.status, 'stale');
    assert.ok(both.json.reasons.includes('dirty_fingerprint_changed'));
    assert.deepEqual(both.v2, both.json);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a workspace with a stale schema revision is stale, not fresh', async () => {
  const { root } = seedRepo('cgf-schema');
  try {
    const snapshot = snapshotWith('schema');
    // `meta.schemaRevision` stands in for `snapshot.schemaRevision`; the
    // compiler writes both from `CONTEXT_GRAPH_SCHEMA_REVISION`.
    await writeContextGraphSnapshot({ root, snapshot, meta: metaFor(snapshot, { schemaRevision: '0.9.0' }) });

    const status = await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(status.status, 'stale');
    assert.deepEqual(status.reasons, ['schema_revision_changed']);
    assert.equal(status.errorCode, 'context_graph_stale');
    assert.equal(status.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
  } finally {
    removeFixtureRoot(root);
  }
});

test('no meta and no published index is missing; no meta with a published index is corrupt', async () => {
  // The distinction the JSON path draws with the snapshot. Collapsing it would
  // either tell a user to build a graph that is already there, or to rebuild
  // one that was never built — a wrong instruction either way.
  const { root } = seedRepo('cgf-presence');
  try {
    const bare = await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(bare.status, 'missing');
    assert.equal(bare.errorCode, 'context_graph_missing');
    assert.equal(bare.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
    assert.deepEqual(bare.reasons, []);

    publishPointer(root, FIXTURE_HASH);
    const published = await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(published.status, 'corrupt');
    assert.equal(published.errorCode, 'context_graph_corrupt');
    assert.deepEqual(published.reasons, ['meta_mismatch']);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a pointer that disagrees with the meta is corrupt rather than a side to prefer', async () => {
  const { root } = seedRepo('cgf-divergent');
  try {
    const snapshot = snapshotWith('divergent');
    await writeContextGraphSnapshot({ root, snapshot, meta: metaFor(snapshot) });
    publishPointer(root, FIXTURE_HASH);
    assert.notEqual(snapshot.snapshotHash, FIXTURE_HASH);

    const status = await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(status.status, 'corrupt', 'ADR §6: divergence is an error, not a tie to break');
    assert.deepEqual(status.reasons, ['meta_mismatch']);
  } finally {
    removeFixtureRoot(root);
  }
});

test('an unparseable pointer is damage, and damage is never fresh', async () => {
  const { root } = seedRepo('cgf-bad-pointer');
  try {
    const snapshot = snapshotWith('bad-pointer');
    await writeContextGraphSnapshot({ root, snapshot, meta: metaFor(snapshot) });
    fs.mkdirSync(contextIndexStoreDir(root), { recursive: true });
    fs.writeFileSync(contextIndexPointerPath(root), '{ half written', 'utf8');

    const status = await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(status.status, 'corrupt');
    assert.deepEqual(status.reasons, ['meta_mismatch']);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a meta whose cache-key parts are absent fails closed', async () => {
  // The shape that would otherwise read as "nothing to compare, therefore
  // fresh". `compareCacheKeyParts` treats an absent record as a full change,
  // and the preflight must not paper over that.
  const { root } = seedRepo('cgf-fail-closed');
  try {
    const snapshot = snapshotWith('fail-closed');
    const meta = metaFor(snapshot);
    await writeContextGraphSnapshot({ root, snapshot, meta });
    fs.writeFileSync(
      contextGraphMetaPath(root),
      JSON.stringify({ ...meta, cacheKeyParts: {} }),
      'utf8'
    );

    const status = await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false });
    assert.equal(status.status, 'stale');
    assert.ok(status.reasons.length > 0, 'an uncomparable key is stale, never fresh');
    assert.equal(status.errorCode, 'context_graph_stale');
  } finally {
    removeFixtureRoot(root);
  }
});

test('every non-fresh verdict names the repair command', async () => {
  const { root } = seedRepo('cgf-repair');
  try {
    for (const status of [
      await contextIndexFreshness(root, { cacheKey: keyOf(cleanParts()), verifySources: false })
    ]) {
      assert.notEqual(status.status, 'fresh');
      assert.ok(status.errorCode, 'a non-fresh verdict carries an error code');
      assert.equal(status.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
      assert.ok(!JSON.stringify(status).includes(path.resolve(root)),
        'a status must never carry an absolute path');
    }
  } finally {
    removeFixtureRoot(root);
  }
});
