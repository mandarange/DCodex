/**
 * Attention anchors, projected off a published CRK2 generation (CG2-13).
 *
 * The engine under these assertions changed completely — pointer, compact
 * reader, retrieval kernel, selected-only hydration — so they are written against
 * the *anchor contract* rather than against the pipeline: provenance that points
 * at real workspace-relative paths, a reason path, a bounded token cost, and the
 * trust rule that keeps identity hashes off anything not fact-grade.
 *
 * One assertion is deliberately about a loss. Format revision 1 has no label
 * table, so `code:<module-label>` no longer resolves. That is asserted here as
 * the current, honest behaviour — an unresolved anchor with no provenance — so
 * that wiring the lexicon into the writer will fail this test loudly instead of
 * quietly restoring something nobody was tracking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryWorkspaceContext } from '../../query/index.js';
import {
  ATTENTION_FACT_TRUST_FLOOR,
  attentionHydrateHint,
  isFactGradeAnchor,
  projectContextGraphAnchors,
  projectContextPackAnchors,
  resolveContextGraphAnchorNode
} from '../anchors.js';
import { HUB_FILE, HUB_MODULE_LABEL, removeProjectionFixture } from './projection-fixtures.js';
import { createIndexedProjectionFixture } from './projection-index-fixtures.js';

function hubModuleId(fixture: { snapshot: { nodes: readonly { id: string; kind: string; label: string }[] } }): string {
  const module = fixture.snapshot.nodes.find((node) => node.kind === 'module' && node.label === HUB_MODULE_LABEL);
  assert.ok(module, 'the fixture must carry a hub module node');
  return module.id;
}

test('query-selected anchors carry a reason path, provenance and a token cost', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 4 });
  try {
    const answer = await queryWorkspaceContext(
      fixture.root,
      { query: HUB_FILE, profile: 'implementation', tokenBudget: 2000, maxSelected: 8 },
      { index: fixture.handle }
    );
    const anchors = projectContextGraphAnchors(fixture.cursor, answer.hydration.nodes, 8);
    assert.ok(anchors.length > 0, 'the hub query should select anchors');
    assert.ok(anchors.length <= 8);
    for (const anchor of anchors) {
      assert.ok(anchor.provenance.length > 0, `anchor ${anchor.id} has no provenance`);
      for (const ref of anchor.provenance) {
        assert.ok(ref.path && !ref.path.startsWith('/') && !ref.path.startsWith('~'), `leaky path ${ref.path}`);
        assert.ok(ref.hash.length > 0);
      }
      assert.ok(anchor.reason_path.length > 0, `anchor ${anchor.id} has no reason path`);
      assert.ok(anchor.token_cost >= 0);
      assert.ok(anchor.trust_score >= 0 && anchor.trust_score <= 1);
    }
    assert.ok(anchors.some((anchor) => anchor.id.includes(HUB_FILE)), 'the seeded file should be an anchor');
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a lower-trust or non-fresh anchor is hydrate-only and keeps no identity hashes', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 1 }, (snapshot) => ({
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (node.kind === 'symbol' ? { ...node, trust: 0.2 } : node))
  }));
  try {
    const answer = await queryWorkspaceContext(
      fixture.root,
      { query: HUB_FILE, profile: 'implementation', tokenBudget: 2000, maxSelected: 8 },
      { index: fixture.handle }
    );
    const anchors = projectContextGraphAnchors(fixture.cursor, answer.hydration.nodes, 8);
    const weak = anchors.filter((anchor) => !isFactGradeAnchor(anchor.trust_score, anchor.freshness));
    assert.ok(weak.length > 0, 'the weakened symbols should surface as hydrate-only anchors');
    for (const anchor of weak) {
      assert.equal(anchor.claim_hash, null, `${anchor.id} must not present a claim hash before hydration`);
      assert.equal(anchor.source_hash, null);
      assert.ok(anchor.hydrate_hint && anchor.hydrate_hint.includes('trust_action:hydrate_first'));
    }
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('the hydrate hint carries only workspace-relative citations and graph reasons', () => {
  const hint = attentionHydrateHint(
    [{ path: 'src/core/hooks/runtime.ts', line: 3, hash: 'abc' }],
    0.2,
    'stale',
    'protected',
    false
  );
  assert.ok(hint);
  assert.ok(hint.includes('trust_action:hydrate_first'));
  assert.ok(hint.includes('freshness:stale'));
  assert.ok(hint.includes('risk:protected'));
  assert.ok(hint.includes('code_citations:src/core/hooks/runtime.ts'));
  assert.ok(!hint.includes('/Users/'));
  assert.ok(hint.length <= 240);
  assert.ok(ATTENTION_FACT_TRUST_FLOOR > 0 && ATTENTION_FACT_TRUST_FLOOR <= 1);
});

test('context pack anchors resolve back to graph nodes and gain reason path, provenance and cost', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 2 });
  try {
    const moduleId = hubModuleId(fixture);
    const projected = projectContextPackAnchors(fixture.reader, fixture.cursor, [
      { id: `code:${moduleId}` },
      { id: fixture.hubFileNodeId },
      { id: 'code:not-a-real-module' }
    ]);
    assert.equal(projected.length, 3);

    const moduleAnchor = projected[0];
    assert.ok(moduleAnchor);
    assert.equal(moduleAnchor.id, `code:${moduleId}`);
    assert.ok(moduleAnchor.provenance.length > 0, 'a resolved module anchor must be grounded');
    assert.deepEqual(moduleAnchor.reason_path, [moduleId]);
    assert.ok(moduleAnchor.token_cost > 0);

    const fileAnchor = projected[1];
    assert.ok(fileAnchor);
    assert.ok(fileAnchor.provenance.some((ref) => ref.path === HUB_FILE));
    assert.equal(fileAnchor.freshness, 'fresh');
    assert.ok(fileAnchor.claim_hash, 'a fresh, high-trust file anchor keeps its identity hash');

    const unresolved = projected[2];
    assert.ok(unresolved);
    assert.equal(unresolved.claim_hash, null);
    assert.equal(unresolved.source_hash, null);
    assert.deepEqual(unresolved.provenance, []);
    assert.equal(unresolved.trust_score, 0);
    assert.ok(unresolved.hydrate_hint?.includes('graph:unresolved_anchor'));
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('anchor ids resolve through both the code-pack form and the raw node id', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 1 });
  try {
    const moduleId = hubModuleId(fixture);
    const byModuleId = resolveContextGraphAnchorNode(fixture.reader, fixture.cursor, `code:${moduleId}`);
    assert.equal(byModuleId?.kind, 'module');
    const byNodeId = resolveContextGraphAnchorNode(fixture.reader, fixture.cursor, fixture.hubFileNodeId);
    assert.equal(byNodeId?.path, HUB_FILE);
    const byPrefixedNodeId = resolveContextGraphAnchorNode(fixture.reader, fixture.cursor, `code:${fixture.hubFileNodeId}`);
    assert.equal(byPrefixedNodeId?.id, fixture.hubFileNodeId);
    assert.equal(resolveContextGraphAnchorNode(fixture.reader, fixture.cursor, 'code:nope'), null);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('BLOCKED: a bare module label resolves nothing, because revision 1 has no label table', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 1 });
  try {
    // v1 resolved this through `index.nodesByLabel`. The exact table holds
    // canonical node ids and the basename table holds whole workspace-relative
    // paths, so a label reaches neither. Reported, never guessed at (ADR §4):
    // a BM25F match promoted to an anchor would attach one module's provenance
    // to another module's claim.
    assert.equal(resolveContextGraphAnchorNode(fixture.reader, fixture.cursor, `code:${HUB_MODULE_LABEL}`), null);
    const [anchor] = projectContextPackAnchors(fixture.reader, fixture.cursor, [{ id: `code:${HUB_MODULE_LABEL}` }]);
    assert.ok(anchor);
    assert.deepEqual(anchor.provenance, []);
    assert.equal(anchor.claim_hash, null);
    assert.equal(anchor.trust_score, 0);
    assert.ok(anchor.hydrate_hint?.includes('graph:unresolved_anchor'));
  } finally {
    removeProjectionFixture(fixture.root);
  }
});
