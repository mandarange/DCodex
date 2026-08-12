/**
 * The transactional incremental build, end to end.
 *
 * plan → load the fragments the plan kept → extract only the rest → k-way merge →
 * snapshot → manifest. The previous full JSON snapshot is never opened; the
 * manifest and the content-addressed fragments it names are the entire memory of
 * the last build (ADR §8, work order §9.3).
 *
 * Two orderings here are load-bearing rather than incidental:
 *
 * - **A no-op returns before touching anything.** Not one fragment is loaded and
 *   not one extractor is called when the inventory did not move. A "fast path"
 *   that still reads the cache to prove there is nothing to do has already paid
 *   most of the cost it exists to avoid.
 * - **A blocked extraction writes no manifest.** Blockers mean the fragment set
 *   is incomplete, and an incomplete manifest is worse than none: the sources
 *   missing from it would look like sources already handled, so the next build
 *   would skip them. A lint error is different — those fragments are real and
 *   correctly described, so the manifest is written and the lint failure is left
 *   to stop the commit.
 */
import {
  type ContextGraphLintIssue,
  type ContextGraphSnapshot,
} from '../contracts.js';
import { buildContextGraphIndex, computeStronglyConnectedComponents, outgoingEdges } from '../graph-index.js';
import { buildContextGraphSnapshot, contextGraphCycleId } from './serialize.js';
import { countDanglingEdges, mergeSourceFragments, type MergeSourceFragmentsResult } from './fragment-merge.js';
import {
  buildContextFragmentManifest,
  contextFragmentManifestHash,
  sourceFragmentKey,
  type ContextFragmentManifest,
  type FragmentManifestIdentity,
} from './fragment-manifest.js';
import { readContextFragmentManifest, writeContextFragmentManifest } from './fragment-manifest-store.js';
import { fileSourceFragmentStore, pruneSourceFragmentStore, type SourceFragmentStore } from './fragment-store.js';
import { planIncrementalBuild, type FragmentExtractionRequest, type IncrementalBuildPlan } from './fragment-plan.js';
import { runSourceExtractors } from './incremental-extract.js';
import {
  manifestEntryFromSourceFragment,
  type ContextGraphSourceExtractor,
  type ContextGraphSourceFragment,
} from './source-fragment.js';

export interface IncrementalBuildStats {
  readonly extracted: number;
  readonly synthesizedEmpty: number;
  readonly reused: number;
  /** Cached payloads that failed re-addressing and were re-extracted instead. */
  readonly reuseFailures: number;
  readonly removed: number;
  readonly prunedEdges: number;
}

export interface IncrementalBuildResult {
  readonly status: 'unchanged' | 'built' | 'blocked';
  readonly plan: IncrementalBuildPlan;
  readonly manifest: ContextFragmentManifest | null;
  readonly manifestHash: string | null;
  readonly merged: MergeSourceFragmentsResult | null;
  readonly snapshot: ContextGraphSnapshot | null;
  readonly issues: readonly ContextGraphLintIssue[];
  readonly blockers: readonly string[];
  readonly stats: IncrementalBuildStats;
}

export interface RunIncrementalBuildInput {
  readonly root: string;
  readonly extractors: readonly ContextGraphSourceExtractor[];
  /** Workspace-relative POSIX path -> content hash, for every source the build considers. */
  readonly inventory: ReadonlyMap<string, string>;
  readonly identity: FragmentManifestIdentity;
  readonly observedAt: string;
  readonly store?: SourceFragmentStore | undefined;
  /** Injected for tests and for callers that already hold the manifest. */
  readonly previous?: { status: 'ok' | 'absent' | 'unreadable'; manifest: ContextFragmentManifest | null } | undefined;
  readonly persist?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

const EMPTY_STATS: IncrementalBuildStats = Object.freeze({
  extracted: 0,
  synthesizedEmpty: 0,
  reused: 0,
  reuseFailures: 0,
  removed: 0,
  prunedEdges: 0,
});

/** Cycles are derived from the merged graph, so the snapshot describes itself rather than the previous one. */
function snapshotWithCycles(merged: MergeSourceFragmentsResult): ContextGraphSnapshot {
  const provisional = buildContextGraphSnapshot({
    nodes: merged.nodes,
    edges: merged.edges,
    cycles: [],
    extractors: merged.extractors,
  });
  const index = buildContextGraphIndex(provisional);
  const components = computeStronglyConnectedComponents(
    provisional.nodes.map((node) => node.id),
    (nodeId) => outgoingEdges(index, nodeId).map((edge) => ({ to: edge.to })),
  );
  return buildContextGraphSnapshot({
    nodes: provisional.nodes,
    edges: provisional.edges,
    cycles: components.map((nodes) => ({ id: contextGraphCycleId(nodes), nodes })),
    extractors: provisional.extractors,
  });
}

function withExtraSources(
  requests: readonly FragmentExtractionRequest[],
  extra: ReadonlyMap<string, ReadonlySet<string>>,
): FragmentExtractionRequest[] {
  const merged = new Map<string, Set<string>>();
  for (const request of requests) merged.set(request.extractor, new Set(request.sourcePaths));
  for (const [extractor, paths] of extra) {
    const target = merged.get(extractor) ?? new Set<string>();
    for (const sourcePath of paths) target.add(sourcePath);
    merged.set(extractor, target);
  }
  return [...merged.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([extractor, paths]) => ({ extractor, sourcePaths: [...paths].sort() }));
}

interface ReuseOutcome {
  readonly fragments: readonly ContextGraphSourceFragment[];
  readonly reusedKeys: ReadonlySet<string>;
  readonly failures: ReadonlyMap<string, ReadonlySet<string>>;
  readonly failureCount: number;
}

/**
 * A payload that fails to load or fails re-addressing is not an error: the plan
 * simply loses the right to skip that source, and it moves to the extract set.
 * That is what keeps a corrupt cache a performance problem rather than a
 * correctness one.
 */
async function loadReusableFragments(plan: IncrementalBuildPlan, store: SourceFragmentStore): Promise<ReuseOutcome> {
  const fragments: ContextGraphSourceFragment[] = [];
  const reusedKeys = new Set<string>();
  const failures = new Map<string, Set<string>>();
  let failureCount = 0;
  for (const entry of plan.reuse) {
    const fragment = await store.load(entry);
    if (fragment) {
      fragments.push(fragment);
      reusedKeys.add(sourceFragmentKey(entry.extractor, entry.sourcePath));
      continue;
    }
    failureCount += 1;
    const target = failures.get(entry.extractor) ?? new Set<string>();
    target.add(entry.sourcePath);
    failures.set(entry.extractor, target);
  }
  return { fragments, reusedKeys, failures, failureCount };
}

export async function runIncrementalBuild(input: RunIncrementalBuildInput): Promise<IncrementalBuildResult> {
  const previous = input.previous ?? (await readContextFragmentManifest(input.root));
  const plan = planIncrementalBuild({
    previous: previous.manifest,
    previousStatus: previous.status,
    identity: input.identity,
    extractors: input.extractors.map((extractor) => ({ id: extractor.id, revision: extractor.revision })),
    inventory: input.inventory,
  });

  if (plan.mode === 'noop') {
    return {
      status: 'unchanged',
      plan,
      manifest: previous.manifest,
      manifestHash: previous.manifest ? contextFragmentManifestHash(previous.manifest) : null,
      merged: null,
      snapshot: null,
      issues: [],
      blockers: [],
      stats: EMPTY_STATS,
    };
  }

  const persist = input.persist !== false;
  const store = input.store ?? fileSourceFragmentStore(input.root);
  const reuse = await loadReusableFragments(plan, store);
  const extraction = await runSourceExtractors({
    root: input.root,
    extractors: input.extractors,
    requests: withExtraSources(plan.extract, reuse.failures),
    inventory: input.inventory,
    observedAt: input.observedAt,
    timeoutMs: input.timeoutMs,
  });

  const stats: IncrementalBuildStats = {
    extracted: extraction.extractedCount,
    synthesizedEmpty: extraction.emptyCount,
    reused: reuse.reusedKeys.size,
    reuseFailures: reuse.failureCount,
    removed: plan.invalidated.filter((entry) => entry.reason === 'source_removed' || entry.reason === 'extractor_removed').length,
    prunedEdges: 0,
  };
  if (extraction.blockers.length > 0) {
    return {
      status: 'blocked',
      plan,
      manifest: null,
      manifestHash: null,
      merged: null,
      snapshot: null,
      issues: [],
      blockers: extraction.blockers,
      stats,
    };
  }

  const fragments = [...reuse.fragments, ...extraction.fragments];
  const merged = mergeSourceFragments({ fragments, reusedKeys: reuse.reusedKeys });
  // Checked rather than trusted. The merge prunes every unresolved endpoint, so a
  // survivor here means the merge itself is broken — and an index published with
  // an edge into nothing reads as a real relation to everything downstream.
  const dangling = countDanglingEdges(merged.nodes, merged.edges);
  if (dangling > 0) {
    return {
      status: 'blocked',
      plan,
      manifest: null,
      manifestHash: null,
      merged,
      snapshot: null,
      issues: merged.issues,
      blockers: ['merge_dangling_edge'],
      stats: { ...stats, prunedEdges: merged.pruned.length },
    };
  }
  const snapshot = snapshotWithCycles(merged);
  const manifest = buildContextFragmentManifest({
    identity: input.identity,
    sourceFingerprint: plan.sourceFingerprint,
    entries: fragments.map(manifestEntryFromSourceFragment),
  });

  if (persist) {
    for (const fragment of extraction.fragments) await store.save(fragment);
    await writeContextFragmentManifest(input.root, manifest);
    await pruneSourceFragmentStore(input.root, new Set(manifest.entries.map((entry) => entry.fragmentHash)));
  }

  return {
    status: 'built',
    plan,
    manifest,
    manifestHash: contextFragmentManifestHash(manifest),
    merged,
    snapshot,
    issues: merged.issues,
    blockers: [],
    stats: { ...stats, prunedEdges: merged.pruned.length },
  };
}
