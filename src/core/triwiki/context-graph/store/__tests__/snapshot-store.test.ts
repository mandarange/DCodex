import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import { CONTEXT_GRAPH_REPAIR_COMMAND, CONTEXT_GRAPH_META_SCHEMA, CONTEXT_GRAPH_SCHEMA_REVISION } from '../../contracts.js';
import type { ContextGraphMeta, ContextGraphSnapshot } from '../../contracts.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { compileContextGraph } from '../../compiler/index.js';
import {
  contextGraphEventLogPath,
  contextGraphMetaPath,
  contextGraphPrevSnapshotPath,
  contextGraphSnapshotPath
} from '../../paths.js';
import {
  readContextGraphMeta,
  readContextGraphSnapshot,
  writeContextGraphSnapshot
} from '../snapshot-store.js';
import { contextGraphStatus } from '../graph-status.js';
import { withContextGraphCompileLock } from '../compile-lock.js';
import { appendContextGraphEvent } from '../event-log.js';
import { fragmentCacheKey, pruneFragmentCache, readCachedFragment, writeCachedFragment } from '../fragment-cache.js';
import {
  FIXED_OBSERVED_AT,
  commitFixtureChanges,
  commitFixturePaths,
  fileGraphExtractor,
  fileNode,
  fragmentOf,
  gitAvailable,
  initGitRepo,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureFile
} from '../../compiler/__tests__/graph-test-fixtures.js';

const FILES = ['src/a.ts', 'src/b.ts'];

function seedRepo(prefix: string): string {
  const root = makeFixtureRoot(prefix);
  writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
  writeFixtureFile(root, 'src/b.ts', "import { A } from './a.js';\nexport const B = A;\n");
  return root;
}

function snapshotWith(label: string): ContextGraphSnapshot {
  return buildContextGraphSnapshot({
    nodes: [fileNode('src/a.ts', sha256(label))],
    edges: [],
    cycles: [],
    extractors: []
  });
}

function metaFor(snapshot: ContextGraphSnapshot): ContextGraphMeta {
  return {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: snapshot.snapshotHash,
    previousSnapshotHash: null,
    generatedAt: FIXED_OBSERVED_AT,
    cacheKey: sha256('cache-key'),
    cacheKeyParts: {
      workspaceIdentity: sha256('workspace'),
      head: null,
      gitState: 'unknown',
      trackedDirtyFingerprint: 'unknown',
      untrackedFingerprint: 'unknown',
      schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
      tsconfigHash: sha256('tsconfig'),
      commandManifestHash: sha256('commands'),
      gateManifestHash: sha256('gates'),
      proofIndexHash: sha256('proofs'),
      wikiContextHash: sha256('wiki')
    },
    inputHashes: {},
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    lint: { ok: true, errors: 0, warnings: 0 },
    skipped: [],
    durationMs: 1
  };
}

test('a corrupt current snapshot refuses, and no previous generation exists to resolve to', async () => {
  const root = seedRepo('cgs-corrupt');
  try {
    const good = snapshotWith('previous');
    await writeContextGraphSnapshot({ root, snapshot: good, meta: metaFor(good) });
    const next = snapshotWith('current');
    await writeContextGraphSnapshot({ root, snapshot: next, meta: metaFor(next) });
    fs.writeFileSync(contextGraphSnapshotPath(root), '{ this is not json', 'utf8');

    const load = await readContextGraphSnapshot(root);
    assert.equal(load.status, 'corrupt');
    assert.equal(load.snapshot, null, 'a corrupt current snapshot must not silently resolve to prev');
    assert.equal(load.errorCode, 'context_graph_corrupt');
    assert.ok(load.blocker?.includes(CONTEXT_GRAPH_REPAIR_COMMAND), load.blocker ?? '');
    assert.ok(!load.blocker?.includes(root), 'a blocker must never contain an absolute path');

    // The refusal is structural, not a policy the store chooses to apply: after two
    // commits there is no second generation on disk for any caller to reach for.
    assert.equal(
      fs.existsSync(contextGraphPrevSnapshotPath(root)),
      false,
      'committing must not leave a previous generation behind'
    );

    const status = await contextGraphStatus(root, { verifySources: false });
    assert.equal(status.status, 'corrupt');
    assert.equal(status.errorCode, 'context_graph_corrupt');
    assert.equal(status.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a crash before the rename leaves the existing snapshot byte-intact', async () => {
  const root = seedRepo('cgs-crash');
  try {
    const snapshot = snapshotWith('committed');
    await writeContextGraphSnapshot({ root, snapshot, meta: metaFor(snapshot) });
    const committed = fs.readFileSync(contextGraphSnapshotPath(root), 'utf8');

    // What a process killed mid-write leaves behind: a temp file that was never renamed.
    const orphan = `${contextGraphSnapshotPath(root)}.${process.pid}.deadbeef.tmp`;
    fs.writeFileSync(orphan, '{"schema":"sks.context-graph.v1","nodes":[', 'utf8');

    const load = await readContextGraphSnapshot(root);
    assert.equal(load.status, 'ok');
    assert.equal(load.snapshot?.snapshotHash, snapshot.snapshotHash);
    assert.equal(fs.readFileSync(contextGraphSnapshotPath(root), 'utf8'), committed);
  } finally {
    removeFixtureRoot(root);
  }
});

test('no previous generation is retained, but its hash still is', async () => {
  const root = seedRepo('cgs-prev');
  try {
    const first = snapshotWith('v1');
    const second = snapshotWith('v2');
    const third = snapshotWith('v3');
    await writeContextGraphSnapshot({ root, snapshot: first, meta: metaFor(first) });
    await writeContextGraphSnapshot({ root, snapshot: second, meta: metaFor(second) });
    const result = await writeContextGraphSnapshot({ root, snapshot: third, meta: metaFor(third) });

    // A hash is everything any consumer ever wanted from the previous generation;
    // the 63 MB second copy that used to carry it had no reader at all.
    assert.equal(result.previousSnapshotHash, second.snapshotHash);
    assert.equal(result.reclaimedRetiredPrevious, false, 'a clean workspace has nothing to reclaim');
    assert.equal((await readContextGraphSnapshot(root)).snapshot?.snapshotHash, third.snapshotHash);
    const entries = fs.readdirSync(path.dirname(contextGraphSnapshotPath(root)));
    assert.equal(
      entries.filter((name) => name.startsWith('context-graph.prev')).length,
      0,
      `no prev artifact may be written: ${entries.join(',')}`
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test('a retired prev snapshot left by an older build is reclaimed by the next commit', async () => {
  const root = seedRepo('cgs-prev-reclaim');
  try {
    const first = snapshotWith('v1');
    await writeContextGraphSnapshot({ root, snapshot: first, meta: metaFor(first) });

    // What an older build left behind: a byte-identical duplicate of the snapshot.
    const retired = contextGraphPrevSnapshotPath(root);
    const committed = fs.readFileSync(contextGraphSnapshotPath(root), 'utf8');
    fs.writeFileSync(retired, committed, 'utf8');
    assert.equal(fs.existsSync(retired), true);

    const second = snapshotWith('v2');
    const result = await writeContextGraphSnapshot({ root, snapshot: second, meta: metaFor(second) });

    assert.equal(result.reclaimedRetiredPrevious, true, 'the duplicate must be reclaimed, not left to rot');
    assert.equal(fs.existsSync(retired), false);
    // Reclaiming disk must never cost the commit: the new generation is intact and
    // still names the one it replaced.
    assert.equal(result.previousSnapshotHash, first.snapshotHash);
    assert.equal((await readContextGraphSnapshot(root)).snapshot?.snapshotHash, second.snapshotHash);
    assert.equal((await readContextGraphMeta(root)).status, 'ok');
  } finally {
    removeFixtureRoot(root);
  }
});

test('a snapshot without its meta reports corrupt rather than fresh', async () => {
  const root = seedRepo('cgs-meta');
  try {
    const snapshot = snapshotWith('lonely');
    await writeContextGraphSnapshot({ root, snapshot, meta: metaFor(snapshot) });
    fs.rmSync(contextGraphMetaPath(root));

    assert.equal((await readContextGraphMeta(root)).status, 'missing');
    const status = await contextGraphStatus(root, { verifySources: false });
    assert.equal(status.status, 'corrupt');
    assert.deepEqual(status.reasons, ['meta_mismatch']);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a missing snapshot reports missing with the repair command', async () => {
  const root = seedRepo('cgs-missing');
  try {
    const status = await contextGraphStatus(root, { verifySources: false });
    assert.equal(status.status, 'missing');
    assert.equal(status.errorCode, 'context_graph_missing');
    assert.equal(status.snapshotHash, null);
    assert.deepEqual(status.reasons, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test('an unknown git state keeps the stored graph stale, never fresh', async () => {
  const root = seedRepo('cgs-status-unknown');
  try {
    const extractors = [fileGraphExtractor('code', '1.0.0', FILES)];
    const compiled = await compileContextGraph({ root, extractors, observedAt: FIXED_OBSERVED_AT });
    assert.equal(compiled.ok, true, compiled.blockers.join(','));

    const status = await contextGraphStatus(root, { extractors });
    assert.equal(status.status, 'stale');
    assert.equal(status.errorCode, 'context_graph_stale');
    assert.ok(status.reasons.includes('git_state_unknown'), status.reasons.join(','));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a committed git tree yields a fresh status, and editing a tracked file makes it stale', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is required to establish a known git state');
    return;
  }
  const root = seedRepo('cgs-status-fresh');
  initGitRepo(root);
  try {
    const extractors = [fileGraphExtractor('code', '1.0.0', FILES)];
    const compiled = await compileContextGraph({ root, extractors, observedAt: FIXED_OBSERVED_AT });
    assert.equal(compiled.ok, true, compiled.blockers.join(','));

    const fresh = await contextGraphStatus(root, { extractors });
    assert.equal(fresh.status, 'fresh', `expected fresh, got ${fresh.status} (${fresh.reasons.join(',')})`);
    assert.equal(fresh.errorCode, null);
    assert.equal(fresh.snapshotHash, compiled.snapshotHash);

    writeFixtureFile(root, 'src/a.ts', 'export const A = 2;\n');
    const stale = await contextGraphStatus(root, { extractors });
    assert.equal(stale.status, 'stale');
    assert.ok(stale.reasons.length > 0);
    assert.ok(
      stale.reasons.includes('dirty_fingerprint_changed') || stale.reasons.includes('source_hash_mismatch'),
      stale.reasons.join(',')
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test('a code-pack-only commit preserves graph freshness, but a later source commit does not', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is required to prove metadata-only ancestry');
    return;
  }
  const root = seedRepo('cgs-status-code-pack-metadata');
  initGitRepo(root);
  try {
    const extractors = [fileGraphExtractor('code', '1.0.0', FILES)];
    const compiled = await compileContextGraph({ root, extractors, observedAt: FIXED_OBSERVED_AT });
    assert.equal(compiled.ok, true, compiled.blockers.join(','));

    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.json', '{"schema":"sks.code-pack.v1"}\n');
    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.prev.json', '{"schema":"sks.code-pack.v1"}\n');
    commitFixturePaths(
      root,
      ['.sneakoscope/wiki/code-pack.json', '.sneakoscope/wiki/code-pack.prev.json'],
      'refresh code pack'
    );

    const metadataOnly = await contextGraphStatus(root, { extractors });
    assert.equal(
      metadataOnly.status,
      'fresh',
      `metadata-only history must stay fresh: ${metadataOnly.reasons.join(',')}`
    );

    writeFixtureFile(root, 'src/a.ts', 'export const A = 2;\n');
    commitFixtureChanges(root, 'change source');

    const sourceChanged = await contextGraphStatus(root, { extractors });
    assert.equal(sourceChanged.status, 'stale');
    assert.ok(sourceChanged.reasons.includes('head_changed'), sourceChanged.reasons.join(','));
    assert.ok(sourceChanged.reasons.includes('source_hash_mismatch'), sourceChanged.reasons.join(','));
  } finally {
    removeFixtureRoot(root);
  }
});

test('two concurrent lock holders: only one runs the critical section', async () => {
  const root = seedRepo('cgs-lock');
  try {
    let entered = 0;
    const body = async (): Promise<number> => {
      entered += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return entered;
    };
    const [left, right] = await Promise.all([
      withContextGraphCompileLock(root, body),
      withContextGraphCompileLock(root, body)
    ]);
    const acquired = [left, right].filter((outcome) => outcome.acquired);
    assert.equal(acquired.length, 1);
    assert.equal(entered, 1);
    const rejected = [left, right].find((outcome) => !outcome.acquired);
    assert.ok(rejected && rejected.acquired === false);
  } finally {
    removeFixtureRoot(root);
  }
});

test('the fragment cache round-trips by content hash and rejects a foreign extractor', async () => {
  const root = seedRepo('cgs-fragments');
  try {
    const key = fragmentCacheKey({
      extractorId: 'code',
      extractorRevision: '1.0.0',
      cacheKey: sha256('key'),
      changedPaths: null
    });
    const fragment = fragmentOf('code', '1.0.0', { nodes: [fileNode('src/a.ts', sha256('a'))] });
    await writeCachedFragment(root, key, fragment);

    const round = await readCachedFragment(root, key, 'code');
    assert.equal(round?.extractor, 'code');
    assert.equal(round?.nodes.length, 1);
    assert.equal(await readCachedFragment(root, key, 'topology'), null);
    assert.equal(await readCachedFragment(root, sha256('other'), 'code'), null);
    assert.equal(await pruneFragmentCache(root, 1), 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('the event log is append-only and carries only codes, counts and hashes', async () => {
  const root = seedRepo('cgs-events');
  try {
    await appendContextGraphEvent(root, {
      type: 'compile.committed',
      at: FIXED_OBSERVED_AT,
      snapshotHash: sha256('snapshot'),
      nodeCount: 2,
      edgeCount: 1,
      reason: 'ok'
    });
    await appendContextGraphEvent(root, { type: 'compile.blocked', at: FIXED_OBSERVED_AT, reason: 'dangling_edge' });

    const rows = fs
      .readFileSync(contextGraphEventLogPath(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.schema, 'sks.context-graph-event.v1');
    assert.equal(rows[1]?.reason, 'dangling_edge');
    assert.ok(!fs.readFileSync(contextGraphEventLogPath(root), 'utf8').includes(root));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a rewritten snapshot that no longer matches its meta reports corrupt', async () => {
  const root = seedRepo('cgs-mismatch');
  try {
    const snapshot = snapshotWith('one');
    await writeContextGraphSnapshot({ root, snapshot, meta: metaFor(snapshot) });
    const other = snapshotWith('two');
    fs.writeFileSync(contextGraphSnapshotPath(root), `${JSON.stringify(other, null, 2)}\n`, 'utf8');

    const status = await contextGraphStatus(root, { verifySources: false });
    assert.equal(status.status, 'corrupt');
    assert.deepEqual(status.reasons, ['meta_mismatch']);
    assert.ok(fs.existsSync(contextGraphPrevSnapshotPath(root)) === false);
  } finally {
    removeFixtureRoot(root);
  }
});
