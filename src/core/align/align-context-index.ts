/**
 * Align's context-index seam: publish the generation, then project the pack from
 * the published generation rather than from bytes held in memory.
 *
 * Align replaces `.sneakoscope/wiki` wholesale by renaming a staged directory
 * over it, and the CRK2 generation store lives *inside* that directory. So a
 * generation published into the live root before promotion would be renamed away
 * by the promotion itself, and one published after promotion would be too late
 * for the code pack, which is a staged artifact. Both orderings are wrong, and
 * the resolution is neither: the staged wiki is built as the `.sneakoscope/wiki`
 * of a **pending workspace root**, the generation is published into that root,
 * and the promotion moves an already-published store into place atomically.
 *
 * That is what lets the pack be projected through the query facade — the same
 * `openWorkspaceContextIndex` every other consumer uses — instead of through the
 * inline `encodeContextIndex`/`openContextIndex` pair that stood in for a
 * publisher while there was none. If the pack can be built this way, the index
 * align just published is one a query can actually open; if it cannot, align
 * fails before it promotes anything.
 *
 * Failures are translated at this boundary. The store and the writer raise typed
 * errors carrying an ADR §5 public code, and align records blockers as strings —
 * so the public code is carried into the string rather than flattened into a
 * message, and `context_index_commit_blocked` stays distinguishable from the
 * reader codes that tell a user to rebuild.
 */
import path from 'node:path';
import { readSourceHashes } from '../triwiki/context-graph/compiler/freshness.js';
import { computeSourceInventoryFingerprint } from '../triwiki/context-graph/compiler/fragment-manifest.js';
import {
  publishContextIndexGeneration,
  type PublishedContextIndexGeneration
} from '../triwiki/context-graph/compiler/publish-index.js';
import type { ContextGraphSnapshot } from '../triwiki/context-graph/contracts.js';
import { openWorkspaceContextIndex, type ContextIndexReader } from '../triwiki/context-graph/query/index.js';
import { ContextIndexStoreError } from '../triwiki/context-graph/store/generation-errors.js';
import { ContextIndexWriterError } from '../triwiki/context-graph/runtime-index/writer.js';
import { ContextIndexFormatError } from '../triwiki/context-graph/runtime-index/format.js';
import { projectCodePackFromGraph, type CodePack } from '../triwiki/code-pack.js';

/** Directory under the align staging root that stands in for the workspace root. */
export const ALIGN_PENDING_ROOT_DIR = 'pending';

export const ALIGN_CONTEXT_INDEX_BLOCKER = 'code_navigation_context_index_blocked';

/**
 * The staged workspace root. Its `.sneakoscope/wiki` is what becomes the live
 * one, so every store path resolved against it — pointer, meta, generations —
 * lands at exactly the workspace-relative path it will occupy after promotion.
 */
export function alignPendingRoot(stageRoot: string): string {
  return path.join(stageRoot, ALIGN_PENDING_ROOT_DIR);
}

export function alignPendingWiki(stageRoot: string): string {
  return path.join(alignPendingRoot(stageRoot), '.sneakoscope', 'wiki');
}

/**
 * Source identity for the published generation, derived with the compiler's own
 * inventory digest so a generation align publishes and one an incremental build
 * publishes describe their sources the same way.
 */
export function alignSourceFingerprint(inputHashes: Readonly<Record<string, string>>): string {
  return computeSourceInventoryFingerprint(new Map(Object.entries(inputHashes)));
}

/** A typed index failure becomes an align blocker string, public code intact. */
function alignBlocker(error: unknown): Error {
  if (error instanceof ContextIndexStoreError) {
    return new Error(`${ALIGN_CONTEXT_INDEX_BLOCKER}:${error.publicCode}:${error.code}`);
  }
  if (error instanceof ContextIndexWriterError || error instanceof ContextIndexFormatError) {
    return new Error(`${ALIGN_CONTEXT_INDEX_BLOCKER}:${error.publicCode}:${error.code}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface PublishAlignContextIndexInput {
  readonly pendingRoot: string;
  readonly snapshot: ContextGraphSnapshot;
  readonly sourceFingerprint: string;
  /** From the build that produced this snapshot; `null` when it produced no manifest. */
  readonly fragmentManifestHash?: string | null | undefined;
  readonly lintErrors?: readonly string[] | undefined;
  readonly lintWarnings?: number | undefined;
}

export async function publishAlignContextIndex(
  input: PublishAlignContextIndexInput
): Promise<PublishedContextIndexGeneration> {
  try {
    return await publishContextIndexGeneration({
      root: input.pendingRoot,
      snapshot: input.snapshot,
      sourceFingerprint: input.sourceFingerprint,
      fragmentManifestHash: input.fragmentManifestHash ?? null,
      ...(input.lintErrors === undefined ? {} : { lintErrors: input.lintErrors }),
      ...(input.lintWarnings === undefined ? {} : { lintWarnings: input.lintWarnings })
    });
  } catch (error: unknown) {
    throw alignBlocker(error);
  }
}

function citedPaths(pack: CodePack): string[] {
  return [...new Set(pack.entries.flatMap((entry) => entry.citations.map((citation) => citation.path)))].sort();
}

export interface ProjectAlignCodePackInput {
  /** The real workspace root: citations and source hashes are resolved against it. */
  readonly root: string;
  readonly pendingRoot: string;
  readonly gitHeadSha: string | null;
  readonly generatedAt: string;
  /** Asserted against the pointer, so the pack cannot be projected from an index describing another tree. */
  readonly sourceFingerprint: string;
}

/**
 * Project the code pack from the generation align has just published.
 *
 * The cache is bypassed rather than used. A reader cached under the pending root
 * would outlive the directory that root names — promotion renames it away — and
 * the first thing a stale entry buys is an answer from a generation that no
 * longer exists on disk.
 */
export async function projectAlignCodePack(input: ProjectAlignCodePackInput): Promise<CodePack> {
  let reader: ContextIndexReader;
  try {
    const handle = await openWorkspaceContextIndex(input.pendingRoot, {
      cache: null,
      expectedSourceFingerprint: input.sourceFingerprint
    });
    reader = handle.reader;
  } catch (error: unknown) {
    throw alignBlocker(error);
  }
  const options = {
    generatedAt: input.generatedAt,
    gitHeadSha: input.gitHeadSha,
    snapshotFreshness: 'fresh' as const
  };
  const first = projectCodePackFromGraph(input.root, reader, options);
  const observed = await readSourceHashes(input.root, citedPaths(first.pack));
  return projectCodePackFromGraph(input.root, reader, { ...options, observedSourceHashes: observed }).pack;
}
