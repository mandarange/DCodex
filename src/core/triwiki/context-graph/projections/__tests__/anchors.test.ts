import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextGraphIndex } from '../../graph-index.js';
import { queryContextGraphSnapshot } from '../../query/index.js';
import {
  ATTENTION_FACT_TRUST_FLOOR,
  attentionHydrateHint,
  isFactGradeAnchor,
  projectContextGraphAnchors,
  projectContextPackAnchors,
  resolveContextGraphAnchorNode
} from '../anchors.js';
import { HUB_FILE, HUB_MODULE_LABEL, createProjectionFixture, removeProjectionFixture } from './projection-fixtures.js';

test('query-selected anchors carry a reason path, provenance and a token cost', () => {
  const fixture = createProjectionFixture({ fillerModules: 4 });
  try {
    const result = queryContextGraphSnapshot(fixture.index, {
      root: fixture.root,
      query: HUB_FILE,
      profile: 'implementation',
      tokenBudget: 2000,
      maxSelected: 8
    });
    const anchors = projectContextGraphAnchors(fixture.index, result.selected, 8);
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

test('a lower-trust or non-fresh anchor is hydrate-only and keeps no identity hashes', () => {
  const fixture = createProjectionFixture({ fillerModules: 1 });
  try {
    const nodes = fixture.snapshot.nodes.map((node) =>
      node.kind === 'symbol' ? { ...node, trust: 0.2 } : node
    );
    const weakened = buildContextGraphIndex({ ...fixture.snapshot, nodes });
    const result = queryContextGraphSnapshot(weakened, {
      root: fixture.root,
      query: HUB_FILE,
      profile: 'implementation',
      tokenBudget: 2000,
      maxSelected: 8
    });
    const anchors = projectContextGraphAnchors(weakened, result.selected, 8);
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

test('context pack anchors resolve back to graph nodes and gain reason path, provenance and cost', () => {
  const fixture = createProjectionFixture({ fillerModules: 2 });
  try {
    const projected = projectContextPackAnchors(fixture.index, [
      { id: `code:${HUB_MODULE_LABEL}` },
      { id: fixture.hubFileNodeId },
      { id: 'code:not-a-real-module' }
    ]);
    assert.equal(projected.length, 3);

    const moduleAnchor = projected[0];
    assert.ok(moduleAnchor);
    assert.equal(moduleAnchor.id, `code:${HUB_MODULE_LABEL}`);
    assert.ok(moduleAnchor.provenance.length > 0, 'a resolved module anchor must be grounded');
    assert.deepEqual(moduleAnchor.reason_path, ['module:src/core/hooks']);
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

test('anchor ids resolve through both the code-pack form and the raw node id', () => {
  const fixture = createProjectionFixture({ fillerModules: 1 });
  try {
    const byLabel = resolveContextGraphAnchorNode(fixture.index, `code:${HUB_MODULE_LABEL}`);
    assert.equal(byLabel?.kind, 'module');
    const byNodeId = resolveContextGraphAnchorNode(fixture.index, fixture.hubFileNodeId);
    assert.equal(byNodeId?.path, HUB_FILE);
    const byPrefixedNodeId = resolveContextGraphAnchorNode(fixture.index, `code:${fixture.hubFileNodeId}`);
    assert.equal(byPrefixedNodeId?.id, fixture.hubFileNodeId);
    assert.equal(resolveContextGraphAnchorNode(fixture.index, 'code:nope'), null);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});
