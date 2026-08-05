import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, exists, globalSksRoot, nowIso, packageRoot, PACKAGE_VERSION, projectRoot, readJson, readText, runProcess, sha256, which, writeJsonAtomic, writeReceiptRotated, writeTextAtomic } from '../fsx.js';
import { MANAGED_ASSET_VERSION } from '../managed-assets/managed-assets-manifest.js';
import { enforceRetention } from '../retention.js';
import { COMMANDS } from '../../cli/command-registry.js';
import { reconcileLegacyManagedGeneration } from '../init/legacy-generation-convergence.js';
import { runConfigFastModeNormalizeStage } from './update-migration-state/fast-mode-config.js';
import { runSessionStateSplitStage } from './update-migration-state/session-state-split.js';
import {
  runHookTrustRefreshStage,
  runOtherHarnessCleanupStage
} from './update-migration-state/simple-stages.js';
import { compareSemVer } from './semver.js';

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
  postMigrationStageCheck?: () => Promise<{
    blockers?: string[];
    warnings?: string[];
  }>;
}): Promise<UpdateMigrationReceipt> {
  const receiptPath = projectUpdateMigrationReceiptPath(input.root);
  const epoch = await ensureInstallationEpoch(input.source);
  const retentionCleanup = await runUpdateRetentionCleanup(input.root, input.source);
  const migrationStageRuns = await runUpdateMigrationStages(input.root, { fromVersion: input.fromVersion || null });
  const migrationStages = migrationStageRuns.map(summarizeMigrationStage);
  const stageBlockers = migrationStageRuns.flatMap((stage) => stage.blockers.map((blocker) => `${stage.id}:${blocker}`));
  const stageWarnings = migrationStageRuns.flatMap((stage) => stage.warnings.map((warning) => `${stage.id}:${warning}`));
  let postStageCheck: { blockers?: string[]; warnings?: string[] } = {};
  if (input.postMigrationStageCheck) {
    try {
      postStageCheck = await input.postMigrationStageCheck();
    } catch (error: unknown) {
      postStageCheck = {
        blockers: [`post_migration_stage_check_failed:${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }
  const requiredBlockers = [...new Set([
    ...(input.blockers || []),
    ...stageBlockers,
    ...(postStageCheck.blockers || [])
  ])];
  const optionalWarnings = [...new Set([
    ...(input.warnings || []),
    ...stageWarnings,
    ...(postStageCheck.warnings || [])
  ])];
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
      // Update migration owns only the selected project's state. A global SKS
      // temp sweep can delete another active task's fixture or runtime while
      // this receipt is being written, especially when max_tmp_age_hours is 0.
      skipSksTempSweep: true,
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
    id: 'skills-reconcile',
    min_from_version: '0.0.0',
    run: runSkillsReconcileStage
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

async function runCurrentPublicSurfaceReconcileStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  const [
    { runDoctorCommandAliasCleanup },
    { migrateSksProfilesToPerFile },
    { cleanupRetiredRemoteBridgeLaunchAgent, quarantineRetiredRemoteBridgeBindings }
  ] = await Promise.all([
    import('../doctor/command-alias-cleanup.js'),
    import('../auto-review.js'),
    import('../codex-app/menubar/migration.js')
  ]);
  const home = path.resolve(process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global'));
  // Serialize config writers: public-surface guidance and profile migration both touch ~/.codex/config.toml.
  const publicSurface = await runDoctorCommandAliasCleanup({
    root,
    home,
    globalRuntimeRoot,
    fix: true,
    managedGenerationAlreadyConverged: true
  });
  const profileMigration = await migrateSksProfilesToPerFile({ env: process.env }).catch((err: any) => ({
    error: err?.message || String(err),
    retired_profile_table_count: 0,
    retired_profile_file_removed_count: 0
  }));
  const retiredLaunchAgent = await cleanupRetiredRemoteBridgeLaunchAgent({ home, env: process.env });
  const retiredBindings = await quarantineRetiredRemoteBridgeBindings(root);
  const remainingCount = Number(publicSurface.cleanup?.remaining_count || 0)
    + Number(publicSurface.cleanup?.managed_runtime?.remaining_managed_artifact_count || 0)
    + Number(publicSurface.cleanup?.project_guidance?.remaining_count || 0);
  const blockers = [
    ...(publicSurface.ok === true ? [] : ['public_surface_reconcile_failed']),
    ...(retiredLaunchAgent.ok ? [] : retiredLaunchAgent.blockers),
    ...(retiredBindings.ok ? [] : retiredBindings.blockers),
    ...((profileMigration as any).error ? [`retired_profile_migration_failed:${(profileMigration as any).error}`] : []),
    ...(remainingCount > 0 ? [`public_surface_remaining:${remainingCount}`] : [])
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: [
      'reconciled_current_public_surface',
      ...(retiredLaunchAgent.status === 'removed' ? ['retired_remote_bridge_launch_agent_removed'] : []),
      ...(retiredBindings.status === 'quarantined' ? ['retired_remote_bridge_bindings_quarantined'] : [])
    ],
    blockers,
    warnings: [
      ...(publicSurface.warnings || []),
      ...retiredLaunchAgent.warnings,
      ...retiredBindings.warnings
    ],
    detail: {
      removed_skill_count: Number(publicSurface.cleanup?.removed_count || 0),
      quarantined_skill_collision_count: Number(publicSurface.cleanup?.preserved_user_collision_count || 0),
      removed_runtime_artifact_count: Number(publicSurface.cleanup?.managed_runtime?.removed_managed_artifact_count || 0),
      quarantined_runtime_collision_count: Number(publicSurface.cleanup?.managed_runtime?.preserved_user_file_count || 0),
      reconciled_guidance_count: Number(publicSurface.cleanup?.project_guidance?.reconciled_count || 0),
      quarantined_guidance_collision_count: Number(publicSurface.cleanup?.project_guidance?.preserved_user_file_count || 0),
      removed_retired_role_count: 0,
      quarantined_retired_role_collision_count: 0,
      retired_profile_table_count: Number((profileMigration as any).retired_profile_table_count || 0),
      retired_profile_file_removed_count: Number((profileMigration as any).retired_profile_file_removed_count || 0),
      retired_remote_bridge_launch_agent_status: retiredLaunchAgent.status,
      retired_remote_bridge_binding_status: retiredBindings.status,
      retired_remote_bridge_binding_count: retiredBindings.retired_binding_count,
      retired_remote_bridge_binding_quarantine_path: retiredBindings.quarantine_path,
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

async function runSkillsReconcileStage(root: string): Promise<Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>> {
  if (process.env.SKS_TEST_UPDATE_GLOBAL_SKILLS_FAIL === '1') {
    return {
      ok: false,
      status: 'failed',
      actions: [],
      blockers: ['global:forced_update_global_skills_reconcile_failure'],
      warnings: [],
      detail: {
        global_installed: null,
        global_removed_count: 0,
        project_removed_count: 0,
        residue_remaining_count: 0
      }
    };
  }
  const home = path.resolve(process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global'));
  const convergence = await reconcileLegacyManagedGeneration({
    root,
    home,
    globalRuntimeRoot,
    fix: true
  });
  const skillReports = [convergence.global_skills, ...convergence.project_skills];
  const globalRemaining = Number((convergence.global_skills as any).retired_residue?.remaining_count || 0);
  const projectRemaining = convergence.project_skills.reduce(
    (sum, report) => sum + Number((report as any).retired_residue?.remaining_count || 0),
    0
  );
  const runtimeRemaining = convergence.retired_runtime_scopes.reduce(
    (sum, report) => sum + report.remaining_managed_artifact_count,
    0
  );
  const runtimeErrors = convergence.retired_runtime_scopes.reduce(
    (sum, report) => sum + report.error_count,
    0
  );
  const blockers = [
    ...skillReports.flatMap((report) => report.ok ? [] : [
      `${report.scope}:${'error' in report ? report.error : 'failed'}`
    ]),
    ...(globalRemaining ? [`global_retired_residue_remaining:${globalRemaining}`] : []),
    ...(projectRemaining ? [`project_retired_residue_remaining:${projectRemaining}`] : []),
    ...(convergence.retired_agent_roles.ok ? [] : ['retired_agent_role_reconcile_failed']),
    ...(runtimeRemaining ? [`retired_runtime_residue_remaining:${runtimeRemaining}`] : []),
    ...(runtimeErrors ? [`retired_runtime_reconcile_failed:${runtimeErrors}`] : []),
    ...(convergence.managed_configs.remaining_count
      ? [`retired_config_residue_remaining:${convergence.managed_configs.remaining_count}`]
      : []),
    ...(convergence.managed_configs.error_count
      ? [`retired_config_reconcile_failed:${convergence.managed_configs.error_count}`]
      : []),
    ...((convergence as any).blockers || [])
  ];
  const uniqueBlockers = [...new Set(blockers)];
  const global = convergence.global_skills;
  return {
    ok: uniqueBlockers.length === 0,
    status: uniqueBlockers.length ? 'failed' : 'ok',
    actions: [
      'reconciled_latest_managed_generation',
      'reconciled_global_skills',
      'reconciled_project_skills'
    ],
    blockers: uniqueBlockers,
    warnings: convergence.warnings,
    detail: {
      global_installed: Array.isArray((global as any).installed) ? (global as any).installed.length : null,
      global_removed_count: Number((global as any).retired_residue?.removed_count || 0)
        + (Array.isArray((global as any).removed) ? (global as any).removed.length : 0),
      project_removed_count: convergence.project_skills.reduce(
        (sum, report) => sum
          + Number((report as any).retired_residue?.removed_count || 0)
          + (Array.isArray((report as any).removed) ? (report as any).removed.length : 0),
        0
      ),
      retired_agent_role_removed_count: convergence.retired_agent_roles.removed_count,
      retired_runtime_removed_count: convergence.retired_runtime_scopes.reduce(
        (sum, report) => sum + report.removed_managed_artifact_count,
        0
      ),
      retired_config_rewritten_count: convergence.managed_configs.rewritten_count,
      residue_remaining_count: globalRemaining
        + projectRemaining
        + runtimeRemaining
        + convergence.managed_configs.remaining_count
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

  return withUpdateMigrationLock(root, empty, async (lockOwner, lockPath) => {
    const reportFile = path.join(root, '.sneakoscope', 'update', 'doctor-migration.json');
    await pruneLegacyDoctorMigrationReports(root).catch(() => undefined);
    const preDoctorReceipt = await readProjectUpdateMigrationReceipt(root);
    const baseTimeoutMs = migrationDoctorTimeoutMs(env);
    let doctor = await runPackageLocalDoctor({
      root,
      args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', reportFile],
      env: {
        ...env,
        SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
        SKS_DISABLE_UPDATE_CHECK: '1',
        SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '1'
      },
      timeoutMs: baseTimeoutMs,
      maxOutputBytes: 32 * 1024,
      onSpawn: (pid) => registerUpdateMigrationLockChild(lockPath, lockOwner, pid)
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
          SKS_MIGRATION_DOCTOR_RETRY: '1',
          SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '1'
        },
        timeoutMs: baseTimeoutMs * 2,
        maxOutputBytes: 32 * 1024,
        onSpawn: (pid) => registerUpdateMigrationLockChild(lockPath, lockOwner, pid)
      });
    }
    const doctorReceipt = await readProjectUpdateMigrationReceipt(root);
    const freshDoctorReceipt = isFreshDoctorOwnedMigrationReceipt({
      receipt: doctorReceipt,
      priorReceipt: preDoctorReceipt,
      epoch,
      root
    });
    if (!freshDoctorReceipt) {
      const blockers = ['doctor_migration_receipt_missing_or_stale'];
      const warnings = [...new Set([
        ...timeoutWarnings,
        ...doctor.optional_warnings
      ])];
      return {
        ...empty,
        ok: false,
        status: 'blocked',
        receipt: null,
        doctor,
        failed_stage_id: 'doctor:migration-receipt',
        blockers,
        warnings
      };
    }
    const preservedUserOwnedConfig = migrationDoctorOnlyPreservedUserOwnedConfig(doctor);
    if (!doctor.ok && !preservedUserOwnedConfig) {
      const blocker = doctor.timedOut ? 'doctor_migration_timeout' : 'doctor_migration_failed';
      const requiredBlockers = [...new Set([
        blocker,
        ...(doctor.required_blockers.length ? doctor.required_blockers : []),
        ...(doctorReceipt?.blockers || [])
      ])];
      const warnings = [
        ...timeoutWarnings,
        ...doctor.optional_warnings,
        ...(doctor.timedOut ? ['doctor_migration_timeout_may_be_network_or_first_compile_slow_run_sks_doctor_fix_yes_for_live_progress'] : [])
      ];
      return { ...empty, ok: false, status: 'blocked', receipt: doctorReceipt, doctor, failed_stage_id: 'doctor:migration-profile', blockers: requiredBlockers, warnings };
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
      ...(doctorReceipt?.warnings || []),
      ...preservationWarnings
    ])];
    if (!isProjectReceiptCurrentForEpoch(doctorReceipt, epoch)) {
      const blockers = [...new Set([
        ...(doctorReceipt?.blockers || []),
        'doctor_migration_receipt_blocked'
      ])];
      const failedStage = doctorReceipt?.migration_stages?.find((stage) => stage.ok !== true)?.id || 'doctor:migration-receipt';
      return {
        ...empty,
        ok: false,
        status: 'blocked',
        receipt: doctorReceipt,
        doctor,
        failed_stage_id: failedStage,
        blockers,
        warnings
      };
    }
    return { ...empty, ok: true, status: 'repaired', receipt: doctorReceipt, doctor, failed_stage_id: null, blockers: [], warnings };
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
  onSpawn?: (pid: number) => void | Promise<void>;
} = {}): Promise<PackageLocalDoctorRun> {
  const entrypoint = input.entrypoint || path.join(packageRoot(), 'dist', 'bin', 'sks.js');
  const cwd = input.root || globalSksRoot();
  const args = input.args || ['doctor', '--json'];
  const env = input.env || process.env;
  const testRun = testPackageLocalDoctorRun({ entrypoint, cwd, args, env });
  if (testRun) {
    if (
      env.SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT === '1'
      && isMigrationFixDoctorInvocation(args)
      && !testRun.timedOut
    ) {
      const preservedUserOwnedConfig = migrationDoctorOnlyPreservedUserOwnedConfig(testRun);
      const blockers = testRun.ok || preservedUserOwnedConfig ? [] : testRun.required_blockers;
      const warnings = [
        ...testRun.optional_warnings,
        ...(preservedUserOwnedConfig
          ? [
              'migration_doctor_preserved_user_owned_project_config',
              ...testRun.required_blockers.map((blocker) => `migration_optional_blocker:${blocker}`)
            ]
          : [])
      ];
      await writeProjectUpdateMigrationReceipt({
        root: cwd,
        source: 'doctor-migration',
        doctor: testRun,
        blockers,
        warnings,
        ...(blockers.length ? { status: 'blocked' as const } : {})
      });
    }
    return testRun;
  }
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
    maxOutputBytes: input.maxOutputBytes ?? 64 * 1024,
    ...(input.onSpawn ? { onSpawn: input.onSpawn } : {})
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
  const ok = (result as any).code === 0
    && (result as any).spawnRegistrationFailed !== true
    && (reportFile ? parsedOk === true : parsedOk !== false);
  const requiredBlockers = [...new Set([
    ...extractRequiredBlockers(parsed, ok),
    ...((result as any).spawnRegistrationFailed === true
      ? ['doctor_spawn_registration_failed']
      : [])
  ])];
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
  if (!input.globalRoot) return null;
  const candidate = path.join(input.globalRoot, packageName, 'dist', 'bin', 'sks.js');
  return await exists(candidate) ? candidate : null;
}

// 20차 P2-2: was 20s — --help now bypasses this gate entirely (cli/router.ts),
// so this timeout only affects commands that genuinely need the migration
// gate; 5s is enough to cooperate with a sibling in-flight migration without
// making every gated command absorb a 20s worst case.
const MIGRATION_LOCK_WAIT_MS = 5_000;
const MIGRATION_LOCK_POLL_MS = 150;
const MIGRATION_LOCK_PROGRESS_INTERVAL_MS = 1_000;
const MIGRATION_LOCK_MALFORMED_GRACE_MS = 120_000;
const MIGRATION_LOCK_MAX_BYTES = 4 * 1024;
const MIGRATION_LOCK_SCHEMA = 'sks.update-migration-lock.v1' as const;

interface UpdateMigrationLockRecord {
  schema: typeof MIGRATION_LOCK_SCHEMA;
  pid: number;
  process_start?: string | null;
  token: string;
  created_at: string;
  version: string;
}

interface UpdateMigrationLockChildRecord {
  schema: 'sks.update-migration-lock-child.v1';
  token: string;
  pid: number;
  process_start: string | null;
  process_group_id: number | null;
  registered_at: string;
}

export interface UpdateMigrationLockOwner {
  token: string;
  dev: number;
  ino: number;
}

interface UpdateMigrationLockSnapshot extends UpdateMigrationLockOwner {
  pid: number;
  processStart: string | null;
  createdAt: string | undefined;
  mtimeMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUpdateMigrationLock(
  root: string,
  base: Omit<UpdateMigrationGateResult, 'ok' | 'status' | 'receipt' | 'doctor' | 'blockers' | 'warnings' | 'failed_stage_id'>,
  fn: (owner: UpdateMigrationLockOwner, lockPath: string) => Promise<UpdateMigrationGateResult>,
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
  const maxAttempts = Math.max(
    1,
    Math.ceil((options.maxWaitMs ?? MIGRATION_LOCK_WAIT_MS) / MIGRATION_LOCK_POLL_MS) + 2
  );
  let reapedStale = false;
  let lastProgressAt = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let owner: UpdateMigrationLockOwner | null = null;
    try {
      owner = await acquireUpdateMigrationLock(lockPath);
    } catch (err: any) {
      return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: [`update_migration_lock_error:${err?.message || String(err)}`], warnings: [] };
    }
    if (!owner) {
      // The lock is held by a concurrent process. Cooperate instead of failing fast:
      // 1) a sibling may have already completed the migration we need.
      if (recheck) {
        const done = await recheck();
        if (done) return done;
      }
      // 2) reap a genuinely stale lock (dead holder, or malformed past its grace period).
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
      return await fn(owner, lockPath);
    } catch (err: any) {
      return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: [`update_migration_lock_error:${err?.message || String(err)}`], warnings: [] };
    } finally {
      await releaseUpdateMigrationLock(lockPath, owner).catch(() => false);
    }
  }
  return { ...base, ok: false, status: 'blocked', receipt: null, doctor: null, failed_stage_id: 'migration-lock', blockers: ['update_migration_lock_held'], warnings: [] };
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

export async function acquireUpdateMigrationLock(lockPath: string): Promise<UpdateMigrationLockOwner | null> {
  await ensureDir(path.dirname(lockPath));
  const token = randomBytes(24).toString('hex');
  const candidatePath = `${lockPath}.${process.pid}.${token}.candidate`;
  const record: UpdateMigrationLockRecord = {
    schema: MIGRATION_LOCK_SCHEMA,
    pid: process.pid,
    process_start: processStartIdentity(process.pid),
    token,
    created_at: nowIso(),
    version: PACKAGE_VERSION
  };
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(
      candidatePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    const candidateStat = await handle.stat();
    await handle.close();
    handle = null;
    try {
      await fsp.link(candidatePath, lockPath);
    } catch (error: any) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
    const published = await readUpdateMigrationLockSnapshot(lockPath);
    if (
      !published
      || published.token !== token
      || published.dev !== candidateStat.dev
      || published.ino !== candidateStat.ino
    ) {
      throw new Error('update_migration_lock_publication_verification_failed');
    }
    return { token, dev: candidateStat.dev, ino: candidateStat.ino };
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

export async function releaseUpdateMigrationLock(
  lockPath: string,
  owner: UpdateMigrationLockOwner
): Promise<boolean> {
  const snapshot = await readUpdateMigrationLockSnapshot(lockPath);
  if (!migrationLockIdentityMatches(snapshot, owner)) return false;
  const released = await unlinkClaimedMigrationLock(lockPath, owner, 'release');
  if (released) await removeUpdateMigrationLockChild(lockPath, owner.token);
  return released;
}

export async function removeStaleMigrationLock(
  lockPath: string,
  nowMs = Date.now()
): Promise<boolean> {
  const snapshot = await readUpdateMigrationLockSnapshot(lockPath);
  if (!snapshot) return false;
  const createdAt = snapshot.createdAt || new Date(snapshot.mtimeMs).toISOString();
  if (!updateMigrationLockIsStale(
    snapshot.pid,
    createdAt,
    nowMs,
    snapshot.processStart
  )) return false;
  const child = await readUpdateMigrationLockChild(lockPath);
  if (child?.token === snapshot.token && registeredMigrationChildAlive(child)) return false;
  const removed = await unlinkClaimedMigrationLock(lockPath, snapshot, 'stale');
  if (removed) await removeUpdateMigrationLockChild(lockPath, snapshot.token);
  return removed;
}

export async function registerUpdateMigrationLockChild(
  lockPath: string,
  owner: UpdateMigrationLockOwner,
  pid: number
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`update_migration_lock_child_pid_invalid:${String(pid)}`);
  }
  const before = await readUpdateMigrationLockSnapshot(lockPath);
  if (!migrationLockIdentityMatches(before, owner)) {
    throw new Error('update_migration_lock_child_owner_lost');
  }
  const record: UpdateMigrationLockChildRecord = {
    schema: 'sks.update-migration-lock-child.v1',
    token: owner.token,
    pid,
    process_start: processStartIdentity(pid),
    process_group_id: process.platform === 'win32' ? null : pid,
    registered_at: nowIso()
  };
  await writeJsonAtomic(updateMigrationLockChildPath(lockPath), record, { mode: 0o600 });
  const after = await readUpdateMigrationLockSnapshot(lockPath);
  if (!migrationLockIdentityMatches(after, owner)) {
    await removeUpdateMigrationLockChild(lockPath, owner.token);
    throw new Error('update_migration_lock_child_owner_lost');
  }
}

async function unlinkClaimedMigrationLock(
  lockPath: string,
  identity: UpdateMigrationLockOwner,
  purpose: 'release' | 'stale'
): Promise<boolean> {
  if (!migrationLockTokenIsPathSafe(identity.token)) return false;
  const claimPath = `${lockPath}.${process.pid}.${identity.token}.${randomBytes(24).toString('hex')}.${purpose}.claim`;
  try {
    // Rename is the ownership claim: only one releaser can remove the fixed
    // path, and a successor published after that point is never unlinked.
    await fsp.rename(lockPath, claimPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
    throw error;
  }
  try {
    const claim = await readUpdateMigrationLockSnapshot(claimPath);
    if (!migrationLockIdentityMatches(claim, identity)) {
      await restoreMigrationLockClaimNoReplace(claimPath, lockPath);
      return false;
    }
    await fsp.rm(claimPath, { force: true });
    return true;
  } catch (error: any) {
    await restoreMigrationLockClaimNoReplace(claimPath, lockPath).catch(() => undefined);
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function restoreMigrationLockClaimNoReplace(claimPath: string, lockPath: string): Promise<void> {
  const claim = await fsp.lstat(claimPath).catch(() => null);
  if (!claim?.isFile() || claim.isSymbolicLink()) return;
  try {
    await fsp.link(claimPath, lockPath);
    await fsp.rm(claimPath, { force: true });
  } catch (error: any) {
    // A successor may already own the fixed path. Preserve the randomized
    // claim rather than overwrite or remove either independently owned inode.
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function readUpdateMigrationLockSnapshot(lockPath: string): Promise<UpdateMigrationLockSnapshot | null> {
  let handle: fsp.FileHandle | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    handle = await fsp.open(lockPath, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.size > MIGRATION_LOCK_MAX_BYTES) {
      return {
        pid: 0,
        processStart: null,
        token: malformedMigrationLockToken(before.dev, before.ino),
        createdAt: undefined,
        dev: before.dev,
        ino: before.ino,
        mtimeMs: before.mtimeMs
      };
    }
    const raw = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    const pathAfter = await fsp.lstat(lockPath).catch(() => null);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || !pathAfter
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
    ) return null;
    let parsed: Partial<UpdateMigrationLockRecord> | null = null;
    try {
      const value = raw.trim() ? JSON.parse(raw) : null;
      parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      parsed = null;
    }
    const token = typeof parsed?.token === 'string' && /^[a-f0-9]{48}$/.test(parsed.token)
      ? parsed.token
      : malformedMigrationLockToken(after.dev, after.ino);
    return {
      pid: Number(parsed?.pid || 0),
      processStart: typeof parsed?.process_start === 'string'
        ? parsed.process_start
        : null,
      token,
      createdAt: typeof parsed?.created_at === 'string' ? parsed.created_at : undefined,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function malformedMigrationLockToken(dev: number, ino: number): string {
  return `malformed-${dev}-${ino}`;
}

function migrationLockTokenIsPathSafe(token: string): boolean {
  return /^[a-f0-9]{48}$/.test(token) || /^malformed-\d+-\d+$/.test(token);
}

function migrationLockIdentityMatches(
  snapshot: UpdateMigrationLockSnapshot | null,
  identity: UpdateMigrationLockOwner
): boolean {
  return snapshot?.token === identity.token
    && snapshot.dev === identity.dev
    && snapshot.ino === identity.ino;
}

function updateMigrationLockChildPath(lockPath: string): string {
  return `${lockPath}.child`;
}

async function readUpdateMigrationLockChild(
  lockPath: string
): Promise<UpdateMigrationLockChildRecord | null> {
  const childPath = updateMigrationLockChildPath(lockPath);
  let handle: fsp.FileHandle | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    handle = await fsp.open(childPath, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MIGRATION_LOCK_MAX_BYTES) return null;
    const value = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    if (
      value?.schema !== 'sks.update-migration-lock-child.v1'
      || typeof value.token !== 'string'
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
    ) return null;
    return {
      schema: 'sks.update-migration-lock-child.v1',
      token: value.token,
      pid: value.pid,
      process_start: typeof value.process_start === 'string'
        ? value.process_start
        : null,
      process_group_id: Number.isSafeInteger(value.process_group_id)
        && value.process_group_id > 0
        ? value.process_group_id
        : null,
      registered_at: typeof value.registered_at === 'string'
        ? value.registered_at
        : ''
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeUpdateMigrationLockChild(
  lockPath: string,
  token: string
): Promise<boolean> {
  if (!migrationLockTokenIsPathSafe(token)) return false;
  const childPath = updateMigrationLockChildPath(lockPath);
  const child = await readUpdateMigrationLockChild(lockPath);
  if (child?.token !== token) return false;
  const claimPath = `${childPath}.${process.pid}.${randomBytes(16).toString('hex')}.claim`;
  try {
    await fsp.rename(childPath, claimPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const claimed = await readUpdateMigrationLockChildClaim(claimPath);
  if (claimed?.token !== token) {
    const restored = await fsp.link(claimPath, childPath).then(() => true).catch(() => false);
    if (restored) await fsp.rm(claimPath, { force: true });
    return false;
  }
  await fsp.rm(claimPath, { force: true });
  return true;
}

async function readUpdateMigrationLockChildClaim(
  claimPath: string
): Promise<UpdateMigrationLockChildRecord | null> {
  try {
    const stat = await fsp.lstat(claimPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MIGRATION_LOCK_MAX_BYTES) return null;
    const value = JSON.parse(await fsp.readFile(claimPath, 'utf8'));
    return value?.schema === 'sks.update-migration-lock-child.v1'
      && typeof value.token === 'string'
      ? value as UpdateMigrationLockChildRecord
      : null;
  } catch {
    return null;
  }
}

export function updateMigrationLockIsStale(
  pid: number,
  createdAt?: string,
  nowMs = Date.now(),
  expectedProcessStart?: string | null
): boolean {
  // A migration Doctor is allowed to run longer than the historical
  // 120-second stale threshold. Reaping a lock solely because it is old can
  // therefore start a second writer while the first process is still alive.
  if (Number.isInteger(pid) && pid > 0) {
    return !processIdentityAlive(pid, expectedProcessStart);
  }
  const createdMs = createdAt ? Date.parse(createdAt) : 0;
  if (!Number.isFinite(createdMs) || createdMs <= 0) return false;
  return nowMs - createdMs > MIGRATION_LOCK_MALFORMED_GRACE_MS;
}

function registeredMigrationChildAlive(child: UpdateMigrationLockChildRecord): boolean {
  const observedStart = processStartIdentity(child.pid);
  if (observedStart) {
    return child.process_start
      ? observedStart === child.process_start
      : pidAlive(child.pid);
  }
  if (child.process_group_id && process.platform !== 'win32') {
    try {
      process.kill(-child.process_group_id, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  }
  return false;
}

function processIdentityAlive(pid: number, expectedProcessStart?: string | null): boolean {
  if (!pidAlive(pid)) return false;
  if (!expectedProcessStart) return true;
  const observed = processStartIdentity(pid);
  return observed === null || observed === expectedProcessStart;
}

function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
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

function isFreshDoctorOwnedMigrationReceipt(input: {
  receipt: UpdateMigrationReceipt | null;
  priorReceipt: UpdateMigrationReceipt | null;
  epoch: InstallationEpoch;
  root: string;
}): boolean {
  const { receipt, priorReceipt } = input;
  if (
    receipt?.schema !== UPDATE_MIGRATION_SCHEMA
    || !['current', 'blocked'].includes(receipt.status)
    || receipt.sks_version !== PACKAGE_VERSION
    || receipt.source !== 'doctor-migration'
    || path.resolve(receipt.root) !== path.resolve(input.root)
    || receipt.installation_epoch_sha256 !== installationEpochSha256(input.epoch)
  ) return false;
  return !priorReceipt || sha256(JSON.stringify(receipt)) !== sha256(JSON.stringify(priorReceipt));
}

function isMigrationFixDoctorInvocation(args: readonly string[]): boolean {
  const profileIndex = args.indexOf('--profile');
  return args[0] === 'doctor'
    && args.includes('--fix')
    && profileIndex >= 0
    && args[profileIndex + 1] === 'migration';
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
