/**
 * The reader's frozen failure surface.
 *
 * ADR §5: every failure names one command, and no error is advisory. Corruption
 * inside the file is raised by `format.ts` with its own granular code; this
 * module covers the failures only a reader holding the pointer can detect, and
 * gives consumers one place to turn either kind into a code and a repair.
 *
 * There is no "recoverable" tier here on purpose. A consumer that can tell the
 * two error classes apart will eventually handle one and swallow the other, and
 * a swallowed index error is the silent downgrade to a slower path that §1
 * forbids.
 */
import { ContextIndexFormatError } from './format.js';

export const CONTEXT_INDEX_ERROR_REPAIR = {
  context_index_missing: 'sks align run',
  context_index_stale: 'sks align run',
  context_index_format_unsupported: 'sks update',
  context_index_checksum_mismatch: 'sks align run --rebuild-index',
  context_index_truncated: 'sks align run --rebuild-index',
  context_index_pointer_meta_divergent: 'sks align run --rebuild-index',
  context_operation_journal_corrupt: 'sks align run --rebuild-index',
} as const;

export type ContextIndexErrorCode = keyof typeof CONTEXT_INDEX_ERROR_REPAIR;

/**
 * Numbers only, for the same reason `ContextIndexFormatError` carries numbers
 * only: the file holds interned workspace strings, so a `string` field on an
 * error would sooner or later be filled with a decoded value from the very file
 * being rejected, turning a corrupt-index report into a content leak.
 */
export class ContextIndexReaderError extends Error {
  readonly code: ContextIndexErrorCode;
  readonly publicCode: ContextIndexErrorCode;
  readonly repairCommand: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextIndexErrorCode, detail: Record<string, number> = {}) {
    super(code);
    this.name = 'ContextIndexReaderError';
    this.code = code;
    this.publicCode = code;
    this.repairCommand = CONTEXT_INDEX_ERROR_REPAIR[code];
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (Number.isFinite(value)) numeric[key] = value;
    }
    this.detail = Object.freeze(numeric);
  }
}

export interface ContextIndexFailure {
  readonly code: ContextIndexErrorCode;
  readonly repairCommand: string;
}

/**
 * Normalizes both error families into the public code a caller reports.
 *
 * A format error and a pointer error are the same event to a user — "the index
 * is unusable, run this" — so consumers must not pattern-match on the error
 * class. Returns `null` for anything that is not an index failure, so an
 * unrelated bug is never reported as a corrupt index.
 */
export function contextIndexFailureOf(error: unknown): ContextIndexFailure | null {
  if (error instanceof ContextIndexReaderError) {
    return { code: error.code, repairCommand: error.repairCommand };
  }
  if (error instanceof ContextIndexFormatError) {
    const code = error.publicCode as ContextIndexErrorCode;
    return { code, repairCommand: error.repairCommand };
  }
  return null;
}
