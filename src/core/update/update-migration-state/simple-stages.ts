import { codexHookTrustDoctor } from '../../codex-hooks/codex-hook-trust-doctor.js';
import type { UpdateMigrationStageRun } from '../update-migration-state.js';

type StageOutcome = Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>;

export async function runOtherHarnessCleanupStage(root: string): Promise<StageOutcome> {
  const { cleanupOtherHarnessConflicts, scanHarnessConflicts } = await import('../../harness-conflicts.js');
  const scan = await scanHarnessConflicts(root);
  if (!scan.hard_block) {
    return {
      ok: true,
      status: 'ok',
      actions: ['other_harness_conflict_check_clean'],
      blockers: [],
      warnings: [],
      detail: {
        cleaned_count: 0,
        remaining_count: 0,
        error_count: 0
      }
    };
  }
  const cleanup = await cleanupOtherHarnessConflicts(root);
  const remaining = Array.isArray(cleanup.remaining) ? cleanup.remaining : [];
  const errors = Array.isArray(cleanup.errors) ? cleanup.errors : [];
  const blockers = [
    ...remaining.map((row: { path?: string }) => `other_harness_conflict:${row.path || 'unknown'}`),
    ...errors.map((row: { path?: string; error?: string }) => `other_harness_cleanup_failed:${row.path || 'unknown'}:${row.error || 'error'}`),
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: ['other_harness_conflicts_quarantined'],
    blockers,
    warnings: [],
    detail: {
      cleaned_count: Array.isArray(cleanup.cleaned) ? cleanup.cleaned.length : 0,
      remaining_count: remaining.length,
      error_count: errors.length
    }
  };
}

export async function runHookTrustRefreshStage(root: string): Promise<StageOutcome> {
  const result = await codexHookTrustDoctor(root, { fix: true, managed: true, actual: true });
  const blockers = (result as any).ok === false
    ? ((result as any).blockers || ['hook_trust_refresh_failed'])
    : [];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: ['refreshed_hook_trust'],
    blockers,
    warnings: (result as any).warnings || [],
    detail: { entries: (result as any).current_hash_count ?? null }
  };
}
