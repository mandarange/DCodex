import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateCodePack } from '../../../code-pack.js';
import { CONTEXT_GRAPH_MISSING_ERROR } from '../../contracts.js';
import { buildContextGraphIndex } from '../../graph-index.js';
import { contextGraphQueryProfile } from '../../profiles.js';
import { clearContextGraphSnapshotCache } from '../../query/snapshot-cache.js';
import { readSourceHashes } from '../../compiler/freshness.js';
import {
  buildCodePackFromGraph,
  computeCodePackIndexDigest,
  isCodePackProjectionBoundToSnapshot,
  projectCodePackFromGraph
} from '../code-pack.js';
import { buildWorkspaceCodePack } from '../code-pack-workspace.js';
import { estimateEntryTokenCost } from '../node-summary.js';
import { rankModuleCandidates } from '../module-view.js';
import {
  HUB_FILE,
  HUB_MODULE_LABEL,
  createProjectionFixture,
  removeProjectionFixture,
  writeFixtureGraph,
  type ProjectionFixture
} from './projection-fixtures.js';

const BUDGET = 8000;

/**
 * The retired scanner packed module cards in inventory order until the budget ran
 * out. This reproduces that discipline over the identical entry text, so a
 * comparison isolates the ordering change instead of a text-length change.
 */
function moduleOrderPackCost(fixture: ProjectionFixture, budget: number): { cost: number; entries: number } {
  const byIndexOrder = rankModuleCandidates(fixture.index, contextGraphQueryProfile('implementation'), 'normal')
    .slice()
    .sort((left, right) => (left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0));
  let cost = 0;
  let entries = 0;
  for (const candidate of byIndexOrder) {
    const entryCost = estimateEntryTokenCost(candidate.text);
    if (cost + entryCost > budget) continue;
    cost += entryCost;
    entries += 1;
  }
  return { cost, entries };
}

test('a query pack costs fewer tokens than the module-order pack for the same budget', () => {
  const fixture = createProjectionFixture();
  try {
    const baseline = moduleOrderPackCost(fixture, BUDGET);
    const pack = buildCodePackFromGraph(fixture.root, fixture.index, {
      tokenBudget: BUDGET,
      query: HUB_FILE,
      generatedAt: '2026-02-02T00:00:00.000Z'
    });
    assert.ok(baseline.entries > 10, `baseline should pack the whole inventory, packed ${baseline.entries}`);
    assert.ok(pack.entries.length > 0, 'the query pack must not be empty');
    assert.ok(
      pack.total_token_cost < baseline.cost,
      `query pack ${pack.total_token_cost} should cost less than module-order pack ${baseline.cost}`
    );
    const citedPaths = pack.entries.flatMap((entry) => entry.citations.map((citation) => citation.path));
    assert.ok(citedPaths.includes(HUB_FILE), `query pack should cite ${HUB_FILE}, cited ${JSON.stringify(citedPaths)}`);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('every projected entry is grounded in a citation that exists on disk', async () => {
  const fixture = createProjectionFixture({ fillerModules: 4 });
  try {
    const pack = buildCodePackFromGraph(fixture.root, fixture.snapshot, { tokenBudget: BUDGET });
    assert.ok(pack.entries.length > 0);
    for (const entry of pack.entries) {
      assert.ok(entry.citations.length > 0, `entry ${entry.id} has no citation`);
      for (const citation of entry.citations) {
        assert.ok(fs.existsSync(path.join(fixture.root, citation.path)), `missing cited path ${citation.path}`);
      }
    }
    const validation = await validateCodePack(pack, fixture.root);
    assert.deepEqual(validation.issues, []);
    assert.equal(validation.ok, true);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('freshness is decided by real source hashes instead of a blanket unknown', async () => {
  const fixture = createProjectionFixture({ fillerModules: 2 });
  try {
    const paths = [HUB_FILE, 'src/core/hooks/gate.ts', 'src/core/mcp/manager.ts', 'src/core/ppt/review.ts'];
    const observedSourceHashes = await readSourceHashes(fixture.root, paths);
    const fresh = buildCodePackFromGraph(fixture.root, fixture.index, { tokenBudget: BUDGET, observedSourceHashes });
    assert.ok(fresh.entries.length > 0);
    assert.equal(
      fresh.entries.every((entry) => entry.freshness !== 'unknown'),
      true,
      `entries still report unknown: ${JSON.stringify(fresh.entries.map((entry) => [entry.id, entry.freshness]))}`
    );
    assert.ok(fresh.entries.some((entry) => entry.freshness === 'fresh'));

    fs.writeFileSync(path.join(fixture.root, HUB_FILE), 'export function runHooks(): string { return "changed"; }\n');
    const afterEdit = await readSourceHashes(fixture.root, paths);
    const stale = buildCodePackFromGraph(fixture.root, fixture.index, {
      tokenBudget: BUDGET,
      observedSourceHashes: afterEdit
    });
    const hubEntry = stale.entries.find((entry) => entry.id === `code:${HUB_MODULE_LABEL}`);
    assert.ok(hubEntry, 'the hub module entry should be packed');
    assert.equal(hubEntry.freshness, 'stale');
    assert.ok(hubEntry.trust_score < 1);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a stale snapshot can only downgrade freshness, never upgrade it', () => {
  const fixture = createProjectionFixture({ fillerModules: 1 });
  try {
    const pack = buildCodePackFromGraph(fixture.root, fixture.index, {
      tokenBudget: BUDGET,
      snapshotFreshness: 'stale'
    });
    assert.ok(pack.entries.length > 0);
    assert.equal(pack.entries.every((entry) => entry.freshness === 'stale'), true);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a module node carries no bytes, so its own recorded verdict cannot poison its files', () => {
  const fixture = createProjectionFixture({ fillerModules: 1 });
  try {
    // The compiler marks a module `stale` because its path is a directory that
    // cannot be read as a file. The projection must let the contained files decide.
    const nodes = fixture.snapshot.nodes.map((node) =>
      node.kind === 'module' ? { ...node, freshness: 'stale' as const } : node
    );
    const index = buildContextGraphIndex({ ...fixture.snapshot, nodes });
    const pack = buildCodePackFromGraph(fixture.root, index, { tokenBudget: BUDGET });
    const hubEntry = pack.entries.find((entry) => entry.id === `code:${HUB_MODULE_LABEL}`);
    assert.ok(hubEntry);
    assert.equal(hubEntry.freshness, 'fresh');
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a caller-supplied stale status governs the whole pack instead of being ignored', async () => {
  const fixture = createProjectionFixture({ fillerModules: 2 });
  clearContextGraphSnapshotCache();
  try {
    await writeFixtureGraph(fixture);
    const result = await buildWorkspaceCodePack(fixture.root, {
      tokenBudget: BUDGET,
      status: { status: 'stale', reasons: ['head_changed'] },
      allowStale: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.snapshotFreshness, 'stale');
    assert.ok(result.pack);
    assert.equal(result.pack.entries.every((entry) => entry.freshness === 'stale'), true);
  } finally {
    clearContextGraphSnapshotCache();
    removeProjectionFixture(fixture.root);
  }
});

test('index_digest binds to the snapshot hash and moves when an export changes', () => {
  const base = createProjectionFixture({ fillerModules: 2 });
  const changed = createProjectionFixture({ fillerModules: 2, extraExport: true });
  try {
    const options = { tokenBudget: BUDGET, generatedAt: '2026-02-02T00:00:00.000Z' } as const;
    const first = buildCodePackFromGraph(base.root, base.index, options);
    const repeat = buildCodePackFromGraph(base.root, base.index, options);
    assert.equal(first.index_digest, repeat.index_digest, 'the same graph must project the same digest');
    assert.equal(first.index_digest, computeCodePackIndexDigest(base.snapshot.snapshotHash, first.entries));
    assert.equal(isCodePackProjectionBoundToSnapshot(base.snapshot.snapshotHash, first), true);

    const withExtraExport = buildCodePackFromGraph(changed.root, changed.index, options);
    assert.notEqual(base.snapshot.snapshotHash, changed.snapshot.snapshotHash);
    assert.notEqual(first.index_digest, withExtraExport.index_digest);
    assert.equal(isCodePackProjectionBoundToSnapshot(changed.snapshot.snapshotHash, first), false);
  } finally {
    removeProjectionFixture(base.root);
    removeProjectionFixture(changed.root);
  }
});

test('corpus packing follows graph importance rather than module id order', () => {
  const fixture = createProjectionFixture();
  try {
    const projection = projectCodePackFromGraph(fixture.root, fixture.index, { tokenBudget: BUDGET });
    const ids = projection.pack.entries.map((entry) => entry.id);
    const hubRank = ids.indexOf(`code:${HUB_MODULE_LABEL}`);
    assert.ok(hubRank >= 0, `hub module missing from ${JSON.stringify(ids)}`);
    const firstFillerRank = ids.findIndex((id) => id.startsWith('code:core-mod'));
    assert.ok(firstFillerRank >= 0, 'filler modules should still be packed');
    assert.ok(hubRank < firstFillerRank, `hub (${hubRank}) should outrank the first filler (${firstFillerRank})`);
    assert.ok(projection.candidateCount >= ids.length);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('the token budget is never exceeded and the overflow is counted', () => {
  const fixture = createProjectionFixture({ fillerModules: 6 });
  try {
    const full = projectCodePackFromGraph(fixture.root, fixture.index, { tokenBudget: BUDGET });
    const firstCost = full.pack.entries[0]?.token_cost ?? 0;
    assert.ok(firstCost > 0);
    const bounded = projectCodePackFromGraph(fixture.root, fixture.index, { tokenBudget: firstCost });
    assert.ok(bounded.pack.total_token_cost <= firstCost);
    assert.ok(bounded.omittedForBudget > 0, 'entries dropped for budget must be counted');
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('buildWorkspaceCodePack projects from the stored graph with no scanner involvement', async () => {
  const fixture = createProjectionFixture({ fillerModules: 3 });
  clearContextGraphSnapshotCache();
  try {
    await writeFixtureGraph(fixture, 'fixturehead0000');
    const result = await buildWorkspaceCodePack(fixture.root, { tokenBudget: BUDGET });
    assert.equal(result.ok, true);
    assert.equal(result.errorCode, null);
    const pack = result.pack;
    assert.ok(pack, 'a pack should be produced');
    assert.equal(pack.git_head_sha, 'fixturehead0000', 'HEAD comes from graph metadata, not a git spawn');
    assert.equal(pack.index_digest, computeCodePackIndexDigest(fixture.snapshot.snapshotHash, pack.entries));
    assert.equal(pack.source_file_count, fixture.snapshot.nodes.filter((node) => node.kind === 'file').length);
    assert.equal(pack.entries.every((entry) => entry.freshness === 'fresh'), true);
    assert.deepEqual((await validateCodePack(pack, fixture.root)).issues, []);
  } finally {
    clearContextGraphSnapshotCache();
    removeProjectionFixture(fixture.root);
  }
});

test('a missing graph is reported explicitly instead of producing a degraded pack', async () => {
  const fixture = createProjectionFixture({ fillerModules: 0 });
  clearContextGraphSnapshotCache();
  try {
    const result = await buildWorkspaceCodePack(fixture.root, { tokenBudget: BUDGET });
    assert.equal(result.ok, false);
    assert.equal(result.pack, null);
    assert.equal(result.errorCode, CONTEXT_GRAPH_MISSING_ERROR);
    assert.equal(result.repairCommand, 'sks wiki refresh --code');
    assert.ok(result.errors.some((issue) => issue.includes('sks wiki refresh --code')));
  } finally {
    clearContextGraphSnapshotCache();
    removeProjectionFixture(fixture.root);
  }
});
