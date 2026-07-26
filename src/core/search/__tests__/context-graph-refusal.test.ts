/**
 * Refusal behaviour of the graph-backed `context` mode.
 *
 * The point of these tests is the *absence* of an answer: when the graph is
 * missing, stale or corrupt, `searchContext` must say so with the matching
 * `context_graph_*` code and the repair command, and must not quietly hand back
 * the lexical hits it could trivially have produced instead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { searchContext } from '../context.js';
import { search } from '../provider.js';
import { SEARCH_SCHEMA_VERSION, type SearchRequest } from '../types.js';
import {
  CONTEXT_GRAPH_REPAIR_COMMAND,
  type ContextGraphSnapshot,
  type ContextGraphStatus
} from '../../triwiki/context-graph/contracts.js';
import {
  buildFixtureSnapshot,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureWorkspace
} from '../../triwiki/context-graph/query/__tests__/query-fixtures.js';

const SERVICE_SOURCE = 'export function runService(): void {\n  return;\n}\n';

function writeSource(root: string, relative: string, body: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body, 'utf8');
}

function contextRequest(root: string, query: string): SearchRequest {
  return { schemaVersion: SEARCH_SCHEMA_VERSION, mode: 'context', root, query, limits: { maxMatches: 50 } };
}

function statusOf(
  status: ContextGraphStatus['status'],
  snapshot: ContextGraphSnapshot | null,
  reasons: ContextGraphStatus['reasons'],
  errorCode: ContextGraphStatus['errorCode']
): ContextGraphStatus {
  return {
    schema: 'sks.context-graph-status.v1',
    status,
    snapshotHash: snapshot?.snapshotHash ?? null,
    generatedAt: null,
    reasons,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    errorCode,
    nodeCount: snapshot?.nodeCount ?? 0,
    edgeCount: snapshot?.edgeCount ?? 0
  };
}

describe('search context refuses instead of degrading', () => {
  it('reports context_graph_missing with the repair command and no matches', async () => {
    const root = makeFixtureRoot('search-ctx-missing');
    try {
      writeSource(root, 'src/app/service.ts', SERVICE_SOURCE);
      const response = await searchContext(contextRequest(root, 'runService'), { cache: false });

      assert.equal(response.ok, false);
      assert.equal(response.mode, 'context');
      assert.deepEqual(response.matches, []);
      assert.ok(response.errors.includes('context_graph_missing'), response.errors.join(','));
      assert.equal(response.context?.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
      assert.equal(response.context?.hydrated, false);
      assert.equal(response.processSpawns, 0);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('returns NO lexical matches for a query text search would have found', async () => {
    const root = makeFixtureRoot('search-ctx-nofallback');
    try {
      writeSource(root, 'src/app/service.ts', SERVICE_SOURCE);

      // Proof the text is actually there: plain text mode finds it in this workspace.
      const lexical = await search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'text',
        root,
        pattern: 'runService',
        limits: { maxMatches: 20 }
      });
      assert.ok(lexical.matches.length > 0, 'fixture must contain a lexically findable hit');

      const response = await searchContext(contextRequest(root, 'runService'), { cache: false });
      assert.equal(response.ok, false);
      assert.equal(response.matches.length, 0);
      assert.equal(
        response.matches.filter((match) => match.confidence === 'text_candidate').length,
        0,
        'a missing graph must never be answered with text candidates'
      );
      assert.notEqual(response.engine, 'triwiki+codepack+local-search');
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('reports context_graph_stale from the real freshness preflight', async () => {
    const root = makeFixtureRoot('search-ctx-stale');
    try {
      const snapshot = buildFixtureSnapshot();
      await writeFixtureWorkspace(root, snapshot);
      writeSource(root, 'src/app/service.ts', SERVICE_SOURCE);

      const response = await searchContext(contextRequest(root, 'runService'), { cache: false });
      assert.equal(response.ok, false);
      assert.equal(response.matches.length, 0);
      assert.ok(response.errors.includes('context_graph_stale'), response.errors.join(','));
      assert.ok(response.warnings.length > 0, 'stale reasons must reach warnings');
      assert.equal(response.context?.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
      assert.equal(response.context?.graph?.snapshotHash, snapshot.snapshotHash);
      assert.equal(response.context?.graph?.snapshotFreshness, 'stale');
      assert.equal(response.processSpawns, 0);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('carries the stale reasons through as warnings', async () => {
    const root = makeFixtureRoot('search-ctx-reasons');
    try {
      const snapshot = buildFixtureSnapshot();
      await writeFixtureWorkspace(root, snapshot);
      const response = await searchContext(contextRequest(root, 'runService'), {
        cache: false,
        status: statusOf('stale', snapshot, ['head_changed', 'source_hash_mismatch'], 'context_graph_stale')
      });

      assert.equal(response.ok, false);
      assert.deepEqual(response.warnings, ['head_changed', 'source_hash_mismatch']);
      assert.deepEqual(response.errors, ['context_graph_stale']);
      assert.equal(response.matches.length, 0);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('reports context_graph_corrupt without substituting a previous generation', async () => {
    const root = makeFixtureRoot('search-ctx-corrupt');
    try {
      const snapshot = buildFixtureSnapshot();
      await writeFixtureWorkspace(root, snapshot);
      const response = await searchContext(contextRequest(root, 'runService'), {
        cache: false,
        status: statusOf('corrupt', snapshot, ['meta_mismatch'], 'context_graph_corrupt')
      });

      assert.equal(response.ok, false);
      assert.deepEqual(response.errors, ['context_graph_corrupt']);
      assert.equal(response.matches.length, 0);
      assert.equal(response.context?.repairCommand, CONTEXT_GRAPH_REPAIR_COMMAND);
    } finally {
      removeFixtureRoot(root);
    }
  });

  it('rejects an empty query without blaming the graph', async () => {
    const root = makeFixtureRoot('search-ctx-empty');
    try {
      const response = await searchContext(contextRequest(root, '   '), { cache: false });
      assert.equal(response.ok, false);
      assert.deepEqual(response.errors, ['missing_context_query']);
      assert.equal(response.context?.repairCommand, undefined);
      assert.equal(response.matches.length, 0);
    } finally {
      removeFixtureRoot(root);
    }
  });
});
