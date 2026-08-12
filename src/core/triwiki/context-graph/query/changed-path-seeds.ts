/**
 * Caller-supplied changed paths, as kernel seeds.
 *
 * A caller that already knows which files it is working on holds evidence the
 * query text does not carry: `sks search --mode context "why did this break"`
 * says nothing about the three files in the diff, and the kernel cannot infer
 * them. v1 turned those paths into `file_path` provided seeds through
 * `search/context-graph-seeds.ts`; the v2 callers dropped the field, and the
 * measured cost was 57.7% of the v1→v2 must-include recall gap.
 *
 * ## Why this is allowed to be exact, and where that stops
 *
 * §4 gives `exact` confidence to the anchor lane only, and `admitProvidedSeeds`
 * routes a seed there only when its confidence is in the exact family. A changed
 * path qualifies for exactly one reason: **the caller resolved it**. It named a
 * workspace-relative path, that path is looked up as a canonical `file:` node
 * id, and a lookup that misses is dropped rather than downgraded — so the claim
 * "this node was retrieved because the caller identified it" is true whenever
 * the seed reaches the answer.
 *
 * That reasoning does not extend one step further. A path *derived* from the
 * query, guessed from a basename, or inferred from a label is not something the
 * caller verified, and it must not enter through here: widening this function to
 * accept a derived path would buy recall by making `file_path` mean "probably".
 * Every input to it is a path a caller supplied verbatim, and nothing in this
 * module constructs, completes or fuzzy-matches one.
 *
 * ## No cap lives here
 *
 * The anchor lane admits query anchors, then focus paths, then these — sharing
 * one `laneTopN` rank budget — so a caller who supplies a thousand paths is
 * bounded by the kernel's own cap and reported as `posting_cap`, and can never
 * displace the query's own anchors. A second cap here would be a tuning number
 * outside `ranking-config.ts`.
 */
import { contextGraphNodeId } from '../ids.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import type { ContextGraphSeed } from '../query-types.js';
import type { KernelProvidedSeed } from './kernel-types.js';

/** One caller-verified path, paired with the node id it resolves to. */
export interface ChangedPathSeed {
  /** The path exactly as the caller supplied it. Never normalized into existence. */
  readonly path: string;
  readonly nodeId: string;
}

/**
 * Workspace-relative changed paths, deduped, in caller order.
 *
 * A path that is not workspace-relative POSIX is dropped silently *here* rather
 * than turned into a node id that cannot exist: an absolute or escaping path is
 * a caller mistake, not a retrieval miss, and letting it through would report it
 * as `unknown_seed` — an omission reason that would then mean two different
 * things at once.
 */
export function changedPathSeeds(changedPaths: readonly string[] | undefined): readonly ChangedPathSeed[] {
  const seeds: ChangedPathSeed[] = [];
  const seen = new Set<string>();
  for (const candidate of changedPaths ?? []) {
    const value = String(candidate ?? '');
    if (!isWorkspaceRelativePosixPath(value) || seen.has(value)) continue;
    seen.add(value);
    seeds.push({ path: value, nodeId: contextGraphNodeId({ kind: 'file', path: value }) });
  }
  return seeds;
}

/**
 * The v2 kernel form. `verified` is set explicitly rather than left to be
 * inferred from the confidence, because the two answer different questions: the
 * confidence says *what kind of evidence* this is, and `verified` says *who
 * established it*. Only a caller-resolved path may set both.
 */
export function changedPathKernelSeeds(changedPaths: readonly string[] | undefined): readonly KernelProvidedSeed[] {
  return changedPathSeeds(changedPaths).map((seed) => ({
    nodeId: seed.nodeId,
    confidence: 'file_path' as const,
    verified: true
  }));
}

/** The v1 snapshot-engine form of the same seed set, so both engines are fed identically. */
export function changedPathSnapshotSeeds(changedPaths: readonly string[] | undefined): readonly ContextGraphSeed[] {
  return changedPathSeeds(changedPaths).map((seed) => ({
    nodeId: seed.nodeId,
    confidence: 'file_path' as const,
    origin: 'provided' as const,
    path: seed.path
  }));
}
