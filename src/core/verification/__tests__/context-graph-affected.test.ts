/**
 * Affected-verification tests.
 *
 * The load-bearing property is the floor: whatever the exact changed-file
 * selector chose has to survive, on a fresh graph and on a broken one alike. The
 * fixture graph is built through the real serializer and index builder, and the
 * only workspace touched is an `fs.mkdtempSync` directory under `os.tmpdir()`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  ContextGraphEdge,
  ContextGraphEdgeType,
  ContextGraphMetadata,
  ContextGraphNode,
  ContextGraphRisk
} from '../../triwiki/context-graph/contracts.js';
import { buildContextGraphSnapshot } from '../../triwiki/context-graph/compiler/serialize.js';
import { buildContextGraphIndex, type ContextGraphIndex } from '../../triwiki/context-graph/graph-index.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../triwiki/context-graph/ids.js';
import { buildGateEntry, selectGates, type GateManifestEntry } from '../../release/gate-manifest.js';
import {
  contextGraphAffectedVerification,
  contextGraphAffectedVerificationFromIndex,
  missingContextGraphBaselineGates,
  type ContextGraphAffectedResult
} from '../context-graph-affected.js';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

const PATHS = {
  changed: 'src/mod-x/changed.ts',
  dependent: 'src/mod-x/dependent.ts',
  unrelated: 'src/mod-y/unrelated.ts',
  suite: 'src/mod-x/__tests__/changed.test.ts'
} as const;

const IDS = {
  changed: contextGraphNodeId({ kind: 'file', path: PATHS.changed }),
  dependent: contextGraphNodeId({ kind: 'file', path: PATHS.dependent }),
  unrelated: contextGraphNodeId({ kind: 'file', path: PATHS.unrelated }),
  suiteFile: contextGraphNodeId({ kind: 'file', path: PATHS.suite }),
  suite: contextGraphNodeId({ kind: 'test', path: PATHS.suite }),
  gateCustom: contextGraphNodeId({ kind: 'gate', gateId: 'custom:thing' }),
  gateSecurity: contextGraphNodeId({ kind: 'gate', gateId: 'security:secret-scan' }),
  gateLint: contextGraphNodeId({ kind: 'gate', gateId: 'lint:fast' })
} as const;

/** Gate universe: one always-on release gate plus gates whose globs never match the changed file. */
const GATES: GateManifestEntry[] = [
  buildGateEntry('release:metadata'),
  buildGateEntry('custom:thing'),
  buildGateEntry('security:secret-scan'),
  buildGateEntry('lint:fast')
];

function fileNode(id: string, filePath: string, metadata: ContextGraphMetadata = {}): ContextGraphNode {
  return {
    id,
    kind: 'file',
    label: path.posix.basename(filePath),
    path: filePath,
    contentHash: `sha-${filePath}`,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 40,
    metadata
  };
}

function gateNode(id: string, label: string, risk: ContextGraphRisk, metadata: ContextGraphMetadata): ContextGraphNode {
  return {
    id,
    kind: 'gate',
    label,
    path: 'release-gates.v2.json',
    contentHash: 'sha-gates',
    trust: 0.95,
    freshness: 'fresh',
    risk,
    tokenCost: 20,
    metadata
  };
}

function edge(from: string, to: string, type: ContextGraphEdgeType, provenancePath: string, line: number): ContextGraphEdge {
  return {
    id: contextGraphEdgeId({ from, to, type }),
    from,
    to,
    type,
    confidence: 'manifest',
    provenance: { path: provenancePath, line, hash: `sha-${provenancePath}`, extractor: 'affected-fixture' },
    observedAt: OBSERVED_AT
  };
}

function fixtureIndex(): ContextGraphIndex {
  const nodes: ContextGraphNode[] = [
    fileNode(IDS.changed, PATHS.changed),
    fileNode(IDS.dependent, PATHS.dependent),
    fileNode(IDS.unrelated, PATHS.unrelated),
    fileNode(IDS.suiteFile, PATHS.suite, { isTest: true }),
    {
      id: IDS.suite,
      kind: 'test',
      label: 'changed.test.ts',
      path: PATHS.suite,
      contentHash: `sha-${PATHS.suite}`,
      trust: 1,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 30,
      metadata: { suite: 'file' }
    },
    gateNode(IDS.gateCustom, 'custom:thing', 'high', { namespace: 'custom' }),
    gateNode(IDS.gateSecurity, 'security:secret-scan', 'protected', { namespace: 'security', requiredForPublish: true }),
    gateNode(IDS.gateLint, 'lint:fast', 'medium', { namespace: 'lint' })
  ];
  const edges: ContextGraphEdge[] = [
    edge(IDS.dependent, IDS.changed, 'imports', PATHS.dependent, 1),
    edge(IDS.suite, IDS.changed, 'tests', PATHS.suite, 2),
    edge(IDS.suiteFile, IDS.suite, 'contains', PATHS.suite, 1),
    // Reachable only through the dependent, which is exactly what a glob selector misses.
    edge(IDS.gateCustom, IDS.dependent, 'affected_by', 'release-gates.v2.json', 21),
    edge(IDS.gateSecurity, IDS.changed, 'affected_by', 'release-gates.v2.json', 22),
    edge(IDS.gateLint, IDS.unrelated, 'affected_by', 'release-gates.v2.json', 23)
  ];
  return buildContextGraphIndex(
    buildContextGraphSnapshot({
      nodes,
      edges,
      cycles: [],
      extractors: [{ id: 'affected-fixture', revision: '1.0.0', nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0, skippedCount: 0 }]
    })
  );
}

function baselineIds(changedFiles: string[], publish = false): string[] {
  return selectGates([...GATES], changedFiles, publish ? { publish: true } : {})
    .selected.map((entry) => entry.id)
    .sort();
}

function run(changedFiles: string[], graphStatus: 'fresh' | 'stale' = 'fresh'): ContextGraphAffectedResult {
  return contextGraphAffectedVerificationFromIndex(fixtureIndex(), {
    root: '/workspace-not-read',
    changedFiles,
    gates: GATES,
    graphStatus
  });
}

function assertNeverFewer(result: ContextGraphAffectedResult): void {
  assert.deepEqual(result.dropped_baseline_gates, [], 'the exact selector is a floor, never a ceiling');
  assert.deepEqual(missingContextGraphBaselineGates(result.baseline_gates, result.gates), []);
  for (const id of result.baseline_gates) assert.ok(result.gates.includes(id), `baseline gate ${id} survived`);
  assert.ok(result.gates.length >= result.baseline_gates.length);
}

test('the graph only ever adds to the exact changed-file selection', () => {
  const result = run([PATHS.changed]);

  assert.deepEqual(result.baseline_gates, baselineIds([PATHS.changed]));
  assertNeverFewer(result);
  assert.ok(result.gates.length > result.baseline_gates.length, 'the graph found reach the globs missed');
  assert.deepEqual(result.gates, [...new Set([...result.baseline_gates, ...result.added_gates])].sort());
});

test('a gate reachable only through a dependent file is added with its reason path', () => {
  const result = run([PATHS.changed]);

  assert.ok(result.added_gates.includes('custom:thing'), 'the transitively affected gate is added');
  assert.ok(!baselineIds([PATHS.changed]).includes('custom:thing'), 'the glob selector really did miss it');
  const detail = result.gate_details.find((row) => row.gate_id === 'custom:thing');
  assert.ok(detail);
  assert.equal(detail.source, 'context_graph');
  assert.deepEqual(detail.reason_path, [IDS.changed, '<-imports', IDS.dependent, '<-affected_by', IDS.gateCustom]);
  assert.equal(detail.explanation.length, 2);
  assert.equal(detail.provenance.at(-1)?.path, 'release-gates.v2.json');
  assert.ok(!result.gates.includes('lint:fast'), 'a gate with no path to the change is not invented');
});

test('protected release and security gates are always in the result', () => {
  const result = run([PATHS.unrelated]);

  assert.ok(result.gates.includes('release:metadata'), 'an always-on release gate never falls out');
  assert.ok(result.protected_gates.includes('release:metadata'));
  const security = run([PATHS.changed]);
  assert.ok(security.gates.includes('security:secret-scan'));
  const detail = security.gate_details.find((row) => row.gate_id === 'security:secret-scan');
  assert.equal(detail?.protected, true);
});

test('affected tests are recommended with the hop chain that produced them', () => {
  const result = run([PATHS.changed]);

  const suite = result.recommended_tests.find((row) => row.path === PATHS.suite);
  assert.ok(suite, 'the suite that exercises the changed file is recommended');
  assert.deepEqual(suite.reason_path, [IDS.changed, '<-tests', IDS.suite]);
  assert.equal(suite.provenance[0]?.path, PATHS.suite);
  assert.ok(suite.provenance.every((row) => !row.path.startsWith('/')));
});

test('a stale graph keeps the exact selection and refuses to widen or shrink it', () => {
  const stale = run([PATHS.changed], 'stale');

  assert.equal(stale.ok, false);
  assert.equal(stale.graph_status, 'stale');
  assert.equal(stale.graph_used, false);
  assert.equal(stale.error_code, 'context_graph_stale');
  assert.equal(stale.repair_command, 'sks align run');
  assert.equal(stale.conservative, true);
  assert.ok(stale.conservative_reasons.includes('context_graph_stale'));
  assert.deepEqual(stale.added_gates, [], 'stale evidence never adds a gate');
  assert.deepEqual(stale.recommended_tests, []);
  assert.deepEqual(stale.gates, stale.baseline_gates);
  assert.ok(stale.errors.some((line) => line.includes('sks align run')));
  assertNeverFewer(stale);
});

test('a changed file the graph has never seen is reported, not silently ignored', () => {
  const result = run(['src/brand-new/file.ts']);

  assert.deepEqual(result.unresolved_changed_files, ['src/brand-new/file.ts']);
  assert.ok(result.conservative_reasons.includes('changed_file_not_in_graph'));
  assertNeverFewer(result);
});

test('publish keeps every publish-required gate and still adds graph reach', () => {
  const result = contextGraphAffectedVerificationFromIndex(fixtureIndex(), {
    root: '/workspace-not-read',
    changedFiles: [PATHS.changed],
    gates: GATES,
    publish: true,
    graphStatus: 'fresh'
  });

  assert.deepEqual(result.baseline_gates, baselineIds([PATHS.changed], true));
  assertNeverFewer(result);
  assert.ok(result.gates.includes('custom:thing'));
});

test('an upstream selector result is carried through untouched', () => {
  const result = contextGraphAffectedVerificationFromIndex(fixtureIndex(), {
    root: '/workspace-not-read',
    changedFiles: [PATHS.changed],
    gates: GATES,
    baselineGateIds: ['lint:fast'],
    graphStatus: 'fresh'
  });

  assert.ok(result.baseline_gates.includes('lint:fast'));
  assert.ok(result.gates.includes('lint:fast'), 'a gate the caller already committed to is never dropped');
  assertNeverFewer(result);
});

test('a workspace with no compiled graph still returns the exact selection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-affected-missing-'));
  try {
    const result = await contextGraphAffectedVerification({ root, changedFiles: [PATHS.changed], gates: GATES });
    assert.equal(result.ok, false);
    assert.equal(result.graph_status, 'missing');
    assert.equal(result.error_code, 'context_graph_missing');
    assert.deepEqual(result.gates, baselineIds([PATHS.changed]));
    assert.deepEqual(result.added_gates, []);
    assert.ok(result.errors.some((line) => line.includes('sks align run')));
    assertNeverFewer(result);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
