/**
 * Affected verification, end to end through the CRK2 query facade.
 *
 * The sibling suite proves the selection logic against a reader handed in by the
 * caller. This one proves the half that suite cannot reach: the module resolves a
 * real workspace off disk through `openWorkspaceContextIndex`, and every way that
 * resolution can fail still returns the exact selector's gates under the status
 * the facade refused with.
 *
 * **No workspace here contains `context-graph.json`.** That is the point rather
 * than tidiness: the only graph on disk is a published binary generation, so a
 * module that went back to reading the JSON store would report `missing` on the
 * healthy case and fail the first test. A fixture that wrote both artifacts would
 * pass either way and prove nothing about which one was read.
 *
 * "Still returns the exact selector's gates" is the other half. A selector that
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
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphEdge,
  type ContextGraphNode,
  type ContextGraphSnapshot
} from '../../triwiki/context-graph/contracts.js';
import { buildContextGraphSnapshot } from '../../triwiki/context-graph/compiler/serialize.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../triwiki/context-graph/ids.js';
import {
  publishFixtureContextIndex,
  resetContextIndexCache
} from '../../triwiki/context-graph/query/__tests__/workspace-fixtures.js';
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

/** `salt` changes the node set, so two fixtures encode to genuinely different indexes. */
function snapshot(salt = ''): ContextGraphSnapshot {
  const nodes = [
    node(IDS.changed, 'file', 'changed.ts', CHANGED),
    node(IDS.dependent, 'file', 'dependent.ts', DEPENDENT),
    node(IDS.suite, 'test', 'changed.test.ts', SUITE),
    node(IDS.gate, 'gate', 'custom:thing', 'release-gates.v2.json'),
    ...(salt
      ? [node(contextGraphNodeId({ kind: 'file', path: `src/mod-z/${salt}.ts` }), 'file', `${salt}.ts`, `src/mod-z/${salt}.ts`)]
      : [])
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

type WorkspaceShape = 'full' | 'generation_missing' | 'corrupt_generation' | 'foreign_generation' | 'none';

const STORE = ['.sneakoscope', 'wiki', 'context-graph'] as const;

function pointerPath(root: string): string {
  return path.join(root, ...STORE, 'current.json');
}

function generationPath(root: string, snapshotHash: string): string {
  return path.join(root, ...STORE, 'generations', `${snapshotHash}.idx`);
}

/**
 * `foreign_generation` needs a second, genuinely different index. It is built in
 * its own root because the store refuses two different operations on one root —
 * correctly, since that is two compilers racing on one workspace.
 */
async function foreignIndexBytes(): Promise<Uint8Array> {
  const donor = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-affected-donor-'));
  try {
    const other = snapshot('donor');
    await publishFixtureContextIndex(donor, other);
    return await fsp.readFile(generationPath(donor, other.snapshotHash));
  } finally {
    await fsp.rm(donor, { recursive: true, force: true });
  }
}

async function workspace(shape: WorkspaceShape): Promise<string> {
  resetContextIndexCache();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-affected-facade-'));
  if (shape === 'none') return root;
  const stored = snapshot();
  await publishFixtureContextIndex(root, stored);
  const generation = generationPath(root, stored.snapshotHash);

  if (shape === 'generation_missing') await fsp.rm(generation);
  if (shape === 'corrupt_generation') {
    // Same byte length, so the store's cheap size check passes it through and the
    // reader is the one that refuses: a checksum failure, not a truncation.
    const bytes = await fsp.readFile(generation);
    bytes.fill(0xff, Math.floor(bytes.byteLength / 2), Math.floor(bytes.byteLength / 2) + 64);
    await fsp.writeFile(generation, bytes);
  }
  if (shape === 'foreign_generation') {
    // An intact index that describes another tree: the pointer's snapshot hash and
    // the file's own header disagree. `indexBytes` is corrected so the store's size
    // check does not fire first and mask the state under test.
    const bytes = await foreignIndexBytes();
    await fsp.writeFile(generation, bytes);
    const pointer = JSON.parse(await fsp.readFile(pointerPath(root), 'utf8'));
    await fsp.writeFile(pointerPath(root), JSON.stringify({ ...pointer, indexBytes: bytes.byteLength }));
  }
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
  const root = await workspace('full');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.graph_status, 'fresh');
    assert.equal(result.graph_used, true);
    assert.equal(result.error_code, null);
    assert.notEqual(result.snapshot_hash, '');
    assert.equal(result.snapshot_hash, snapshot().snapshotHash, 'the answer names the generation it was read from');
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

test('a damaged generation fails closed as corrupt and keeps every exact gate', async () => {
  const root = await workspace('corrupt_generation');
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

test('a pointer whose generation vanished is missing, not a half-answer off the pointer alone', async () => {
  const root = await workspace('generation_missing');
  try {
    const result = await run(root, [CHANGED]);
    assert.equal(result.error_code, CONTEXT_GRAPH_MISSING_ERROR);
    assert.equal(result.graph_used, false);
    assertNeverFewer(result, [CHANGED]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an intact index describing another tree is stale, and stale is not corrupt', async () => {
  const root = await workspace('foreign_generation');
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
