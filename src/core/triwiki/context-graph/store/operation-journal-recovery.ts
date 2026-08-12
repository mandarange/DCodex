/**
 * Pure crash-recovery decision over journal state.
 *
 * Deliberately free of filesystem access: this function decides what would
 * *permit* a resume, and the generation store then has to earn it by proving the
 * temp artifact still exists and still checksums. Keeping the two apart is what
 * stops "the phase says indexed" from being mistaken for "the bytes are good" —
 * `resume_index` is a candidacy, never a licence.
 *
 * Resume is gated on the provenance and source fingerprints, not on the phase
 * alone: a temp index built from sources that have since changed is a stale
 * artifact wearing a valid checksum.
 */
import { CONTEXT_OPERATION_RESUMABLE_PHASE, type ContextOperationJournal } from './operation-journal-schema.js';

export const CONTEXT_OPERATION_RECOVERY_ACTIONS = [
  'start',
  'resume_index',
  'discard_temp',
  'finish_commit',
  'clear_journal',
] as const;

export type ContextOperationRecoveryAction = (typeof CONTEXT_OPERATION_RECOVERY_ACTIONS)[number];

export const CONTEXT_OPERATION_RECOVERY_REASONS = [
  'no_operation',
  'commit_completed',
  'stale_journal',
  'fingerprint_drift',
  'phase_not_resumable',
  'resume_candidate',
  'temp_index_missing',
  'temp_index_checksum_mismatch',
] as const;

export type ContextOperationRecoveryReason = (typeof CONTEXT_OPERATION_RECOVERY_REASONS)[number];

export interface ContextOperationExpectation {
  readonly targetSnapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
}

export interface ContextOperationRecoveryPlan {
  readonly action: ContextOperationRecoveryAction;
  readonly reason: ContextOperationRecoveryReason;
  readonly journal: ContextOperationJournal | null;
}

/**
 * Pure decision over journal state. The filesystem proof (does the temp index
 * exist, does it still checksum) is deliberately not here: this function decides
 * what would *permit* a resume, and the store then has to earn it. `resume_index`
 * is therefore a candidacy, never a licence.
 */
export function planContextOperationRecovery(
  journal: ContextOperationJournal | null,
  expectation: ContextOperationExpectation,
): ContextOperationRecoveryPlan {
  if (!journal) return { action: 'start', reason: 'no_operation', journal: null };

  // Checked before fingerprints: once the pointer has been replaced the work is
  // done and only cleanup is owed, whether or not the sources have since moved.
  if (journal.phase === 'committed') {
    return { action: 'finish_commit', reason: 'commit_completed', journal };
  }
  if (journal.phase === 'cleaned') {
    return { action: 'clear_journal', reason: 'stale_journal', journal };
  }

  const drifted =
    journal.targetSnapshotHash !== expectation.targetSnapshotHash ||
    journal.configFingerprint !== expectation.configFingerprint ||
    journal.sourceFingerprint !== expectation.sourceFingerprint;
  if (drifted) return { action: 'discard_temp', reason: 'fingerprint_drift', journal };

  if (journal.phase === CONTEXT_OPERATION_RESUMABLE_PHASE && journal.indexChecksum) {
    return { action: 'resume_index', reason: 'resume_candidate', journal };
  }
  return { action: 'discard_temp', reason: 'phase_not_resumable', journal };
}
