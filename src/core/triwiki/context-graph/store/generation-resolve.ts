/**
 * The read path: what a query is allowed to open.
 *
 * Two absences here are deliberate and load-bearing:
 *
 * - **No journal read.** A query that consulted the operation journal could act
 *   on an index that has not passed lint or checksum verification yet, which is
 *   exactly the partial-index read ADR §6 forbids. Nothing in this module knows
 *   the journal exists.
 * - **No previous-generation branch.** When the current generation is missing or
 *   short, this raises `context_index_missing` / `context_index_truncated` and
 *   names a repair command, even though a perfectly good previous generation is
 *   usually sitting right next to it. **The previous generation is not a
 *   rollback target** — it exists for incremental merge and audit. Serving it
 *   would be the silent downgrade ADR §1 forbids, and it would make the
 *   performance floor unobservable and the correctness floor unprovable.
 */
import fsp from 'node:fs/promises';
import { refuseStore } from './generation-errors.js';
import { contextIndexGenerationPath } from './generation-layout.js';
import {
  assertContextIndexPointerMetaAgreement,
  readContextIndexMeta,
  readContextIndexPointer,
  type ContextIndexMeta,
  type ContextIndexPointer,
} from './generation-pointer.js';

export interface ResolvedContextIndex {
  readonly pointer: ContextIndexPointer;
  readonly meta: ContextIndexMeta;
  /** Absolute path; resolved from the pointer, never from a directory listing. */
  readonly generationPath: string;
}

export interface ResolveContextIndexOptions {
  readonly expectedSourceFingerprint?: string | undefined;
}

export async function resolveCurrentContextIndex(
  root: string,
  options: ResolveContextIndexOptions = {},
): Promise<ResolvedContextIndex> {
  const pointer = await readContextIndexPointer(root);
  if (!pointer) refuseStore('pointer_missing', {});
  const meta = await readContextIndexMeta(root);
  if (!meta) refuseStore('meta_missing', {});
  assertContextIndexPointerMetaAgreement(pointer, meta);

  if (options.expectedSourceFingerprint && options.expectedSourceFingerprint !== pointer.sourceFingerprint) {
    refuseStore('source_fingerprint_stale', {});
  }

  const generationPath = contextIndexGenerationPath(root, pointer.snapshotHash);
  const stat = await fsp.stat(generationPath).catch(() => null);
  if (!stat || !stat.isFile()) refuseStore('generation_missing', {});
  // A cheap length check ahead of the reader: a file that lost bytes since it was
  // committed is truncated, and saying so beats letting a section offset walk off
  // the end of the buffer.
  if (stat.size !== pointer.indexBytes) {
    refuseStore('generation_size_mismatch', { found: stat.size, expected: pointer.indexBytes });
  }
  return { pointer, meta, generationPath };
}
