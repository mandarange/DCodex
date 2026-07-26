import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphStatus
} from '../../contracts.js';
import { contextGraphSnapshotPath } from '../../paths.js';
import { writeContextGraphSnapshot } from '../../store/snapshot-store.js';
import {
  clearContextGraphSnapshotCache,
  contextGraphSnapshotCacheStats,
  queryContextGraph,
  contextGraphSearchMeta
} from '../index.js';
import {
  buildFixtureSnapshot,
  fixtureMeta,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureWorkspace
} from './query-fixtures.js';

function staleStatus(snapshotHash: string): ContextGraphStatus {
  return {
    schema: 'sks.context-graph-status.v1',
    status: 'stale',
    snapshotHash,
    generatedAt: null,
    reasons: ['head_changed'],
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    errorCode: CONTEXT_GRAPH_STALE_ERROR,
    nodeCount: 0,
    edgeCount: 0
  };
}

test('a missing graph returns an explicit error and never falls back to text search', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-missing');
  try {
    const result = await queryContextGraph({ root, query: 'runService' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(CONTEXT_GRAPH_MISSING_ERROR));
    assert.ok(result.errors.some((error) => error.includes(CONTEXT_GRAPH_REPAIR_COMMAND)));
    assert.equal(result.selectedNodes, 0);
    assert.equal(result.seedCount, 0, 'no lexical seeds are produced for an unusable graph');
    assert.equal(result.processSpawns, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a corrupt snapshot is reported as corrupt, not silently replaced', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-corrupt');
  try {
    await writeFixtureWorkspace(root, buildFixtureSnapshot());
    fs.writeFileSync(contextGraphSnapshotPath(root), '{ not json', 'utf8');
    const result = await queryContextGraph({ root, query: 'runService' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(CONTEXT_GRAPH_CORRUPT_ERROR));
    assert.equal(result.selectedNodes, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a stale preflight verdict blocks the answer and names the repair command', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-stale');
  try {
    const snapshot = buildFixtureSnapshot();
    await writeFixtureWorkspace(root, snapshot);
    const result = await queryContextGraph({ root, query: 'runService' }, { status: staleStatus(snapshot.snapshotHash) });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(CONTEXT_GRAPH_STALE_ERROR));
    assert.ok(result.errors.some((error) => error.includes(CONTEXT_GRAPH_REPAIR_COMMAND)));
    assert.equal(result.selectedNodes, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a minimal preflight verdict is enough to block the answer', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-minimal-verdict');
  try {
    await writeFixtureWorkspace(root, buildFixtureSnapshot());
    const result = await queryContextGraph({ root, query: 'runService' }, { status: { status: 'stale' } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(CONTEXT_GRAPH_STALE_ERROR));
  } finally {
    removeFixtureRoot(root);
  }
});

test('answering over a stale graph requires an explicit opt in and is labelled stale', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-allow-stale');
  try {
    const snapshot = buildFixtureSnapshot();
    await writeFixtureWorkspace(root, snapshot);
    const result = await queryContextGraph(
      { root, query: 'runService' },
      { status: staleStatus(snapshot.snapshotHash), allowStale: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.snapshotFreshness, 'stale');
    assert.ok(result.selectedNodes > 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a changed recorded source is detected without spawning a process', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-verify');
  try {
    const snapshot = buildFixtureSnapshot();
    fs.mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app', 'service.ts'), 'export const runService = () => 1;\n', 'utf8');
    const meta = { ...fixtureMeta(snapshot), inputHashes: { 'src/app/service.ts': 'not-the-current-hash' } };
    await writeContextGraphSnapshot({ root, snapshot, meta });
    const result = await queryContextGraph({ root, query: 'runService' }, { verifySources: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(CONTEXT_GRAPH_STALE_ERROR));
  } finally {
    removeFixtureRoot(root);
  }
});

test('an unverified freshness claim is warned about rather than implied', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-unverified');
  try {
    await writeFixtureWorkspace(root, buildFixtureSnapshot());
    const result = await queryContextGraph({ root, query: 'runService' });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => warning.includes('freshness was not verified')));
  } finally {
    removeFixtureRoot(root);
  }
});

test('repeated queries in one process reuse the cached snapshot', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-cache');
  try {
    await writeFixtureWorkspace(root, buildFixtureSnapshot());
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await queryContextGraph({ root, query: 'runService' });
      assert.equal(result.ok, true);
    }
    const stats = contextGraphSnapshotCacheStats();
    assert.equal(stats.hits, 9);
    assert.ok(stats.hitRate >= 0.9, `cache hit rate ${stats.hitRate} is at least 0.90`);
    assert.equal(stats.entries, 1);
  } finally {
    clearContextGraphSnapshotCache();
    removeFixtureRoot(root);
  }
});

test('the search meta projection carries only counts and the snapshot identity', async () => {
  clearContextGraphSnapshotCache();
  const root = makeFixtureRoot('cg-query-meta');
  try {
    const snapshot = buildFixtureSnapshot();
    await writeFixtureWorkspace(root, snapshot);
    const result = await queryContextGraph({ root, query: 'runService' });
    const meta = contextGraphSearchMeta(result);
    assert.equal(meta.snapshotHash, snapshot.snapshotHash);
    assert.equal(meta.provenanceCoverage, 1);
    assert.equal(meta.selectedNodes, result.selectedNodes);
    assert.ok(!JSON.stringify(meta).includes(root), 'no absolute workspace path leaks into the projection');
  } finally {
    clearContextGraphSnapshotCache();
    removeFixtureRoot(root);
  }
});

test('no query module can spawn a process', () => {
  const queryDir = fileURLToPath(new URL('../', import.meta.url));
  const modules = fs
    .readdirSync(queryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(queryDir, entry.name));
  assert.ok(modules.length >= 8, 'the query package was compiled');
  for (const module of modules) {
    const source = fs.readFileSync(module, 'utf8');
    assert.ok(!source.includes('child_process'), `${path.basename(module)} does not import child_process`);
    assert.ok(!source.includes('cache-key.js'), `${path.basename(module)} does not reach the git backed cache key`);
    assert.ok(!source.includes('graph-status.js'), `${path.basename(module)} does not reach the spawning status helper`);
  }
});
