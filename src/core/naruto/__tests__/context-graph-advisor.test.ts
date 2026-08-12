/**
 * Naruto scope advisory tests.
 *
 * The fixture graph is built through the real serializer and the real index
 * builder, so ordering, hashing and adjacency match what the compiler produces.
 * Nothing here touches the operator's HOME: the only workspace used is an
 * `fs.mkdtempSync` directory under `os.tmpdir()`, and it is removed again.
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
import { encodeContextIndex } from '../../triwiki/context-graph/runtime-index/writer.js';
import { openContextIndex } from '../../triwiki/context-graph/runtime-index/reader.js';
import type { ContextIndexReader } from '../../triwiki/context-graph/query/index.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../triwiki/context-graph/ids.js';
import {
  NARUTO_CONTEXT_GRAPH_ADVISOR_AUTHORITY,
  narutoContextGraphAdvice,
  narutoContextGraphAdviceFromIndex,
  type NarutoContextGraphAdvice,
  type NarutoContextGraphSliceInput
} from '../context-graph-advisor.js';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

const PATHS = {
  a: 'src/mod-a/impl.ts',
  b: 'src/mod-b/impl.ts',
  shared: 'src/shared/util.ts',
  c: 'src/mod-c/impl.ts',
  d: 'src/mod-d/impl.ts',
  suite: 'src/__tests__/shared.test.ts'
} as const;

const IDS = {
  a: contextGraphNodeId({ kind: 'file', path: PATHS.a }),
  b: contextGraphNodeId({ kind: 'file', path: PATHS.b }),
  shared: contextGraphNodeId({ kind: 'file', path: PATHS.shared }),
  c: contextGraphNodeId({ kind: 'file', path: PATHS.c }),
  d: contextGraphNodeId({ kind: 'file', path: PATHS.d }),
  suiteFile: contextGraphNodeId({ kind: 'file', path: PATHS.suite }),
  suite: contextGraphNodeId({ kind: 'test', path: PATHS.suite }),
  gateRelease: contextGraphNodeId({ kind: 'gate', gateId: 'release:publish' }),
  gateLint: contextGraphNodeId({ kind: 'gate', gateId: 'lint:fast' })
} as const;

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
    confidence: 'exact',
    provenance: { path: provenancePath, line, hash: `sha-${provenancePath}`, extractor: 'advisor-fixture' },
    observedAt: OBSERVED_AT
  };
}

/**
 * A region whose only job is to overflow `maxRecommendationsPerSlice`.
 *
 * `capA` sorts first, so `narutoAdvisorPathList` puts it first and its suites
 * arrive first — and they are named to sort last. A rule that keeps the first 24
 * arrivals returns 24 `zz-*` suites and neither gate; the stated order returns
 * both gates, every `aa-*` suite, and only the lowest-sorting `zz-*` remainder.
 */
const CAP_PATHS = { capA: 'src/mod-cap/a-seed.ts', capB: 'src/mod-cap/b-seed.ts' } as const;
const CAP_COUNTS = { arriveFirst: 24, arriveSecond: 10, gates: 2 } as const;
const CAP_LIMIT = 24;

function capSuite(prefix: string, index: number): string {
  return `src/mod-cap/__tests__/${prefix}-${String(index).padStart(3, '0')}.test.ts`;
}

function capFixture(): { nodes: ContextGraphNode[]; edges: ContextGraphEdge[] } {
  const nodes: ContextGraphNode[] = [];
  const edges: ContextGraphEdge[] = [];
  const fileId = (value: string): string => contextGraphNodeId({ kind: 'file', path: value });
  const testId = (value: string): string => contextGraphNodeId({ kind: 'test', path: value });

  for (const seed of Object.values(CAP_PATHS)) nodes.push(fileNode(fileId(seed), seed));
  const suites = (prefix: string, count: number, target: string): void => {
    for (let index = 0; index < count; index += 1) {
      const suitePath = capSuite(prefix, index);
      nodes.push({
        id: testId(suitePath),
        kind: 'test',
        label: path.posix.basename(suitePath),
        path: suitePath,
        contentHash: `sha-${suitePath}`,
        trust: 1,
        freshness: 'fresh',
        risk: 'low',
        tokenCost: 30,
        metadata: {}
      });
      edges.push(edge(testId(suitePath), fileId(target), 'tests', suitePath, index + 1));
    }
  };
  suites('zz', CAP_COUNTS.arriveFirst, CAP_PATHS.capA);
  suites('aa', CAP_COUNTS.arriveSecond, CAP_PATHS.capB);
  for (let index = 0; index < CAP_COUNTS.gates; index += 1) {
    const gateId = `custom:cap-${String(index).padStart(2, '0')}`;
    const node = contextGraphNodeId({ kind: 'gate', gateId });
    nodes.push(gateNode(node, gateId, 'medium', { namespace: 'custom' }));
    edges.push(edge(node, fileId(CAP_PATHS.capB), 'affected_by', 'release-gates.v2.json', 90 + index));
  }
  return { nodes, edges };
}

function fixtureIndex(): ContextIndexReader {
  const nodes: ContextGraphNode[] = [
    fileNode(IDS.a, PATHS.a),
    fileNode(IDS.b, PATHS.b),
    fileNode(IDS.shared, PATHS.shared),
    fileNode(IDS.c, PATHS.c),
    fileNode(IDS.d, PATHS.d),
    fileNode(IDS.suiteFile, PATHS.suite, { isTest: true }),
    {
      id: IDS.suite,
      kind: 'test',
      label: 'shared.test.ts',
      path: PATHS.suite,
      contentHash: `sha-${PATHS.suite}`,
      trust: 1,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 30,
      metadata: { suite: 'file' }
    },
    gateNode(IDS.gateRelease, 'release:publish', 'protected', { namespace: 'release', requiredForPublish: true }),
    gateNode(IDS.gateLint, 'lint:fast', 'high', { namespace: 'lint', requiredForPublish: false })
  ];
  const edges: ContextGraphEdge[] = [
    edge(IDS.a, IDS.shared, 'imports', PATHS.a, 1),
    edge(IDS.b, IDS.shared, 'imports', PATHS.b, 1),
    edge(IDS.suite, IDS.c, 'tests', PATHS.suite, 3),
    edge(IDS.suite, IDS.d, 'tests', PATHS.suite, 4),
    edge(IDS.suiteFile, IDS.suite, 'contains', PATHS.suite, 1),
    edge(IDS.gateRelease, IDS.a, 'affected_by', 'release-gates.v2.json', 11),
    edge(IDS.gateLint, IDS.c, 'affected_by', 'release-gates.v2.json', 12)
  ];
  const caps = capFixture();
  nodes.push(...caps.nodes);
  edges.push(...caps.edges);
  // Encoded and reopened rather than handed over as an in-memory structure: the
  // advisory now reads the compact index, and a fixture that skipped the encode
  // would not exercise the string interning or the CSR adjacency it depends on.
  const snapshot = buildContextGraphSnapshot({
    nodes,
    edges,
    cycles: [],
    extractors: [{ id: 'advisor-fixture', revision: '1.0.0', nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0, skippedCount: 0 }]
  });
  const encoded = encodeContextIndex({ snapshot, configHash: new Uint8Array(32).fill(3), schemaRevision: 1 });
  return openContextIndex(encoded.bytes, { expectedSnapshotHash: snapshot.snapshotHash });
}

function advise(slices: NarutoContextGraphSliceInput[], graphStatus: 'fresh' | 'stale' = 'fresh'): NarutoContextGraphAdvice {
  return narutoContextGraphAdviceFromIndex(fixtureIndex(), { root: '/workspace-not-read', task: 'adjust the module', slices, graphStatus });
}

test('two slices writing the same file are a direct conflict with a grounded reason', () => {
  const advice = advise([
    { id: 'S1', writePaths: [PATHS.a] },
    { id: 'S2', writePaths: [PATHS.a] }
  ]);

  assert.equal(advice.ok, true);
  assert.equal(advice.parallel_safe, false);
  assert.equal(advice.recommended_max_parallel_slices, 1);
  const pair = advice.pairs[0];
  assert.ok(pair, 'expected one pair');
  assert.equal(pair.kind, 'direct_write_overlap');
  assert.equal(pair.shared_paths[0], PATHS.a, 'the directly overlapping write is reported first');
  const direct = pair.reasons.filter((row) => row.path === PATHS.a);
  assert.deepEqual(direct.map((row) => row.slice_id).sort(), ['S1', 'S2'], 'both slices explain the shared file');
  for (const reason of pair.reasons) {
    assert.ok(reason.provenance.length > 0, 'every reason is grounded in repository truth');
    assert.ok(reason.provenance.every((row) => !row.path.startsWith('/') && !row.path.includes('..')));
  }
});

test('two slices standing on the same dependency are an indirect conflict', () => {
  const advice = advise([
    { id: 'S1', writePaths: [PATHS.a] },
    { id: 'S2', writePaths: [PATHS.b] }
  ]);

  assert.equal(advice.parallel_safe, false);
  const pair = advice.pairs[0];
  assert.ok(pair);
  assert.equal(pair.kind, 'shared_dependency');
  assert.deepEqual(pair.shared_paths, [PATHS.shared]);
  const left = pair.reasons.find((row) => row.slice_id === 'S1');
  assert.ok(left, 'the left slice explains how it reaches the shared file');
  assert.deepEqual(left.reason_path, [IDS.a, 'imports', IDS.shared]);
  assert.equal(left.explanation.length, 1);
  assert.equal(left.explanation[0]?.type, 'imports');
  assert.equal(left.provenance[0]?.path, PATHS.a);
});

test('genuinely disjoint modules stay parallel-safe', () => {
  const advice = advise([
    { id: 'S1', writePaths: [PATHS.c] },
    { id: 'S2', writePaths: [PATHS.d] }
  ]);

  assert.equal(advice.parallel_safe, true);
  assert.equal(advice.pairs.length, 1);
  assert.equal(advice.pairs[0]?.kind, null);
  assert.deepEqual(advice.pairs[0]?.shared_paths, []);
  assert.equal(advice.recommended_max_parallel_slices, 2);
});

test('a shared test suite is not a write conflict', () => {
  const advice = advise([
    { id: 'S1', writePaths: [PATHS.c] },
    { id: 'S2', writePaths: [PATHS.d] }
  ]);

  // The suite really does link the two slices...
  const suiteRecommendations = advice.recommended_tests.filter((row) => row.path === PATHS.suite);
  assert.deepEqual(suiteRecommendations.map((row) => row.slice_id).sort(), ['S1', 'S2']);
  assert.ok(suiteRecommendations.every((row) => row.reason_path.includes('<-tests')));
  assert.ok(suiteRecommendations.every((row) => row.provenance.length > 0));
  // ...but a dependent is not a dependency, so it never enters a write closure.
  for (const scope of advice.scopes) assert.ok(!scope.write_closure.includes(PATHS.suite));
  assert.equal(advice.parallel_safe, true);
});

test('a protected release gate is recommended with its reason path and domain', () => {
  const advice = advise([{ id: 'S1', writePaths: [PATHS.a] }]);

  const gate = advice.recommended_gates.find((row) => row.id === 'release:publish');
  assert.ok(gate, 'the release gate that declares this file as an input is recommended');
  assert.equal(gate.protected, true);
  assert.deepEqual(gate.reason_path, [IDS.a, '<-affected_by', IDS.gateRelease]);
  assert.equal(gate.provenance[0]?.path, 'release-gates.v2.json');
  assert.deepEqual(advice.protected_domains, ['release']);
  assert.ok(!advice.recommended_gates.some((row) => row.id === 'lint:fast'), 'an unrelated gate is not invented');
});

test('a stale graph yields the conservative result and never a wider fan-out', () => {
  const fresh = advise([
    { id: 'S1', writePaths: [PATHS.c] },
    { id: 'S2', writePaths: [PATHS.d] }
  ]);
  const stale = advise(
    [
      { id: 'S1', writePaths: [PATHS.c] },
      { id: 'S2', writePaths: [PATHS.d] }
    ],
    'stale'
  );

  assert.equal(stale.ok, false);
  assert.equal(stale.graph_status, 'stale');
  assert.equal(stale.error_code, 'context_graph_stale');
  assert.equal(stale.repair_command, 'sks align run');
  assert.equal(stale.conservative, true);
  assert.ok(stale.conservative_reasons.includes('context_graph_stale'));
  assert.equal(stale.parallel_safe, false);
  assert.equal(stale.pairs.every((pair) => pair.parallel_safe === false && pair.kind === 'graph_not_usable'), true);
  assert.deepEqual(stale.recommended_tests, []);
  assert.deepEqual(stale.recommended_gates, []);
  assert.ok(stale.errors.some((line) => line.includes('sks align run')));
  assert.ok(
    stale.recommended_max_parallel_slices <= fresh.recommended_max_parallel_slices,
    'stale evidence must never widen the recommended fan-out'
  );
  assert.equal(stale.recommended_max_parallel_slices, 1);
});

test('a slice whose scope resolves to nothing is never called parallel-safe', () => {
  const advice = advise([
    { id: 'S1', writePaths: [PATHS.c] },
    { id: 'S2', title: 'do something unnameable' }
  ]);

  assert.equal(advice.parallel_safe, false);
  assert.equal(advice.pairs[0]?.kind, 'undeclared_write_scope');
  assert.ok(advice.conservative_reasons.includes('slice_scope_unresolved'));
});

/**
 * `maxRecommendationsPerSlice` used to stop with a bare `break`, so an advisory
 * that had seen 36 verifiers and returned 24 looked exactly like one that had seen
 * 24. It is the same defect `context-graph-affected.ts` carried on `maxTests`, in
 * the other consumer of the same walk.
 */
test('the recommendation cap reports itself and keeps gates before same-distance tests', () => {
  const advice = advise([{ id: 'S1', writePaths: [CAP_PATHS.capA, CAP_PATHS.capB] }]);
  const forSlice = <T extends { slice_id: string }>(rows: readonly T[]): T[] => rows.filter((row) => row.slice_id === 'S1');
  const gates = forSlice(advice.recommended_gates);
  const tests = forSlice(advice.recommended_tests);

  assert.equal(gates.length + tests.length, CAP_LIMIT);
  assert.ok(advice.conservative_reasons.includes('recommendations_truncated'), 'a shortened list must not read as a complete one');
  assert.equal(advice.conservative, true);
  assert.equal(gates.length, CAP_COUNTS.gates, 'a gate is never dropped in favour of a test at the same distance');
  const paths = tests.map((row) => row.id).sort();
  for (let index = 0; index < CAP_COUNTS.arriveSecond; index += 1) {
    assert.ok(paths.includes(capSuite('aa', index)), `${capSuite('aa', index)} survived though its seed is walked second`);
  }
  assert.deepEqual(
    paths.filter((row) => row.includes('/zz-')),
    Array.from({ length: CAP_LIMIT - CAP_COUNTS.gates - CAP_COUNTS.arriveSecond }, (_, index) => capSuite('zz', index)),
    'the surviving remainder is the lowest-sorting slice, not the slice that arrived first'
  );
});

/** The control: without it the reason above is satisfied by one pushed unconditionally. */
test('a slice whose verifiers fit under the cap is not reported as truncated', () => {
  const advice = advise([{ id: 'S1', writePaths: [PATHS.a] }]);

  assert.ok(!advice.conservative_reasons.includes('recommendations_truncated'));
});

test('the advisory declares that it decides nothing', () => {
  const advice = advise([{ id: 'S1', writePaths: [PATHS.a] }]);

  assert.equal(advice.authority, NARUTO_CONTEXT_GRAPH_ADVISOR_AUTHORITY);
  assert.deepEqual(advice.guarantees, {
    spawns_agents: false,
    selects_models: false,
    merges_patches: false,
    skips_gates: false,
    overrides_explicit_agents: false,
    process_spawns: 0
  });
});

test('a workspace with no compiled graph reports missing instead of guessing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-advisor-missing-'));
  try {
    const advice = await narutoContextGraphAdvice({ root, slices: [{ id: 'S1', writePaths: [PATHS.a] }, { id: 'S2', writePaths: [PATHS.b] }] });
    assert.equal(advice.ok, false);
    assert.equal(advice.graph_status, 'missing');
    assert.equal(advice.error_code, 'context_graph_missing');
    assert.equal(advice.parallel_safe, false);
    assert.equal(advice.recommended_max_parallel_slices, 1);
    assert.ok(advice.errors.some((line) => line.includes('sks align run')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
