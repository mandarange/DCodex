/**
 * Failure vocabulary for the generation store.
 *
 * Split out from the store itself because every module in the family raises
 * from the same closed set, and a code that only exists at one call site is a
 * code no caller can branch on.
 *
 * Two rules are enforced by the shape of the type rather than by convention:
 *
 * - **Compile-side blockers carry their own public code.** A refusal to publish
 *   is not a statement about an index a reader is holding; mapping `lint failed`
 *   or `stale writer` onto a reader error would tell a user to repair an index
 *   that is perfectly intact.
 * - **`detail` is numbers only.** The store handles workspace paths and hashes,
 *   so a `string` field here would sooner or later be filled with one of them
 *   and turn a failure report into a content leak (work order §1.4). Fields are
 *   identified by numeric id for the same reason.
 */

export const CONTEXT_INDEX_COMMIT_BLOCKED = 'context_index_commit_blocked' as const;

export const CONTEXT_INDEX_STORE_ERRORS = {
  pointer_missing: 'context_index_missing',
  generation_missing: 'context_index_missing',
  generation_meta_missing: 'context_index_missing',
  pointer_malformed: 'context_index_checksum_mismatch',
  meta_malformed: 'context_index_checksum_mismatch',
  meta_missing: 'context_index_checksum_mismatch',
  generation_checksum_mismatch: 'context_index_checksum_mismatch',
  generation_identity_mismatch: 'context_index_checksum_mismatch',
  generation_size_mismatch: 'context_index_truncated',
  pointer_meta_divergent: 'context_index_pointer_meta_divergent',
  source_fingerprint_stale: 'context_index_stale',
  format_revision_unsupported: 'context_index_format_unsupported',
  lint_not_passed: CONTEXT_INDEX_COMMIT_BLOCKED,
  stale_writer: CONTEXT_INDEX_COMMIT_BLOCKED,
  operation_in_flight: CONTEXT_INDEX_COMMIT_BLOCKED,
  phase_out_of_order: CONTEXT_INDEX_COMMIT_BLOCKED,
  retention_overflow: CONTEXT_INDEX_COMMIT_BLOCKED,
  temp_index_missing: CONTEXT_INDEX_COMMIT_BLOCKED,
  unsafe_store_path: CONTEXT_INDEX_COMMIT_BLOCKED,
} as const;

export type ContextIndexStoreErrorCode = keyof typeof CONTEXT_INDEX_STORE_ERRORS;

export const CONTEXT_INDEX_STORE_REBUILD_COMMAND = 'sks align run --rebuild-index' as const;
export const CONTEXT_INDEX_STORE_ALIGN_COMMAND = 'sks align run' as const;
export const CONTEXT_INDEX_STORE_UPDATE_COMMAND = 'sks update' as const;

/** Every failure names exactly one command; no error in this family is advisory (ADR §5). */
function repairCommandFor(publicCode: string): string {
  if (publicCode === 'context_index_format_unsupported') return CONTEXT_INDEX_STORE_UPDATE_COMMAND;
  if (publicCode === 'context_index_missing' || publicCode === 'context_index_stale') {
    return CONTEXT_INDEX_STORE_ALIGN_COMMAND;
  }
  return CONTEXT_INDEX_STORE_REBUILD_COMMAND;
}

/** Same discipline as the binary format's error type: a code, a repair command, and integers. */
export class ContextIndexStoreError extends Error {
  readonly code: ContextIndexStoreErrorCode;
  readonly publicCode: string;
  readonly repairCommand: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextIndexStoreErrorCode, detail: Record<string, number> = {}) {
    super(code);
    this.name = 'ContextIndexStoreError';
    this.code = code;
    this.publicCode = CONTEXT_INDEX_STORE_ERRORS[code];
    this.repairCommand = repairCommandFor(this.publicCode);
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (Number.isFinite(value)) numeric[key] = value;
    }
    this.detail = Object.freeze(numeric);
  }
}

export function refuseStore(code: ContextIndexStoreErrorCode, detail?: Record<string, number>): never {
  throw new ContextIndexStoreError(code, detail);
}
