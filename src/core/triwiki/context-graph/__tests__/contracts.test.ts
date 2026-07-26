import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_GRAPH_EDGE_TYPES,
  CONTEXT_GRAPH_NODE_KINDS,
  CONTEXT_GRAPH_SCHEMA,
  validateContextGraphSnapshot,
  type ContextGraphEdge,
  type ContextGraphNode,
  type ContextGraphSnapshot
} from '../contracts.js';
import { contextGraphEdgeId, contextGraphNodeId, contextGraphPathFromId } from '../ids.js';
import { ContextGraphPathError, isWorkspaceRelativePosixPath, normalizeGraphPath, resolveInsideWorkspace } from '../paths.js';
import { contextGraphQueryProfile, CONTEXT_GRAPH_TRAVERSAL_CAPS, profileTraversesEdge } from '../profiles.js';
import { buildContextGraphIndex, computeStronglyConnectedComponents } from '../graph-index.js';

function node(id: string, overrides: Partial<ContextGraphNode> = {}): ContextGraphNode {
  return {
    id,
    kind: 'file',
    label: id,
    trust: 0.8,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 10,
    metadata: {},
    ...overrides
  };
}

function edge(from: string, to: string, overrides: Partial<ContextGraphEdge> = {}): ContextGraphEdge {
  return {
    id: contextGraphEdgeId({ from, to, type: 'imports' }),
    from,
    to,
    type: 'imports',
    confidence: 'exact',
    provenance: { path: 'src/a.ts', hash: 'deadbeef', extractor: 'test' },
    observedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function snapshot(nodes: ContextGraphNode[], edges: ContextGraphEdge[]): ContextGraphSnapshot {
  return {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash: 'a'.repeat(64),
    nodes: [...nodes].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges].sort((left, right) => left.id.localeCompare(right.id)),
    cycles: [],
    extractors: [],
    nodeCount: nodes.length,
    edgeCount: edges.length
  };
}

test('node identity is stable and free of ordering or timestamps', () => {
  const first = contextGraphNodeId({ kind: 'symbol', path: 'src/a.ts', symbolKind: 'function', name: 'run', startOffset: 42 });
  const second = contextGraphNodeId({ kind: 'symbol', path: 'src/a.ts', symbolKind: 'function', name: 'run', startOffset: 42 });
  assert.equal(first, second);
  assert.equal(first, 'symbol:src/a.ts#function:run@42');
  assert.equal(contextGraphPathFromId(first), 'src/a.ts');
  assert.equal(contextGraphNodeId({ kind: 'file', path: './src/a.ts' }), 'file:src/a.ts');
  assert.equal(contextGraphNodeId({ kind: 'gate', gateId: 'triwiki:cache-key' }), 'gate:triwiki:cache-key');
});

test('same-name symbols in different modules never collide', () => {
  const left = contextGraphNodeId({ kind: 'symbol', path: 'src/a.ts', symbolKind: 'function', name: 'run', startOffset: 0 });
  const right = contextGraphNodeId({ kind: 'symbol', path: 'src/b.ts', symbolKind: 'function', name: 'run', startOffset: 0 });
  assert.notEqual(left, right);
});

test('edge identity merges the same relation observed by two extractors', () => {
  const left = contextGraphEdgeId({ from: 'file:a.ts', to: 'file:b.ts', type: 'imports' });
  const right = contextGraphEdgeId({ from: 'file:a.ts', to: 'file:b.ts', type: 'imports' });
  const other = contextGraphEdgeId({ from: 'file:a.ts', to: 'file:b.ts', type: 'references' });
  assert.equal(left, right);
  assert.notEqual(left, other);
});

test('normalizeGraphPath rejects absolute and escaping paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-paths-'));
  try {
    assert.equal(normalizeGraphPath(root, path.join(root, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(normalizeGraphPath(root, './src/a.ts'), 'src/a.ts');
    assert.throws(() => normalizeGraphPath(root, '../outside.ts'), ContextGraphPathError);
    assert.throws(() => normalizeGraphPath(root, '/etc/passwd'), ContextGraphPathError);
    assert.throws(() => normalizeGraphPath(root, ''), ContextGraphPathError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlinks that leave the workspace are refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-symlink-'));
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const x = 1;\n');
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked.ts'));
  try {
    assert.throws(() => resolveInsideWorkspace(root, 'linked.ts'), ContextGraphPathError);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('isWorkspaceRelativePosixPath rejects home, drive, and traversal shapes', () => {
  assert.equal(isWorkspaceRelativePosixPath('src/core/a.ts'), true);
  assert.equal(isWorkspaceRelativePosixPath('/Users/me/a.ts'), false);
  assert.equal(isWorkspaceRelativePosixPath('~/a.ts'), false);
  assert.equal(isWorkspaceRelativePosixPath('C:/a.ts'), false);
  assert.equal(isWorkspaceRelativePosixPath('src\\a.ts'), false);
  assert.equal(isWorkspaceRelativePosixPath('src/../../a.ts'), false);
});

test('snapshot validation flags dangling edges, missing provenance, and unsorted arrays', () => {
  const ok = snapshot([node('file:a.ts'), node('file:b.ts')], [edge('file:a.ts', 'file:b.ts')]);
  assert.equal(validateContextGraphSnapshot(ok).ok, true);

  const dangling = snapshot([node('file:a.ts')], [edge('file:a.ts', 'file:missing.ts')]);
  const danglingResult = validateContextGraphSnapshot(dangling);
  assert.equal(danglingResult.ok, false);
  assert.ok(danglingResult.issues.some((issue) => issue.code === 'dangling_edge'));

  const noProvenance = snapshot(
    [node('file:a.ts'), node('file:b.ts')],
    [edge('file:a.ts', 'file:b.ts', { provenance: { path: '', hash: '', extractor: 'test' } })]
  );
  assert.ok(validateContextGraphSnapshot(noProvenance).issues.some((issue) => issue.code === 'edge_without_provenance'));

  const unsorted = snapshot([node('file:b.ts'), node('file:a.ts')], []);
  unsorted.nodes = [node('file:b.ts'), node('file:a.ts')];
  assert.ok(validateContextGraphSnapshot(unsorted).issues.some((issue) => issue.code === 'non_deterministic_serialization'));
});

test('query profiles only traverse their declared edges and share one cap source', () => {
  const implementation = contextGraphQueryProfile('implementation');
  assert.equal(profileTraversesEdge(implementation, 'defines'), true);
  assert.equal(profileTraversesEdge(implementation, 'cochanged_with'), false);
  assert.equal(contextGraphQueryProfile('nope').name, 'implementation');
  assert.equal(contextGraphQueryProfile('review').name, 'review');
  assert.ok(CONTEXT_GRAPH_TRAVERSAL_CAPS.maxVisitedNodes > 0);
  assert.ok(contextGraphQueryProfile('review').maxDepthHighRisk >= contextGraphQueryProfile('review').maxDepth);
});

test('graph index builds reverse adjacency and detects cycles', () => {
  const nodes = [node('file:a.ts', { path: 'a.ts' }), node('file:b.ts', { path: 'b.ts' })];
  const edges = [edge('file:a.ts', 'file:b.ts'), edge('file:b.ts', 'file:a.ts')];
  const index = buildContextGraphIndex(snapshot(nodes, edges));
  assert.deepEqual([...(index.incoming.get('file:b.ts') ?? [])], [edges[0]!.id]);
  assert.deepEqual([...(index.nodesByPath.get('a.ts') ?? [])], ['file:a.ts']);
  const components = computeStronglyConnectedComponents(['file:a.ts', 'file:b.ts'], (id) =>
    edges.filter((candidate) => candidate.from === id).map((candidate) => ({ to: candidate.to }))
  );
  assert.deepEqual(components, [['file:a.ts', 'file:b.ts']]);
});

test('contract enumerations stay in sync with the published JSON schema', () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'triwiki', 'context-graph.schema.json');
  const parsed = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
    definitions: { node: { properties: { kind: { enum: string[] } } }; edge: { properties: { type: { enum: string[] } } } };
  };
  assert.deepEqual(parsed.definitions.node.properties.kind.enum, [...CONTEXT_GRAPH_NODE_KINDS]);
  assert.deepEqual(parsed.definitions.edge.properties.type.enum, [...CONTEXT_GRAPH_EDGE_TYPES]);
});
