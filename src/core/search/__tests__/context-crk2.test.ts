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

/** Resolves through the anchor lane: the basename table is keyed by whole path. */
const ANCHOR_QUERY = 'src/other/a.ts';

/**
 * Resolves only through the lexical lane — it is neither a canonical node id nor
 * a path, so the anchor lane cannot see it. Keeping both queries is what
 * separates "the plumbing works" from "text retrieval works": an index built
 * without a lexicon answers the first and returns nothing for the second.
 */
const TEXT_QUERY = 'runService';

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
 * `writeFixtureWorkspace` still runs, but only to give the meta file these tests
 * inject a status against — the freshness preflight moved to
 * `store/index-freshness.ts` and no longer parses the JSON snapshot, so nothing
 * on the query path reads it any more.
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

  it('answers a text query that no anchor can resolve', async () => {
    const workspace = await makeWorkspace('crk2-lexical');
    try {
      const response = await searchContext(contextRequest(workspace.root, TEXT_QUERY), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      assert.ok(
        response.matches.length > 0,
        `"${TEXT_QUERY}" is neither a node id nor a path, so a hit here can only have come from the lexical lane`
      );

      // §4 is the point of the assertion, not a side note: BM25F is what found
      // these, and a BM25F score never yields an exact confidence at any
      // magnitude. If this ever admits `exact_*`, a text match has been promoted
      // to a relation.
      for (const match of response.matches) {
        assert.notEqual(match.confidence, 'exact_definition', nodeIdOf(match));
        assert.notEqual(match.confidence, 'exact_reference', nodeIdOf(match));
      }
      const graph = response.context?.graph;
      assert.ok(graph);
      assert.ok(graph.seedCount > 0, 'the lexical lane must have admitted seeds');
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

  /**
   * The join, not the mechanism.
   *
   * `admitProvidedSeeds` already had passing unit tests while every production
   * caller dropped the field, so a lane test cannot detect this class. What has
   * to be asserted here is that a caller's changed path *arrives*: the query
   * below names neither the path nor anything in that file, so the node can only
   * be in the answer because the seed reached the kernel.
   */
  it('carries a caller-supplied changed path into the answer as a verified anchor', async () => {
    const workspace = await makeWorkspace('crk2-changed-paths');
    try {
      // A query that matches nothing isolates the join: every node below can
      // only be in the answer because the caller's path reached the anchor lane.
      const request = contextRequest(workspace.root, 'zzzzqqq');
      const without = await searchContext(request, { cache: false, status: workspace.status });
      assert.equal(without.ok, true);
      assert.deepEqual(without.matches, [], 'the control must find nothing, or the test proves nothing');

      const seeded = await searchContext(request, {
        cache: false,
        status: workspace.status,
        changedPaths: ['src/other/b.ts']
      });
      const seedMatch = seeded.matches.find((match) => nodeIdOf(match) === IDS.fileOtherB);
      assert.ok(seedMatch, 'a caller-resolved changed path must reach the kernel as a seed');
      assert.equal(seedMatch.confidence, 'file_path');
      assert.equal(seedMatch.meta?.seed, true);
      assert.ok(seeded.matches.length > 1, 'the traversal must run from the seed, not stop at it');

      // The same field on the published request shape, which is how an external
      // caller of `sks.search-provider.v1` supplies it.
      const viaRequest = await searchContext(
        { ...request, changedPaths: ['src/other/b.ts'] },
        { cache: false, status: workspace.status }
      );
      assert.ok(viaRequest.matches.some((match) => nodeIdOf(match) === IDS.fileOtherB));
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('never lets an unresolvable changed path claim an exact confidence', async () => {
    const workspace = await makeWorkspace('crk2-changed-unknown');
    try {
      const response = await searchContext(contextRequest(workspace.root, 'zzzzqqq'), {
        cache: false,
        status: workspace.status,
        // One path outside the workspace, one that resolves to no node. Neither
        // may be completed, guessed at, or reported as an exact hit (§4), and an
        // unresolvable seed must not conjure an answer to a query that has none.
        changedPaths: ['/etc/passwd', 'src/does/not/exist.ts']
      });
      assert.equal(response.ok, true);
      assert.deepEqual(response.matches, []);
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

      // Seeds change the answer, so a cached answer keyed without them would
      // hand back the unseeded one and silently undo the seed join.
      const seeded = await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), {
        status: workspace.status,
        changedPaths: ['src/legacy/old.ts']
      });
      assert.equal(seeded.cacheHit, false);
      assert.equal(
        (await searchContext(contextRequest(workspace.root, ANCHOR_QUERY), { status: workspace.status })).cacheHit,
        true,
        'the unseeded entry must survive the seeded one rather than being overwritten by it'
      );
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
