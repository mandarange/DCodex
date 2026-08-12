import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../../../../fsx.js';
import type { ContextGraphEdge, ContextGraphNode } from '../../contracts.js';
import { countDanglingEdges, mergeSourceFragments } from '../fragment-merge.js';
import { sourceFragmentKey } from '../fragment-manifest.js';
import { computeContextGraphSnapshotHash } from '../serialize.js';
import { buildSourceFragment, type ContextGraphSourceFragment } from '../source-fragment.js';
import { edgeBetween, fileNode, plainNode } from './graph-test-fixtures.js';

interface FragmentParts {
  readonly extractor?: string | undefined;
  readonly sourcePath?: string | undefined;
  readonly nodes?: readonly ContextGraphNode[] | undefined;
  readonly edges?: readonly ContextGraphEdge[] | undefined;
}

function fragment(parts: FragmentParts = {}): ContextGraphSourceFragment {
  const sourcePath = parts.sourcePath ?? 'src/a.ts';
  return buildSourceFragment({
    extractor: parts.extractor ?? 'files',
    extractorRevision: '1',
    sourcePath,
    sourceHash: sha256(sourcePath),
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
  });
}

const NODE_A = fileNode('src/a.ts', sha256('a'));
const NODE_B = fileNode('src/b.ts', sha256('b'));
const A_TO_B = edgeBetween(NODE_A.id, NODE_B.id, { path: 'src/a.ts', hash: sha256('a') });

test('the merge is a function of the fragment set, not of the order it arrives in', () => {
  const fragments = [
    fragment({ sourcePath: 'src/a.ts', nodes: [NODE_A], edges: [A_TO_B] }),
    fragment({ sourcePath: 'src/b.ts', nodes: [NODE_B] }),
    fragment({ extractor: 'modules', sourcePath: 'src/a.ts', nodes: [plainNode('module:src/a.ts')] }),
    fragment({ extractor: 'modules', sourcePath: 'src/b.ts', nodes: [plainNode('module:src/b.ts')] }),
  ];
  const forward = mergeSourceFragments({ fragments });
  const reversed = mergeSourceFragments({ fragments: [...fragments].reverse() });
  const rotated = mergeSourceFragments({ fragments: [fragments[2]!, fragments[0]!, fragments[3]!, fragments[1]!] });

  assert.deepEqual(forward.nodes, reversed.nodes);
  assert.deepEqual(forward.edges, reversed.edges);
  assert.deepEqual(forward.nodes, rotated.nodes);
  const hashOf = (result: typeof forward): string =>
    computeContextGraphSnapshotHash({ nodes: result.nodes, edges: result.edges, cycles: [], extractors: result.extractors });
  assert.equal(hashOf(forward), hashOf(reversed));
  assert.equal(hashOf(forward), hashOf(rotated));
  assert.deepEqual(forward.nodes.map((node) => node.id), [...forward.nodes.map((node) => node.id)].sort());
});

test('a reused edge whose target was deleted is pruned as a fact, not as an error', () => {
  const fragments = [fragment({ sourcePath: 'src/a.ts', nodes: [NODE_A], edges: [A_TO_B] })];
  const merged = mergeSourceFragments({
    fragments,
    reusedKeys: new Set([sourceFragmentKey('files', 'src/a.ts')]),
  });
  assert.equal(countDanglingEdges(merged.nodes, merged.edges), 0);
  assert.deepEqual(merged.edges, []);
  assert.deepEqual(merged.pruned.map((edge) => edge.reason), ['reused_endpoint_missing']);
  assert.deepEqual(merged.issues, []);
});

test('a freshly extracted edge into nothing is pruned and blocks the write', () => {
  const merged = mergeSourceFragments({ fragments: [fragment({ nodes: [NODE_A], edges: [A_TO_B] })] });
  assert.equal(countDanglingEdges(merged.nodes, merged.edges), 0);
  assert.deepEqual(merged.pruned.map((edge) => edge.reason), ['fresh_endpoint_missing']);
  assert.deepEqual(merged.issues.map((issue) => `${issue.severity}:${issue.code}`), ['error:dangling_edge']);
});

test('two extractors describing the same node merge pessimistically', () => {
  const cautious = { ...NODE_A, trust: 0.4, freshness: 'stale' as const, risk: 'high' as const, tokenCost: 10 };
  const confident = { ...NODE_A, trust: 0.9, freshness: 'fresh' as const, risk: 'low' as const, tokenCost: 40 };
  const merged = mergeSourceFragments({
    fragments: [fragment({ nodes: [confident] }), fragment({ extractor: 'modules', nodes: [cautious] })],
  });
  assert.equal(merged.nodes.length, 1);
  const node = merged.nodes[0]!;
  assert.equal(node.trust, 0.9);
  assert.equal(node.tokenCost, 40);
  assert.equal(node.freshness, 'stale');
  assert.equal(node.risk, 'high');
});

test('a genuine disagreement about a node is an error rather than a last-writer-wins', () => {
  const asFile = fileNode('src/a.ts', sha256('a'));
  const asOtherContent = { ...asFile, contentHash: sha256('different') };
  const merged = mergeSourceFragments({
    fragments: [fragment({ nodes: [asFile] }), fragment({ extractor: 'modules', nodes: [asOtherContent] })],
  });
  assert.deepEqual(merged.issues.map((issue) => issue.code), ['duplicate_node_conflict']);
});

test('a derived relation survives only while an exact one backs the same pair', () => {
  const derived = { ...edgeBetween(NODE_A.id, NODE_B.id, { type: 'depends_on', confidence: 'derived' }) };
  const exact = edgeBetween(NODE_A.id, NODE_B.id, { type: 'imports', confidence: 'exact' });
  const nodes = [NODE_A, NODE_B];

  const supported = mergeSourceFragments({
    fragments: [fragment({ nodes, edges: [derived, exact] })],
  });
  assert.equal(supported.edges.length, 2);

  const unsupported = mergeSourceFragments({ fragments: [fragment({ nodes, edges: [derived] })] });
  assert.deepEqual(unsupported.edges, []);
  assert.deepEqual(unsupported.pruned.map((edge) => edge.reason), ['derived_without_support']);
});

test('the same edge seen twice keeps the stronger claim regardless of arrival order', () => {
  const nodes = [NODE_A, NODE_B];
  const weak = { ...A_TO_B, confidence: 'observed' as const };
  const strong = { ...A_TO_B, confidence: 'exact' as const };
  const first = mergeSourceFragments({
    fragments: [fragment({ nodes, edges: [weak] }), fragment({ extractor: 'modules', edges: [strong] })],
  });
  const second = mergeSourceFragments({
    fragments: [fragment({ nodes, edges: [strong] }), fragment({ extractor: 'modules', edges: [weak] })],
  });
  assert.equal(first.edges.length, 1);
  assert.equal(first.edges[0]!.confidence, 'exact');
  assert.deepEqual(first.edges, second.edges);
});
