import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_GRAPH_SCHEMA,
  validateContextGraphSnapshot,
  type ContextGraphNode,
  type ContextGraphSnapshot
} from '../../../contracts.js';
import { CONTEXT_PACK_REL } from '../index.js';
import {
  LIMITS,
  edgesOfType,
  fileSha256,
  hasIssue,
  makeWorkspace,
  manifestEntry,
  removeWorkspace,
  runExtractor,
  writeContextPack,
  writeRawContextPack
} from './fixtures.js';

function claimNodes(nodes: readonly ContextGraphNode[]): ContextGraphNode[] {
  return nodes.filter((node) => node.kind === 'wiki_claim');
}

function claimByLabel(nodes: readonly ContextGraphNode[], label: string): ContextGraphNode {
  const found = nodes.find((node) => node.kind === 'wiki_claim' && node.label === label);
  assert.ok(found, `expected a wiki_claim node labelled ${label}`);
  return found;
}

test('a cited claim keeps its trust while an orphan claim is capped and warned', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        { id: 'cited-claim', text: 'two sources back this claim', source_paths: ['src/a.ts', 'src/b.ts'], trust_score: 0.9, status: 'supported', risk: 'high' },
        { id: 'single-claim', text: 'one source only', source_paths: ['src/a.ts'], trust_score: 0.95, status: 'supported' },
        { id: 'orphan-claim', text: 'nothing backs this', trust_score: 0.99, status: 'supported' }
      ],
      entries: [manifestEntry(root, 'src/a.ts'), manifestEntry(root, 'src/b.ts')]
    });

    const fragment = await runExtractor(root);
    assert.equal(claimNodes(fragment.nodes).length, 3);

    const cited = claimByLabel(fragment.nodes, 'cited-claim');
    assert.equal(cited.metadata.citation_count, 2);
    assert.equal(cited.freshness, 'fresh');
    assert.equal(cited.trust, 0.9);

    const single = claimByLabel(fragment.nodes, 'single-claim');
    assert.equal(single.metadata.citation_count, 1);
    assert.ok(single.trust <= 0.6, `single-source claim trust should be capped, got ${single.trust}`);

    const orphan = claimByLabel(fragment.nodes, 'orphan-claim');
    assert.equal(orphan.metadata.citation_count, 0);
    assert.ok(orphan.trust <= 0.2, `orphan claim trust should be capped, got ${orphan.trust}`);
    assert.equal(orphan.metadata.trust_basis, 'orphan_capped');

    assert.ok(hasIssue(fragment, 'orphan_wiki_claim'));
    assert.ok(hasIssue(fragment, 'single_source_low_trust_synthesis'));

    const cites = edgesOfType(fragment, 'cites');
    assert.equal(cites.filter((edge) => edge.from === cited.id).length, 2);
    assert.equal(cites.filter((edge) => edge.from === orphan.id).length, 0);
    for (const edge of cites) {
      assert.equal(edge.provenance.path, CONTEXT_PACK_REL);
      assert.ok(edge.provenance.hash.length >= 32);
      assert.equal(edge.provenance.extractor, 'triwiki-evidence');
    }

    const derived = edgesOfType(fragment, 'derived_from');
    assert.ok(derived.length >= 2, 'each cited source should derive from its file node');
    assert.ok(fragment.nodes.some((node) => node.kind === 'file' && node.path === 'src/a.ts'));
    assert.ok(fragment.nodes.some((node) => node.kind === 'risk_domain'));
  } finally {
    removeWorkspace(root);
  }
});

test('a source hash that no longer matches disk marks the source and its claim stale', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        { id: 'stale-claim', text: 'backed by a drifted file', source_paths: ['src/a.ts'], trust_score: 0.95, status: 'supported' },
        { id: 'fresh-claim', text: 'backed by a current file', source_paths: ['src/b.ts'], trust_score: 0.95, status: 'supported' }
      ],
      entries: [manifestEntry(root, 'src/a.ts', 'f'.repeat(64)), manifestEntry(root, 'src/b.ts')]
    });

    const fragment = await runExtractor(root);
    const staleClaim = claimByLabel(fragment.nodes, 'stale-claim');
    assert.equal(staleClaim.freshness, 'stale');
    assert.equal(staleClaim.metadata.stale_source_count, 1);
    assert.ok(staleClaim.trust <= 0.35, `stale claim trust should be capped, got ${staleClaim.trust}`);

    const staleSource = fragment.nodes.find((node) => node.kind === 'source' && node.path === 'src/a.ts');
    assert.ok(staleSource);
    assert.equal(staleSource.freshness, 'stale');
    assert.equal(staleSource.metadata.hash_match, false);
    assert.equal(staleSource.metadata.disk_hash, fileSha256(root, 'src/a.ts').slice(0, 16));

    const freshClaim = claimByLabel(fragment.nodes, 'fresh-claim');
    assert.equal(freshClaim.freshness, 'fresh');
  } finally {
    removeWorkspace(root);
  }
});

test('claim-to-claim relations are emitted only when the pack declares them', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        { id: 'claim-old', text: 'the earlier position', source_paths: ['src/a.ts'] },
        { id: 'claim-new', text: 'the later position', source_paths: ['src/b.ts'], supersedes: ['claim-old'] },
        { id: 'claim-side', text: 'a similar sounding position with no declared relation', source_paths: ['src/a.ts'] }
      ],
      entries: [manifestEntry(root, 'src/a.ts'), manifestEntry(root, 'src/b.ts')],
      relations: [
        { from: 'claim-new', to: 'claim-old', type: 'contradicts' },
        { from: 'claim-new', to: 'missing-claim', type: 'supports' }
      ]
    });

    const fragment = await runExtractor(root);
    const older = claimByLabel(fragment.nodes, 'claim-old');
    const newer = claimByLabel(fragment.nodes, 'claim-new');
    const side = claimByLabel(fragment.nodes, 'claim-side');

    const supersedes = edgesOfType(fragment, 'supersedes');
    assert.equal(supersedes.length, 1);
    assert.equal(supersedes[0]?.from, newer.id);
    assert.equal(supersedes[0]?.to, older.id);
    assert.equal(supersedes[0]?.confidence, 'manifest');

    assert.equal(edgesOfType(fragment, 'contradicts').length, 1);
    assert.equal(edgesOfType(fragment, 'supports').length, 0, 'a relation to an unknown claim must not be invented');
    assert.equal(
      fragment.edges.filter((edge) => edge.from === side.id && ['supports', 'contradicts', 'supersedes'].includes(edge.type)).length,
      0,
      'prose similarity must never produce a relation'
    );
  } finally {
    removeWorkspace(root);
  }
});

test('a cited directory is fresh only while every manifest member still matches, and a non-path source stays unresolved', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        { id: 'dir-claim', text: 'cites a directory', source_paths: ['src'], trust_score: 0.9 },
        { id: 'label-claim', text: 'cites a label, not a path', source: 'code-pack', trust_score: 0.9 },
        { id: 'url-claim', text: 'cites a remote doc', source_paths: ['https://example.invalid/doc'], trust_score: 0.9 }
      ],
      entries: [manifestEntry(root, 'src/a.ts'), manifestEntry(root, 'src/b.ts')]
    });

    const fresh = await runExtractor(root);
    const dirSource = fresh.nodes.find((node) => node.kind === 'source' && node.path === 'src');
    assert.ok(dirSource);
    assert.equal(dirSource.metadata.entry_kind, 'directory');
    assert.equal(dirSource.freshness, 'fresh');

    const label = claimByLabel(fresh.nodes, 'label-claim');
    assert.equal(label.metadata.citation_count, 0);
    assert.equal(label.metadata.unresolved_citation_count, 1);
    const url = claimByLabel(fresh.nodes, 'url-claim');
    assert.equal(url.metadata.citation_count, 0);
    assert.equal(url.metadata.remote_citation_count, 1);
    assert.ok(url.trust <= 0.2, 'a remote-only citation cannot buy local trust');

    writeContextPack(root, {
      claims: [{ id: 'dir-claim', text: 'cites a directory', source_paths: ['src'], trust_score: 0.9 }],
      entries: [manifestEntry(root, 'src/a.ts', '0'.repeat(64)), manifestEntry(root, 'src/b.ts')]
    });
    const drifted = await runExtractor(root);
    const driftedDir = drifted.nodes.find((node) => node.kind === 'source' && node.path === 'src');
    assert.ok(driftedDir);
    assert.equal(driftedDir.freshness, 'stale');
    assert.equal(claimByLabel(drifted.nodes, 'dir-claim').freshness, 'stale');
  } finally {
    removeWorkspace(root);
  }
});

test('a missing or corrupt context pack is an explicit skip, never an empty success', async () => {
  const missingRoot = makeWorkspace();
  try {
    const fragment = await runExtractor(missingRoot);
    assert.equal(fragment.nodes.length, 0);
    assert.equal(fragment.edges.length, 0);
    const packSkip = fragment.skipped.find((skip) => skip.path === CONTEXT_PACK_REL);
    assert.ok(packSkip, 'expected an explicit context-pack skip');
    assert.equal(packSkip.reason, 'unreadable');
    assert.ok(hasIssue(fragment, 'extractor_skipped_input'));
    assert.equal(Object.keys(fragment.inputHashes).length, 0);
  } finally {
    removeWorkspace(missingRoot);
  }

  const corruptRoot = makeWorkspace();
  try {
    writeRawContextPack(corruptRoot, '{ not json');
    const fragment = await runExtractor(corruptRoot);
    assert.equal(fragment.nodes.length, 0);
    assert.ok(fragment.skipped.some((skip) => skip.detail === 'context_pack_corrupt'));
    assert.ok(Object.keys(fragment.inputHashes).includes(CONTEXT_PACK_REL));
  } finally {
    removeWorkspace(corruptRoot);
  }
});

test('the fragment is deterministic and structurally valid as a snapshot', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        { id: 'zeta-claim', text: 'z', source_paths: ['src/b.ts'], risk: 'critical' },
        { id: 'alpha-claim', text: 'a', source_paths: ['src/a.ts', 'src/b.ts'], risk: 'low' },
        { id: 'mid-claim', text: 'm', source_paths: ['src/a.ts'] }
      ],
      entries: [manifestEntry(root, 'src/a.ts'), manifestEntry(root, 'src/b.ts')],
      anchors: [['mid-claim', '00112233', [0, 0, 0, 1], 'code', 'supported', 'medium', 'wiki', '0123456789abcdef', 'src/b.ts']]
    });

    const first = await runExtractor(root);
    const second = await runExtractor(root);
    assert.equal(JSON.stringify(second), JSON.stringify(first));

    const sortedNodes = [...first.nodes].sort((left, right) => left.id.localeCompare(right.id));
    const sortedEdges = [...first.edges].sort((left, right) => left.id.localeCompare(right.id));
    const snapshot: ContextGraphSnapshot = {
      schema: CONTEXT_GRAPH_SCHEMA,
      schemaRevision: '1.0.0',
      snapshotHash: 'test-snapshot-hash',
      nodes: sortedNodes,
      edges: sortedEdges,
      cycles: [],
      extractors: [],
      nodeCount: sortedNodes.length,
      edgeCount: sortedEdges.length
    };
    const validation = validateContextGraphSnapshot(snapshot);
    assert.deepEqual(validation.issues.filter((issue) => issue.severity === 'error'), []);
    assert.equal(validation.ok, true);

    assert.ok(first.nodes.length <= LIMITS.maxNodes);
    for (const node of first.nodes) {
      if (node.path === undefined) continue;
      assert.ok(!node.path.startsWith('/'), `node path must be workspace-relative: ${node.path}`);
    }
  } finally {
    removeWorkspace(root);
  }
});
