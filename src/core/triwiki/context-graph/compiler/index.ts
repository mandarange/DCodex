/**
 * Context Graph compiler.
 *
 * Fragments in, one deterministic snapshot out, under a compile lock. The
 * extractors are injected rather than imported so the compiler never depends on
 * (or executes) the code it is describing.
 *
 * The pipeline is: cache key -> extract -> entity-resolve -> freshness ->
 * adjacency + cycles -> lint -> canonical serialize -> atomic write. A hard lint
 * error stops the pipeline before the write: the presence of the artifact is what
 * gives every consumer permission to answer from it.
 */
import path from 'node:path';
import {
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  type ContextGraphCycle,
  type ContextGraphExtractionLimits,
  type ContextGraphExtractor,
  type ContextGraphLintIssue,
  type ContextGraphMeta,
  type ContextGraphSkip,
  type ContextGraphSnapshot
} from '../contracts.js';
import { buildContextGraphIndex, computeStronglyConnectedComponents, outgoingEdges } from '../graph-index.js';
import { tryNormalizeGraphPath } from '../paths.js';
import { runContextGraphLint } from '../lint/index.js';
import { withContextGraphCompileLock } from '../store/compile-lock.js';
import { appendContextGraphEvent } from '../store/event-log.js';
import {
  readContextGraphMeta,
  readContextGraphSnapshot,
  readContextGraphSnapshotHash,
  writeContextGraphSnapshot
} from '../store/snapshot-store.js';
import { computeContextGraphCacheKey, type ContextGraphCacheKeyResult } from './cache-key.js';
import { DEFAULT_CONTEXT_GRAPH_LIMITS, runContextGraphExtractors } from './extract.js';
import { applyContextGraphFreshness } from './freshness.js';
import { withTriWikiStateLock } from '../../triwiki-cleanup.js';
import {
  applyContextGraphCaps,
  carryForwardFromSnapshot,
  mergeContextGraphFragments,
  type ContextGraphCarryForward,
  type DroppedContextGraphEdge
} from './merge.js';
import { buildContextGraphSnapshot, contextGraphCycleId } from './serialize.js';

const MAX_META_SKIPPED = 200;

export type CompileContextGraphBlockReason =
  | 'lock_held'
  | 'extractor_failed'
  | 'lint_error';

export interface CompileContextGraphInput {
  root: string;
  /** Injected registry. The compiler never imports an extractor directly. */
  extractors: readonly ContextGraphExtractor[];
  /** `null`/omitted compiles everything; otherwise only these paths plus each extractor's closure. */
  changedPaths?: readonly string[] | null | undefined;
  limits?: Partial<ContextGraphExtractionLimits> | undefined;
  /** Injected clock for `observedAt`, so a compile stays reproducible under test. */
  observedAt?: string | undefined;
  tokenBudget?: number | undefined;
  useFragmentCache?: boolean | undefined;
  /** Pre-computed cache identity for callers with a narrower source policy. */
  cacheKey?: ContextGraphCacheKeyResult | undefined;
  /** Build and validate in memory without publishing graph artifacts or events. */
  persistArtifacts?: boolean | undefined;
  /** Skip the graph lock only when the caller already holds a broader state-transition lock. */
  useCompileLock?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface CompileContextGraphResult {
  ok: boolean;
  /** Present whenever a snapshot was produced, even if lint then blocked the write. */
  snapshot: ContextGraphSnapshot | null;
  meta: ContextGraphMeta | null;
  issues: ContextGraphLintIssue[];
  wrote: boolean;
  snapshotHash: string | null;
  previousSnapshotHash: string | null;
  durationMs: number;
  skipped: ContextGraphSkip[];
  /** Machine codes, never prose: `lock_held`, `extractor_timeout:<id>`, `lint:<code>`. */
  blockers: string[];
  reason: CompileContextGraphBlockReason | null;
  cacheKey: string | null;
  cacheReusable: boolean;
  incremental: boolean;
  droppedEdges: DroppedContextGraphEdge[];
}

function resolveLimits(partial: Partial<ContextGraphExtractionLimits> | undefined): ContextGraphExtractionLimits {
  return { ...DEFAULT_CONTEXT_GRAPH_LIMITS, ...(partial ?? {}) };
}

function normalizeChangedPaths(root: string, changedPaths: readonly string[] | null | undefined): string[] | null {
  if (changedPaths === null || changedPaths === undefined) return null;
  const out = new Set<string>();
  for (const candidate of changedPaths) {
    const normalized = tryNormalizeGraphPath(root, candidate);
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}

function failure(
  reason: CompileContextGraphBlockReason,
  blockers: string[],
  durationMs: number,
  extra: Partial<CompileContextGraphResult> = {}
): CompileContextGraphResult {
  return {
    ok: false,
    snapshot: null,
    meta: null,
    issues: [],
    wrote: false,
    snapshotHash: null,
    previousSnapshotHash: null,
    durationMs,
    skipped: [],
    blockers,
    reason,
    cacheKey: null,
    cacheReusable: false,
    incremental: false,
    droppedEdges: [],
    ...extra
  };
}

function cyclesOf(snapshot: ContextGraphSnapshot): ContextGraphCycle[] {
  const index = buildContextGraphIndex(snapshot);
  const components = computeStronglyConnectedComponents(
    snapshot.nodes.map((node) => node.id),
    (nodeId) => outgoingEdges(index, nodeId).map((edge) => ({ to: edge.to }))
  );
  return components.map((nodes) => ({ id: contextGraphCycleId(nodes), nodes }));
}

async function compileLocked(
  input: CompileContextGraphInput,
  root: string,
  startedAt: number
): Promise<CompileContextGraphResult> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const limits = resolveLimits(input.limits);
  const changedPaths = normalizeChangedPaths(root, input.changedPaths);
  const cacheKey: ContextGraphCacheKeyResult = input.cacheKey ?? await computeContextGraphCacheKey({
    root,
    extractors: input.extractors
  });
  const persistArtifacts = input.persistArtifacts !== false;

  if (persistArtifacts) {
    await appendContextGraphEvent(root, {
      type: 'compile.started',
      at: observedAt,
      cacheKey: cacheKey.key,
      incremental: changedPaths !== null
    });
  }

  const extraction = await runContextGraphExtractors({
    root,
    extractors: input.extractors,
    changedPaths,
    limits,
    observedAt,
    cacheKey: cacheKey.key,
    // A non-reusable cache key means git state is unknown; replaying fragments
    // from disk then has nothing trustworthy to key on.
    useFragmentCache: (input.useFragmentCache ?? true) && cacheKey.reusable
  });
  if (extraction.blockers.length > 0) {
    if (persistArtifacts) {
      await appendContextGraphEvent(root, {
        type: 'compile.blocked',
        at: observedAt,
        cacheKey: cacheKey.key,
        reason: extraction.blockers[0] ?? 'extractor_failed'
      });
    }
    return failure('extractor_failed', extraction.blockers, Date.now() - startedAt, {
      cacheKey: cacheKey.key,
      cacheReusable: cacheKey.reusable,
      issues: extraction.issues
    });
  }

  const carryForward = changedPaths === null ? null : await previousGeneration(root, cacheKey, changedPaths);
  const merged = mergeContextGraphFragments({
    fragments: extraction.fragments,
    ...(carryForward === null ? {} : { carryForward })
  });

  const freshness = await applyContextGraphFreshness({
    root,
    nodes: merged.nodes,
    edges: merged.edges
  });
  const capped = applyContextGraphCaps(freshness.nodes, merged.edges, limits);
  const skipped = [...merged.skipped, ...capped.skipped];

  const provisional = buildContextGraphSnapshot({
    nodes: capped.nodes,
    edges: capped.edges,
    cycles: [],
    extractors: merged.extractors
  });
  const snapshot = buildContextGraphSnapshot({
    nodes: provisional.nodes,
    edges: provisional.edges,
    cycles: cyclesOf(provisional),
    extractors: provisional.extractors
  });

  const inputHashes: Record<string, string> = { ...merged.inputHashes };
  for (const [file, hash] of Object.entries(freshness.sourceHashes)) {
    if (inputHashes[file] === undefined) inputHashes[file] = hash;
  }

  const lint = runContextGraphLint({
    root,
    snapshot,
    sourceHashes: freshness.sourceHashes,
    skipped,
    env: input.env ?? process.env
  });
  const issues = [...extraction.issues, ...merged.issues, ...lint.issues];
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    if (persistArtifacts) {
      await appendContextGraphEvent(root, {
        type: 'compile.blocked',
        at: observedAt,
        cacheKey: cacheKey.key,
        snapshotHash: snapshot.snapshotHash,
        errorCount: errors.length,
        warningCount: issues.length - errors.length,
        reason: errors[0]?.code ?? 'lint_error'
      });
    }
    return {
      ok: false,
      snapshot,
      meta: null,
      issues,
      wrote: false,
      snapshotHash: snapshot.snapshotHash,
      previousSnapshotHash: null,
      durationMs: Date.now() - startedAt,
      skipped,
      blockers: errors.map((issue) => `lint:${issue.code}`),
      reason: 'lint_error',
      cacheKey: cacheKey.key,
      cacheReusable: cacheKey.reusable,
      incremental: carryForward !== null,
      droppedEdges: merged.dropped
    };
  }

  const durationMs = Date.now() - startedAt;
  // Read before writing: the meta has to name the generation it replaces, and a
  // second write to fill that field in would rotate the real previous generation away.
  const previousSnapshotHash = await readContextGraphSnapshotHash(root);
  const meta: ContextGraphMeta = {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: snapshot.snapshotHash,
    previousSnapshotHash,
    generatedAt: observedAt,
    cacheKey: cacheKey.key,
    cacheKeyParts: cacheKey.parts,
    inputHashes,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    lint: { ok: true, errors: 0, warnings: issues.length },
    skipped: skipped.slice(0, MAX_META_SKIPPED),
    durationMs
  };
  if (persistArtifacts) {
    await writeContextGraphSnapshot({ root, snapshot, meta });
    await appendContextGraphEvent(root, {
      type: 'compile.committed',
      at: observedAt,
      cacheKey: cacheKey.key,
      snapshotHash: snapshot.snapshotHash,
      previousSnapshotHash,
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
      errorCount: 0,
      warningCount: issues.length,
      durationMs,
      incremental: carryForward !== null
    });
  }

  return {
    ok: true,
    snapshot,
    meta,
    issues,
    wrote: persistArtifacts,
    snapshotHash: snapshot.snapshotHash,
    previousSnapshotHash,
    durationMs,
    skipped,
    blockers: [],
    reason: null,
    cacheKey: cacheKey.key,
    cacheReusable: cacheKey.reusable,
    incremental: carryForward !== null,
    droppedEdges: merged.dropped
  };
}

/**
 * The reusable slice of the previous generation for an incremental compile.
 * Returns `null` (forcing a full compile) whenever the previous artifacts are
 * missing, corrupt, or were built by a different extractor set.
 */
async function previousGeneration(
  root: string,
  cacheKey: ContextGraphCacheKeyResult,
  changedPaths: readonly string[]
): Promise<ContextGraphCarryForward | null> {
  if (!cacheKey.reusable) return null;
  const [snapshotLoad, metaLoad] = await Promise.all([
    readContextGraphSnapshot(root),
    readContextGraphMeta(root)
  ]);
  if (snapshotLoad.status !== 'ok' || !snapshotLoad.snapshot) return null;
  if (metaLoad.status !== 'ok' || !metaLoad.meta) return null;
  if (metaLoad.meta.snapshotHash !== snapshotLoad.snapshot.snapshotHash) return null;
  if (metaLoad.meta.schemaRevision !== CONTEXT_GRAPH_SCHEMA_REVISION) return null;
  if (metaLoad.meta.cacheKeyParts.schemaRevision !== cacheKey.parts.schemaRevision) return null;
  return carryForwardFromSnapshot(
    snapshotLoad.snapshot.nodes,
    snapshotLoad.snapshot.edges,
    changedPaths
  );
}

export async function compileContextGraph(
  input: CompileContextGraphInput
): Promise<CompileContextGraphResult> {
  const startedAt = Date.now();
  const root = path.resolve(input.root);
  if (input.useCompileLock === false) return compileLocked(input, root, startedAt);
  try {
    return await withTriWikiStateLock(root, async () => {
      const outcome = await withContextGraphCompileLock(root, () => compileLocked(input, root, startedAt));
      if (outcome.acquired) return outcome.value;
      await appendContextGraphEvent(root, {
        type: 'compile.lock_contended',
        at: input.observedAt ?? new Date().toISOString(),
        reason: 'lock_held'
      });
      return failure('lock_held', ['lock_held'], Date.now() - startedAt);
    });
  } catch (error) {
    if (!String(error).includes('file_lock_timeout:')) throw error;
    return failure('lock_held', ['triwiki_state_lock_held'], Date.now() - startedAt);
  }
}

export { DEFAULT_CONTEXT_GRAPH_LIMITS } from './extract.js';
export type { ContextGraphCacheKeyResult } from './cache-key.js';
