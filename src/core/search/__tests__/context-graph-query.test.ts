/**
 * The answering path of the graph-backed `context` mode.
 *
 * Every assertion here is about a property the old lexical fusion could not have:
 * a match's confidence is the confidence of the relation that produced it, an
 * invalidated proof and a stale node are excluded and counted, hydration means a
 * provenance record resolved to a real file, and the order is the same on every run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { searchContext } from '../context.js';
import { SEARCH_SCHEMA_VERSION, type SearchMatch, type SearchRequest } from '../types.js';
import {
  CONTEXT_GRAPH_REPAIR_COMMAND,
  type ContextGraphSnapshot,
  type ContextGraphStatus
} from '../../triwiki/context-graph/contracts.js';
import {
  buildFixtureSnapshot,
  fixtureEdges,
  fixtureNodes,
  FIXTURE_OBSERVED_AT,
  IDS,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureWorkspace
} from '../../triwiki/context-graph/query/__tests__/query-fixtures.js';

/** Every path the fixture's provenance records point at. */
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

function materializeSources(root: string): void {
  for (const relative of FIXTURE_SOURCES) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `// ${relative}\n`, 'utf8');
  }
}

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

async function makeWorkspace(prefix: string, withSources = true): Promise<Workspace> {
  const root = makeFixtureRoot(prefix);
  const snapshot = buildFixtureSnapshot();
  await writeFixtureWorkspace(root, snapshot);
  if (withSources) materializeSources(root);
  return { root, snapshot, status: freshStatus(snapshot) };
}

function nodeIdOf(match: SearchMatch): string {
  return String(match.meta?.node_id ?? '');
}

function findByNode(matches: readonly SearchMatch[], nodeId: string): SearchMatch | undefined {
  return matches.find((match) => nodeIdOf(match) === nodeId);
}

describe('search context answers from the context graph', () => {
  it('preserves an exact symbol seed and gives each match its own confidence', async () => {
    const workspace = await makeWorkspace('search-ctx-symbol');
    try {
      const response = await searchContext(contextRequest(workspace.root, 'runService'), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      assert.equal(response.processSpawns, 0);
      assert.equal(response.engine, 'triwiki+context-graph');
      assert.equal(response.context?.method, 'context_graph_query');
      assert.ok(response.matches.length > 1, 'expected the traversal to reach beyond the seed');

      const symbol = findByNode(response.matches, IDS.symbolRun);
      assert.ok(symbol, 'the seeded symbol must be selected');
      assert.equal(symbol.confidence, 'exact_definition');
      assert.equal(symbol.meta?.seed, true);
      assert.equal(symbol.meta?.seed_confidence, 'exact_definition');
      assert.equal(symbol.symbol, 'runService');

      // A syntactic import hop must not be reported as an exact reference.
      const consumer = findByNode(response.matches, IDS.fileConsumer);
      assert.ok(consumer);
      assert.equal(consumer.confidence, 'syntactic_reference');
      assert.equal(consumer.meta?.graph_relation, 'imports');

      // A manifest-backed relation is a real reference.
      const command = findByNode(response.matches, IDS.commandWiki);
      assert.ok(command);
      assert.equal(command.confidence, 'exact_reference');

      const distinct = new Set(response.matches.map((match) => match.confidence));
      assert.ok(distinct.size > 1, 'confidences must not all be stamped the same');
      assert.equal(distinct.has('context_pack') && distinct.size === 1, false);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('attaches reason path, provenance, trust, freshness and token cost to every match', async () => {
    const workspace = await makeWorkspace('search-ctx-meta');
    try {
      const response = await searchContext(contextRequest(workspace.root, 'runService'), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      for (const match of response.matches) {
        const meta = match.meta ?? {};
        assert.ok(Array.isArray(meta.reason_path) && (meta.reason_path as string[]).length > 0);
        assert.equal(typeof meta.graph_relation, 'string');
        assert.equal(typeof meta.trust, 'number');
        assert.equal(typeof meta.token_cost, 'number');
        assert.equal(meta.freshness, 'fresh');
        const provenance = meta.provenance as Array<{ path: string; hash: string }>;
        assert.ok(Array.isArray(provenance) && provenance.length > 0, 'every match must be grounded');
        for (const ref of provenance) {
          assert.ok(!path.isAbsolute(ref.path), `provenance path must stay workspace-relative: ${ref.path}`);
          assert.ok(!ref.path.startsWith('~'));
        }
      }

      const graph = response.context?.graph;
      assert.ok(graph);
      assert.equal(graph.snapshotHash, workspace.snapshot.snapshotHash);
      assert.equal(graph.profile, 'implementation');
      assert.equal(graph.snapshotFreshness, 'fresh');
      assert.ok(graph.seedCount >= 1);
      assert.equal(graph.provenanceCoverage, 1);
      assert.equal(response.context?.hydrated, true);
      assert.equal(response.context?.indexFreshness, FIXTURE_OBSERVED_AT);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('keeps a path-only seed at file_path', async () => {
    const workspace = await makeWorkspace('search-ctx-path');
    try {
      const response = await searchContext(contextRequest(workspace.root, 'src/other/a.ts'), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      const hit = findByNode(response.matches, IDS.fileOtherA);
      assert.ok(hit, 'the path seed must be selected');
      assert.equal(hit.confidence, 'file_path');
      assert.equal(hit.meta?.seed, true);
      assert.equal(hit.meta?.seed_confidence, 'file_path');
      assert.equal(hit.path, 'src/other/a.ts');
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('excludes an invalidated proof and a stale node, and counts both', async () => {
    const workspace = await makeWorkspace('search-ctx-invalidated');
    try {
      const response = await searchContext(contextRequest(workspace.root, 'runService'), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      assert.equal(findByNode(response.matches, IDS.proofInvalid), undefined);
      assert.equal(findByNode(response.matches, IDS.fileLegacy), undefined);
      const graph = response.context?.graph;
      assert.ok(graph);
      assert.ok(graph.invalidatedExcluded >= 1, 'the invalidated proof must be counted');
      assert.ok(graph.staleExcluded >= 1, 'the stale node must be counted');
      assert.equal(response.context?.excludedCount, graph.staleExcluded + graph.invalidatedExcluded);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('reports token-budget truncation instead of silently trimming', async () => {
    const workspace = await makeWorkspace('search-ctx-budget');
    try {
      const response = await searchContext(contextRequest(workspace.root, 'runService'), {
        cache: false,
        status: workspace.status,
        tokenBudget: 40
      });

      assert.equal(response.ok, true);
      assert.equal(response.truncated, true);
      assert.equal(response.context?.truncation, true);
      assert.ok((response.context?.tokenBudgetOmissions ?? 0) > 0);
      assert.ok((response.skipped.reasons.token_budget ?? 0) > 0);
      assert.equal(response.matches.length, 1);
      assert.equal(nodeIdOf(response.matches[0] as SearchMatch), IDS.symbolRun);
      assert.ok((response.context?.graph?.tokenCost ?? 0) <= 40);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('produces an identical ordering on three consecutive runs', async () => {
    const workspace = await makeWorkspace('search-ctx-order');
    try {
      const signatures: string[] = [];
      for (let run = 0; run < 3; run += 1) {
        const response = await searchContext(contextRequest(workspace.root, 'service'), {
          cache: false,
          status: workspace.status
        });
        assert.equal(response.ok, true);
        assert.ok(response.matches.length > 0);
        assert.equal(response.deterministicOrder, 'path_line_column');
        signatures.push(
          JSON.stringify(
            response.matches.map((match) => [match.path, match.line ?? null, match.confidence, nodeIdOf(match)])
          )
        );
      }
      assert.equal(signatures[0], signatures[1]);
      assert.equal(signatures[1], signatures[2]);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('is hydrated only when provenance resolves to a real file', async () => {
    const workspace = await makeWorkspace('search-ctx-dry', false);
    try {
      const response = await searchContext(contextRequest(workspace.root, 'runService'), {
        cache: false,
        status: workspace.status
      });

      assert.equal(response.ok, true);
      assert.ok(response.matches.length > 0, 'the graph still answers without the sources on disk');
      assert.equal(response.context?.hydrated, false);
      assert.equal(response.scanned.files, 0);
      for (const match of response.matches) assert.equal(match.meta?.provenance_resolved, false);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('keys the response cache on the snapshot hash and the query profile', async () => {
    const workspace = await makeWorkspace('search-ctx-cache');
    try {
      const first = await searchContext(contextRequest(workspace.root, 'runService'), { status: workspace.status });
      assert.equal(first.cacheHit, false);

      const repeat = await searchContext(contextRequest(workspace.root, 'runService'), { status: workspace.status });
      assert.equal(repeat.cacheHit, true);

      const otherProfile = await searchContext(contextRequest(workspace.root, 'runService'), {
        status: workspace.status,
        profile: 'review'
      });
      assert.equal(otherProfile.cacheHit, false);
      assert.equal(otherProfile.context?.graph?.profile, 'review');

      // A rebuilt graph is a different snapshot hash, so the cached answer must not be reused.
      const rebuilt = buildFixtureSnapshot(fixtureNodes(), fixtureEdges().slice(0, 6));
      assert.notEqual(rebuilt.snapshotHash, workspace.snapshot.snapshotHash);
      await writeFixtureWorkspace(workspace.root, rebuilt);
      const afterRebuild = await searchContext(contextRequest(workspace.root, 'runService'), {
        status: freshStatus(rebuilt)
      });
      assert.equal(afterRebuild.cacheHit, false);
      assert.equal(afterRebuild.context?.graph?.snapshotHash, rebuilt.snapshotHash);
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });

  it('reads the query profile off the request when the caller threads --profile through', async () => {
    const workspace = await makeWorkspace('search-ctx-profile');
    try {
      const request = { ...contextRequest(workspace.root, 'runService'), profile: 'planning' } as SearchRequest;
      const response = await searchContext(request, { cache: false, status: workspace.status });
      assert.equal(response.ok, true);
      assert.equal(response.context?.graph?.profile, 'planning');
    } finally {
      removeFixtureRoot(workspace.root);
    }
  });
});
