/**
 * Affected verification, end to end through the query facade.
 *
 * The sibling suite proves the selection logic against an index handed in by the
 * caller. This one proves the half that suite cannot reach: the module resolves a
 * real workspace off disk through `query/index.js` and never through the snapshot
 * store, and every way that resolution can fail still returns the exact
 * selector's gates under the public code the facade refused with.
 *
 * "Still returns the exact selector's gates" is the whole point. A selector that
 * quietly returns fewer gates when the index is broken looks like a fast run right
 * up until the release that needed the missing gate, so each failure case asserts
 * the floor rather than only the error code.
 *
 * Every workspace here is an `fsp.mkdtemp` directory under `os.tmpdir()`, removed
 * in `finally`; nothing reads or writes the real repo.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphEdge,
  type ContextGraphNode,
  type ContextGraphSnapshot
} from '../../triwiki/context-graph/contracts.js';
import { buildContextGraphSnapshot } from '../../triwiki/context-graph/compiler/serialize.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../triwiki/context-graph/ids.js';
import { clearContextGraphSnapshotCache } from '../../triwiki/context-graph/query/index.js';
import { buildGateEntry, selectGates, type GateManifestEntry } from '../../release/gate-manifest.js';
import {
  contextGraphAffectedVerification,
  missingContextGraphBaselineGates,
  type ContextGraphAffectedResult
} from '../context-graph-affected.js';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';
const CHANGED = 'src/mod-x/changed.ts';
const DEPENDENT = 'src/mod-x/dependent.ts';
const SUITE = 'src/mod-x/__tests__/changed.test.ts';

const IDS = {
  changed: contextGraphNodeId({ kind: 'file', path: CHANGED }),
  dependent: contextGraphNodeId({ kind: 'file', path: DEPENDENT }),
  suite: contextGraphNodeId({ kind: 'test', path: SUITE }),
  gate: contextGraphNodeId({ kind: 'gate', gateId: 'custom:thing' })
} as const;

/** One always-on release gate plus a gate no glob in the manifest can reach. */
const GATES: GateManifestEntry[] = [buildGateEntry('release:metadata-current'), buildGateEntry('custom:thing')];

function node(id: string, kind: 'file' | 'test' | 'gate', label: string, nodePath: string): ContextGraphNode {
  return {
    id,
    kind,
    label,
    path: nodePath,
    contentHash: `sha-${nodePath}`,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 30,
    metadata: {}
  };
}

function edge(from: string, to: string, type: 'imports' | 'tests' | 'affected_by', provenancePath: string): ContextGraphEdge {
  return {
    id: contextGraphEdgeId({ from, to, type }),
    from,
    to,
    type,
    confidence: 'manifest',
    provenance: { path: provenancePath, line: 1, hash: `sha-${provenancePath}`, extractor: 'affected-facade-fixture' },
    observedAt: OBSERVED_AT
  };
}

function snapshot(): ContextGraphSnapshot {
  const nodes = [
    node(IDS.changed, 'file', 'changed.ts', CHANGED),
    node(IDS.dependent, 'file', 'dependent.ts', DEPENDENT),
    node(IDS.suite, 'test', 'changed.test.ts', SUITE),
    node(IDS.gate, 'gate', 'custom:thing', 'release-gates.v2.json')
  ];
  const edges = [
    edge(IDS.dependent, IDS.changed, 'imports', DEPENDENT),
    edge(IDS.suite, IDS.changed, 'tests', SUITE),
    // Reachable only through the dependent — exactly what a glob selector misses.
    edge(IDS.gate, IDS.dependent, 'affected_by', 'release-gates.v2.json')
  ];
  return buildContextGraphSnapshot({
    nodes,
    edges,
    cycles: [],
    extractors: [{ id: 'affected-facade-fixture', revision: '1.0.0', nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0, skippedCount: 0 }]
  });
}

function metaFor(stored: ContextGraphSnapshot) {
  return {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: stored.snapshotHash,
    previousSnapshotHash: null,
    generatedAt: OBSERVED_AT,
    cacheKey: `cache-${stored.snapshotHash}`,
    cacheKeyParts: { sourcePolicy: 'workspace' },
    inputHashes: {},
    nodeCount: stored.nodeCount,
    edgeCount: stored.edgeCount,
    lint: { ok: true, errors: 0, warnings: 0 },
    skipped: [],
    durationMs: 1
  };
}

async function workspace(write: 'full' | 'meta_only' | 'corrupt_snapshot' | 'stale_revision' | 'none'): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-affected-facade-'));
  if (write === 'none') return root;
  const wiki = path.join(root, '.sneakoscope', 'wiki');
  await fsp.mkdir(wiki, { recursive: true });
  const stored = snapshot();
  await fsp.writeFile(path.join(wiki, 'context-graph.meta.json'), JSON.stringify(metaFor(stored)));
  if (write === 'meta_only') return root;
  const body = write === 'stale_revision' ? { ...stored, schemaRevision: '0.9.0' } : stored;
  await fsp.writeFile(
    path.join(wiki, 'context-graph.json'),
    write === 'corrupt_snapshot' ? '{"snapshotHash": ' : JSON.stringify(body)
  );
  return root;
}

function exactIds(changedFiles: string[]): string[] {
  return selectGates([...GATES], changedFiles, {}).selected.map((entry) => entry.id).sort();
}

function run(root: string, changedFiles: string[]): Promise<ContextGraphAffectedResult> {
  return contextGraphAffectedVerification({ root, changedFiles, gates: GATES, baselineGateIds: exactIds(changedFiles) });
}

/** The floor, restated as an assertion: nothing the exact selector chose may be missing. */
function assertNeverFewer(result: ContextGraphAffectedResult, changedFiles: string[]): void {
  for (const id of exactIds(changedFiles)) {
    assert.equal(result.gates.includes(id), true, `exact gate ${id} was dropped from the affected selection`);
  }
  assert.deepEqual(result.dropped_baseline_gates, []);
  assert.deepEqual(missingContextGraphBaselineGates(result.baseline_gates, result.gates), []);
  assert.equal(result.process_spawns, 0);
  assert.equal(result.repair_command, CONTEXT_GRAPH_REPAIR_COMMAND);
}

test('a workspace resolved through the facade widens the exact selection and recommends its suites', async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('full');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.graph_status, 'fresh');
    assert.equal(result.graph_used, true);
    assert.equal(result.error_code, null);
    assert.notEqual(result.snapshot_hash, '');
    assertNeverFewer(result, [CHANGED]);
    // The gate hangs off the dependent, two reverse hops from the changed file:
    // reach no glob expresses, which is the only reason this module exists.
    assert.equal(result.added_gates.includes('custom:thing'), true);
    assert.deepEqual(result.recommended_tests.map((row) => row.path), [SUITE]);
    assert.equal((result.recommended_tests[0]?.provenance.length ?? 0) > 0, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a second call reuses the facade cache and answers identically', async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('full');
  try {
    const first = await run(root, [CHANGED]);
    const second = await run(root, [CHANGED]);
    assert.deepEqual(second.gates, first.gates);
    assert.deepEqual(second.recommended_tests.map((row) => row.path), first.recommended_tests.map((row) => row.path));
    assert.equal(second.snapshot_hash, first.snapshot_hash);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an absent index fails closed as missing and keeps every exact gate', async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('none');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.ok, false);
    assert.equal(result.graph_status, 'missing');
    assert.equal(result.graph_used, false);
    assert.equal(result.error_code, CONTEXT_GRAPH_MISSING_ERROR);
    assert.equal(result.errors[0], CONTEXT_GRAPH_MISSING_ERROR);
    assert.equal(result.conservative_reasons.includes(CONTEXT_GRAPH_MISSING_ERROR), true);
    assert.deepEqual(result.recommended_tests, []);
    assertNeverFewer(result, [CHANGED]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an unparseable snapshot fails closed as corrupt and keeps every exact gate', async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('corrupt_snapshot');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.ok, false);
    assert.equal(result.graph_status, 'corrupt');
    assert.equal(result.error_code, CONTEXT_GRAPH_CORRUPT_ERROR);
    assert.equal(result.errors.includes(`Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to rebuild the context graph.`), true);
    assertNeverFewer(result, [CHANGED]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('metadata without its snapshot is missing, not a half-answer off the metadata alone', async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('meta_only');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.error_code, CONTEXT_GRAPH_MISSING_ERROR);
    assert.equal(result.graph_used, false);
    assertNeverFewer(result, [CHANGED]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a snapshot from another schema revision is stale, and stale is not corrupt', async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('stale_revision');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.graph_status, 'stale');
    assert.equal(result.error_code, CONTEXT_GRAPH_STALE_ERROR);
    assert.equal(result.graph_used, false);
    assertNeverFewer(result, [CHANGED]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a caller's stale preflight verdict is honoured without touching the index", async () => {
  clearContextGraphSnapshotCache();
  const root = await workspace('full');
  try {
    const result = await contextGraphAffectedVerification({
      root,
      changedFiles: [CHANGED],
      gates: GATES,
      baselineGateIds: exactIds([CHANGED]),
      graphStatus: 'stale'
    });
    assert.equal(result.graph_status, 'stale');
    assert.equal(result.error_code, CONTEXT_GRAPH_STALE_ERROR);
    // A supplied verdict is a verified one, so the module must not also report
    // that freshness went unverified.
    assert.equal(result.conservative_reasons.includes('graph_freshness_not_verified'), false);
    assertNeverFewer(result, [CHANGED]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
