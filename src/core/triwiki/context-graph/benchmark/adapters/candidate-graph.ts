/**
 * `candidate-graph` — the Context Graph under measurement.
 *
 * Cold: compile the fixture with the injected extractor registry, verify the
 * snapshot recompiles to the same hash, build the adjacency index, answer.
 * Warm: reuse the compiled root, take the index from the in-process snapshot
 * cache, and answer. The warm path performs no compile, no snapshot re-parse
 * and no process spawn — `ContextGraphQueryResult.processSpawns` is `0` by type.
 *
 * A graph that is missing, stale or corrupt is reported as exactly that, with
 * the engine's own `context_graph_*` code. This adapter has no text-search
 * branch to fall into and never borrows the baseline's.
 */
import { CONTEXT_GRAPH_TRAVERSAL_CAPS } from '../../profiles.js';
import { contextGraphNodeId } from '../../ids.js';
import { isWorkspaceRelativePosixPath } from '../../paths.js';
import type { ContextGraphQueryRequest, ContextGraphQueryResult, ContextGraphSeed } from '../../query-types.js';
import { queryContextGraph } from '../../query/index.js';
import { detectWriteScopeConflicts } from './slice-conflicts.js';
import { emptyBenchmarkSafety } from '../types.js';
import type {
  ContextGraphBenchmarkAdapter,
  ContextGraphBenchmarkQuery,
  ContextGraphBenchmarkRun
} from '../types.js';
import {
  projectContextGraphAnswer,
  PROJECTION_EDGE_SCAN_CAP,
  type ContextGraphAnswerProjection
} from './graph-projection.js';
import {
  ContextGraphSessionCache,
  type ContextGraphSessionOptions,
  type ContextGraphSnapshotSafety
} from './graph-session.js';

export const CANDIDATE_GRAPH_ADAPTER_ID = 'candidate-graph';

export interface CandidateGraphAdapterOptions {
  /** Override only when two graph variants must appear in one report. */
  readonly id?: string;
  readonly session?: ContextGraphSessionOptions;
  readonly maxSelected?: number;
  readonly timeoutMs?: number;
  readonly edgeScanCap?: number;
}

export interface CandidateGraphOutcome {
  readonly run: ContextGraphBenchmarkRun;
  readonly result: ContextGraphQueryResult | null;
  readonly projection: ContextGraphAnswerProjection | null;
}

/**
 * The benchmark's `changedPaths` become caller-supplied `file_path` seeds. They
 * are paths the caller named, so they keep `file_path` confidence — a provided
 * seed is never promoted to an exact reference.
 */
function providedSeeds(changedPaths: readonly string[]): ContextGraphSeed[] {
  const seeds: ContextGraphSeed[] = [];
  const seen = new Set<string>();
  for (const candidate of changedPaths) {
    if (!isWorkspaceRelativePosixPath(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    seeds.push({
      nodeId: contextGraphNodeId({ kind: 'file', path: candidate }),
      confidence: 'file_path',
      origin: 'provided',
      path: candidate
    });
  }
  return seeds;
}

function buildRequest(
  query: ContextGraphBenchmarkQuery,
  options: CandidateGraphAdapterOptions
): ContextGraphQueryRequest {
  const seeds = providedSeeds(query.changedPaths);
  return {
    root: query.root,
    query: query.query,
    profile: query.profile,
    tokenBudget: query.tokenBudget,
    risk: query.risk,
    focusPaths: [...query.focusPaths],
    now: query.now,
    ...(seeds.length === 0 ? {} : { seeds }),
    ...(options.maxSelected === undefined ? {} : { maxSelected: options.maxSelected }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  };
}

function failedRun(
  query: ContextGraphBenchmarkQuery,
  adapterId: string,
  errorCode: string,
  latencyMs: number
): ContextGraphBenchmarkRun {
  return {
    caseId: query.caseId,
    adapterId,
    mode: query.mode,
    iteration: query.iteration,
    ok: false,
    errorCode,
    matchedPaths: [],
    matchedNodeIds: [],
    selectedGateIds: [],
    selectedTestPaths: [],
    writeScopeConflicts: [],
    tokenCost: 0,
    latencyMs,
    cacheHit: false,
    provenanceCoverage: 0,
    staleIncluded: [],
    invalidatedIncluded: [],
    exactSeedsPreserved: [],
    // The point of this branch: an unusable graph is surfaced, not papered over.
    safety: emptyBenchmarkSafety({ silentTextFallback: false, scanBudget: CONTEXT_GRAPH_TRAVERSAL_CAPS.maxVisitedNodes })
  };
}

export function toCandidateRun(
  query: ContextGraphBenchmarkQuery,
  adapterId: string,
  result: ContextGraphQueryResult,
  projection: ContextGraphAnswerProjection,
  snapshot: ContextGraphSnapshotSafety,
  cacheHit: boolean,
  latencyMs: number
): ContextGraphBenchmarkRun {
  return {
    caseId: query.caseId,
    adapterId,
    mode: query.mode,
    iteration: query.iteration,
    ok: result.ok,
    errorCode: result.ok ? null : (result.errors[0] ?? 'adapter_error:query_failed'),
    matchedPaths: projection.matchedPaths,
    matchedNodeIds: projection.matchedNodeIds,
    selectedGateIds: projection.selectedGateIds,
    selectedTestPaths: projection.selectedTestPaths,
    writeScopeConflicts: projection.writeScopeConflicts,
    tokenCost: result.tokenCost,
    latencyMs,
    cacheHit,
    provenanceCoverage: result.provenanceCoverage,
    staleIncluded: projection.staleIncluded,
    invalidatedIncluded: projection.invalidatedIncluded,
    exactSeedsPreserved: projection.exactSeedsPreserved,
    safety: emptyBenchmarkSafety({
      // The engine copies labels, paths and hashes out of the snapshot and never
      // file content, so a leak would have to come from the snapshot itself —
      // which the floors re-scan independently from the run payload.
      secretLeaks: [],
      pathLeaks: [],
      danglingEdges: snapshot.danglingEdges,
      edgesWithoutProvenance: snapshot.edgesWithoutProvenance,
      snapshotHash: snapshot.snapshotHash,
      determinismHash: snapshot.determinismHash,
      silentTextFallback: false,
      unsupportedLanguageExactClaims: projection.unsupportedLanguageExactClaims,
      projectCodeExecutions: 0,
      processSpawns: result.processSpawns,
      // The hot path walks graph nodes, not the file system. `visitedNodes`
      // against the traversal cap is therefore the bounded scan to report.
      scannedFiles: result.visitedNodes,
      scanBudget: CONTEXT_GRAPH_TRAVERSAL_CAPS.maxVisitedNodes
    })
  };
}

/**
 * A candidate adapter instance. It owns its compile memo, so cold and warm are
 * separated per adapter instance and never leak between two adapters in one
 * report. Call `reset()` between independent benchmark runs in one process.
 */
export class CandidateGraphAdapter implements ContextGraphBenchmarkAdapter {
  readonly id: string;

  readonly kind = 'candidate' as const;

  private readonly sessions: ContextGraphSessionCache;

  private readonly options: CandidateGraphAdapterOptions;

  constructor(options: CandidateGraphAdapterOptions = {}) {
    this.id = options.id ?? CANDIDATE_GRAPH_ADAPTER_ID;
    this.options = options;
    this.sessions = new ContextGraphSessionCache(options.session ?? {});
  }

  /** Roots compiled so far; a warm iteration must not increase this. */
  compiledRoots(): number {
    return this.sessions.compiledRoots();
  }

  reset(): void {
    this.sessions.reset();
  }

  async answer(query: ContextGraphBenchmarkQuery): Promise<CandidateGraphOutcome> {
    const startedAt = Date.now();
    const acquired = await this.sessions.acquire(query.root, query.now);
    if (!acquired.ok) {
      return {
        run: failedRun(query, this.id, acquired.errorCode, Date.now() - startedAt),
        result: null,
        projection: null
      };
    }
    const session = acquired.session;
    const result = await queryContextGraph(buildRequest(query, this.options), { index: session.index });
    const projected = projectContextGraphAnswer(
      session.index,
      result,
      this.options.edgeScanCap ?? PROJECTION_EDGE_SCAN_CAP
    );
    // Conflicts come from the production Naruto advisory, not from a
    // benchmark-local re-derivation, so the conflict floor measures what
    // actually protects a parallel wave. The advisory reads the v2 binary index
    // (CG2-13), so it takes the session's reader rather than the v1 adjacency
    // index the query path still uses.
    const projection = {
      ...projected,
      writeScopeConflicts: detectWriteScopeConflicts(query.root, session.reader, query.query)
    };
    return {
      run: toCandidateRun(
        query,
        this.id,
        result,
        projection,
        session.safety,
        session.cacheHit,
        Date.now() - startedAt
      ),
      result,
      projection
    };
  }

  async run(query: ContextGraphBenchmarkQuery): Promise<ContextGraphBenchmarkRun> {
    const outcome = await this.answer(query);
    return outcome.run;
  }
}

export function createCandidateGraphAdapter(options: CandidateGraphAdapterOptions = {}): CandidateGraphAdapter {
  return new CandidateGraphAdapter(options);
}
