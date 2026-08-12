/**
 * The join: a compiled snapshot becomes the generation every query reads.
 *
 * Every part of this sequence already existed and none of them called each
 * other. The build produced a snapshot and a fragment manifest hash, the writer
 * encoded bytes, and the store owned durability, the pointer CAS, retention and
 * recovery — but the only production caller of `encodeContextIndex` was a
 * benchmark adapter, so no real workspace had a published v2 index. This module
 * is the missing call, and it is the whole of it:
 *
 * ```text
 * runIncrementalBuild -> beginContextIndexOperation({ fragmentManifestHash })
 *   -> encodeContextIndex({ snapshot, configHash, schemaRevision, lexicon })
 *   -> stageContextIndexGeneration -> commitContextIndexGeneration
 *   -> cleanContextIndexOperation
 * ```
 *
 * Four properties are structural rather than reviewed:
 *
 * - **The lexicon config is threaded, never copied.** Omitting `lexicon` leaves
 *   the four dictionary sections empty, and a symbol query against the published
 *   index then returns nothing — a blocker found by measurement, not by review.
 *   The value comes from `query/ranking-config.ts` because that is the only file
 *   the bounded optimizer may edit; a weight copied to this call site would be a
 *   weight nothing can tune.
 * - **A lint failure refuses to publish, in compile-side terms.** The writer
 *   already refuses a snapshot carrying lint errors; that refusal is translated
 *   into `context_index_commit_blocked` rather than allowed to surface as a
 *   reader code, because telling a user to rebuild an index that is intact is a
 *   wrong instruction, not merely an imprecise one.
 * - **Nothing here writes the pointer.** The store replaces it last, after every
 *   lint and every checksum; this module supplies bytes and a lint verdict and
 *   has no other say in when a generation becomes visible.
 * - **A failure abandons the operation and leaves the previous generation
 *   untouched.** Everything before the pointer replace is invisible to a reader,
 *   so abandoning only has to drop this operation's own temp artifact and
 *   journal — `current.json` is never opened for writing on any failure path,
 *   which is what makes a crash mid-publish leave it byte-identical.
 *
 * Crash recovery is deliberately *not* run here. `beginContextIndexOperation`
 * refuses while another operation is in flight, and that refusal is the
 * concurrency guard; recovering first would discard a live compiler's staged
 * index in the name of tidying up after a dead one. Recovery belongs to a caller
 * that knows no other compile is running.
 */
import crypto from 'node:crypto';
import type { ContextGraphSnapshot } from '../contracts.js';
import { CONTEXT_GRAPH_QUERY_PROFILES } from '../profiles.js';
import {
  CONTEXT_GRAPH_KERNEL_CONFIG,
  CONTEXT_GRAPH_LEXICON_CONFIG,
  CONTEXT_GRAPH_RANKING_CONFIG,
} from '../query/ranking-config.js';
import { CONTEXT_INDEX_FORMAT_REVISION } from '../runtime-index/format.js';
import {
  ContextIndexWriterError,
  encodeContextIndex,
  type ContextIndexWriteLexiconResult,
  type ContextIndexWriteResult,
} from '../runtime-index/writer.js';
import {
  beginContextIndexOperation,
  commitContextIndexGeneration,
  stageContextIndexGeneration,
} from '../store/generation-commit.js';
import { refuseStore } from '../store/generation-errors.js';
import type { ContextIndexMeta, ContextIndexPointer } from '../store/generation-pointer.js';
import { cleanContextIndexOperation } from '../store/generation-retention.js';
import type { ContextOperationJournal } from '../store/operation-journal.js';

export const CONTEXT_INDEX_CONFIG_LABEL = 'sks.context-index-config.v1' as const;

/**
 * Key order is forced rather than trusted. `JSON.stringify` follows insertion
 * order, so a config object refactored into the same values in a different order
 * would change the fingerprint and invalidate every published index for no
 * reason a reader could name.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * Config identity for a published generation: the format revision plus the whole
 * tuning surface. It is derived from the live config objects rather than from a
 * fixed label so that a retune produces a different index identity — the pointer,
 * the meta and the header then agree on which configuration the bytes were built
 * under, and a reader opening under a different one fails closed instead of
 * ranking with weights the index was not built for.
 */
export const CONTEXT_INDEX_CONFIG_HASH: Uint8Array = new Uint8Array(
  crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        label: CONTEXT_INDEX_CONFIG_LABEL,
        formatRevision: CONTEXT_INDEX_FORMAT_REVISION,
        lexicon: CONTEXT_GRAPH_LEXICON_CONFIG,
        ranking: CONTEXT_GRAPH_RANKING_CONFIG,
        kernel: CONTEXT_GRAPH_KERNEL_CONFIG,
        profiles: CONTEXT_GRAPH_QUERY_PROFILES,
      }),
    )
    .digest(),
);

/** The same 32 bytes as hex: what the pointer, the meta and the journal record. */
export const CONTEXT_INDEX_CONFIG_FINGERPRINT: string = Buffer.from(CONTEXT_INDEX_CONFIG_HASH).toString('hex');

export interface PublishContextIndexInput {
  readonly root: string;
  readonly snapshot: ContextGraphSnapshot;
  /** Digest of the source inventory this snapshot was built from (`computeSourceInventoryFingerprint`). */
  readonly sourceFingerprint: string;
  /** From `runIncrementalBuild`; `null` when the caller's build produced no manifest. */
  readonly fragmentManifestHash?: string | null | undefined;
  /** Lint error codes. Non-empty means the writer refuses and nothing is published. */
  readonly lintErrors?: readonly string[] | undefined;
  readonly lintWarnings?: number | undefined;
  readonly protectedNodeIds?: Iterable<string> | undefined;
  readonly invalidatedNodeIds?: Iterable<string> | undefined;
  readonly now?: string | undefined;
}

export interface PublishedContextIndexGeneration {
  /** False when the pointer already named this exact generation and nothing was replaced. */
  readonly committed: boolean;
  readonly reason: 'committed' | 'already_current';
  readonly snapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
  readonly indexBytes: number;
  /** Workspace-relative; never absolute, because it is copied straight out of the pointer. */
  readonly generationPath: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** `null` only if the lexicon were ever omitted, which this module never does. */
  readonly lexicon: ContextIndexWriteLexiconResult | null;
  readonly removedGenerationFiles: number;
  readonly pointer: ContextIndexPointer;
  readonly meta: ContextIndexMeta;
}

function encode(input: PublishContextIndexInput, lintErrors: readonly string[]): ContextIndexWriteResult {
  try {
    return encodeContextIndex({
      snapshot: input.snapshot,
      configHash: CONTEXT_INDEX_CONFIG_HASH,
      schemaRevision: CONTEXT_INDEX_FORMAT_REVISION,
      // Never omitted. Without it `LEXICON_TABLE`, `LEXICON_POSTINGS`,
      // `COARSE_TERM_TABLE` and `COARSE_POSTINGS` are written zero-length, only
      // the anchor lane can produce candidates, and the published index answers
      // a pasted path and nothing else.
      lexicon: CONTEXT_GRAPH_LEXICON_CONFIG,
      ...(lintErrors.length > 0 ? { lintErrors } : {}),
      ...(input.protectedNodeIds === undefined ? {} : { protectedNodeIds: input.protectedNodeIds }),
      ...(input.invalidatedNodeIds === undefined ? {} : { invalidatedNodeIds: input.invalidatedNodeIds }),
    });
  } catch (error: unknown) {
    // The writer's refusal is correct but is phrased as a writer fault. A lint
    // failure is a refusal to *publish*, so it is reported as one: the index a
    // reader currently holds is intact and still serving.
    if (error instanceof ContextIndexWriterError && error.code === 'lint_error') {
      refuseStore('lint_not_passed', { errors: lintErrors.length });
    }
    throw error;
  }
}

/**
 * Drop an operation that will not finish.
 *
 * The cleanup failure is swallowed on purpose: it is a second-order problem, and
 * replacing the real blocker with it would hide the reason the publish stopped.
 * Nothing a reader can see changes either way — the pointer was never touched.
 */
async function abandon(root: string, journal: ContextOperationJournal): Promise<void> {
  try {
    await cleanContextIndexOperation(root, journal);
  } catch {
    /* the operation is already unreachable; the original error is the one that matters */
  }
}

export async function publishContextIndexGeneration(
  input: PublishContextIndexInput,
): Promise<PublishedContextIndexGeneration> {
  const lintErrors = input.lintErrors ?? [];
  const journal = await beginContextIndexOperation(input.root, {
    targetSnapshotHash: input.snapshot.snapshotHash,
    configFingerprint: CONTEXT_INDEX_CONFIG_FINGERPRINT,
    sourceFingerprint: input.sourceFingerprint,
    fragmentManifestHash: input.fragmentManifestHash ?? null,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  try {
    const encoded = encode(input, lintErrors);
    const staged = await stageContextIndexGeneration(input.root, journal, encoded.bytes);
    const commit = await commitContextIndexGeneration(input.root, staged, {
      lint: {
        passed: lintErrors.length === 0,
        errorCount: lintErrors.length,
        warningCount: Math.max(0, Math.trunc(input.lintWarnings ?? 0)),
      },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    // Retention runs after the pointer, never before it: pruning to a pointer
    // that has not moved yet would delete the generation about to become current.
    const cleaned = await cleanContextIndexOperation(input.root, commit.journal);
    return Object.freeze({
      committed: commit.committed,
      reason: commit.reason,
      snapshotHash: commit.pointer.snapshotHash,
      configFingerprint: commit.pointer.configFingerprint,
      sourceFingerprint: commit.pointer.sourceFingerprint,
      indexBytes: commit.meta.indexBytes,
      generationPath: commit.pointer.generationPath,
      nodeCount: commit.meta.nodeCount,
      edgeCount: commit.meta.edgeCount,
      lexicon: encoded.lexicon,
      removedGenerationFiles: cleaned.removedGenerationFiles,
      pointer: commit.pointer,
      meta: commit.meta,
    });
  } catch (error: unknown) {
    await abandon(input.root, journal);
    throw error;
  }
}
