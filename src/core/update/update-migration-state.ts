import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, exists, globalSksRoot, nowIso, packageRoot, PACKAGE_VERSION, projectRoot, readJson, readText, runProcess, sameFilesystemPath, sha256, which, writeJsonAtomic, writeReceiptRotated, writeTextAtomic } from '../fsx.js';
import { MANAGED_ASSET_VERSION } from '../managed-assets/managed-assets-manifest.js';
import { enforceRetention } from '../retention.js';
import { COMMANDS } from '../../cli/command-registry.js';
import { reconcileSkills } from '../init/skills.js';
import { codexHookTrustDoctor } from '../codex-hooks/codex-hook-trust-doctor.js';
import { writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { compareSemVer } from './semver.js';
import { escapeRegExp } from '../text/regex.js';

export const UPDATE_MIGRATION_SCHEMA = 'sks.project-migration-receipt.v2' as const;
export const INSTALLATION_EPOCH_SCHEMA = 'sks.installation-epoch.v1' as const;

export interface InstallationEpoch {
  schema: typeof INSTALLATION_EPOCH_SCHEMA;
  sks_version: string;
  package_realpath: string;
  build_sha256: string;
  managed_asset_version: string;
  installed_at: string;
  source: string;
}

export interface PackageLocalDoctorRun {
  schema: 'sks.package-local-doctor-run.v1';
  ok: boolean;
  status: 'ok' | 'failed' | 'missing_entrypoint';
  entrypoint: string | null;
  cwd: string;
  args: string[];
  exit_code: number | null;
  parsed_ok: boolean | null;
  required_blockers: string[];
  optional_warnings: string[];
  stdout_tail: string;
  stderr_tail: string;
  timedOut: boolean;
  timed_out: boolean;
  error: string | null;
}

export interface UpdateRetentionCleanupRun {
  schema: 'sks.update-retention-cleanup.v1';
  ok: boolean;
  status: 'completed' | 'skipped' | 'failed';
  root: string;
  source: string;
  generated_at: string;
  action_count: number;
  cleanup_report_path: string | null;
  storage_report_path: string | null;
  reason?: string;
  error?: string | null;
}

export interface UpdateMigrationReceipt {
  schema: typeof UPDATE_MIGRATION_SCHEMA;
  status: 'current' | 'pending_project_receipt' | 'blocked' | 'skipped';
  sks_version: string;
  root: string;
  source: string;
  generated_at: string;
  project_root_hash?: string;
  installation_epoch_sha256?: string;
  project_semantic_hash?: string;
  pending_marker_path?: string | null;
  installation_epoch_path?: string | null;
  from_version?: string | null;
  doctor?: PackageLocalDoctorRun | null;
  retention_cleanup?: UpdateRetentionCleanupRun | null;
  update_stages?: unknown[];
  migration_stages?: UpdateMigrationStageSummary[];
  required_blockers?: string[];
  optional_warnings?: string[];
  blockers: string[];
  warnings: string[];
}

export interface UpdateMigrationStageRun {
  schema: 'sks.update-migration-stage.v2';
  id: string;
  ok: boolean;
  status: 'ok' | 'skipped' | 'failed';
  min_from_version: string;
  from_version: string | null;
  actions: string[];
  blockers: string[];
  warnings: string[];
  detail?: Record<string, unknown>;
}

export interface UpdateMigrationStageSummary {
  id: string;
  ok: boolean;
  status: 'ok' | 'skipped' | 'failed';
  action_count: number;
  blocker_count: number;
  warning_count: number;
}

export interface UpdateMigrationGateResult {
  schema: 'sks.update-migration-gate.v1';
  ok: boolean;
  status: 'current' | 'repaired' | 'skipped' | 'blocked';
  root: string;
  command: string;
  receipt_path: string;
  pending_marker_path: string;
  installation_epoch_path: string;
  receipt: UpdateMigrationReceipt | null;
  doctor: PackageLocalDoctorRun | null;
  scope: 'global' | 'project';
  failed_stage_id: string | null;
  blockers: string[];
  warnings: string[];
}

export function installationEpochPath(): string {
  return path.join(globalSksRoot(), 'update', 'installation-epoch.json');
}

export function pendingUpdateMigrationPath(): string {
  return installationEpochPath();
}

export function projectUpdateMigrationReceiptPath(root: string): string {
  return path.join(root, '.sneakoscope', 'update', 'migration-receipt.json');
}

export async function readPendingUpdateMigration(): Promise<UpdateMigrationReceipt | null> {
  const epoch = await readInstallationEpoch();
  if (!epoch) return null;
  return {
    schema: UPDATE_MIGRATION_SCHEMA,
    status: 'pending_project_receipt',
    sks_version: epoch.sks_version,
    root: globalSksRoot(),
    source: epoch.source,
    generated_at: epoch.installed_at,
    pending_marker_path: installationEpochPath(),
    installation_epoch_path: installationEpochPath(),
    installation_epoch_sha256: installationEpochSha256(epoch),
    blockers: [],
    warnings: []
  };
}

export async function readProjectUpdateMigrationReceipt(root: string): Promise<UpdateMigrationReceipt | null> {
  return readJson<UpdateMigrationReceipt | null>(projectUpdateMigrationReceiptPath(root), null).catch(() => null);
}

export function isUpdateMigrationReceiptCurrent(
  receipt: UpdateMigrationReceipt | null | undefined,
  expectedVersion = PACKAGE_VERSION
): boolean {
  return receipt?.schema === UPDATE_MIGRATION_SCHEMA
    && receipt.status === 'current'
    && receipt.sks_version === expectedVersion
    && typeof receipt.installation_epoch_sha256 === 'string'
    && Array.isArray(receipt.blockers)
    && receipt.blockers.length === 0
    && (!Array.isArray(receipt.required_blockers) || receipt.required_blockers.length === 0);
}

export async function readInstallationEpoch(): Promise<InstallationEpoch | null> {
  return readJson<InstallationEpoch | null>(installationEpochPath(), null).catch(() => null);
}

export async function ensureInstallationEpoch(source = 'runtime'): Promise<InstallationEpoch> {
  const current = await buildInstallationEpoch(source);
  const existing = await readInstallationEpoch();
  if (existing && isInstallationEpochCurrent(existing, current)) return existing;
  await writeJsonAtomic(installationEpochPath(), current);
  return current;
}

export async function writePendingUpdateMigration(input: {
  source: string;
  doctor?: PackageLocalDoctorRun | null;
  blockers?: string[];
  warnings?: string[];
}): Promise<UpdateMigrationReceipt> {
  const epoch = await ensureInstallationEpoch(input.source);
  const pendingPath = installationEpochPath();
  const receipt: UpdateMigrationReceipt = {
    schema: UPDATE_MIGRATION_SCHEMA,
    status: 'pending_project_receipt',
    sks_version: PACKAGE_VERSION,
    root: globalSksRoot(),
    source: input.source,
    generated_at: nowIso(),
    pending_marker_path: pendingPath,
    installation_epoch_path: pendingPath,
    installation_epoch_sha256: installationEpochSha256(epoch),
    doctor: input.doctor || null,
    required_blockers: input.blockers || [],
    optional_warnings: input.warnings || [],
    blockers: input.blockers || [],
    warnings: input.warnings || []
  };
  return receipt;
}

export async function clearPendingUpdateMigration(): Promise<void> {
  // v2 keeps a persistent installation epoch; project receipts are compared
  // independently and one project must not consume global migration state.
}

export async function writeProjectUpdateMigrationReceipt(input: {
  root: string;
  source: string;
  status?: UpdateMigrationReceipt['status'];
  doctor?: PackageLocalDoctorRun | null;
  updateStages?: unknown[];
  fromVersion?: string | null;
  blockers?: string[];
  warnings?: string[];
}): Promise<UpdateMigrationReceipt> {
  const receiptPath = projectUpdateMigrationReceiptPath(input.root);
  const epoch = await ensureInstallationEpoch(input.source);
  const retentionCleanup = await runUpdateRetentionCleanup(input.root, input.source);
  const migrationStageRuns = await runUpdateMigrationStages(input.root, { fromVersion: input.fromVersion || null });
  const migrationStages = migrationStageRuns.map(summarizeMigrationStage);
  const stageBlockers = migrationStageRuns.flatMap((stage) => stage.blockers.map((blocker) => `${stage.id}:${blocker}`));
  const stageWarnings = migrationStageRuns.flatMap((stage) => stage.warnings.map((warning) => `${stage.id}:${warning}`));
  const requiredBlockers = [...(input.blockers || []), ...stageBlockers];
  const optionalWarnings = [...(input.warnings || []), ...stageWarnings];
  const receipt: UpdateMigrationReceipt = {
    schema: UPDATE_MIGRATION_SCHEMA,
    status: input.status || (requiredBlockers.length ? 'blocked' : 'current'),
    sks_version: PACKAGE_VERSION,
    root: input.root,
    source: input.source,
    generated_at: nowIso(),
    from_version: input.fromVersion || null,
    project_root_hash: projectRootHash(input.root),
    installation_epoch_sha256: installationEpochSha256(epoch),
    project_semantic_hash: await projectSemanticHash(input.root),
    pending_marker_path: installationEpochPath(),
    installation_epoch_path: installationEpochPath(),
    doctor: input.doctor || null,
    retention_cleanup: retentionCleanup,
    update_stages: [...(input.updateStages || []), ...migrationStages],
    migration_stages: migrationStages,
    required_blockers: requiredBlockers,
    optional_warnings: optionalWarnings,
    blockers: requiredBlockers,
    warnings: optionalWarnings
  };
  await writeReceiptRotated(receiptPath, receipt, { keep: 5 });
  return receipt;
}

function summarizeMigrationStage(stage: UpdateMigrationStageRun): UpdateMigrationStageSummary {
  return {
    id: stage.id,
    ok: stage.ok,
    status: stage.status,
    action_count: stage.actions.length,
    blocker_count: stage.blockers.length,
    warning_count: stage.warnings.length
  };
}

export async function runUpdateRetentionCleanup(root: string, source = 'update-migration'): Promise<UpdateRetentionCleanupRun> {
  const missionsPath = path.join(root, '.sneakoscope', 'missions');
  const cleanupPath = path.join(root, '.sneakoscope', 'reports', 'retention-cleanup.json');
  const storagePath = path.join(root, '.sneakoscope', 'reports', 'storage.json');
  if (process.env.SKS_UPDATE_RETENTION_CLEANUP === '0') {
    return {
      schema: 'sks.update-retention-cleanup.v1',
      ok: true,
      status: 'skipped',
      root,
      source,
      generated_at: nowIso(),
      action_count: 0,
      cleanup_report_path: null,
      storage_report_path: null,
      reason: 'disabled_by_env'
    };
  }
  if (!(await exists(missionsPath))) {
    return {
      schema: 'sks.update-retention-cleanup.v1',
      ok: true,
      status: 'skipped',
      root,
      source,
      generated_at: nowIso(),
      action_count: 0,
      cleanup_report_path: null,
      storage_report_path: null,
      reason: 'missions_missing'
    };
  }
  try {
    const result = await enforceRetention(root, {
      mode: 'update_migration',
      pruneReportLogs: true,
      policy: { max_tmp_age_hours: 0 }
    });
    return {
      schema: 'sks.update-retention-cleanup.v1',
      ok: true,
      status: 'completed',
      root,
      source,
      generated_at: nowIso(),
      action_count: Array.isArray(result.actions) ? result.actions.length : 0,
      cleanup_report_path: cleanupPath,
      storage_report_path: storagePath
    };
  } catch (err: any) {
    return {
      schema: 'sks.update-retention-cleanup.v1',
      ok: false,
      status: 'failed',
      root,
      source,
      generated_at: nowIso(),
      action_count: 0,
      cleanup_report_path: null,
      storage_report_path: null,
      error: err?.message || String(err)
    };
  }
}

type UpdateMigrationStageDefinition = {
  id: string;
  min_from_version: string;
  run: (root: string, fromVersion: string | null) => Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>>;
};

const UPDATE_MIGRATION_STAGES: UpdateMigrationStageDefinition[] = [
  {
    id: 'other-harness-cleanup',
    min_from_version: '0.0.0',
    run: runOtherHarnessCleanupStage
  },
  {
    id: 'current-public-surface-reconcile',
    min_from_version: '0.0.0',
    run: runCurrentPublicSurfaceReconcileStage
  },
  {
    id: 'session-state-split',
    min_from_version: '0.0.0',
    run: runSessionStateSplitStage
  },
  {
    id: 'skills-reconcile',
    min_from_version: '0.0.0',
    run: runSkillsReconcileStage
  },
  {
    id: 'menubar-retarget',
    min_from_version: '0.0.0',
    run: runMenubarRetargetStage
  },
  {
    id: 'config-fastmode-normalize',
    min_from_version: '0.0.0',
    run: runConfigFastModeNormalizeStage
  },
  {
    id: 'hook-trust-refresh',
    min_from_version: '0.0.0',
    run: runHookTrustRefreshStage
  },
  {
    id: 'receipt-rotation',
    min_from_version: '0.0.0',
    run: runReceiptRotationStage
  }
];

async function runOtherHarnessCleanupStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const { scanHarnessConflicts } = await import('../harness-conflicts.js');
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

async function runCurrentPublicSurfaceReconcileStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const [{ runDoctorCommandAliasCleanup }, { reconcileRetiredAgentRoleResidue }, { migrateSksProfilesToPerFile }] = await Promise.all([
    import('../doctor/command-alias-cleanup.js'),
    import('../agents/agent-role-config.js'),
    import('../auto-review.js')
  ]);
  const home = path.resolve(process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global'));
  // Serialize config writers: public-surface guidance and profile migration both touch ~/.codex/config.toml.
  const publicSurface = await runDoctorCommandAliasCleanup({ root, home, globalRuntimeRoot, fix: true });
  const retiredRoles = await reconcileRetiredAgentRoleResidue({ root, home, globalRuntimeRoot, fix: true });
  const profileMigration = await migrateSksProfilesToPerFile({ env: process.env }).catch((err: any) => ({
    error: err?.message || String(err),
    retired_profile_table_count: 0,
    retired_profile_file_removed_count: 0
  }));
  const remainingCount = Number(publicSurface.cleanup?.remaining_count || 0)
    + Number(publicSurface.cleanup?.managed_runtime?.remaining_managed_artifact_count || 0)
    + Number(publicSurface.cleanup?.project_guidance?.remaining_count || 0)
    + retiredRoles.remaining_count;
  const blockers = [
    ...(publicSurface.ok === true ? [] : ['public_surface_reconcile_failed']),
    ...(retiredRoles.ok === true ? [] : ['retired_agent_role_reconcile_failed']),
    ...((profileMigration as any).error ? [`retired_profile_migration_failed:${(profileMigration as any).error}`] : []),
    ...(remainingCount > 0 ? [`public_surface_remaining:${remainingCount}`] : [])
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: ['reconciled_current_public_surface'],
    blockers,
    warnings: [],
    detail: {
      removed_skill_count: Number(publicSurface.cleanup?.removed_count || 0),
      quarantined_skill_collision_count: Number(publicSurface.cleanup?.preserved_user_collision_count || 0),
      removed_runtime_artifact_count: Number(publicSurface.cleanup?.managed_runtime?.removed_managed_artifact_count || 0),
      quarantined_runtime_collision_count: Number(publicSurface.cleanup?.managed_runtime?.preserved_user_file_count || 0),
      reconciled_guidance_count: Number(publicSurface.cleanup?.project_guidance?.reconciled_count || 0),
      quarantined_guidance_collision_count: Number(publicSurface.cleanup?.project_guidance?.preserved_user_file_count || 0),
      removed_retired_role_count: retiredRoles.removed_count,
      quarantined_retired_role_collision_count: retiredRoles.quarantined_user_collision_count,
      retired_profile_table_count: Number((profileMigration as any).retired_profile_table_count || 0),
      retired_profile_file_removed_count: Number((profileMigration as any).retired_profile_file_removed_count || 0),
      remaining_count: remainingCount
    }
  };
}

async function runUpdateMigrationStages(root: string, opts: { fromVersion?: string | null } = {}): Promise<UpdateMigrationStageRun[]> {
  const fromVersion = opts.fromVersion || null;
  const runs: UpdateMigrationStageRun[] = [];
  for (const stage of UPDATE_MIGRATION_STAGES) {
    if (!legacyStageApplies(fromVersion, stage.min_from_version)) {
      runs.push({
        schema: 'sks.update-migration-stage.v2',
        id: stage.id,
        ok: true,
        status: 'skipped',
        min_from_version: stage.min_from_version,
        from_version: fromVersion,
        actions: ['skipped_by_from_version'],
        blockers: [],
        warnings: []
      });
      continue;
    }
    try {
      const result = await stage.run(root, fromVersion);
      runs.push({
        schema: 'sks.update-migration-stage.v2',
        id: stage.id,
        min_from_version: stage.min_from_version,
        from_version: fromVersion,
        ...result
      });
    } catch (err: any) {
      runs.push({
        schema: 'sks.update-migration-stage.v2',
        id: stage.id,
        ok: false,
        status: 'failed',
        min_from_version: stage.min_from_version,
        from_version: fromVersion,
        actions: [],
        blockers: [err?.message || String(err)],
        warnings: []
      });
    }
  }
  return runs;
}

async function runSessionStateSplitStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const legacyCurrent = path.join(root, '.sneakoscope', 'current.json');
  const stateCurrent = path.join(root, '.sneakoscope', 'state', 'current.json');
  const sessionsDir = path.join(root, '.sneakoscope', 'state', 'sessions');
  await ensureDir(sessionsDir);
  const actions: string[] = [];
  let current = await readJson<any>(stateCurrent, null).catch(() => null);
  const legacy = await readJson<any>(legacyCurrent, null).catch(() => null);
  if (!current && legacy) {
    current = legacy;
    await writeJsonAtomic(stateCurrent, current);
    actions.push('copied_legacy_current_json_to_state_current');
  }
  const missionId = typeof current?.mission_id === 'string' ? current.mission_id : typeof current?.mission === 'string' ? current.mission : null;
  if (missionId) {
    const sessionPath = path.join(sessionsDir, `${safeFileName(missionId)}.json`);
    if (!(await exists(sessionPath))) {
      await writeJsonAtomic(sessionPath, { ...current, migrated_from: path.relative(root, stateCurrent), migrated_at: nowIso() });
      actions.push('wrote_state_session_alias');
    }
  }
  if (!actions.length) actions.push('session_state_current');
  return { ok: true, status: 'ok', actions, blockers: [], warnings: [], detail: { legacy_present: Boolean(legacy), mission_id: missionId } };
}

async function runSkillsReconcileStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const home = path.resolve(process.env.HOME || os.homedir());
  const globalTarget = path.resolve(home, '.agents', 'skills');
  const projectTarget = path.resolve(root, '.agents', 'skills');
  const global = await reconcileSkills({ targetDir: globalTarget, scope: 'global', fix: true })
    .catch((err: any) => ({ ok: false, error: err?.message || String(err) }));
  const sameSkillRoot = await sameFilesystemPath(projectTarget, globalTarget);
  const project = sameSkillRoot
    ? {
        schema: 'sks.skill-reconcile.v1',
        ok: true,
        scope: 'project',
        target_dir: projectTarget,
        fix: true,
        skipped: true,
        reason: 'same_as_authoritative_global_skill_root'
      }
    : await reconcileSkills({ targetDir: projectTarget, scope: 'project', fix: true })
      .catch((err: any) => ({ ok: false, error: err?.message || String(err) }));
  const globalRemaining = Number((global as any).retired_residue?.remaining_count || 0);
  const projectRemaining = Number((project as any).retired_residue?.remaining_count || 0);
  const blockers = [
    ...((global as any).ok === false || (global as any).error ? [`global:${(global as any).error || 'failed'}`] : []),
    ...((project as any).ok === false || (project as any).error ? [`project:${(project as any).error || 'failed'}`] : []),
    ...(globalRemaining ? [`global_retired_residue_remaining:${globalRemaining}`] : []),
    ...(projectRemaining ? [`project_retired_residue_remaining:${projectRemaining}`] : [])
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: [
      'reconciled_global_skills',
      sameSkillRoot ? 'skipped_project_skills_same_as_global' : 'reconciled_project_skills'
    ],
    blockers,
    warnings: [],
    detail: {
      global_installed: Array.isArray((global as any).installed) ? (global as any).installed.length : null,
      global_removed_count: Number((global as any).retired_residue?.removed_count || 0)
        + (Array.isArray((global as any).removed) ? (global as any).removed.length : 0),
      project_removed_count: Number((project as any).retired_residue?.removed_count || 0)
        + (Array.isArray((project as any).removed) ? (project as any).removed.length : 0),
      residue_remaining_count: globalRemaining + projectRemaining
    }
  };
}

async function runMenubarRetargetStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const installDir = path.join(os.homedir(), '.codex', 'sks-menubar');
  const actionScript = path.join(installDir, 'sks-menubar-action.sh');
  const buildStamp = path.join(installDir, 'build-stamp.json');
  const text = await readText(actionScript, null);
  if (typeof text !== 'string') return { ok: true, status: 'ok', actions: ['menubar_action_script_absent'], blockers: [], warnings: [] };
  const desired = path.join(packageRoot(), 'dist', 'bin', 'sks.js');
  const line = `SKS_ENTRY='${desired.replace(/'/g, `'\\''`)}'`;
  const actions: string[] = [];
  const stampedGeneration = await exists(buildStamp);
  const next = /^\s*SKS_ENTRY\s*=.*$/m.test(text)
    ? text.replace(/^\s*SKS_ENTRY\s*=.*$/m, line)
    : `${line}\n${text}`;
  if (next !== text) {
    if (stampedGeneration) {
      // A stamped Menu Bar generation binds the action script hash to the app,
      // resources, LaunchAgent, and rollback candidate. Rewriting only the
      // script here would make the current generation unverifiable before the
      // transactional installer can replace it. Preserve the generation and
      // let the installer retarget all bound artifacts atomically.
      actions.push('deferred_menubar_retarget_to_transactional_rebuild');
    } else {
      await writeTextAtomic(actionScript, next);
      actions.push('retargeted_legacy_menubar_action_script');
    }
  }
  const stat = await fsp.stat(actionScript).catch(() => null);
  if (!stat || (stat.mode & 0o111) === 0) {
    await fsp.chmod(actionScript, 0o755);
    actions.push('restored_menubar_action_executable_bit');
  }
  return {
    ok: true,
    status: 'ok',
    actions: actions.length ? actions : ['menubar_action_script_current'],
    blockers: [],
    warnings: [],
    detail: {
      action_script: actionScript,
      build_stamp_present: stampedGeneration,
      retarget_deferred: stampedGeneration && next !== text
    }
  };
}

async function runConfigFastModeNormalizeStage(): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const { reconcileRetiredSksConfigText } = await import('../auto-review.js');
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const text = await readText(configPath, null);
  if (typeof text !== 'string') return { ok: true, status: 'ok', actions: ['codex_config_absent'], blockers: [], warnings: [] };
  const normalized = normalizeLegacyFastModeConfigForUpdate(text);
  const retired = reconcileRetiredSksConfigText(normalized.text);
  const nextText = ensureTrailingNewline(retired.text);
  const actions = [
    ...normalized.actions,
    ...(retired.detected_count > 0 ? ['stripped_retired_sks_config_profiles_and_policies'] : [])
  ];
  if (nextText === ensureTrailingNewline(text)) {
    return {
      ok: true,
      status: 'ok',
      actions: actions.length ? actions : ['fastmode_config_current'],
      blockers: [],
      warnings: [],
      detail: {
        config_path: configPath,
        default_profile: normalized.defaultProfile,
        retired_config_detected_count: retired.detected_count
      }
    };
  }
  let guardResult: any = null;
  guardResult = await writeCodexConfigGuarded({
    configPath,
    before: text,
    mutate: () => nextText,
    cause: 'project-update-fastmode-normalize',
    backupTag: 'project-update-fastmode-normalize',
    preserveFastUiKeys: true
  });
  if (!guardResult.ok) {
    return {
      ok: false,
      status: 'failed',
      actions: ['normalize_fastmode_config_blocked'],
      blockers: [`codex_config_guard:${guardResult.status}`],
      warnings: [],
      detail: {
        config_path: configPath,
        default_profile: normalized.defaultProfile,
        retired_config_detected_count: retired.detected_count,
        guard: guardResult
      }
    };
  }
  return {
    ok: true,
    status: 'ok',
    actions: actions.length ? actions : ['fastmode_config_current'],
    blockers: [],
    warnings: [],
    detail: {
      config_path: configPath,
      default_profile: normalized.defaultProfile,
      retired_config_detected_count: retired.detected_count,
      guard: guardResult
    }
  };
}

async function runHookTrustRefreshStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const result = await codexHookTrustDoctor(root, { fix: true, managed: true, actual: true });
  const blockers = (result as any).ok === false ? ((result as any).blockers || ['hook_trust_refresh_failed']) : [];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: ['refreshed_hook_trust'],
    blockers,
    warnings: (result as any).warnings || [],
    detail: { entries: (result as any).current_hash_count ?? null }
  };
}

async function runReceiptRotationStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const receiptPath = projectUpdateMigrationReceiptPath(root);
  const dir = path.dirname(receiptPath);
  const base = path.basename(receiptPath);
  const rows = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const rotated = await Promise.all(rows
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.`) && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const file = path.join(dir, entry.name);
      return { file, stat: await fsp.stat(file).catch(() => null) };
    }));
  const removable = rotated
    .filter((row): row is { file: string; stat: import('node:fs').Stats } => Boolean(row.stat))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(5);
  await Promise.all(removable.map((row) => fsp.rm(row.file, { force: true }).catch(() => undefined)));
  return {
    ok: true,
    status: 'ok',
    actions: removable.length ? ['rotated_old_update_receipts'] : ['receipt_rotation_current'],
    blockers: [],
    warnings: [],
    detail: { removed: removable.length }
  };
}

function legacyStageApplies(fromVersion: string | null, minFromVersion: string): boolean {
  if (!fromVersion) return true;
  if (compareVersionLike(fromVersion, PACKAGE_VERSION) > 0) return false;
  return compareVersionLike(fromVersion, minFromVersion) >= 0;
}

function compareVersionLike(a: string | null | undefined, b: string | null | undefined): number {
  return compareSemVer(a, b) ?? 0;
}

function safeFileName(value: string): string {
  return String(value || 'session').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function insertTopLevelTomlKey(text: string, line: string): string {
  const raw = String(text || '').trimEnd();
  const firstTable = raw.search(/^\s*\[/m);
  if (firstTable < 0) return `${line}\n${raw}`.trim() + '\n';
  return `${raw.slice(0, firstTable).trimEnd()}\n${line}\n\n${raw.slice(firstTable).trimStart()}`.trim() + '\n';
}

function normalizeLegacyFastModeConfigForUpdate(text: string): { text: string; actions: string[]; defaultProfile: string | null } {
  // 2026-07 ChatGPT desktop merge: default_profile, [user.fast_mode], and
  // [profiles.<name>] tables left the Codex config schema. This migration now
  // STRIPS the stamps older SKS versions wrote instead of normalizing them, and
  // preserves a legacy "fast default" semantically by writing the documented
  // top-level service_tier = "fast" in their place.
  let next = String(text || '');
  const actions: string[] = [];
  const misplaced = tomlTableString(next, 'user.fast_mode', 'default_profile');
  const topLevel = topLevelTomlString(next, 'default_profile');
  const legacyFastDefault = misplaced === 'sks-fast-high' || topLevel === 'sks-fast-high';
  const before = next;
  next = removeTopLevelTomlKeyLocal(next, 'default_profile');
  next = removeTomlTableLocal(next, 'user.fast_mode');
  next = removeTomlTableLocal(next, 'profiles.sks-fast-high');
  next = removeTomlTableKeyLocal(next, 'notice', 'fast_default_opt_out');
  if (next !== before) actions.push('stripped_removed_fastmode_config_schema_keys');
  if (legacyFastDefault && !topLevelTomlString(next, 'service_tier')) {
    next = insertTopLevelTomlKey(next, 'service_tier = "fast"');
    actions.push('migrated_legacy_fast_default_to_service_tier');
  }
  return { text: ensureTrailingNewline(next), actions, defaultProfile: misplaced || topLevel };
}

function removeTopLevelTomlKeyLocal(text: string, key: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return lines.filter((line, index) => index >= end || !keyPattern.test(line)).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function removeTomlTableLocal(text: string, table: string): string {
  const lines = String(text || '').trimEnd().split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((x) => x.trim() === header);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln !== undefined && /^\s*\[.+\]\s*$/.test(ln)) { end = i; break; }
  }
  return lines.filter((_, index) => index < start || index >= end).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}
function tomlTableString(text: string, table: string, key: string): string | null {
  const block = tomlTableBlock(text, table);
  const match = block?.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match?.[1] || null;
}

function topLevelTomlString(text: string, key: string): string | null {
  const source = String(text || '');
  const firstTable = source.search(/^\s*\[/m);
  const top = firstTable < 0 ? source : source.slice(0, firstTable);
  const match = top.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match?.[1] || null;
}

function tomlTableBlock(text: string, table: string): string | null {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => tableHeaderMatches(line, table));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index] || '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function removeTomlTableKeyLocal(text: string, table: string, key: string): string {
  const lines = String(text || '').split(/\r?\n/);
  let inTable = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) inTable = tableHeaderMatches(line, table);
    if (inTable && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function upsertTomlTableKeyIfAbsentLocal(text: string, table: string, line: string): string {
  const key = tomlLineKey(line);
  return tomlTableHasKey(text, table, key) ? text : upsertTomlTableKeyLocal(text, table, line);
}

function upsertTomlTableKeyLocal(text: string, table: string, line: string): string {
  const raw = String(text || '').trimEnd();
  const key = tomlLineKey(line);
  const lines = raw ? raw.split(/\r?\n/) : [];
  const start = lines.findIndex((candidate) => tableHeaderMatches(candidate, table));
  if (start < 0) {
    return `${raw}${raw ? '\n\n' : ''}[${table}]\n${line}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index] || '')) {
      end = index;
      break;
    }
  }
  for (let index = start + 1; index < end; index += 1) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[index] || '')) {
      if (lines[index] === line) return `${lines.join('\n')}\n`;
      lines[index] = line;
      return `${lines.join('\n')}\n`;
    }
  }
  lines.splice(end, 0, line);
  return `${lines.join('\n')}\n`;
}

function tomlTableHasKey(text: string, table: string, key: string): boolean {
  const block = tomlTableBlock(text, table);
  return Boolean(block && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'm').test(block));
}

function tableHeaderMatches(line: string, table: string): boolean {
  return new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*$`).test(line || '');
}

function tomlLineKey(line: string): string {
  return String(line || '').split('=')[0]?.trim() || '';
}

function ensureTrailingNewline(text: string): string {
  return `${String(text || '').trim()}\n`;
}

export async function ensureCurrentMigrationBeforeCommand(input: {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  skipMigrationGate?: boolean;
}): Promise<UpdateMigrationGateResult> {
  const env = input.env || process.env;
  const command = input.command;
  const root = await projectRoot(input.cwd || process.cwd()).catch(() => path.resolve(input.cwd || process.cwd()));
  const receiptPath = projectUpdateMigrationReceiptPath(root);
  const pendingPath = installationEpochPath();
  const empty: Omit<UpdateMigrationGateResult, 'ok' | 'status' | 'receipt' | 'doctor' | 'blockers' | 'warnings' | 'failed_stage_id'> = {
    schema: 'sks.update-migration-gate.v1',
    root,
    command,
    scope: 'project',
    receipt_path: receiptPath,
    pending_marker_path: pendingPath,
    installation_epoch_path: pendingPath
  };
  if (env.SKS_UPDATE_MIGRATION_GATE_DISABLED === '1') {
    return { ...empty, ok: true, status: 'skipped', receipt: null, doctor: null, failed_stage_id: null, blockers: [], warnings: ['gate_disabled_by_env'] };
  }
  if (input.skipMigrationGate === true || commandSkipsMigrationGate(command)) {
    return { ...empty, ok: true, status: 'skipped', receipt: null, doctor: null, failed_stage_id: null, blockers: [], warnings: [`skip_migration_gate_command:${command}`] };
  }
  // projectRoot() falls back to the raw cwd when no project marker is found.
  // launchd-spawned callers (the SKS menu bar app) run with cwd=/ — there is
  // no project to migrate there, and proceeding would mkdir /.sneakoscope and
  // crash the whole command before it starts.
  if (root === path.parse(root).root) {
    return { ...empty, ok: true, status: 'skipped', receipt: null, doctor: null, failed_stage_id: null, blockers: [], warnings: ['no_project_workspace_at_filesystem_root'] };
  }
  // A git repository is not automatically an SKS project. Global Codex skills
  // (including DFix) may run in ordinary repositories, and route-local state or
  // a stale failed migration receipt can leave a partial `.sneakoscope` folder
  // behind. Only strong installed-project markers authorize project migration.
  if (!(await hasSksProjectMigrationMarker(root))) {
    return { ...empty, ok: true, status: 'skipped', receipt: null, doctor: null, failed_stage_id: null, blockers: [], warnings: ['non_sks_workspace_migration_gate_skipped'] };
  }

  const [epoch, receipt] = await Promise.all([
    ensureInstallationEpoch('first-command-gate'),
    readProjectUpdateMigrationReceipt(root)
  ]);
  const requireReceipt = env.SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT === '1';
  if (isProjectReceiptCurrentForEpoch(receipt, epoch) && !requireReceipt) {
    return { ...empty, ok: true, status: 'current', receipt, doctor: null, failed_stage_id: null, blockers: [], warnings: [] };
  }

  const recheck = requireReceipt
    ? undefined
    : async (): Promise<UpdateMigrationGateResult | null> => {
        const fresh = await readProjectUpdateMigrationReceipt(root);
        if (isProjectReceiptCurrentForEpoch(fresh, epoch)) {
          return { ...empty, ok: true, status: 'current', receipt: fresh, doctor: null, failed_stage_id: null, blockers: [], warnings: [] };
        }
        return null;
      };

  return withUpdateMigrationLock(root, empty, async () => {
    const reportFile = path.join(root, '.sneakoscope', 'update', 'doctor-migration.json');
    await pruneLegacyDoctorMigrationReports(root).catch(() => undefined);
    const baseTimeoutMs = migrationDoctorTimeoutMs(env);
    let doctor = await runPackageLocalDoctor({
      root,
      args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', reportFile],
      env: {
        ...env,
        SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
        SKS_DISABLE_UPDATE_CHECK: '1'
      },
      timeoutMs: baseTimeoutMs,
      maxOutputBytes: 32 * 1024
    });
    const timeoutWarnings: string[] = [];
    if (!doctor.ok && doctor.timedOut) {
      timeoutWarnings.push(`doctor_migration_timeout_retry:timeout_ms=${baseTimeoutMs}`);
      doctor = await runPackageLocalDoctor({
        root,
        args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', reportFile],
        env: {
          ...env,
          SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
          SKS_DISABLE_UPDATE_CHECK: '1',
          SKS_MIGRATION_DOCTOR_RETRY: '1'
        },
        timeoutMs: baseTimeoutMs * 2,
        maxOutputBytes: 32 * 1024
      });
    }
    const preservedUserOwnedConfig = migrationDoctorOnlyPreservedUserOwnedConfig(doctor);
    if (!doctor.ok && !preservedUserOwnedConfig) {
      const blocker = doctor.timedOut ? 'doctor_migration_timeout' : 'doctor_migration_failed';
      const requiredBlockers = [blocker, ...(doctor.required_blockers.length ? doctor.required_blockers : [])];
      const warnings = [
        ...timeoutWarnings,
        ...doctor.optional_warnings,
        ...(doctor.timedOut ? ['doctor_migration_timeout_may_be_network_or_first_compile_slow_run_sks_doctor_fix_yes_for_live_progress'] : [])
      ];
      const blocked = await writeProjectUpdateMigrationReceipt({
        root,
        source: 'first-command-gate',
        status: 'blocked',
        doctor,
        blockers: requiredBlockers,
        warnings
      });
      return { ...empty, ok: false, status: 'blocked', receipt: blocked, doctor, failed_stage_id: 'doctor:migration-profile', blockers: requiredBlockers, warnings };
    }
    const preservationWarnings = preservedUserOwnedConfig
      ? [
          'migration_doctor_preserved_user_owned_project_config',
          ...doctor.required_blockers.map((blocker) => `migration_optional_blocker:${blocker}`)
        ]
      : [];
    const warnings = [...new Set([
      ...timeoutWarnings,
      ...doctor.optional_warnings,
      ...preservationWarnings
    ])];
    const current = await writeProjectUpdateMigrationReceipt({
      root,
      source: 'first-command-gate',
      doctor,
      blockers: [],
      warnings
    });
    return { ...empty, ok: true, status: 'repaired', receipt: current, doctor, failed_stage_id: null, blockers: [], warnings };
  }, recheck ? { recheck } : {});
}

function migrationDoctorOnlyPreservedUserOwnedConfig(doctor: PackageLocalDoctorRun): boolean {
  const blockers = doctor.required_blockers.map((blocker) => String(blocker || '').trim()).filter(Boolean);
  if (!blockers.length || !blockers.every(isUserOwnedProjectConfigBlocker)) return false;
  return doctor.optional_warnings.some((warning) => {
    const value = String(warning || '').trim();
    return value === 'unmanaged_project_config_preserved'
      || value.endsWith(':unmanaged_project_config_preserved');
  });
}

function isUserOwnedProjectConfigBlocker(blocker: string): boolean {
  return blocker === 'user_owned_file_without_sks_marker'
    || blocker.endsWith(':user_owned_file_without_sks_marker')
    || blocker === 'config_write_guard:blocked_unmanaged_project_config'
    || blocker.endsWith(':config_write_guard:blocked_unmanaged_project_config');
}

async function hasSksProjectMigrationMarker(root: string): Promise<boolean> {
  const markers = [
    path.join(root, '.sneakoscope', 'manifest.json'),
    path.join(root, '.sneakoscope', 'policy.json'),
    path.join(root, '.codex', 'SNEAKOSCOPE.md')
  ];
  const present = await Promise.all(markers.map((marker) => exists(marker)));
  return present.some(Boolean);
}

export async function runPostinstallGlobalDoctorAndMarkPending(input: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ schema: 'sks.postinstall-global-doctor.v1'; ok: boolean; doctor: PackageLocalDoctorRun | null; pending: UpdateMigrationReceipt | null; blockers: string[]; warnings: string[] }> {
  const env = input.env || process.env;
  if (env.SKS_POSTINSTALL_GLOBAL_DOCTOR === '0') {
    const pending = await writePendingUpdateMigration({
      source: 'postinstall',
      doctor: null,
      warnings: ['global_doctor_skipped_by_env']
    });
    return { schema: 'sks.postinstall-global-doctor.v1', ok: true, doctor: null, pending, blockers: [], warnings: ['global_doctor_skipped_by_env'] };
  }
  const doctor = await runPackageLocalDoctor({
    root: globalSksRoot(),
    args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', path.join(globalSksRoot(), 'update', 'postinstall-doctor.json')],
    env: {
      ...env,
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
      SKS_DISABLE_UPDATE_CHECK: '1',
      SKS_POSTINSTALL_NO_BOOTSTRAP: '1'
    },
    timeoutMs: migrationDoctorTimeoutMs(env),
    maxOutputBytes: 32 * 1024
  });
  const pending = await writePendingUpdateMigration({
    source: 'postinstall',
    doctor,
    blockers: doctor.ok ? [] : ['postinstall_global_doctor_failed']
  });
  return {
    schema: 'sks.postinstall-global-doctor.v1',
    ok: doctor.ok,
    doctor,
    pending,
    blockers: doctor.ok ? [] : ['postinstall_global_doctor_failed'],
    warnings: []
  };
}

function commandSkipsMigrationGate(command: string): boolean {
  const entry = (COMMANDS as Record<string, { skipMigrationGate?: boolean; readonly?: boolean } | undefined>)[command];
  return entry?.skipMigrationGate === true || entry?.readonly === true;
}

function migrationDoctorTimeoutMs(env: NodeJS.ProcessEnv): number {
  const override = Number.parseInt(env.SKS_MIGRATION_DOCTOR_TIMEOUT_MS || '', 10);
  return Number.isFinite(override) && override > 0 ? override : 180_000;
}

export async function runPackageLocalDoctor(input: {
  root?: string;
  entrypoint?: string | null;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
} = {}): Promise<PackageLocalDoctorRun> {
  const entrypoint = input.entrypoint || path.join(packageRoot(), 'dist', 'bin', 'sks.js');
  const cwd = input.root || globalSksRoot();
  const args = input.args || ['doctor', '--json'];
  const env = input.env || process.env;
  const testRun = testPackageLocalDoctorRun({ entrypoint, cwd, args, env });
  if (testRun) return testRun;
  if (!(await exists(entrypoint))) {
    return {
      schema: 'sks.package-local-doctor-run.v1',
      ok: false,
      status: 'missing_entrypoint',
      entrypoint,
      cwd,
      args,
      exit_code: null,
      parsed_ok: null,
      required_blockers: ['missing_package_local_sks_entrypoint'],
      optional_warnings: [],
      stdout_tail: '',
      stderr_tail: '',
      timedOut: false,
      timed_out: false,
      error: `missing package-local sks entrypoint: ${entrypoint}`
    };
  }
  const result = await runProcess(process.execPath, [entrypoint, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
      SKS_DISABLE_UPDATE_CHECK: '1'
    },
    timeoutMs: input.timeoutMs ?? 5 * 60 * 1000,
    maxOutputBytes: input.maxOutputBytes ?? 64 * 1024
  }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err),
    timedOut: false
  }));
  const reportFile = reportFileFromArgs(args);
  const parsed = reportFile
    ? await readJson(reportFile, null).catch(() => null)
    : parseDoctorJson((result as any).stdout);
  const parsedOk = typeof parsed?.ok === 'boolean' ? parsed.ok : null;
  const ok = (result as any).code === 0 && (reportFile ? parsedOk === true : parsedOk !== false);
  const requiredBlockers = extractRequiredBlockers(parsed, ok);
  const optionalWarnings = extractOptionalWarnings(parsed);
  return {
    schema: 'sks.package-local-doctor-run.v1',
    ok,
    status: ok ? 'ok' : 'failed',
    entrypoint,
    cwd,
    args,
    exit_code: (result as any).code ?? null,
    parsed_ok: parsedOk,
    required_blockers: requiredBlockers,
    optional_warnings: optionalWarnings,
    stdout_tail: tail((result as any).stdout || ''),
    stderr_tail: tail((result as any).stderr || ''),
    timedOut: (result as any).timedOut === true,
    timed_out: (result as any).timedOut === true,
    error: ok ? null : tail((result as any).stderr || (result as any).stdout || requiredBlockers.join(', ') || 'doctor failed')
  };
}

function testPackageLocalDoctorRun(input: {
  entrypoint: string;
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): PackageLocalDoctorRun | null {
  if (input.env.SKS_TEST_DOCTOR_TIMEOUT_ONCE === '1' && input.env.SKS_MIGRATION_DOCTOR_RETRY !== '1') {
    return mockPackageLocalDoctorRun(input, {
      ok: false,
      timedOut: true,
      exitCode: 124,
      blockers: ['test_doctor_timeout_once']
    });
  }
  if (input.env.SKS_TEST_DOCTOR_TIMEOUT_ONCE === '1' && input.env.SKS_MIGRATION_DOCTOR_RETRY === '1') {
    return mockPackageLocalDoctorRun(input, {
      ok: true,
      timedOut: false,
      exitCode: 0,
      warnings: ['test_doctor_retry_succeeded']
    });
  }
  if (input.env.SKS_TEST_DOCTOR_FAIL === '1') {
    return mockPackageLocalDoctorRun(input, {
      ok: false,
      timedOut: false,
      exitCode: 1,
      blockers: ['test_doctor_failed']
    });
  }
  if (input.env.SKS_TEST_DOCTOR_USER_CONFIG_PRESERVED === '1') {
    return mockPackageLocalDoctorRun(input, {
      ok: false,
      timedOut: false,
      exitCode: 1,
      blockers: [
        'project:user_owned_file_without_sks_marker',
        'user_owned_file_without_sks_marker'
      ],
      warnings: ['project:unmanaged_project_config_preserved']
    });
  }
  if (input.env.SKS_TEST_DOCTOR_OK === '1') {
    return mockPackageLocalDoctorRun(input, {
      ok: true,
      timedOut: false,
      exitCode: 0,
      warnings: ['test_doctor_ok']
    });
  }
  return null;
}

function mockPackageLocalDoctorRun(
  input: { entrypoint: string; cwd: string; args: string[] },
  result: { ok: boolean; timedOut: boolean; exitCode: number; blockers?: string[]; warnings?: string[] }
): PackageLocalDoctorRun {
  return {
    schema: 'sks.package-local-doctor-run.v1',
    ok: result.ok,
    status: result.ok ? 'ok' : 'failed',
    entrypoint: input.entrypoint,
    cwd: input.cwd,
    args: input.args,
    exit_code: result.exitCode,
    parsed_ok: result.ok,
    required_blockers: result.ok ? [] : result.blockers || [],
    optional_warnings: result.warnings || [],
    stdout_tail: result.ok ? '{"ok":true}' : '',
    stderr_tail: result.ok ? '' : (result.blockers || ['doctor failed']).join(', '),
    timedOut: result.timedOut,
    timed_out: result.timedOut,
    error: result.ok ? null : (result.blockers || ['doctor failed']).join(', ')
  };
}

export async function resolveInstalledSksEntrypoint(input: {
  packageName?: string;
  globalRoot?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | null> {
  const packageName = input.packageName || 'sneakoscope';
  const candidates = [
    input.globalRoot ? path.join(input.globalRoot, packageName, 'dist', 'bin', 'sks.js') : null,
    path.join(packageRoot(), 'dist', 'bin', 'sks.js')
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return which('sks');
}

// 20차 P2-2: was 20s — --help now bypasses this gate entirely (cli/router.ts),
// so this timeout only affects commands that genuinely need the migration
// gate; 5s is enough to cooperate with a sibling in-flight migration without
// making every gated command absorb a 20s worst case.
const MIGRATION_LOCK_WAIT_MS = 5_000;
const MIGRATION_LOCK_POLL_MS = 150;
const MIGRATION_LOCK_PROGRESS_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUpdateMigrationLock(
  root: string,
  base: Omit<UpdateMigrationGateResult, 'ok' | 'status' | 'receipt' | 'doctor' | 'blockers' | 'warnings' | 'failed_stage_id'>,
  fn: () => Promise<UpdateMigrationGateResult>,
  options: { recheck?: () => Promise<UpdateMigrationGateResult | null>; maxWaitMs?: number } = {}
): Promise<UpdateMigrationGateResult> {
  const lockPath = path.join(root, '.sneakoscope', 'update', 'migration.lock');
  try {
    await ensureDir(path.dirname(lockPath));
  } catch (err: any) {
    // An unwritable root (read-only mount, cwd outside any workspace) must fail
    // the gate with a reportable blocker, not crash the whole CLI dispatch.
    return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: [`update_migration_lock_dir_unwritable:${err?.message || String(err)}`], warnings: [] };
  }
  const recheck = options.recheck ?? null;
  const waitStartedAt = Date.now();
  const deadline = waitStartedAt + (options.maxWaitMs ?? MIGRATION_LOCK_WAIT_MS);
  let reapedStale = false;
  let lastProgressAt = 0;
  for (;;) {
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(lockPath, 'wx');
    } catch (err: any) {
      if (err?.code !== 'EEXIST') {
        return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: [`update_migration_lock_error:${err?.message || String(err)}`], warnings: [] };
      }
      // The lock is held by a concurrent process. Cooperate instead of failing fast:
      // 1) a sibling may have already completed the migration we need.
      if (recheck) {
        const done = await recheck();
        if (done) return done;
      }
      // 2) reap a genuinely stale lock (dead holder or older than the stale threshold).
      if (!reapedStale && await removeStaleMigrationLock(lockPath)) {
        reapedStale = true;
        continue;
      }
      // 3) wait for the in-flight holder to finish, then retry acquisition.
      if (Date.now() < deadline) {
        const now = Date.now();
        if (now - lastProgressAt >= MIGRATION_LOCK_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          process.stderr.write(`Waiting for SKS migration lock (${Math.round((now - waitStartedAt) / 1000)}s)...\n`);
        }
        await delay(MIGRATION_LOCK_POLL_MS);
        continue;
      }
      // 4) gave up waiting on a live holder.
      return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: ['update_migration_lock_held'], warnings: [] };
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: nowIso(), version: PACKAGE_VERSION }) + '\n', 'utf8');
      return await fn();
    } catch (err: any) {
      return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: [`update_migration_lock_error:${err?.message || String(err)}`], warnings: [] };
    } finally {
      await handle.close().catch(() => undefined);
      await fsp.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}

const DOCTOR_MIGRATION_REPORT_KEEP_COUNT = 10;
const DOCTOR_MIGRATION_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A now-unused legacy naming scheme (doctor-migration-<epoch>.json per run,
// one per migration-gate doctor invocation) left ~80 files/several MB of
// dead weight in .sneakoscope/update/ with nothing ever removing them
// (20차 P2-5c) — the current code writes a single fixed doctor-migration.json
// instead, but any leftovers from before that change, or from any other
// path that reintroduces per-run naming, are pruned here: keep the most
// recent DOCTOR_MIGRATION_REPORT_KEEP_COUNT, and nothing older than
// DOCTOR_MIGRATION_REPORT_MAX_AGE_MS regardless of count.
async function pruneLegacyDoctorMigrationReports(root: string): Promise<void> {
  const dir = path.join(root, '.sneakoscope', 'update');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((entry) => entry.isFile() && /^doctor-migration-\d+\.json$/.test(entry.name));
  if (!candidates.length) return;
  const withStats = await Promise.all(candidates.map(async (entry) => {
    const filePath = path.join(dir, entry.name);
    const stat = await fsp.stat(filePath).catch(() => null);
    return stat ? { filePath, mtimeMs: stat.mtimeMs } : null;
  }));
  const rows = withStats.filter((row): row is { filePath: string; mtimeMs: number } => Boolean(row)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  const removable = rows.filter((row, index) => index >= DOCTOR_MIGRATION_REPORT_KEEP_COUNT || now - row.mtimeMs > DOCTOR_MIGRATION_REPORT_MAX_AGE_MS);
  await Promise.all(removable.map((row) => fsp.rm(row.filePath, { force: true }).catch(() => undefined)));
}

async function removeStaleMigrationLock(lockPath: string): Promise<boolean> {
  const raw = await fsp.readFile(lockPath, 'utf8').catch(() => '');
  let parsed: { pid?: number; created_at?: string } | null = null;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const pid = Number(parsed?.pid || 0);
  const createdMs = parsed?.created_at ? Date.parse(parsed.created_at) : 0;
  const ageMs = Number.isFinite(createdMs) && createdMs > 0 ? Date.now() - createdMs : Number.POSITIVE_INFINITY;
  const stale = !pidAlive(pid) || ageMs > 120_000;
  if (!stale) return false;
  await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  return true;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

async function buildInstallationEpoch(source: string): Promise<InstallationEpoch> {
  const root = packageRoot();
  const realpath = await fsp.realpath(root).catch(() => root);
  return {
    schema: INSTALLATION_EPOCH_SCHEMA,
    sks_version: PACKAGE_VERSION,
    package_realpath: realpath,
    build_sha256: await packageBuildSha256(root),
    managed_asset_version: MANAGED_ASSET_VERSION,
    installed_at: nowIso(),
    source
  };
}

function isInstallationEpochCurrent(existing: InstallationEpoch, current: InstallationEpoch): boolean {
  return existing.schema === INSTALLATION_EPOCH_SCHEMA
    && existing.sks_version === current.sks_version
    && existing.package_realpath === current.package_realpath
    && existing.build_sha256 === current.build_sha256
    && existing.managed_asset_version === current.managed_asset_version;
}

async function packageBuildSha256(root: string): Promise<string> {
  const candidates = [
    path.join(root, 'dist', 'build-manifest.json'),
    path.join(root, 'package.json')
  ];
  const rows = await Promise.all(candidates.map(async (file) => {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    return { file: path.relative(root, file), sha256: text ? sha256(text) : 'missing' };
  }));
  return sha256(JSON.stringify(rows));
}

function installationEpochSha256(epoch: InstallationEpoch): string {
  return sha256(JSON.stringify({
    schema: epoch.schema,
    sks_version: epoch.sks_version,
    package_realpath: epoch.package_realpath,
    build_sha256: epoch.build_sha256,
    managed_asset_version: epoch.managed_asset_version
  }));
}

function isProjectReceiptCurrentForEpoch(receipt: UpdateMigrationReceipt | null, epoch: InstallationEpoch): boolean {
  return isUpdateMigrationReceiptCurrent(receipt)
    && receipt?.installation_epoch_sha256 === installationEpochSha256(epoch);
}

function projectRootHash(root: string): string {
  return sha256(path.resolve(root));
}

async function projectSemanticHash(root: string): Promise<string> {
  const configPath = path.join(root, '.codex', 'config.toml');
  const config = await fsp.readFile(configPath, 'utf8').catch(() => '');
  return sha256(JSON.stringify({
    root: projectRootHash(root),
    sks_version: PACKAGE_VERSION,
    managed_asset_version: MANAGED_ASSET_VERSION,
    codex_config_sha256: config ? sha256(config) : 'missing'
  }));
}

function parseDoctorJson(text: string): any | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.lastIndexOf('\n{');
  if (start >= 0) {
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {}
  }
  return null;
}

function reportFileFromArgs(args: string[]): string | null {
  const index = args.indexOf('--report-file');
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
}

function extractRequiredBlockers(parsed: any, ok: boolean): string[] {
  if (ok) return [];
  const candidates = [
    parsed?.ready?.blockers,
    parsed?.ready?.repair_readiness?.blockers,
    parsed?.doctor_fix_postcheck?.required_blockers,
    parsed?.doctor_fix_postcheck?.blockers,
    parsed?.blockers
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length) return [...new Set(value.map(String).filter(Boolean))];
  }
  return [];
}

function extractOptionalWarnings(parsed: any): string[] {
  const candidates = [
    parsed?.ready?.warnings,
    parsed?.ready?.repair_readiness?.warnings,
    parsed?.doctor_fix_postcheck?.optional_warnings,
    parsed?.doctor_native_capability?.optional_warnings,
    parsed?.warnings
  ];
  return [...new Set(candidates.flatMap((value) => Array.isArray(value) ? value.map(String) : []).filter(Boolean))];
}

function tail(text: string, max = 4096): string {
  const raw = String(text || '');
  return raw.length <= max ? raw : raw.slice(raw.length - max);
}
