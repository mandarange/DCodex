/**
 * The invalidation closure: which fragments a change actually invalidates.
 *
 * The whole value of an incremental build lives in this one decision, and it is
 * wrong in both directions. Invalidate too much and the build is a full rebuild
 * wearing a costume. Invalidate too little and a stale fragment survives a change
 * it depended on, which is worse than a slow build because nothing downstream can
 * tell.
 *
 * So the closure is exactly two hops and no more:
 *
 * 1. a fragment whose own source moved, and
 * 2. a fragment that **declared** it read a source that moved.
 *
 * It is deliberately not transitive. `a` importing `b` importing `c` does not
 * mean `a`'s fragment read `c`; if the extraction really did read `c`, the
 * extractor says so in `dependencyKeys` and hop 2 catches it. Making the closure
 * transitive "to be safe" would quietly re-extract half the workspace for a leaf
 * change and hide under-declared read sets instead of exposing them.
 *
 * Above that sits the rulebook check. A change to the graph schema revision, the
 * compile config, or the tokenizer means the rules that turned bytes into nodes
 * changed, so identical source bytes no longer imply an identical fragment.
 * Reusing across that boundary is the corruption these triggers exist to prevent,
 * and there is no partial version of the answer: the whole build starts over.
 *
 * The line between the two is which inputs are *files*. The command manifest,
 * the gate manifest and the proof index are workspace files, so they belong in
 * the inventory: an extractor that reads one declares it, and a change to it then
 * invalidates exactly the fragments that read it. Only rules with no file behind
 * them — ranking weights, tokenizer settings, the schema revision — belong in
 * `identity`, where the answer is necessarily all-or-nothing.
 *
 * Nothing here reads the previous graph snapshot. The manifest, the current
 * source inventory, and the identity are the only inputs.
 */
import { compareContextGraphIds } from '../ids.js';
import {
  computeSourceInventoryFingerprint,
  fragmentManifestSourceHashes,
  sourceFragmentKey,
  type ContextFragmentManifest,
  type FragmentManifestEntry,
  type FragmentManifestIdentity,
} from './fragment-manifest.js';

export type FullRebuildReason =
  | 'manifest_absent'
  | 'manifest_unreadable'
  | 'schema_revision_changed'
  | 'config_fingerprint_changed'
  | 'tokenizer_fingerprint_changed'
  | 'source_fingerprint_divergent';

export type FragmentInvalidationReason =
  | 'source_added'
  | 'source_changed'
  | 'source_removed'
  | 'dependency_moved'
  | 'extractor_revision_changed'
  | 'extractor_removed';

export type IncrementalBuildMode = 'noop' | 'incremental' | 'full_rebuild';

export interface ExtractorIdentity {
  readonly id: string;
  readonly revision: string;
}

export interface FragmentExtractionRequest {
  readonly extractor: string;
  readonly sourcePaths: readonly string[];
}

export interface FragmentInvalidation {
  readonly extractor: string;
  readonly sourcePath: string;
  readonly reason: FragmentInvalidationReason;
}

export interface PlanIncrementalBuildInput {
  readonly previous: ContextFragmentManifest | null;
  readonly previousStatus: 'ok' | 'absent' | 'unreadable';
  readonly identity: FragmentManifestIdentity;
  readonly extractors: readonly ExtractorIdentity[];
  /** Workspace-relative POSIX path -> content hash, for every source the build considers. */
  readonly inventory: ReadonlyMap<string, string>;
}

export interface IncrementalBuildPlan {
  readonly mode: IncrementalBuildMode;
  readonly rebuildReason: FullRebuildReason | null;
  readonly sourceFingerprint: string;
  readonly addedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly reuse: readonly FragmentManifestEntry[];
  readonly extract: readonly FragmentExtractionRequest[];
  readonly invalidated: readonly FragmentInvalidation[];
  readonly extractCount: number;
  readonly reuseCount: number;
}

function sortedPaths(values: Iterable<string>): string[] {
  return [...values].sort(compareContextGraphIds);
}

function sortedExtractors(extractors: readonly ExtractorIdentity[]): ExtractorIdentity[] {
  return [...extractors].sort((left, right) => compareContextGraphIds(left.id, right.id));
}

function rebuildReasonFor(input: PlanIncrementalBuildInput): FullRebuildReason | null {
  if (input.previousStatus === 'unreadable') return 'manifest_unreadable';
  const previous = input.previous;
  if (!previous || input.previousStatus !== 'ok') return 'manifest_absent';
  const identity = previous.identity;
  if (identity.schemaRevision !== input.identity.schemaRevision) return 'schema_revision_changed';
  if (identity.configFingerprint !== input.identity.configFingerprint) return 'config_fingerprint_changed';
  if (identity.tokenizerFingerprint !== input.identity.tokenizerFingerprint) return 'tokenizer_fingerprint_changed';
  return null;
}

function fullRebuildPlan(
  input: PlanIncrementalBuildInput,
  reason: FullRebuildReason,
  sourceFingerprint: string,
): IncrementalBuildPlan {
  const sourcePaths = sortedPaths(input.inventory.keys());
  const extract = sortedExtractors(input.extractors).map((extractor) => ({
    extractor: extractor.id,
    sourcePaths,
  }));
  return Object.freeze({
    mode: 'full_rebuild' as const,
    rebuildReason: reason,
    sourceFingerprint,
    addedPaths: sourcePaths,
    changedPaths: Object.freeze([]),
    removedPaths: Object.freeze([]),
    reuse: Object.freeze([]),
    extract: Object.freeze(extract),
    // Listing every pair as invalidated would be `extractors x sources` of noise
    // that says nothing the reason above does not already say.
    invalidated: Object.freeze([]),
    extractCount: extract.length * sourcePaths.length,
    reuseCount: 0,
  });
}

interface SourceDelta {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly moved: ReadonlySet<string>;
}

/**
 * The delta is derived from the inventory, never accepted from a caller. A
 * caller-supplied diff that missed a file would silently license reusing a stale
 * fragment; an inventory comparison cannot miss one.
 */
function sourceDelta(inventory: ReadonlyMap<string, string>, previous: ReadonlyMap<string, string>): SourceDelta {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [sourcePath, hash] of inventory) {
    const before = previous.get(sourcePath);
    if (before === undefined) added.push(sourcePath);
    else if (before !== hash) changed.push(sourcePath);
  }
  for (const sourcePath of previous.keys()) {
    if (!inventory.has(sourcePath)) removed.push(sourcePath);
  }
  return {
    added: sortedPaths(added),
    changed: sortedPaths(changed),
    removed: sortedPaths(removed),
    // A rename is a removal plus an addition, and both halves belong here: a
    // fragment that declared it read the old path must be re-extracted, and so
    // must one that probed for the new path before it existed.
    moved: new Set([...added, ...changed, ...removed]),
  };
}

function invalidationFor(
  entry: FragmentManifestEntry | undefined,
  extractor: ExtractorIdentity,
  sourcePath: string,
  inventoryHash: string,
  delta: SourceDelta,
): FragmentInvalidationReason | null {
  if (!entry) return 'source_added';
  if (entry.sourceHash !== inventoryHash) return 'source_changed';
  if (entry.extractorRevision !== extractor.revision) return 'extractor_revision_changed';
  for (const dependency of entry.dependencyKeys) {
    if (delta.moved.has(dependency)) return 'dependency_moved';
  }
  return null;
}

export function planIncrementalBuild(input: PlanIncrementalBuildInput): IncrementalBuildPlan {
  const sourceFingerprint = computeSourceInventoryFingerprint(input.inventory);
  const rebuildReason = rebuildReasonFor(input);
  if (rebuildReason) return fullRebuildPlan(input, rebuildReason, sourceFingerprint);

  const previous = input.previous as ContextFragmentManifest;
  const previousHashes = fragmentManifestSourceHashes(previous);
  const delta = sourceDelta(input.inventory, previousHashes);
  const entries = new Map(previous.entries.map((entry) => [sourceFragmentKey(entry.extractor, entry.sourcePath), entry]));
  const liveExtractors = new Set(input.extractors.map((extractor) => extractor.id));

  const reuse: FragmentManifestEntry[] = [];
  const extract: FragmentExtractionRequest[] = [];
  const invalidated: FragmentInvalidation[] = [];
  const inventoryPaths = sortedPaths(input.inventory.keys());

  for (const extractor of sortedExtractors(input.extractors)) {
    const sourcePaths: string[] = [];
    for (const sourcePath of inventoryPaths) {
      const entry = entries.get(sourceFragmentKey(extractor.id, sourcePath));
      const reason = invalidationFor(entry, extractor, sourcePath, input.inventory.get(sourcePath) as string, delta);
      if (reason === null) {
        reuse.push(entry as FragmentManifestEntry);
        continue;
      }
      sourcePaths.push(sourcePath);
      invalidated.push({ extractor: extractor.id, sourcePath, reason });
    }
    if (sourcePaths.length > 0) extract.push({ extractor: extractor.id, sourcePaths: Object.freeze(sourcePaths) });
  }

  // Entries the new build has no home for: their source is gone, or the extractor
  // that produced them is. Both drop out of the merge, which is what makes a
  // deletion actually delete instead of lingering as a carried-forward ghost.
  for (const entry of previous.entries) {
    if (input.inventory.has(entry.sourcePath) && liveExtractors.has(entry.extractor)) continue;
    invalidated.push({
      extractor: entry.extractor,
      sourcePath: entry.sourcePath,
      reason: liveExtractors.has(entry.extractor) ? 'source_removed' : 'extractor_removed',
    });
  }

  const extractCount = extract.reduce((total, request) => total + request.sourcePaths.length, 0);
  const inventoryUnmoved = previous.sourceFingerprint === sourceFingerprint;
  const sourcesUnmoved = delta.added.length === 0 && delta.changed.length === 0 && delta.removed.length === 0;
  // A manifest that claims the inventory is unchanged while its own entries record
  // different source hashes describes two workspace states at once; nothing in it
  // can be trusted, so the build starts over rather than picking a side. An empty
  // entry list describes no sources, so there is nothing for it to contradict.
  if (inventoryUnmoved && !sourcesUnmoved && previous.entries.length > 0) {
    return fullRebuildPlan(input, 'source_fingerprint_divergent', sourceFingerprint);
  }

  // Extraction demand is not the test: an extractor upgrade re-extracts every
  // source while the workspace stands still. Dropping an extractor moves nothing
  // either, but its entries still leave the graph, so an invalidation of any kind
  // means there is work to do.
  const noop = inventoryUnmoved && sourcesUnmoved && extractCount === 0 && invalidated.length === 0;
  return Object.freeze({
    mode: noop ? ('noop' as const) : ('incremental' as const),
    rebuildReason: null,
    sourceFingerprint,
    addedPaths: delta.added,
    changedPaths: delta.changed,
    removedPaths: delta.removed,
    reuse: Object.freeze(reuse),
    extract: Object.freeze(extract),
    invalidated: Object.freeze(invalidated),
    extractCount,
    reuseCount: reuse.length,
  });
}
