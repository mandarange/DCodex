/**
 * `searchContext` answered through the CRK2 facade (CG2-13).
 *
 * These are integration tests in the strict sense the card asks for: they
 * publish a real generation into a temp workspace — pointer, meta, and a
 * content-addressed `.idx` written by `runtime-index/writer.ts` — and then call
 * the public `searchContext` with nothing injected but the freshness verdict.
 * Nothing here reaches into the kernel, the reader, or the cache.
 *
 * The parity test is the load-bearing one. It compares the *shape* of the
 * response against the map recorded on the pre-migration engine, not the result
 * set: CRK2 is a different engine and is expected to return different nodes.
 * Asserting v1's rows would pin v1's bugs, including the empty Korean answer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchContext } from '../context.js';
import { V1_SEARCH_RESPONSE_FIELD_MAP } from './context-response-baseline.js';
import { diffResponseFieldMaps, searchResponseFieldMap } from './response-shape.js';
import { SEARCH_SCHEMA_VERSION, type SearchMatch, type SearchRequest } from '../types.js';
import {
  CONTEXT_GRAPH_REPAIR_COMMAND,
  type ContextGraphSnapshot,
  type ContextGraphStatus
} from '../../triwiki/context-graph/contracts.js';
import {
  buildFixtureSnapshot,
  FIXTURE_OBSERVED_AT,
  IDS,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureWorkspace
} from '../../triwiki/context-graph/query/__tests__/query-fixtures.js';
import {
  materializeSources,
  publishFixtureContextIndex,
  resetContextIndexCache
} from '../../triwiki/context-graph/query/__tests__/workspace-fixtures.js';

const FIXTURE_SOURCES = [
  'src/app/service.ts',
  'src/app/consumer.ts',
  'src/app/__tests__/service.test.ts',
  'src/legacy/old.ts',
  'src/other/a.ts',
  'src/other/b.ts',
  'src/cli/manifest.ts',
  'config/release-gates.json',
  'config/proofs.json'
] as const;

/**
 * A path that is a real workspace-relative path in the fixture, which is what
 * format revision 1's basename table is keyed by. See the recall note in
 * `answers a text query` below for why the tests anchor on a path.
 */
const ANCHOR_QUERY = 'src/other/a.ts';

function freshStatus(snapshot: ContextGraphSnapshot): ContextGraphStatus {
  return {
    schema: 'sks.context-graph-status.v1',
    status: 'fresh',
    snapshotHash: snapshot.snapshotHash,
    generatedAt: FIXTURE_OBSERVED_AT,
    reasons: [],
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    errorCode: null,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount
  };
}

function contextRequest(root: string, query: string, maxMatches = 50): SearchRequest {
  return { schemaVersion: SEARCH_SCHEMA_VERSION, mode: 'context', root, query, limits: { maxMatches } };
}

interface Workspace {
  root: string;
  snapshot: ContextGraphSnapshot;
  status: ContextGraphStatus;
}

/**
 * A workspace with a published compact index.
 *
 * The v1 JSON snapshot is written too, and that is not vestigial: the freshness
 * preflight still runs through `contextGraphStatus`, which parses it. Removing
 * that dependency is a `store/graph-status.ts` change and is reported as a
 * CG2-15 blocker rather than smuggled in here.
 */
async function makeWorkspace(prefix: string, withSources = true): Promise<Workspace> {
  const root = makeFixtureRoot(prefix);
  const snapshot = buildFixtureSnapshot();
  resetContextIndexCache();
  await writeFixtureWorkspace(root, snapshot);
  if (withSources) materializeSources(root, FIXTURE_SOURCES);
  await publishFixtureContextIndex(root, snapshot);
  return { root, snapshot, status: freshStatus(snapshot) };
}

function nodeIdOf(match: SearchMatch): string {
  return String(match.meta?.node_id ?? '');
}

describe('search context answers from the compact index', () => {
  it('answers a path anchor end to end through the facade', async () => {
    const workspace = await makeWorkspace('crk2-anchor');
    try {
      const response = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      assert.equal(response.processSpawns, 0);
      assert.equal(response.engine, 'triwiki+context-graph');
      assert.equal(response.context?.method, 'context_graph_query');
      assert.ok(response.matches.length > 1, 'the traversal must reach beyond the anchor');

      const seed = response.matches.find((match) => nodeIdOf(match) === IDS.fileOtherA);
      assert.ok(seed, 'the anchored path must be selected');
      assert.equal(seed.confidence, 'file_path');
      assert.equal(seed.meta?.seed, true);
      assert.equal(seed.path, ANCHOR_QUERY);

      const graph = response.context?.graph;
      assert.ok(graph);
      assert.equal(graph.snapshotHash, workspace.snapshot.snapshotHash);
      assert.equal(graph.provenanceCoverage, 1, 'provenanceCoverage is an equality floor');
      for (const match of response.matches) {
        const provenance = match.meta?.provenance as Array<{ path: string }>;
        assert.ok(Array.isArray(provenance) && provenance.length > 0, 'every match must be grounded');
        for (const ref of provenance) assert.ok(!ref.path.startsWith('/'), 'paths stay workspace-relative');
      }
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('keeps every field of the published response shape', async () => {
    const responses: unknown[] = [];
    const cases: Array<[string, (root: string, status: ContextGraphStatus) => Promise<unknown>]> = [
      ['anchor', (root, status) => searchContext(contextRequest(root, ANCHOR_QUERY), { cache: false, status })],
      ['budget', (root, status) => searchContext(contextRequest(root, ANCHOR_QUERY), { cache: false, status, tokenBudget: 40 })],
      ['review', (root, status) => searchContext(contextRequest(root, ANCHOR_QUERY), { cache: false, status, profile: 'review' })],
      ['korean', (root, status) => searchContext(contextRequest(root, '서비스 실행'), { cache: false, status })],
      ['empty', (root) => searchContext(contextRequest(root, '   '), { cache: false })]
    ];

    for (const [name, run] of cases) {
      const workspace = await makeWorkspace(`crk2-shape-${name}`);
      try {
        responses.push(await run(workspace.root, workspace.status));
      } finally {
        removeFixtureRoot(workspace.root);
      }
    }

    const missing = makeFixtureRoot('crk2-shape-missing');
    try {
      responses.push(await searchContext(contextRequest(missing, ANCHOR_QUERY), { cache: false }));
    } finally {
      removeFixtureRoot(missing);
    }

    const diff = diffResponseFieldMaps(V1_SEARCH_RESPONSE_FIELD_MAP, searchResponseFieldMap(responses));
    assert.deepEqual(diff.broken, [], 'no caller-visible field may disappear or change type');
    // `grounding` is additive: §7 made `hydrated` ambiguous across versions and
    // this says which claim a row is making. Additions are allowed and recorded.
    assert.deepEqual(diff.added, ['$.matches[].meta.grounding']);
  });

  it('refuses a workspace with no published index, and offers no lexical consolation', async () => {
    const root = makeFixtureRoot('crk2-missing');
    resetContextIndexCache();
    try {
      const snapshot = buildFixtureSnapshot();
      await writeFixtureWorkspace(root, snapshot);
      materializeSources(root, FIXTURE_SOURCES);

      const response = await searchContext(contextRequest(root, ANCHOR_QUERY), {
        cache: false,
        status: freshStatus(snapshot)
      });

      assert.equal(response.ok, false);
      assert.deepEqual(response.matches, []);
      assert.deepEqual(response.errors, ['context_graph_missing']);
      assert.equal(response.context?.repairCommand, 'sks align run');
      assert.equal(response.context?.hydrated, false);
      assert.equal(response.processSpawns, 0);
      // The precise CRK2 code is carried without replacing the published one.
      assert.ok(response.warnings.includes('context_index_missing'), response.warnings.join(','));
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('gives an exact confidence only to an anchor-lane seed', async () => {
    const workspace = await makeWorkspace('crk2-confidence');
    try {
      const response = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), {
        cache: false,
        status: workspace.status
      });
      assert.equal(response.ok, true);

      for (const match of response.matches) {
        const exact = match.confidence === 'exact_definition' || match.confidence === 'exact_reference';
        if (!exact) continue;
        assert.equal(match.meta?.seed, true, `${nodeIdOf(match)} claims exact without being a seed`);
      }
      // A node the walk reached is a candidate, not an exact match (ADR §4).
      const traversed = response.matches.filter((match) => match.meta?.seed !== true);
      assert.ok(traversed.length > 0, 'the fixture must produce traversed matches');
      for (const match of traversed) {
        assert.notEqual(match.confidence, 'exact_definition');
        assert.notEqual(match.confidence, 'exact_reference');
      }
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('reuses a response only within the generation that produced it', async () => {
    const workspace = await makeWorkspace('crk2-cache');
    try {
      const first = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), { status: workspace.status });
      assert.equal(first.cacheHit, false);

      const repeat = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), { status: workspace.status });
      assert.equal(repeat.cacheHit, true);

      const otherProfile = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), {
        status: workspace.status,
        profile: 'review'
      });
      assert.equal(otherProfile.cacheHit, false);
      assert.equal(otherProfile.context?.graph?.profile, 'review');
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('produces an identical ordering on three consecutive runs', async () => {
    const workspace = await makeWorkspace('crk2-order');
    try {
      const signatures: string[] = [];
      for (let run = 0; run < 3; run += 1) {
        const response = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), {
          cache: false,
          status: workspace.status
        });
        assert.equal(response.ok, true);
        assert.equal(response.deterministicOrder, 'path_line_column');
        signatures.push(
          JSON.stringify(response.matches.map((match) => [match.path, match.line ?? null, match.confidence, nodeIdOf(match)]))
        );
      }
      assert.equal(signatures[0], signatures[1]);
      assert.equal(signatures[1], signatures[2]);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('is hydrated only when provenance resolves to a real file', async () => {
    const workspace = await makeWorkspace('crk2-dry', false);
    try {
      const response = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      assert.ok(response.matches.length > 0, 'the index still answers without the sources on disk');
      assert.equal(response.context?.hydrated, false);
      assert.equal(response.scanned.files, 0);
      for (const match of response.matches) {
        assert.equal(match.meta?.provenance_resolved, false);
        assert.equal(match.meta?.grounding, 'unverified');
      }
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });
});
