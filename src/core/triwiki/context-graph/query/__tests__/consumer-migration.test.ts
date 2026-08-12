/**
 * CG2-13 consumer migration, asserted on the consumers rather than on imports.
 *
 * The card's failure mode is stated in the inventory: a consumer whose v1 import
 * vanished when the engine was deleted has not been proven to still work. So each
 * consumer here is called through its own public entry point against a real
 * published generation, and the import assertion at the bottom is a *second*
 * check, never the evidence.
 *
 * Two of them are wrappers over `projections/**`. That lane has now migrated too,
 * so their cases assert retrieval — anchors carrying the published generation's
 * snapshot hash, a pack with grounded entries — rather than that the wrapper
 * compiles, which was never the question.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { narutoContextGraphAdvice } from '../../../../naruto/context-graph-advisor.js';
import { readBoundedTriwikiAttention } from '../../../../subagents/triwiki-attention.js';
import { buildCodePack } from '../../../code-pack.js';
import {
  buildFixtureSnapshot,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureWorkspace
} from './query-fixtures.js';
import { materializeSources, publishFixtureContextIndex, resetContextIndexCache } from './workspace-fixtures.js';
import { openWorkspaceContextIndex, workspaceContextFailureOf } from '../index.js';

/**
 * The repository's `src/`, found by walking up to the package root.
 *
 * Resolved rather than counted: this test executes from `dist/`, so a fixed
 * number of `..` segments silently points at compiled output and the import
 * assertion then reads files that do not exist — or worse, reads the emitted
 * JavaScript and passes for the wrong reason.
 */
function sourceRoot(): string {
  let at = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 12; up += 1) {
    if (fs.existsSync(path.join(at, 'package.json'))) return path.join(at, 'src');
    at = path.dirname(at);
  }
  throw new Error('package root not found above this test');
}

/** Module specifiers no migrated consumer may name. `query/index.js` is the facade and is allowed. */
const RETIRED_SPECIFIERS = [
  'context-graph-seeds',
  'query/load.js',
  'query/seeds.js',
  'query/snapshot-cache.js',
  'graph-index.js',
  'store/snapshot-store.js',
  'runtime-index/'
] as const;

/**
 * The files this card owns, including the projection lane the two wrappers sit
 * on. Listing the wrapper without its projection is what let `triwiki/code-pack.ts`
 * pass this check for a round while its retrieval still ran through v1.
 */
const MIGRATED_CONSUMERS = [
  'core/search/context.ts',
  'core/search/context-projection.ts',
  'core/naruto/context-graph-advisor.ts',
  'core/naruto/context-graph-advisor-scope.ts',
  'core/subagents/triwiki-attention.ts',
  'core/triwiki/code-pack.ts',
  'core/triwiki/context-graph/projections/anchors.ts',
  'core/triwiki/context-graph/projections/attention.ts',
  'core/triwiki/context-graph/projections/code-pack.ts',
  'core/triwiki/context-graph/projections/code-pack-entry.ts',
  'core/triwiki/context-graph/projections/code-pack-workspace.ts',
  'core/triwiki/context-graph/projections/graph-facts.ts',
  'core/triwiki/context-graph/projections/module-view.ts',
  'core/triwiki/context-graph/projections/node-summary.ts',
  'core/triwiki/context-graph/projections/projection-candidate.ts'
] as const;

describe('CG2-13 consumers answer through the facade', () => {
  it('naruto resolves its own workspace index and finds a real write conflict', async () => {
    const root = makeFixtureRoot('cg213-naruto');
    resetContextIndexCache();
    try {
      const snapshot = buildFixtureSnapshot();
      await publishFixtureContextIndex(root, snapshot);

      // No `reader` injected: the advisory must open the workspace itself.
      const advice = await narutoContextGraphAdvice({
        root,
        task: 'adjust the service',
        slices: [
          { id: 'S1', writePaths: ['src/app/service.ts'] },
          { id: 'S2', writePaths: ['src/app/service.ts'] }
        ]
      });

      assert.equal(advice.ok, true);
      assert.equal(advice.snapshot_hash, snapshot.snapshotHash);
      assert.equal(advice.parallel_safe, false);
      const pair = advice.pairs[0];
      assert.ok(pair);
      assert.equal(pair.kind, 'direct_write_overlap');
      // The declared file must be named. The rest of the shared list is the two
      // slices' dependency closures overlapping, which is the point of the
      // closure — asserting an exact list would pin the fixture's edges instead.
      assert.ok(pair.shared_paths.includes('src/app/service.ts'), pair.shared_paths.join(','));
      assert.equal(advice.recommended_max_parallel_slices, 1);
      assert.equal(advice.guarantees.process_spawns, 0);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('naruto refuses conservatively when no index is published', async () => {
    const root = makeFixtureRoot('cg213-naruto-missing');
    resetContextIndexCache();
    try {
      const advice = await narutoContextGraphAdvice({
        root,
        slices: [{ id: 'S1', writePaths: ['src/app/service.ts'] }, { id: 'S2', writePaths: ['src/other/a.ts'] }]
      });
      assert.equal(advice.ok, false);
      assert.equal(advice.graph_status, 'missing');
      assert.equal(advice.error_code, 'context_graph_missing');
      assert.equal(advice.parallel_safe, false);
      assert.equal(advice.recommended_max_parallel_slices, 1);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('a symbol-only slice is reported unresolved rather than guessed', async () => {
    const root = makeFixtureRoot('cg213-naruto-symbol');
    resetContextIndexCache();
    try {
      await publishFixtureContextIndex(root, buildFixtureSnapshot());
      const advice = await narutoContextGraphAdvice({
        root,
        slices: [{ id: 'S1', symbols: ['runService'] }, { id: 'S2', writePaths: ['src/other/a.ts'] }]
      });

      assert.equal(advice.ok, true);
      const scope = advice.scopes.find((entry) => entry.slice_id === 'S1');
      assert.ok(scope);
      // Format revision 1 has no label table. The honest answer is "unresolved",
      // which makes the advisory conservative — never a BM25F guess promoted to
      // a declared write scope (ADR §4).
      assert.deepEqual(scope.seed_node_ids, []);
      assert.ok(scope.unresolved_seeds.includes('runService'));
      assert.ok(advice.conservative_reasons.includes('slice_scope_unresolved'));
      const pair = advice.pairs[0];
      assert.ok(pair);
      assert.equal(pair.parallel_safe, false, 'an unproven slice is never called parallel-safe');
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('the facade refuses a missing index with a frozen code and a repair command', async () => {
    const root = makeFixtureRoot('cg213-facade-missing');
    resetContextIndexCache();
    try {
      await assert.rejects(async () => openWorkspaceContextIndex(root));
      const failure = await openWorkspaceContextIndex(root).catch((error: unknown) => workspaceContextFailureOf(error));
      assert.deepEqual(failure, { code: 'context_index_missing', repairCommand: 'sks align run' });
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('bounded triwiki attention answers from the published compact index', async () => {
    const root = makeFixtureRoot('cg213-attention');
    resetContextIndexCache();
    try {
      const snapshot = buildFixtureSnapshot();
      await writeFixtureWorkspace(root, snapshot);
      materializeSources(root, ['src/app/service.ts']);
      await publishFixtureContextIndex(root, snapshot);

      const attention = await readBoundedTriwikiAttention(root, 6, 'src/app/service.ts');
      assert.equal(attention.schema, 'sks.subagent-triwiki-attention.v1');
      assert.equal(attention.hydration_policy, 'on_demand_only');
      assert.equal(attention.full_pack_injected, false);
      assert.ok(attention.anchor_limit <= 6);
      assert.equal(attention.repair_command, 'sks align run');
      // The projection lane migrated, so this is now an assertion about
      // retrieval and not merely about the wrapper compiling: the anchors have
      // to carry the snapshot hash of the generation that was just published.
      assert.equal(attention.available, true);
      assert.equal(attention.snapshot_hash, snapshot.snapshotHash);
      assert.ok(attention.anchors.length > 0);
      for (const anchor of attention.anchors) assert.ok(anchor.provenance.length > 0);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('the code pack projects from the published compact index', async () => {
    const root = makeFixtureRoot('cg213-code-pack');
    resetContextIndexCache();
    try {
      const snapshot = buildFixtureSnapshot();
      await publishFixtureContextIndex(root, snapshot);
      const handle = await openWorkspaceContextIndex(root);
      const pack = buildCodePack(root, handle.reader, { query: 'src/app/service.ts' });
      assert.equal(pack.schema, 'sks.code-pack.v1');
      assert.ok(pack.index_digest.length > 0, 'the pack must stay bound to its snapshot');
      assert.ok(pack.entries.length > 0, 'a path anchor must select something');
      for (const entry of pack.entries) {
        assert.ok(entry.citations.length > 0, `entry ${entry.id} must be grounded`);
      }
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('no migrated consumer names a retired module', () => {
    const offenders: string[] = [];
    for (const relative of MIGRATED_CONSUMERS) {
      const source = fs.readFileSync(path.join(sourceRoot(), relative), 'utf8');
      for (const line of source.split('\n')) {
        if (!/^\s*(import|export)\b/.test(line) || !line.includes('from ')) continue;
        for (const specifier of RETIRED_SPECIFIERS) {
          if (line.includes(specifier)) offenders.push(`${relative}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'a migrated consumer still imports a retired module');
  });
});
