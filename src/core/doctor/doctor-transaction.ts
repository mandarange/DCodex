import path from 'node:path';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import type { DoctorDirtyPlan } from './doctor-dirty-planner.js';
import { isDoctorPhaseClean, markDoctorPhaseClean } from './doctor-dirty-planner.js';
import { ui as cliUi } from '../../cli/cli-theme.js';
import { messageOf } from '../errors/message.js';

export interface DoctorFixTransactionPhase {
  id: string;
  ok: boolean;
  repaired?: boolean;
  rollback_evidence?: string | null;
  manual_required?: boolean;
  required_for_ready?: boolean;
  blockers?: string[];
  warnings?: string[];
  artifact_path?: string | null;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  rollback_performed?: boolean;
  /** Paths this phase actually wrote in this run. */
  changed_files?: string[];
}

export interface DoctorFixPhaseDefinition {
  id: string;
  required_for_ready?: boolean;
  run: () => Promise<DoctorFixTransactionPhase | void>;
  /**
   * The phase's own repair report. `changedFilesFromRepairReport` reads the
   * written paths out of it, which is what makes the doctor idempotence gate
   * able to see a second run that was not a no-op.
   */
  report?: () => unknown;
  postcheck?: (phase: DoctorFixTransactionPhase) => Promise<Partial<DoctorFixTransactionPhase> | void>;
  rollback?: (phase: DoctorFixTransactionPhase) => Promise<void>;
}

/**
 * Keys whose values name a path THIS RUN wrote. Deliberately excludes
 * `existing`, `preserved`, and `generated_files`, which list managed paths that
 * were already correct — counting those would make every run look mutating.
 */
const CHANGED_PATH_KEYS = Object.freeze([
  'repaired_paths', 'created_files', 'created', 'updated', 'changed_files',
  'written_files', 'removed_files', 'removed', 'quarantined', 'backups'
]);

export function changedFilesFromRepairReport(report: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    for (const key of CHANGED_PATH_KEYS) {
      const entries = row[key];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const text = String(entry || '').trim();
          if (text) found.add(text);
        }
      } else if (typeof entries === 'string' && entries.trim()) {
        found.add(entries.trim());
      }
    }
    // A backup or a config path is only evidence of a write when the same
    // report says the write happened.
    if (row.changed === true || row.applied === true) {
      for (const key of ['config_path', 'backup_path', 'path', 'file']) {
        const text = String(row[key] || '').trim();
        if (text) found.add(text);
      }
    }
    for (const nested of Object.values(row)) walk(nested, depth + 1);
  };
  walk(report, 0);
  return [...found].sort();
}

export interface DoctorFixTransaction {
  schema: 'sks.doctor-fix-transaction.v2';
  ok: boolean;
  root: string;
  started_at: string;
  completed_at: string;
  phases: Array<{
    id: string;
    ok: boolean;
    repaired: boolean;
    manual_required: boolean;
    required_for_ready: boolean;
    blockers: string[];
    warnings: string[];
    artifact_path: string | null;
    rollback_evidence: string | null;
    started_at: string | null;
    completed_at: string | null;
    duration_ms: number | null;
    rollback_performed: boolean;
    changed_files: string[];
  }>;
  postcheck_ok: boolean;
  rollback_performed: boolean;
  mutations_without_rollback: number;
  /** Union of every path the phases wrote; the idempotence gate reads this. */
  changed_files: string[];
  raw_secret_values_recorded: false;
  skipped_clean_phases: string[];
  dirty_phases: string[];
  proof_ids_used: string[];
  saved_ms_estimate: number;
  semantic_dirty_plan_path: string | null;
  report_write_failed?: boolean;
}

export async function runDoctorFixTransaction(input: {
  root: string;
  phases: DoctorFixPhaseDefinition[];
  reportPath?: string | null;
  dirtyPlan?: DoctorDirtyPlan | null;
  json?: boolean;
  machineOnly?: boolean;
}): Promise<DoctorFixTransaction> {
  const startedAt = nowIso();
  const phases: DoctorFixTransactionPhase[] = [];
  const proofIdsUsed: string[] = [];
  let rollbackPerformed = false;
  const liveOutput = input.json !== true && input.machineOnly !== true;
  for (const definition of input.phases) {
    const phaseStarted = nowIso();
    const startedMs = Date.now();
    if (liveOutput) cliUi.step(`▸ ${definition.id} ...`);
    let phase: DoctorFixTransactionPhase = {
      id: definition.id,
      ok: false,
      repaired: false,
      manual_required: false,
      required_for_ready: definition.required_for_ready !== false,
      blockers: [],
      warnings: [],
      artifact_path: null,
      started_at: phaseStarted
    };
    if (isDoctorPhaseClean(input.dirtyPlan, definition.id)) {
      const proofId = input.dirtyPlan?.phases.find((row) => row.id === definition.id)?.last_clean_proof_id;
      if (proofId) proofIdsUsed.push(proofId);
      phases.push({
        ...phase,
        ok: true,
        rollback_evidence: 'clean_phase_no_mutation',
        warnings: [`dirty_plan_skipped_clean_phase${proofId ? `:${proofId}` : ''}`],
        completed_at: nowIso(),
        duration_ms: Math.max(0, Date.now() - startedMs)
      });
      if (liveOutput) cliUi.step(`✔ ${definition.id} (${Math.round((Date.now() - startedMs) / 1000)}s)`);
      continue;
    }
    try {
      const result = await definition.run();
      phase = normalizePhase(definition, result, phase, startedMs);
      if (definition.postcheck) {
        const postcheck = await definition.postcheck(phase);
        if (postcheck) phase = mergePhase(phase, postcheck);
      }
    } catch (err: unknown) {
      phase = normalizePhase(definition, {
        id: definition.id,
        ok: false,
        blockers: [messageOf(err)]
      }, phase, startedMs);
    }
    if (!phase.ok && definition.rollback) {
      try {
        await definition.rollback(phase);
        phase.rollback_performed = true;
        rollbackPerformed = true;
      } catch (err: unknown) {
        phase.rollback_performed = true;
        rollbackPerformed = true;
        phase.blockers = [...(phase.blockers || []), `rollback_failed:${messageOf(err)}`];
      }
    }
    phase.completed_at = phase.completed_at || nowIso();
    phase.duration_ms = phase.duration_ms ?? Math.max(0, Date.now() - startedMs);
    phase.rollback_evidence = phase.rollback_evidence || (definition.rollback ? 'phase_rollback_function' : phase.repaired ? null : 'no_mutation');
    if (phase.ok || phase.repaired === true) {
      const proofId = `doctor-${definition.id}-${Date.now()}`;
      markDoctorPhaseClean(input.root, definition.id, proofId, phase.ok === true);
      proofIdsUsed.push(proofId);
    }
    phases.push(phase);
    if (liveOutput) cliUi.step(`${phase.ok ? '✔' : '✖'} ${definition.id} (${Math.round((phase.duration_ms || 0) / 1000)}s)`);
  }
  const writeInput: {
    root: string;
    startedAt: string;
    phases: DoctorFixTransactionPhase[];
    rollbackPerformed: boolean;
    reportPath?: string | null;
  } = {
    root: input.root,
    startedAt,
    phases,
    rollbackPerformed
  };
  if (input.reportPath !== undefined) writeInput.reportPath = input.reportPath;
  return writeDoctorFixTransaction({
    ...writeInput,
    dirtyPlan: input.dirtyPlan || null,
    proofIdsUsed
  });
}

export async function writeDoctorFixTransaction(input: {
  root: string;
  startedAt?: string;
  phases: DoctorFixTransactionPhase[];
  rollbackPerformed?: boolean;
  reportPath?: string | null;
  dirtyPlan?: DoctorDirtyPlan | null;
  proofIdsUsed?: string[];
}): Promise<DoctorFixTransaction> {
  const root = path.resolve(input.root);
  const phases = input.phases.map((phase) => ({
    id: phase.id,
    ok: phase.ok === true,
    repaired: phase.repaired === true,
    manual_required: phase.manual_required === true,
    required_for_ready: phase.required_for_ready !== false,
    blockers: phase.blockers || [],
    warnings: phase.warnings || [],
    artifact_path: phase.artifact_path || null,
    rollback_evidence: phase.rollback_evidence || null,
    started_at: phase.started_at || null,
    completed_at: phase.completed_at || null,
    duration_ms: Number.isFinite(phase.duration_ms) ? Number(phase.duration_ms) : null,
    rollback_performed: phase.rollback_performed === true,
    changed_files: [...new Set(phase.changed_files || [])].sort()
  }));
  const postcheckOk = phases.every((phase) => phase.ok || phase.required_for_ready === false);
  const mutationsWithoutRollback = phases.filter((phase) => phase.required_for_ready && phase.repaired && !phase.rollback_evidence).length;
  let report: DoctorFixTransaction = {
    schema: 'sks.doctor-fix-transaction.v2',
    ok: postcheckOk && mutationsWithoutRollback === 0,
    root,
    started_at: input.startedAt || nowIso(),
    completed_at: nowIso(),
    phases,
    postcheck_ok: postcheckOk && mutationsWithoutRollback === 0,
    rollback_performed: input.rollbackPerformed === true,
    mutations_without_rollback: mutationsWithoutRollback,
    changed_files: [...new Set(phases.flatMap((phase) => phase.changed_files))].sort(),
    raw_secret_values_recorded: false,
    skipped_clean_phases: phases.filter((phase) => phase.warnings.some((warning) => warning.startsWith('dirty_plan_skipped_clean_phase'))).map((phase) => phase.id),
    dirty_phases: input.dirtyPlan?.phases.filter((phase) => phase.status === 'dirty').map((phase) => phase.id) || phases.filter((phase) => !phase.warnings.some((warning) => warning.startsWith('dirty_plan_skipped_clean_phase'))).map((phase) => phase.id),
    proof_ids_used: [...new Set(input.proofIdsUsed || [])].sort(),
    saved_ms_estimate: phases.filter((phase) => phase.warnings.some((warning) => warning.startsWith('dirty_plan_skipped_clean_phase'))).length * 1000,
    semantic_dirty_plan_path: input.dirtyPlan?.semantic_dirty_plan_path || null
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-fix-transaction.json');
    try {
      await writeJsonAtomic(reportPath, report);
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true };
      process.stderr.write(`SKS doctor warning: failed to write transaction report ${reportPath}: ${messageOf(err)}\n`);
    }
  }
  return report;
}

function normalizePhase(
  definition: DoctorFixPhaseDefinition,
  result: DoctorFixTransactionPhase | void,
  fallback: DoctorFixTransactionPhase,
  startedMs: number
): DoctorFixTransactionPhase {
  const phase = result || fallback;
  return {
    id: phase.id || definition.id,
    ok: phase.ok === true,
    repaired: phase.repaired === true,
    manual_required: phase.manual_required === true,
    required_for_ready: phase.required_for_ready ?? definition.required_for_ready !== false,
    blockers: phase.blockers || [],
    warnings: phase.warnings || [],
    artifact_path: phase.artifact_path || null,
    rollback_evidence: phase.rollback_evidence || null,
    started_at: phase.started_at || fallback.started_at || nowIso(),
    completed_at: phase.completed_at || nowIso(),
    duration_ms: phase.duration_ms ?? Math.max(0, Date.now() - startedMs),
    rollback_performed: phase.rollback_performed === true,
    changed_files: phase.changed_files
      ?? (definition.report ? changedFilesFromRepairReport(definition.report()) : [])
  };
}

function mergePhase(phase: DoctorFixTransactionPhase, update: Partial<DoctorFixTransactionPhase>): DoctorFixTransactionPhase {
  return {
    ...phase,
    ...update,
    ok: phase.ok === true && update.ok !== false,
    repaired: phase.repaired === true || update.repaired === true,
    manual_required: phase.manual_required === true || update.manual_required === true,
    rollback_evidence: update.rollback_evidence || phase.rollback_evidence || null,
    blockers: [...(phase.blockers || []), ...(update.blockers || [])],
    warnings: [...(phase.warnings || []), ...(update.warnings || [])]
  };
}
