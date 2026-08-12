/**
 * CG2-13 output-shape parity for the projection lane.
 *
 * The six projections moved from a parsed JSON snapshot to the compact reader,
 * and every one of them sits under a consumer that reads its fields by name:
 * `subagents/triwiki-attention.ts` maps anchors field by field,
 * `triwiki/code-pack.ts` writes the pack as `sks.code-pack.v1`,
 * `align/code-navigation-align.ts` validates it and stages it, and
 * `commands/wiki-command.ts` checks it is still bound to its snapshot. A field
 * that quietly changed type would break all of them at once.
 *
 * So the shapes were captured from the v1 engine *before* the first edit and are
 * asserted here against the migrated ones. This is the check that a green test on
 * a wrapper cannot give: `readBoundedTriwikiAttention` compiled fine throughout
 * the migration, and compiling was never the question.
 *
 * The failure states are asserted alongside the success ones. Error parity is the
 * half a refactor loses silently — a projection that started returning a new code
 * for a missing index would leave every `=== 'context_graph_missing'` branch dead
 * with nothing failing anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryWorkspaceContext } from '../../query/index.js';
import { contextGraphQueryProfile } from '../../profiles.js';
import { projectContextGraphAnchors, projectContextPackAnchors } from '../anchors.js';
import { readContextGraphAttention } from '../attention.js';
import { projectCodePackFromGraph } from '../code-pack.js';
import { buildWorkspaceCodePack } from '../code-pack-workspace.js';
import { rankModuleCandidates } from '../module-view.js';
import { HUB_FILE, HUB_MODULE_LABEL, createProjectionFixture, removeProjectionFixture } from './projection-fixtures.js';
import { createIndexedProjectionFixture, resetContextIndexCache } from './projection-index-fixtures.js';
import {
  CODE_PACK_PROJECTION_SHAPE,
  CONTEXT_GRAPH_ATTENTION_RESULT_SHAPE,
  PROJECTED_ATTENTION_ANCHOR_SHAPE,
  PROJECTION_CANDIDATE_SHAPE,
  PROJECTION_FAILURE_CODES,
  WORKSPACE_CODE_PACK_RESULT_SHAPE,
  assertProjectionShape
} from './projection-shape-baseline.js';

test('the shape checker rejects a removed field, an added one and a changed type', () => {
  const spec = { id: 'string', token_cost: 'number' } as const;
  assertProjectionShape({ id: 'a', token_cost: 1 }, spec);
  assert.throws(() => assertProjectionShape({ id: 'a' }, spec), /token_cost: field is missing/);
  assert.throws(() => assertProjectionShape({ id: 'a', token_cost: 1, extra: 2 }, spec), /not part of the recorded shape/);
  assert.throws(() => assertProjectionShape({ id: 'a', token_cost: '1' }, spec), /expected number, found string/);
});

test('every projection still emits its recorded v1 shape', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 4 });
  try {
    const answer = await queryWorkspaceContext(
      fixture.root,
      { query: HUB_FILE, profile: 'implementation', tokenBudget: 2000, maxSelected: 8 },
      { index: fixture.handle }
    );

    const anchors = projectContextGraphAnchors(fixture.cursor, answer.hydration.nodes, 8);
    assert.ok(anchors.length > 0, 'the parity check needs at least one anchor to be about anything');
    for (const anchor of anchors) assertProjectionShape(anchor, PROJECTED_ATTENTION_ANCHOR_SHAPE, 'anchor');

    // The unresolved arm is a separate shape risk: it is the one built by hand
    // rather than from a node, so it is the one that loses a field first.
    const [unresolved] = projectContextPackAnchors(fixture.reader, fixture.cursor, [{ id: 'code:nope' }]);
    assert.ok(unresolved);
    assertProjectionShape(unresolved, PROJECTED_ATTENTION_ANCHOR_SHAPE, 'unresolvedAnchor');

    const candidates = rankModuleCandidates(
      fixture.reader,
      fixture.cursor,
      contextGraphQueryProfile('implementation'),
      'normal'
    );
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) assertProjectionShape(candidate, PROJECTION_CANDIDATE_SHAPE, 'candidate');

    const corpus = projectCodePackFromGraph(fixture.root, fixture.reader, { tokenBudget: 8000, generatedAt: 'X' });
    assertProjectionShape(corpus, CODE_PACK_PROJECTION_SHAPE, 'corpusProjection');
    assert.ok(corpus.pack.entries.length > 0, 'an empty pack proves nothing about entry shape');

    const queried = projectCodePackFromGraph(fixture.root, fixture.reader, {
      tokenBudget: 8000,
      generatedAt: 'X',
      query: HUB_FILE
    });
    assertProjectionShape(queried, CODE_PACK_PROJECTION_SHAPE, 'queryProjection');

    const workspace = await buildWorkspaceCodePack(fixture.root, { tokenBudget: 8000 });
    assertProjectionShape(workspace, WORKSPACE_CODE_PACK_RESULT_SHAPE, 'workspacePack');
    assert.equal(workspace.ok, true);

    const attention = await readContextGraphAttention({ root: fixture.root, query: HUB_FILE, limit: 6 });
    assertProjectionShape(attention, CONTEXT_GRAPH_ATTENTION_RESULT_SHAPE, 'attention');
    assert.equal(attention.available, true);
    assert.equal(attention.reason, null);
    assert.equal(attention.snapshotFreshness, 'fresh');
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('the refusal states keep their shape and their public codes', async () => {
  const fixture = createProjectionFixture({ fillerModules: 0 });
  resetContextIndexCache();
  try {
    const pack = await buildWorkspaceCodePack(fixture.root, { tokenBudget: 8000 });
    assertProjectionShape(pack, WORKSPACE_CODE_PACK_RESULT_SHAPE, 'missingPack');
    assert.equal(pack.ok, false);
    assert.equal(pack.errorCode, 'context_graph_missing');
    assert.ok(PROJECTION_FAILURE_CODES.includes(String(pack.errorCode)));
    assert.equal(pack.repairCommand, 'sks align run');

    const missing = await readContextGraphAttention({ root: fixture.root, query: HUB_FILE, limit: 6 });
    assertProjectionShape(missing, CONTEXT_GRAPH_ATTENTION_RESULT_SHAPE, 'missingAttention');
    assert.equal(missing.available, false);
    assert.equal(missing.reason, 'context_graph_missing');
    assert.deepEqual(missing.anchors, []);
    assert.equal(missing.repairCommand, 'sks align run');

    const empty = await readContextGraphAttention({ root: fixture.root, query: '   ', limit: 6 });
    assertProjectionShape(empty, CONTEXT_GRAPH_ATTENTION_RESULT_SHAPE, 'emptyAttention');
    assert.equal(empty.reason, 'empty_query');
    assert.equal(empty.snapshotHash, null);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a stale index is refused with the stale code, not answered from the previous generation', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 1 });
  try {
    // The preflight's fingerprint disagreeing with the pointer's is exactly the
    // "index describes a tree that has moved" case. It must fail closed: no
    // anchors, the stale code, and the repair command — never the last good
    // generation, which ADR §6 forbids as a fallback target.
    const stale = await readContextGraphAttention(
      { root: fixture.root, query: HUB_FILE, limit: 6 },
      { expectedSourceFingerprint: 'a-fingerprint-this-workspace-does-not-have' }
    );
    assertProjectionShape(stale, CONTEXT_GRAPH_ATTENTION_RESULT_SHAPE, 'staleAttention');
    assert.equal(stale.available, false);
    assert.equal(stale.reason, 'context_graph_stale');
    assert.deepEqual(stale.anchors, []);

    const pack = await buildWorkspaceCodePack(fixture.root, {
      tokenBudget: 8000,
      expectedSourceFingerprint: 'a-fingerprint-this-workspace-does-not-have'
    });
    assertProjectionShape(pack, WORKSPACE_CODE_PACK_RESULT_SHAPE, 'stalePack');
    assert.equal(pack.ok, false);
    assert.equal(pack.errorCode, 'context_graph_stale');
    assert.equal(pack.pack, null);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

/**
 * The two defects the release record names, asserted on this lane's own reads.
 *
 * `isTest` and `exported` are the metadata predicates these six carry, and both
 * arrive as strings from the writer. `contextNodeFlag` is what makes them match;
 * the module label is what still does not resolve.
 */
test('metadata flags survive the string interning, and the label lane is still absent', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 1 });
  try {
    const hub = fixture.cursor.node(fixture.reader.exact(fixture.hubFileNodeId).node(0));
    assert.ok(hub, 'the hub file must resolve by its canonical id');
    // Measured, not assumed: the writer interned the extractor's boolean as text.
    assert.equal(hub.metadata.isTest, 'false');
    assert.equal(typeof hub.metadata.fanIn, 'string');

    const candidates = rankModuleCandidates(
      fixture.reader,
      fixture.cursor,
      contextGraphQueryProfile('implementation'),
      'normal'
    );
    const hubModule = candidates.find((candidate) => candidate.node.label === HUB_MODULE_LABEL);
    assert.ok(hubModule);
    // `exported` is read through `contextNodeFlag`. Compared against `true` it is
    // always false, and this sentence collapses to "no exported surface".
    assert.ok(
      hubModule.text.includes('Key exports:'),
      `the exported-symbol predicate lost its metadata arm: ${hubModule.text}`
    );
    // `fanIn` and `fileCount` are interned as text too; the headline keeps them
    // only because they are parsed rather than type-checked.
    assert.ok(/\d+ files?,/.test(hubModule.text), hubModule.text);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});
