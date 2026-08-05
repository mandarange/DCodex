import { codexHookTrustDoctor } from '../../codex-hooks/codex-hook-trust-doctor.js';
import type { UpdateMigrationStageRun } from '../update-migration-state.js';

type StageOutcome = Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>;

export async function runOtherHarnessCleanupStage(root: string): Promise<StageOutcome> {
  const { scanHarnessConflicts } = await import('../../harness-conflicts.js');
  const scan = await scanHarnessConflicts(root);
  if (scan.hard_block) {
    return {
      ok: false,
      status: 'failed',
      actions: ['other_harness_conflict_detected'],
      blockers: scan.hard.map((row: any) => `other_harness_conflict:${row.path}`),
      warnings: [],
      detail: {
        cleaned_count: 0,
        remaining_count: scan.hard.length,
        error_count: 0,
        cleanup_prompt_command: 'sks conflicts cleanup --yes'
      }
    };
  }
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
