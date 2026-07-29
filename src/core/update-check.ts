import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_VERSION, packageRoot, readJson, runProcess, throttleLines, which } from './fsx.js';
import { createRequestedScopeContract } from './safety/requested-scope-contract.js';
import { guardedPackageInstall, guardContextForRoute } from './safety/mutation-guard.js';
import {
  isUpdateMigrationReceiptCurrent,
  projectUpdateMigrationReceiptPath,
  resolveInstalledSksEntrypoint,
  runPackageLocalDoctor,
  type PackageLocalDoctorRun,
  type UpdateMigrationReceipt,
  writeProjectUpdateMigrationReceipt
} from './update/update-migration-state.js';
import {
  inspectSksMenuBarStatus,
  installSksMenuBar,
  cleanupRetiredRemoteBridgeLaunchAgent,
  quarantineRetiredRemoteBridgeBindings,
  sksMenuBarPaths,
  type SksMenuBarInstallResult,
  type SksMenuBarStatusResult
} from './codex-app/menubar/index.js';
import { inspectCodexCliUpdate, type CodexCliUpdateStatus } from './codex/codex-cli-update.js';
import { reconcileSkills } from './init/skills.js';
import { codexHookTrustDoctor } from './codex-hooks/codex-hook-trust-doctor.js';
import { readCodexHookActualState } from './codex-hooks/codex-hook-actual-discovery.js';
import { compareSemVer, extractSemVer, parseSemVer } from './update/semver.js';
import {
  countUpdates,
  emptyUpdateStatus,
  resolveSksUpdateStatus,
  UpdateStatusRefreshError,
  type SksUpdateStatusV3
} from './update/update-status.js';
import { authorizeUpdateRollback, UpdateOperationRecorder } from './update/update-operation.js';
import { runTemporaryInstallSmoke, type TemporaryInstallSmokeResult } from './update/temporary-install-smoke.js';
import { ui as cliUi, withHeartbeat } from '../cli/cli-theme.js';

export interface SksUpdateCheckOptions {
  packageName?: string;
  currentVersion?: string;
  registry?: string;
  npmBin?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  refresh?: boolean;
}

export interface SksUpdateStatusDependencies {
  inspectCodexCliUpdateImpl?: typeof inspectCodexCliUpdate;
  inspectSksMenuBarStatusImpl?: typeof inspectSksMenuBarStatus;
}

export interface SksUpdateStatusOptions extends SksUpdateCheckOptions {
  home?: string;
  projectRoot?: string;
  supersede?: boolean;
  now?: () => Date;
  ttlMs?: number;
  jitterMs?: number;
  deps?: SksUpdateStatusDependencies;
}

export interface SksVersionCandidate {
  version: string;
  source: string;
}

export interface SksEffectiveVersionResult {
  current: string;
  runtime_current: string;
  package_root_current: string | null;
  path_current: string | null;
  npm_global_current: string | null;
  candidates: SksVersionCandidate[];
  errors: string[];
}

export interface SksUpdateCheckResult {
  schema: 'sks.update-check.v2';
  package: string;
  current: string;
  runtime_current: string;
  package_root_current: string | null;
  path_current: string | null;
  npm_global_current: string | null;
  version_candidates: SksVersionCandidate[];
  latest: string | null;
  update_available: boolean;
  status: 'current' | 'available' | 'unavailable';
  mode: 'function';
  route_required: false;
  pipeline_required: false;
  command: string | null;
  npm_bin: string | null;
  registry: string;
  error: string | null;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export interface SksUpdateNowOptions extends SksUpdateCheckOptions {
  version?: string | null;
  dryRun?: boolean;
  projectRoot?: string | null;
  json?: boolean;
  quiet?: boolean;
  operationKind?: 'update' | 'rollback';
}

export interface SksUpdateNowStage {
  id: string;
  ok: boolean;
  status: string;
  detail?: Record<string, unknown>;
}

export interface SksUpdateVerification {
  id: 'version_match' | 'hooks_trusted' | 'dist_stamp' | 'skills_manifest' | 'sks_menubar_version';
  ok: boolean;
  detail?: string;
  remediation?: string;
}

export interface SksUpdateNowResult {
  schema: 'sks.update-now.v2';
  ok: boolean;
  status: 'updated' | 'updated_with_issues' | 'current' | 'dry_run' | 'unavailable' | 'failed' | 'terminal_uncertain';
  package: string;
  from: string;
  latest: string | null;
  requested_version: string | null;
  install_version: string | null;
  npm_bin: string | null;
  npm_args: string[];
  command: string | null;
  cwd: string;
  registry: string;
  global_root: string | null;
  install_code: number | null;
  old_version_doctor: PackageLocalDoctorRun | null;
  new_binary: string | null;
  new_version: string | null;
  new_version_doctor: PackageLocalDoctorRun | null;
  project_receipt: UpdateMigrationReceipt | null;
  migration_current: boolean;
  sks_menubar: SksMenuBarInstallResult | null;
  stages: SksUpdateNowStage[];
  verification: SksUpdateVerification[];
  temporary_install_smoke: TemporaryInstallSmokeResult | null;
  operation_receipt_path: string | null;
  rollback: {
    available: boolean;
    previous_version: string;
    command: string;
    receipt_path: string | null;
  };
  error: string | null;
}

export interface SksUpdateReviewResult {
  schema: 'sks.update-review.v1';
  ok: boolean;
  current: string;
  target: string | null;
  registry: string;
  npm_bin: string | null;
  global_root: string | null;
  node_path: string;
  expected_menubar_rebuild: boolean;
  expected_migrations: string[];
  rollback_command: string;
  stages: string[];
  project_mutation: boolean;
  error: string | null;
}

export interface SksUpdateRollbackResult {
  schema: 'sks.update-rollback.v1';
  ok: boolean;
  status: SksUpdateNowResult['status'];
  requested_version: string | null;
  update: SksUpdateNowResult | null;
  receipt_path: string | null;
  error: string | null;
}

export async function runSksUpdateStatus(options: SksUpdateStatusOptions = {}): Promise<SksUpdateStatusV3> {
  return runSksUpdateStatusInternal(options);
}

export async function runSksUpdateCheck(options: SksUpdateCheckOptions = {}): Promise<SksUpdateCheckResult> {
  let liveCheck: SksUpdateCheckResult | null = null;
  const status = await runSksUpdateStatusInternal({ ...options, refresh: options.refresh !== false }, (check) => { liveCheck = check; });
  const packageName = options.packageName || 'sneakoscope';
  const registry = options.registry || DEFAULT_REGISTRY;
  const env = options.env || process.env;
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const capturedCheck = liveCheck as SksUpdateCheckResult | null;
  const effective = capturedCheck
    ? effectiveFromCheck(capturedCheck)
    : await detectEffectiveSksVersion({ ...options, packageName, registry, env, npmBin });
  return buildResult({
    packageName,
    current: status.sks.current || effective.current,
    effective,
    latest: status.sks.latest,
    registry,
    npmBin,
    error: capturedCheck?.error || (status.source === 'error' ? status.public_error || 'update status unavailable' : null)
  });
}

async function runSksUpdateStatusInternal(
  options: SksUpdateStatusOptions,
  capture?: (check: SksUpdateCheckResult) => void
): Promise<SksUpdateStatusV3> {
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const expectedVersion = options.currentVersion || PACKAGE_VERSION;
  return resolveSksUpdateStatus({
    env,
    refresh: options.refresh === true,
    supersede: options.supersede === true,
    now,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
    fallbackSnapshot: () => emptyUpdateStatus(expectedVersion, now()),
    fetchLive: async () => {
      const statusHome = options.home || env.HOME;
      const checkPromise = runSksUpdateCheckLive(options);
      const codexPromise = (options.deps?.inspectCodexCliUpdateImpl || inspectCodexCliUpdate)({
        ...(statusHome ? { home: statusHome } : {}),
        force: true,
        env
      }).catch(() => null);
      const menubarPromise = (options.deps?.inspectSksMenuBarStatusImpl || inspectSksMenuBarStatus)({
        ...(statusHome ? { home: statusHome } : {}),
        ...(options.projectRoot === undefined ? {} : { root: options.projectRoot }),
        env
      }).catch(() => null);
      const [check, codex, menubar] = await Promise.all([checkPromise, codexPromise, menubarPromise]);
      capture?.(check);
      const snapshot = buildUpdateStatusSnapshot({ check, codex, menubar, env, now: now() });
      if (check.error) throw new UpdateStatusRefreshError(check.error, snapshot);
      return snapshot;
    }
  });
}

async function runSksUpdateCheckLive(options: SksUpdateCheckOptions = {}): Promise<SksUpdateCheckResult> {
  const packageName = options.packageName || 'sneakoscope';
  const registry = options.registry || DEFAULT_REGISTRY;
  const env = options.env || process.env;
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const effectiveOptions: SksUpdateCheckOptions = {
    packageName,
    currentVersion: options.currentVersion || PACKAGE_VERSION,
    npmBin,
    env
  };
  if (options.timeoutMs !== undefined) effectiveOptions.timeoutMs = options.timeoutMs;
  if (options.maxOutputBytes !== undefined) effectiveOptions.maxOutputBytes = options.maxOutputBytes;
  const override = env[versionOverrideEnvName(packageName)];
  const effectivePromise = detectEffectiveSksVersion(effectiveOptions);
  const latestPromise = !override && npmBin
    ? runProcess(npmBin, ['view', packageName, 'version', '--silent', '--registry', registry], {
      env,
      timeoutMs: options.timeoutMs ?? 1000,
      maxOutputBytes: options.maxOutputBytes ?? 4096
    }).catch((err: unknown) => ({
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err)
    }))
    : Promise.resolve(null);
  const effective = await effectivePromise;
  const current = effective.current;
  if (override) return buildResult({ packageName, current, effective, latest: override, registry, npmBin });

  if (!npmBin) {
    return buildResult({
      packageName,
      current,
      effective,
      latest: null,
      registry,
      npmBin: null,
      error: 'npm not found on PATH'
    });
  }

  const result = await latestPromise;
  if (!result) {
    return buildResult({
      packageName,
      current,
      effective,
      latest: null,
      registry,
      npmBin,
      error: 'npm view failed'
    });
  }
  if (result.code !== 0) {
    return buildResult({
      packageName,
      current,
      effective,
      latest: null,
      registry,
      npmBin,
      error: `${result.stderr || result.stdout || 'npm view failed'}`.trim()
    });
  }
  const latest = extractSemVer(String(result.stdout || '').trim().split(/\s+/).pop() || '');
  return buildResult({
    packageName,
    current,
    effective,
    latest,
    registry,
    npmBin
  });
}

function buildUpdateStatusSnapshot(input: {
  check: SksUpdateCheckResult;
  codex: CodexCliUpdateStatus | null;
  menubar: SksMenuBarStatusResult | null;
  env: NodeJS.ProcessEnv;
  now: Date;
}): SksUpdateStatusV3 {
  const currentParsed = parseSemVer(input.check.current);
  const latestParsed = parseSemVer(input.check.latest);
  const channel: 'stable' | 'beta' = input.env.SKS_UPDATE_CHANNEL === 'beta'
    || Boolean(currentParsed?.prerelease.length || latestParsed?.prerelease.length)
    ? 'beta'
    : 'stable';
  const packageSource = input.check.version_candidates.find((candidate) => candidate.version === input.check.current)?.source || null;
  const expectedVersion = input.check.current || PACKAGE_VERSION;
  const installedVersion = input.menubar?.build_stamp?.package_version || null;
  const signatureOk = input.menubar?.installed
    ? input.menubar.signature.checked ? input.menubar.signature.ok : null
    : null;
  const resources = (input.menubar as (SksMenuBarStatusResult & {
    resources?: { checked?: boolean; ok?: boolean };
  }) | null)?.resources;
  const resourcesOk = input.menubar?.installed
    ? resources?.checked === true ? resources.ok === true : null
    : null;
  const rebuildRequired = !input.menubar?.installed
    || installedVersion !== expectedVersion
    || signatureOk !== true
    || resourcesOk !== true;
  const snapshot: SksUpdateStatusV3 = {
    schema: 'sks.update-status.v3',
    generated_at: input.now.toISOString(),
    expires_at: input.now.toISOString(),
    source: input.check.error ? 'error' : 'live',
    sks: {
      installed: Boolean(parseSemVer(input.check.current)),
      current: parseSemVer(input.check.current)?.raw || null,
      latest: parseSemVer(input.check.latest)?.raw || null,
      update_available: input.check.update_available,
      channel,
      package_source: packageSource
    },
    codex_cli: {
      installed: input.codex?.installed === true,
      current: parseSemVer(input.codex?.current_version)?.raw || null,
      latest: parseSemVer(input.codex?.latest_version)?.raw || null,
      update_available: input.codex?.update_available === true,
      update_method: (input.codex as (CodexCliUpdateStatus & { update_method?: string }) | null)?.update_method || null
    },
    menubar: {
      installed: input.menubar?.installed === true,
      running: input.menubar?.running === true,
      expected_version: expectedVersion,
      installed_version: installedVersion,
      signature_ok: signatureOk,
      resources_ok: resourcesOk,
      rebuild_required: rebuildRequired
    },
    update_count: 0,
    warnings: uniqueStrings([
      ...(input.check.version_candidates.length ? [] : ['sks_version_source_unresolved']),
      ...(input.check.error ? ['sks_update_check_unavailable'] : []),
      ...(input.codex?.warnings || []).map((warning) => `codex_cli:${warning}`),
      ...(input.codex?.blockers || []).map((blocker) => `codex_cli:${blocker}`),
      ...(input.menubar?.warnings || []).map((warning) => `menubar:${warning}`),
      ...(input.menubar?.blockers || []).map((blocker) => `menubar:${blocker}`)
    ]),
    public_error: input.check.error
  };
  snapshot.update_count = countUpdates(snapshot);
  return snapshot;
}

function effectiveFromCheck(check: SksUpdateCheckResult): SksEffectiveVersionResult {
  return {
    current: check.current,
    runtime_current: check.runtime_current,
    package_root_current: check.package_root_current,
    path_current: check.path_current,
    npm_global_current: check.npm_global_current,
    candidates: check.version_candidates,
    errors: []
  };
}

export const UPDATE_STAGE_ORDER = [
  'preflight',
  'download_or_registry_check',
  'temporary_install_smoke',
  'global_install',
  'resolve_new_binary',
  'version_probe',
  'new_version_doctor',
  'hook_trust_repair',
  'project_receipt',
  'global_skills_reconcile',
  'native_capability_setup',
  'menubar_rebuild',
  'menubar_signature_verify',
  'final_self_verification',
  'snapshot_refresh'
] as const;

export function updateNestedProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    SKS_UPDATE_DEFER_MENUBAR_RESTART: '1',
    SKS_SKIP_SKS_MENUBAR_LAUNCH: '1'
  };
}

export async function runSksUpdateReview(options: SksUpdateNowOptions = {}): Promise<SksUpdateReviewResult> {
  const packageName = options.packageName || 'sneakoscope';
  const registry = options.registry || DEFAULT_REGISTRY;
  const env = options.env || process.env;
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const check = await runSksUpdateCheck({ ...options, packageName, registry, env, npmBin, refresh: true });
  const target = parseVersionText(options.version || '') || check.latest;
  const globalRoot = npmBin ? await detectNpmGlobalRoot(npmBin, env, options).catch(() => null) : null;
  const ok = Boolean(npmBin && target && parseSemVer(target));
  return {
    schema: 'sks.update-review.v1',
    ok,
    current: check.current,
    target,
    registry,
    npm_bin: npmBin,
    global_root: globalRoot,
    node_path: process.execPath,
    expected_menubar_rebuild: process.platform === 'darwin' && env.SKS_UPDATE_SKIP_SKS_MENUBAR !== '1',
    expected_migrations: ['hook_trust_repair', 'global_skills_reconcile', 'native_capability_setup'],
    rollback_command: `sks update rollback --version ${check.current} --json`,
    stages: [...UPDATE_STAGE_ORDER],
    project_mutation: Boolean(options.projectRoot || env.SKS_MUTATION_LEDGER_ROOT || process.cwd()),
    error: ok ? null : check.error || (!npmBin ? 'npm not found on PATH' : 'target version unavailable')
  };
}

export async function runSksUpdateRollback(options: SksUpdateNowOptions & { version: string }): Promise<SksUpdateRollbackResult> {
  const version = parseVersionText(options.version || '');
  if (!version) {
    return {
      schema: 'sks.update-rollback.v1',
      ok: false,
      status: 'failed',
      requested_version: null,
      update: null,
      receipt_path: null,
      error: 'rollback requires a valid semantic version'
    };
  }
  const currentVersion = parseVersionText(options.currentVersion || PACKAGE_VERSION);
  if (!currentVersion) {
    return {
      schema: 'sks.update-rollback.v1',
      ok: false,
      status: 'failed',
      requested_version: version,
      update: null,
      receipt_path: null,
      error: 'rollback current version is unavailable'
    };
  }
  const authorization = await authorizeUpdateRollback({
    targetVersion: version,
    currentVersion,
    ...(options.env ? { env: options.env } : {})
  });
  if (!authorization.ok) {
    return {
      schema: 'sks.update-rollback.v1',
      ok: false,
      status: 'failed',
      requested_version: version,
      update: null,
      receipt_path: null,
      error: authorization.blocker
    };
  }
  const update = await runSksUpdateNow({ ...options, version, operationKind: 'rollback' });
  return {
    schema: 'sks.update-rollback.v1',
    ok: update.ok,
    status: update.status,
    requested_version: version,
    update,
    receipt_path: update.operation_receipt_path,
    error: update.error
  };
}

export async function runSksUpdateNow(options: SksUpdateNowOptions = {}): Promise<SksUpdateNowResult> {
  const packageName = options.packageName || 'sneakoscope';
  const registry = options.registry || DEFAULT_REGISTRY;
  const env = options.env || process.env;
  const nestedProcessEnv = updateNestedProcessEnvironment(env);
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const cwd = env.HOME || os.homedir();
  const check = await runSksUpdateCheck({
    ...options,
    packageName,
    registry,
    npmBin,
    env
  });
  const requestedVersion = parseVersionText(options.version || '') || null;
  const installVersion = requestedVersion || check.latest;
  const npmArgs = installVersion ? sksGlobalInstallArgs(packageName, installVersion, registry) : [];
  const command = npmBin && npmArgs.length ? [npmBin, ...npmArgs].join(' ') : null;
  const globalRoot = npmBin ? await detectNpmGlobalRoot(npmBin, env, options).catch(() => null) : null;
  const projectReceiptRoot = path.resolve(options.projectRoot || env.SKS_MUTATION_LEDGER_ROOT || process.cwd());
  const stages: SksUpdateNowStage[] = [];
  let temporaryInstallSmoke: TemporaryInstallSmokeResult | null = null;
  const operation = await UpdateOperationRecorder.create({
    env,
    kind: options.operationKind || 'update',
    fromVersion: check.current,
    targetVersion: installVersion
  });
  const quiet = options.quiet === true || /^(1|true)$/i.test(String(env.SKS_UPDATE_QUIET || ''));
  const machineOutput = quiet || options.json === true;
  const stageStart = (id: string, status: string) => {
    if (!machineOutput) cliUi.step(`▸ ${id} - ${status}`);
  };
  const stage = (id: string, ok: boolean, status: string, detail: Record<string, unknown> = {}) => {
    stages.push({ id, ok, status, detail });
    operation.recordStage(id, ok, status, detail);
    if (!machineOutput) cliUi.step(`${ok ? '✔' : '✖'} ${id} - ${status}`);
  };
  const finalize = async (result: SksUpdateNowResult): Promise<SksUpdateNowResult> => {
    result.temporary_install_smoke = temporaryInstallSmoke;
    result.operation_receipt_path = operation.receiptPath;
    result.rollback = {
      available: Boolean(parseSemVer(check.current)),
      previous_version: check.current,
      command: `sks update rollback --version ${check.current} --json`,
      receipt_path: operation.receiptPath
    };
    await operation.finish({
      state: result.status === 'terminal_uncertain'
        ? 'terminal_uncertain'
        : result.ok ? (options.operationKind === 'rollback' ? 'rolled_back' : 'succeeded') : 'failed',
      resultStatus: result.status,
      error: result.error
    });
    return result;
  };
  const recordRegistryStage = () => stage('download_or_registry_check', !check.error, check.error ? 'unavailable' : 'resolved', {
    registry,
    latest: check.latest,
    requested_version: requestedVersion
  });

  if (!npmBin) {
    stage('preflight', false, 'blocked', { reason: 'npm_not_found' });
    recordRegistryStage();
    return finalize(buildUpdateNowResult({
      packageName,
      from: check.current,
      latest: check.latest,
      requestedVersion,
      installVersion,
      npmBin: null,
      npmArgs,
      command,
      cwd,
      registry,
      globalRoot,
      status: 'unavailable',
      ok: false,
      installCode: null,
      oldVersionDoctor: null,
      newBinary: null,
      newVersion: null,
      newVersionDoctor: null,
      projectReceipt: null,
      migrationCurrent: false,
      stages,
      error: 'npm not found on PATH'
    }));
  }
  if (!installVersion) {
    stage('preflight', false, 'blocked', { reason: 'target_version_unavailable' });
    recordRegistryStage();
    return finalize(buildUpdateNowResult({
      packageName,
      from: check.current,
      latest: check.latest,
      requestedVersion,
      installVersion,
      npmBin,
      npmArgs,
      command,
      cwd,
      registry,
      globalRoot,
      status: 'unavailable',
      ok: false,
      installCode: null,
      oldVersionDoctor: null,
      newBinary: null,
      newVersion: null,
      newVersionDoctor: null,
      projectReceipt: null,
      migrationCurrent: false,
      stages,
      error: check.error || 'latest version unavailable'
    }));
  }
  if (options.dryRun) {
    stage('preflight', true, 'skipped_dry_run', { reason: 'dry_run_does_not_run_doctor_fix' });
    recordRegistryStage();
    stage('temporary_install_smoke', true, 'skipped_dry_run', { reason: 'dry_run' });
    stage('global_install', true, 'dry_run', { command });
    return finalize(buildUpdateNowResult({
      packageName,
      from: check.current,
      latest: check.latest,
      requestedVersion,
      installVersion,
      npmBin,
      npmArgs,
      command,
      cwd,
      registry,
      globalRoot,
      status: 'dry_run',
      ok: true,
      installCode: null,
      oldVersionDoctor: null,
      newBinary: null,
      newVersion: null,
      newVersionDoctor: null,
      projectReceipt: null,
      migrationCurrent: false,
      stages,
      error: null
    }));
  }
  if (!requestedVersion && check.latest && !check.update_available) {
    stage('preflight', true, 'already_current', { current: check.current });
    recordRegistryStage();
    stage('temporary_install_smoke', true, 'skipped_current', { current: check.current });
    stage('global_install', true, 'skipped_current', { current: check.current });
    // Record the install-only stages as explicit skips so the receipt covers the
    // full UPDATE_STAGE_ORDER checklist even when no new package is installed.
    stage('resolve_new_binary', true, 'skipped_current', { current: check.current });
    stage('version_probe', true, 'skipped_current', { current: check.current });
    stage('new_version_doctor', true, 'skipped_current', { current: check.current });
    stage('hook_trust_repair', true, 'skipped_current', { current: check.current });
    const receipt = await writeProjectUpdateMigrationReceipt({
      root: projectReceiptRoot,
      source: 'update-now-current',
      fromVersion: check.current,
      blockers: [],
      warnings: ['package_already_current']
    }).catch(() => null);
    const migrationCurrent = isUpdateMigrationReceiptCurrent(receipt);
    stage('project_receipt', migrationCurrent, migrationCurrent ? 'current' : 'failed', { root: projectReceiptRoot });
    await runUpdateGlobalSkillsReconcile(stage, { quiet: machineOutput, env });
    stage('native_capability_setup', true, 'skipped_current', { reason: 'package_already_current' });
    const sksMenuBar = migrationCurrent
      ? await installUpdateSksMenuBar({ root: projectReceiptRoot, env, stage, quiet: machineOutput })
      : null;
    const menuVerification = await verifyUpdateMenuBar({
      install: sksMenuBar,
      expectedVersion: check.current,
      ...(env.HOME ? { home: env.HOME } : {}),
      root: projectReceiptRoot,
      env
    });
    stage('menubar_signature_verify', menuVerification.ok, menuVerification.status, menuVerification.detail);
    stage('final_self_verification', migrationCurrent && menuVerification.ok, migrationCurrent && menuVerification.ok ? 'verified_current' : 'issues', {});
    const currentSnapshot = await runSksUpdateStatus(updateStatusOptionsFromNow(
      options,
      check.current,
      { ...env, [versionOverrideEnvName(packageName)]: check.latest || check.current }
    )).catch(() => null);
    const snapshotOk = currentSnapshot?.schema === 'sks.update-status.v3' && currentSnapshot.source !== 'error';
    stage('snapshot_refresh', snapshotOk, snapshotOk ? currentSnapshot!.source : 'failed', {
      update_count: currentSnapshot?.update_count ?? null
    });
    const currentMenuBarTerminalUncertain = menuBarInstallIsTerminalUncertain(sksMenuBar);
    const currentOk = migrationCurrent && menuVerification.ok && snapshotOk && !currentMenuBarTerminalUncertain;
    return finalize(buildUpdateNowResult({
      packageName,
      from: check.current,
      latest: check.latest,
      requestedVersion,
      installVersion,
      npmBin,
      npmArgs,
      command,
      cwd,
      registry,
      globalRoot,
      status: currentMenuBarTerminalUncertain ? 'terminal_uncertain' : 'current',
      ok: currentOk,
      installCode: null,
      oldVersionDoctor: null,
      newBinary: null,
      newVersion: check.current,
      newVersionDoctor: null,
      projectReceipt: receipt,
      migrationCurrent,
      sksMenuBar,
      stages,
      error: currentOk ? null : currentMenuBarTerminalUncertain
        ? 'Menu Bar launch or rollback completion could not be confirmed'
        : 'current-version repair verification failed'
    }));
  }

  const oldDoctorTimeoutOverride = Number.parseInt(env.SKS_UPDATE_OLD_DOCTOR_TIMEOUT_MS || '', 10);
  const oldDoctorTimeoutMs = Number.isFinite(oldDoctorTimeoutOverride) && oldDoctorTimeoutOverride > 0
    ? oldDoctorTimeoutOverride
    : 60_000;
  let oldVersionDoctor: PackageLocalDoctorRun | null = null;
  if (env.SKS_UPDATE_SKIP_OLD_DOCTOR_PREFLIGHT === '1') {
    stage('preflight', true, 'skipped', { reason: 'SKS_UPDATE_SKIP_OLD_DOCTOR_PREFLIGHT=1' });
  } else {
    stageStart('preflight', 'running migration doctor on current install');
    oldVersionDoctor = await updateHeartbeat(machineOutput, 'old-version doctor', runPackageLocalDoctor({
      root: projectReceiptRoot,
      args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', path.join(projectReceiptRoot, '.sneakoscope', 'update', 'old-version-doctor.json')],
      env: {
        ...nestedProcessEnv,
        ...(env.SKS_TEST_OLD_DOCTOR_FAIL === '1' ? { SKS_TEST_DOCTOR_FAIL: '1' } : {})
      },
      timeoutMs: oldDoctorTimeoutMs,
      maxOutputBytes: 32 * 1024
    }), 60_000);
    stage('preflight', oldVersionDoctor.ok, oldVersionDoctor.ok ? oldVersionDoctor.status : 'failed_continuing', {
      entrypoint: oldVersionDoctor.entrypoint,
      exit_code: oldVersionDoctor.exit_code,
      timeout_ms: oldDoctorTimeoutMs,
      timed_out: oldVersionDoctor.timedOut,
      note: oldVersionDoctor.ok ? null : 'legacy doctor unreliable; new-version doctor will repair after install'
    });
  }
  recordRegistryStage();
  temporaryInstallSmoke = await runTemporaryInstallSmoke({
    npmBin,
    packageName,
    version: installVersion,
    registry,
    env: nestedProcessEnv,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes })
  });
  stage('temporary_install_smoke', temporaryInstallSmoke.ok, temporaryInstallSmoke.status, {
    install_code: temporaryInstallSmoke.install_code,
    manifest_version: temporaryInstallSmoke.manifest_version,
    probed_version: temporaryInstallSmoke.probed_version,
    doctor_status: temporaryInstallSmoke.doctor?.status || null,
    error: temporaryInstallSmoke.error
  });
  if (!temporaryInstallSmoke.ok) {
    return finalize(buildUpdateNowResult({
      packageName,
      from: check.current,
      latest: check.latest,
      requestedVersion,
      installVersion,
      npmBin,
      npmArgs,
      command,
      cwd,
      registry,
      globalRoot,
      status: 'failed',
      ok: false,
      installCode: null,
      oldVersionDoctor,
      newBinary: null,
      newVersion: null,
      newVersionDoctor: null,
      projectReceipt: null,
      migrationCurrent: false,
      stages,
      error: temporaryInstallSmoke.error || 'temporary install smoke failed'
    }));
  }
  const mutationLedgerRoot = env.SKS_MUTATION_LEDGER_ROOT || packageRoot();
  const installContract = createRequestedScopeContract({
    route: 'update',
    userRequest: command || `npm global install ${packageName}`,
    projectRoot: mutationLedgerRoot,
    overrides: { package_install: true }
  });
  const npmStdout = machineOutput ? undefined : throttleLines((line) => process.stderr.write(`  npm | ${line}\n`), 500);
  const npmStderr = machineOutput ? undefined : throttleLines((line) => process.stderr.write(`  npm ! ${line}\n`), 500);
  stageStart('global_install', command || `npm global install ${packageName}`);
  const installOptions: Parameters<typeof guardedPackageInstall>[2] = {
    confirmed: true,
    command: npmBin,
    args: npmArgs,
    cwd,
    env: nestedProcessEnv,
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    maxOutputBytes: options.maxOutputBytes ?? 128 * 1024
  };
  if (npmStdout) installOptions.onStdout = npmStdout;
  if (npmStderr) installOptions.onStderr = npmStderr;
  const install = env.SKS_UPDATE_FAKE_INSTALL === '1'
    ? { code: 0, stdout: 'fake install ok', stderr: '', timedOut: false }
    : await updateHeartbeat(machineOutput, `npm install -g ${packageName}`, guardedPackageInstall(
      guardContextForRoute(mutationLedgerRoot, installContract, command || `npm global install ${packageName}`),
      `${packageName}@${installVersion}`,
      installOptions
    ), 60_000).catch((err: unknown) => ({
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false
    }));
  const installOk = install.code === 0;
  stage('global_install', installOk, installOk ? env.SKS_UPDATE_FAKE_INSTALL === '1' ? 'fake_installed' : 'installed' : 'failed', { command, code: install.code, timed_out: install.timedOut === true });
  let newBinary: string | null = null;
  let newVersion: string | null = null;
  let newVersionDoctor: PackageLocalDoctorRun | null = null;
  let projectReceipt: UpdateMigrationReceipt | null = null;
  let migrationCurrent = false;
  let sksMenuBar: SksMenuBarInstallResult | null = null;
  let menubarVerified = process.platform !== 'darwin' || env.SKS_UPDATE_SKIP_SKS_MENUBAR === '1';
  let hookTrust: any = null;
  if (installOk) {
    newBinary = env.SKS_UPDATE_FAKE_INSTALL === '1'
      ? path.resolve(env.SKS_UPDATE_FAKE_NEW_ENTRYPOINT || path.join(packageRoot(), 'dist', 'bin', 'sks.js'))
      : await resolveInstalledSksEntrypoint({ packageName, globalRoot, env });
    stage('resolve_new_binary', Boolean(newBinary), newBinary ? 'resolved' : 'missing', { new_binary: newBinary });
    if (newBinary) {
      const versionProbe = await runProcess(process.execPath, [newBinary, '--version'], {
        cwd,
        env: { ...env, SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_DISABLE_UPDATE_CHECK: '1' },
        timeoutMs: 5000,
        maxOutputBytes: 4096
      }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
      newVersion = parseVersionText(versionProbe.stdout || versionProbe.stderr || '') || null;
      stage('version_probe', Boolean(newVersion), newVersion ? 'version_detected' : 'failed', { new_version: newVersion, code: versionProbe.code });
      stageStart('new_version_doctor', 'running migration doctor on updated install');
      newVersionDoctor = await updateHeartbeat(machineOutput, 'new-version doctor', runPackageLocalDoctor({
        root: projectReceiptRoot,
        entrypoint: newBinary,
        args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', path.join(projectReceiptRoot, '.sneakoscope', 'update', 'new-version-doctor.json')],
        env: nestedProcessEnv,
        timeoutMs: updateDoctorTimeoutMs(env),
        maxOutputBytes: 32 * 1024
      }), 60_000);
      stage('new_version_doctor', newVersionDoctor.ok, newVersionDoctor.status, { entrypoint: newBinary, exit_code: newVersionDoctor.exit_code, timeout_ms: updateDoctorTimeoutMs(env), timed_out: newVersionDoctor.timedOut });
    }
    if (newVersionDoctor?.ok) {
      hookTrust = await codexHookTrustDoctor(projectReceiptRoot, { fix: true, managed: true, actual: true })
        .catch((err: any) => ({ ok: false, blockers: [`hook_trust_repair_failed:${err?.message || err}`] }));
      stage('hook_trust_repair', hookTrust?.ok !== false, hookTrust?.ok !== false ? 'repaired' : 'failed', {
        entries: hookTrust?.current_hash_count ?? null,
        blockers: hookTrust?.blockers || []
      });
    }
    if (newBinary && newVersionDoctor?.ok && hookTrust?.ok !== false) {
      const receiptResult = await writeUpdatedPackageMigrationReceipt({
        newBinary,
        expectedVersion: installVersion,
        root: projectReceiptRoot,
        source: 'update-now',
        doctor: newVersionDoctor,
        updateStages: stages,
        fromVersion: check.current,
        env: nestedProcessEnv
      });
      projectReceipt = receiptResult.receipt;
      migrationCurrent = isUpdateMigrationReceiptCurrent(projectReceipt, installVersion);
      stage('project_receipt', migrationCurrent, migrationCurrent ? 'current' : 'failed', {
        root: projectReceiptRoot,
        via: 'new_package_binary',
        expected_version: installVersion,
        receipt_version: projectReceipt?.sks_version || null,
        error: receiptResult.error
      });
      await runUpdateGlobalSkillsReconcile(stage, {
        quiet: machineOutput,
        env,
        newPackageRoot: newBinary ? path.resolve(path.dirname(newBinary), '..', '..') : null
      });
      await runUpdateNativeCapabilitySetup(stage, {
        quiet: machineOutput,
        env,
        newPackageRoot: newBinary ? path.resolve(path.dirname(newBinary), '..', '..') : null,
        root: projectReceiptRoot
      });
      if (migrationCurrent) {
        sksMenuBar = await installUpdateSksMenuBar({ root: projectReceiptRoot, env, stage, quiet: machineOutput, entrypoint: newBinary });
        const menuVerification = await verifyUpdateMenuBar({
          install: sksMenuBar,
          expectedVersion: installVersion,
          ...(env.HOME ? { home: env.HOME } : {}),
          root: projectReceiptRoot,
          env
        });
        menubarVerified = menuVerification.ok;
        stage('menubar_signature_verify', menuVerification.ok, menuVerification.status, menuVerification.detail);
      }
    }
  }
  const verification = await runFinalUpdateVerification({ installOk, newBinary, installVersion, env, projectReceiptRoot });
  const verifyOk = verification.length > 0 && verification.every((item) => item.ok);
  if (verification.length) {
    stage('final_self_verification', verifyOk, verifyOk ? 'verified' : 'issues', {
      failed: verification.filter((item) => !item.ok).map((item) => item.id)
    });
  } else stage('final_self_verification', false, 'not_run', {});
  const snapshot = await runSksUpdateStatus(updateStatusOptionsFromNow(
    options,
    newVersion || check.current,
    {
      ...env,
      ...(installVersion ? { [versionOverrideEnvName(packageName)]: check.latest || installVersion } : {})
    }
  )).catch(() => null);
  const snapshotOk = snapshot?.schema === 'sks.update-status.v3' && snapshot.source !== 'error';
  stage('snapshot_refresh', snapshotOk, snapshotOk ? snapshot!.source : 'failed', {
    current: snapshot?.sks.current || null,
    update_count: snapshot?.update_count ?? null,
    public_error: snapshot?.public_error || null
  });
  const baseOk = installOk && Boolean(newBinary) && newVersionDoctor?.ok === true
    && hookTrust?.ok !== false && migrationCurrent && menubarVerified;
  const ok = baseOk && verifyOk && snapshotOk;
  const menuBarTerminalUncertain = menuBarInstallIsTerminalUncertain(sksMenuBar);
  const terminalUncertain = install.timedOut === true || menuBarTerminalUncertain;
  const status: SksUpdateNowResult['status'] = terminalUncertain
    ? 'terminal_uncertain'
    : ok ? 'updated' : baseOk ? 'updated_with_issues' : 'failed';
  return finalize(buildUpdateNowResult({
    packageName,
    from: check.current,
    latest: check.latest,
    requestedVersion,
    installVersion,
    npmBin,
    npmArgs,
    command,
    cwd,
    registry,
    globalRoot,
    status,
    ok,
    installCode: install.code,
    oldVersionDoctor,
    newBinary,
    newVersion,
    newVersionDoctor,
    projectReceipt,
    migrationCurrent,
    sksMenuBar,
    stages,
    verification,
    error: terminalUncertain
      ? menuBarTerminalUncertain
        ? 'Menu Bar launch or rollback completion could not be confirmed'
        : 'global install timed out; package side-effect completion is uncertain'
      : ok ? null : status === 'updated_with_issues' ? verificationError(verification) : updateNowError(install, newBinary, newVersionDoctor, migrationCurrent)
  }));
}

export function menuBarInstallIsTerminalUncertain(result: SksMenuBarInstallResult | null | undefined): boolean {
  return result?.status === 'terminal_uncertain'
    || result?.launch?.terminal_uncertain === true
    || result?.rollback?.status === 'terminal_uncertain';
}

async function runUpdateGlobalSkillsReconcile(stage: (id: string, ok: boolean, status: string, detail?: Record<string, unknown>) => void, opts: { quiet?: boolean; newPackageRoot?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const targetDir = path.join(opts.env?.HOME || os.homedir(), '.agents', 'skills');
  // reconcileSkills stamps ~/.agents/skills/.sks-generated.json with the
  // PACKAGE_VERSION compiled into whichever module runs it. This function
  // executes inside the OLD (driver) binary, so after a real version install
  // an in-process reconcile would overwrite the manifest the new binary's
  // migration doctor just wrote and make final self-verification report
  // skills_manifest stale forever. Delegate to the freshly installed package.
  if (opts.newPackageRoot) {
    const moduleHref = pathToFileURL(path.join(opts.newPackageRoot, 'dist', 'core', 'init', 'skills.js')).href;
    const script = [
      `const m = await import(${JSON.stringify(moduleHref)});`,
      `const r = await m.reconcileSkills({ targetDir: ${JSON.stringify(targetDir)}, scope: 'global', fix: true });`,
      'console.log(JSON.stringify(r));',
      'if (r && (r.ok === false || r.error)) process.exit(1);'
    ].join('\n');
    const work = runProcess(process.execPath, ['--input-type=module', '-e', script], {
      env: opts.env || process.env,
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024
    }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
    const run = opts.quiet ? await work : await withHeartbeat('skills reconcile', work, { warnAfterMs: 30_000 });
    let parsed: any = null;
    for (const line of String(run.stdout || '').trim().split('\n').reverse()) {
      try { parsed = JSON.parse(line); break; } catch { /* not the JSON result line */ }
    }
    const ok = run.code === 0 && parsed?.ok !== false && !parsed?.error;
    stage('global_skills_reconcile', ok, ok ? 'reconciled' : 'failed', {
      via: 'new_package_binary',
      installed: Array.isArray(parsed?.installed) ? parsed.installed.length : null,
      updated: Array.isArray(parsed?.updated) ? parsed.updated.length : null,
      removed: Array.isArray(parsed?.removed) ? parsed.removed.length : null,
      error: ok ? null : parsed?.error || String(run.stderr || '').trim().slice(-400) || `exit_${run.code}`
    });
    return parsed || { schema: 'sks.skill-reconcile.v1', ok };
  }
  const work = reconcileSkills({
    targetDir,
    scope: 'global',
    fix: true
  }).catch((err: any) => ({ schema: 'sks.skill-reconcile.v1', ok: false, error: err?.message || String(err) }));
  const result = opts.quiet ? await work : await withHeartbeat('skills reconcile', work, { warnAfterMs: 30_000 });
  const ok = (result as any).ok !== false && !(result as any).error;
  stage('global_skills_reconcile', ok, ok ? 'reconciled' : 'failed', {
    installed: Array.isArray((result as any).installed) ? (result as any).installed.length : null,
    updated: Array.isArray((result as any).updated) ? (result as any).updated.length : null,
    removed: Array.isArray((result as any).removed) ? (result as any).removed.length : null,
    error: (result as any).error || null
  });
  return result;
}

async function runUpdateNativeCapabilitySetup(
  stage: (id: string, ok: boolean, status: string, detail?: Record<string, unknown>) => void,
  opts: { quiet?: boolean; newPackageRoot?: string | null; root: string; env?: NodeJS.ProcessEnv }
) {
  if (!opts.newPackageRoot) {
    stage('native_capability_setup', true, 'skipped', { reason: 'new_package_root_unresolved' });
    return null;
  }
  const root = opts.root;
  const moduleHref = (rel: string) => pathToFileURL(path.join(opts.newPackageRoot as string, 'dist', 'core', 'doctor', rel)).href;
  // Same as global_skills_reconcile above: run the newly installed package's own
  // modules in a subprocess rather than in-process, so an old (pre-update) driver
  // binary never runs post-update repair logic with stale compiled-in behavior.
  const script = [
    `const [{ repairCodexImagegen }, { repairComputerUse }, { repairBrowserUse }] = await Promise.all([import(${JSON.stringify(moduleHref('imagegen-repair.js'))}), import(${JSON.stringify(moduleHref('computer-use-repair.js'))}), import(${JSON.stringify(moduleHref('browser-use-repair.js'))})]);`,
    `const root = ${JSON.stringify(root)};`,
    'const imagegen = await repairCodexImagegen({ root, apply: true, reportPath: null }).catch((err) => ({ ok: false, recovered: false, attempted: true, error: String((err && err.message) || err) }));',
    'const computerUse = await repairComputerUse({ root, apply: true, reportPath: null }).catch((err) => ({ ok: false, recovered: false, attempted: true, error: String((err && err.message) || err) }));',
    'const browserUse = await repairBrowserUse({ root, apply: true, reportPath: null }).catch((err) => ({ ok: false, recovered: false, attempted: true, error: String((err && err.message) || err) }));',
    'console.log(JSON.stringify({ imagegen, computer_use: computerUse, browser_use: browserUse }));'
  ].join('\n');
  const work = runProcess(process.execPath, ['--input-type=module', '-e', script], {
    env: opts.env || process.env,
    timeoutMs: 180_000,
    maxOutputBytes: 1024 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
  const run = opts.quiet ? await work : await withHeartbeat('native capability setup', work, { warnAfterMs: 30_000 });
  let parsed: any = null;
  for (const line of String(run.stdout || '').trim().split('\n').reverse()) {
    try { parsed = JSON.parse(line); break; } catch { /* not the JSON result line */ }
  }
  const summarize = (r: any) => (r?.recovered === true || r?.ok === true ? 'ok' : r?.attempted ? 'blocked' : 'not-needed');
  const ok = run.code === 0 && Boolean(parsed);
  // A repair reporting 'blocked' (e.g. no verified CLI subcommand for a plugin
  // install) is a valid, honest terminal state for this stage, not a stage
  // failure — the update itself must not be blocked on a manual-only step.
  stage('native_capability_setup', ok, ok ? 'completed' : 'failed', {
    via: 'new_package_binary',
    summary: ok
      ? { imagegen: summarize(parsed.imagegen), computer_use: summarize(parsed.computer_use), browser_use: summarize(parsed.browser_use) }
      : null,
    error: ok ? null : String(run.stderr || '').trim().slice(-400) || `exit_${run.code}`
  });
  return parsed;
}

async function writeUpdatedPackageMigrationReceipt(input: {
  newBinary: string;
  expectedVersion: string;
  root: string;
  source: string;
  doctor: PackageLocalDoctorRun;
  updateStages: SksUpdateNowStage[];
  fromVersion: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ receipt: UpdateMigrationReceipt | null; error: string | null }> {
  const newPackageRoot = path.resolve(path.dirname(input.newBinary), '..', '..');
  const moduleHref = pathToFileURL(path.join(newPackageRoot, 'dist', 'core', 'update', 'update-migration-state.js')).href;
  const script = [
    "let raw = '';",
    "for await (const chunk of process.stdin) raw += chunk;",
    `const m = await import(${JSON.stringify(moduleHref)});`,
    'const receipt = await m.writeProjectUpdateMigrationReceipt(JSON.parse(raw));',
    "console.log(JSON.stringify({ schema: 'sks.update-migration-write-ack.v1', status: receipt.status, sks_version: receipt.sks_version, generated_at: receipt.generated_at }));"
  ].join('\n');
  const payload = {
    root: input.root,
    source: input.source,
    doctor: input.doctor,
    updateStages: input.updateStages,
    fromVersion: input.fromVersion,
    blockers: [],
    warnings: []
  };
  const run = await runProcess(process.execPath, ['--input-type=module', '-e', script], {
    cwd: input.root,
    env: input.env,
    input: JSON.stringify(payload),
    timeoutMs: updateDoctorTimeoutMs(input.env),
    maxOutputBytes: 128 * 1024
  }).catch((error: unknown) => ({
    code: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    timedOut: false
  }));
  let ack: any = null;
  for (const line of String(run.stdout || '').trim().split(/\r?\n/).reverse()) {
    try {
      ack = JSON.parse(line);
      break;
    } catch {}
  }
  const receipt = run.code === 0
    ? await readJson<UpdateMigrationReceipt | null>(projectUpdateMigrationReceiptPath(input.root), null).catch(() => null)
    : null;
  const acknowledgementMatches = ack?.schema === 'sks.update-migration-write-ack.v1'
    && ack.status === receipt?.status
    && ack.sks_version === receipt?.sks_version
    && ack.generated_at === receipt?.generated_at;
  const current = run.code === 0
    && acknowledgementMatches
    && isUpdateMigrationReceiptCurrent(receipt, input.expectedVersion);
  const receiptError = run.code !== 0
    ? run.timedOut === true
      ? `new package migration receipt writer timed out after ${updateDoctorTimeoutMs(input.env)}ms`
      : String(run.stderr || run.stdout || 'new package migration receipt writer failed').trim()
    : !acknowledgementMatches
      ? 'new package migration receipt acknowledgement did not match the written receipt'
      : `new package migration receipt did not bind to ${input.expectedVersion}`;
  return {
    receipt,
    error: current
      ? null
      : receiptError.slice(-500)
  };
}

export function sksGlobalInstallArgs(packageName: string, version: string, registry = DEFAULT_REGISTRY): string[] {
  return ['install', '--global', `${packageName}@${version}`, '--registry', registry];
}

export async function detectEffectiveSksVersion(options: SksUpdateCheckOptions = {}): Promise<SksEffectiveVersionResult> {
  const packageName = options.packageName || 'sneakoscope';
  const env = options.env || process.env;
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const candidates: SksVersionCandidate[] = [];
  const errors: string[] = [];
  const add = (version: string | null | undefined, source: string) => {
    const parsed = parseVersionText(version || '');
    if (parsed) candidates.push({ version: parsed, source });
  };
  add(options.currentVersion || PACKAGE_VERSION, 'runtime');
  add(env.SKS_INSTALLED_SKS_VERSION, 'env:SKS_INSTALLED_SKS_VERSION');
  const packageRootPromise = readJson<any>(path.join(packageRoot(), 'package.json'), {}).catch(() => ({}));
  const pathSksPromise = which('sks')
    .then(async (sks) => {
      if (!sks) return null;
      const result = await runProcess(sks, ['--version'], {
        timeoutMs: 2000,
        maxOutputBytes: 4096,
        env: { ...env, SKS_DISABLE_UPDATE_CHECK: '1' }
      }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
      return { sks, result };
    })
    .catch(() => null);
  const npmGlobalPromise = npmBin
    ? detectNpmGlobalPackageVersion(npmBin, packageName, env, {
      timeoutMs: options.timeoutMs ?? 2500,
      maxOutputBytes: options.maxOutputBytes ?? 8192
    }).catch((err: any) => ({ version: null, error: err?.message || String(err) }))
    : Promise.resolve(null);
  const [pkg, pathSks, npmGlobal] = await Promise.all([packageRootPromise, pathSksPromise, npmGlobalPromise]);
  add(pkg?.version, 'packageRoot:package.json');
  if (pathSks?.sks) {
    if (pathSks.result.code === 0) add(pathSks.result.stdout, `PATH:${pathSks.sks}`);
    else errors.push(`path_sks_version:${String(pathSks.result.stderr || pathSks.result.stdout || 'failed').trim()}`);
  }
  if (npmGlobal) {
    add(npmGlobal.version, `npm-global:${packageName}`);
    if (npmGlobal.error) errors.push(`npm_global_version:${npmGlobal.error}`);
  }

  const pathCandidate = candidates.find((candidate) => candidate.source.startsWith('PATH:'))?.version || null;
  const npmGlobalCandidate = candidates.find((candidate) => candidate.source.startsWith('npm-global:'))?.version || null;
  const packageRootCandidate = candidates.find((candidate) => candidate.source === 'packageRoot:package.json')?.version || null;
  const current = effectiveInstalledVersion(candidates);
  return {
    current,
    runtime_current: PACKAGE_VERSION,
    package_root_current: packageRootCandidate,
    path_current: pathCandidate,
    npm_global_current: npmGlobalCandidate,
    candidates,
    errors
  };
}

async function detectNpmGlobalPackageVersion(
  npmBin: string,
  packageName: string,
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs: number; maxOutputBytes: number }
): Promise<{ version: string | null; error?: string }> {
  const result = await runProcess(npmBin, ['list', '-g', packageName, '--json', '--depth=0', '--silent'], {
    env,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
  if (result.code === 0 && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout);
      const version = parseVersionText(parsed?.dependencies?.[packageName]?.version || '');
      if (version) return { version };
    } catch {}
  }
  const rootResult = await runProcess(npmBin, ['root', '-g', '--silent'], {
    env,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
  const root = String(rootResult.stdout || '').trim().split(/\r?\n/).pop();
  if (root) {
    const pkg = await readJson<any>(path.join(root, packageName, 'package.json'), null).catch(() => null);
    const version = parseVersionText(pkg?.version || '');
    if (version) return { version };
  }
  return { version: null, error: String(result.stderr || result.stdout || rootResult.stderr || 'npm global package not found').trim() };
}

export function formatSksUpdateCheckText(result: SksUpdateCheckResult): string {
  const lines = [
    'Update Check',
    `Current: ${result.current}`,
    `Latest:  ${result.latest || 'unknown'}`,
    `Update:  ${result.update_available ? 'available' : 'not needed'}`
  ];
  if (result.error) lines.push(`Error:   ${result.error}`);
  if (result.command) lines.push(`Run:     ${result.command}`);
  lines.push('Mode:    function-only');
  return lines.join('\n');
}

export function formatSksUpdateStatusText(result: SksUpdateStatusV3): string {
  const value = (current: string | null, latest: string | null, updateAvailable: boolean) =>
    `${current || 'not installed'}${latest ? ` → ${latest}` : ''}${updateAvailable ? ' (update available)' : ''}`;
  const lines = [
    'Update Status',
    `Source:    ${result.source}`,
    `SKS:       ${value(result.sks.current, result.sks.latest, result.sks.update_available)}`,
    `Codex CLI: ${value(result.codex_cli.current, result.codex_cli.latest, result.codex_cli.update_available)}`,
    `Menu Bar:  ${result.menubar.installed_version || 'not installed'} → ${result.menubar.expected_version}${result.menubar.rebuild_required ? ' (rebuild required)' : ''}`,
    `Updates:   ${result.update_count}`,
    `Expires:   ${result.expires_at}`
  ];
  if (result.public_error) lines.push(`Notice:    ${result.public_error}`);
  return lines.join('\n');
}

export function comparePackageVersions(a: string | null | undefined, b: string | null | undefined): number {
  return compareSemVer(a, b) ?? 0;
}

function buildResult(input: {
  packageName: string;
  current: string;
  effective: SksEffectiveVersionResult;
  latest: string | null;
  registry: string;
  npmBin: string | null;
  error?: string | null;
}): SksUpdateCheckResult {
  const latest = parseSemVer(input.latest)?.raw || null;
  const invalidLatest = Boolean(input.latest && !latest);
  const error = input.error || (invalidLatest ? 'latest version was not valid semantic version data' : null);
  const updateAvailable = !error && Boolean(latest && comparePackageVersions(latest, input.current) > 0);
  return {
    schema: 'sks.update-check.v2',
    package: input.packageName,
    current: input.current,
    runtime_current: PACKAGE_VERSION,
    package_root_current: input.effective.package_root_current,
    path_current: input.effective.path_current,
    npm_global_current: input.effective.npm_global_current,
    version_candidates: input.effective.candidates,
    latest,
    update_available: updateAvailable,
    status: error ? 'unavailable' : updateAvailable ? 'available' : 'current',
    mode: 'function',
    route_required: false,
    pipeline_required: false,
    command: updateAvailable ? `sks update now --version ${latest}` : null,
    npm_bin: input.npmBin,
    registry: input.registry,
    error
  };
}

function buildUpdateNowResult(input: {
  packageName: string;
  from: string;
  latest: string | null;
  requestedVersion: string | null;
  installVersion: string | null;
  npmBin: string | null;
  npmArgs: string[];
  command: string | null;
  cwd: string;
  registry: string;
  globalRoot: string | null;
  status: SksUpdateNowResult['status'];
  ok: boolean;
  installCode: number | null;
  oldVersionDoctor: PackageLocalDoctorRun | null;
  newBinary: string | null;
  newVersion: string | null;
  newVersionDoctor: PackageLocalDoctorRun | null;
  projectReceipt: UpdateMigrationReceipt | null;
  migrationCurrent: boolean;
  sksMenuBar?: SksMenuBarInstallResult | null;
  stages: SksUpdateNowStage[];
  verification?: SksUpdateVerification[];
  error: string | null;
}): SksUpdateNowResult {
  return {
    schema: 'sks.update-now.v2',
    ok: input.ok,
    status: input.status,
    package: input.packageName,
    from: input.from,
    latest: input.latest,
    requested_version: input.requestedVersion,
    install_version: input.installVersion,
    npm_bin: input.npmBin,
    npm_args: input.npmArgs,
    command: input.command,
    cwd: input.cwd,
    registry: input.registry,
    global_root: input.globalRoot,
    install_code: input.installCode,
    old_version_doctor: input.oldVersionDoctor,
    new_binary: input.newBinary,
    new_version: input.newVersion,
    new_version_doctor: input.newVersionDoctor,
    project_receipt: input.projectReceipt,
    migration_current: input.migrationCurrent,
    sks_menubar: input.sksMenuBar || null,
    stages: input.stages,
    verification: input.verification || [],
    temporary_install_smoke: null,
    operation_receipt_path: null,
    rollback: {
      available: Boolean(parseSemVer(input.from)),
      previous_version: input.from,
      command: `sks update rollback --version ${input.from} --json`,
      receipt_path: null
    },
    error: input.error
  };
}

async function verifyUpdateMenuBar(input: {
  install: SksMenuBarInstallResult | null;
  expectedVersion: string;
  home?: string;
  root: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; status: string; detail: Record<string, unknown> }> {
  if (process.platform !== 'darwin' || input.env.SKS_UPDATE_SKIP_SKS_MENUBAR === '1') {
    return { ok: true, status: 'skipped', detail: { reason: process.platform !== 'darwin' ? 'not_macos' : 'SKS_UPDATE_SKIP_SKS_MENUBAR=1' } };
  }
  if (!input.install || input.install.ok === false) {
    return { ok: false, status: 'install_failed', detail: { blockers: input.install?.blockers || ['menubar_install_missing'] } };
  }
  const status = await inspectSksMenuBarStatus({
    ...(input.home === undefined ? {} : { home: input.home }),
    root: input.root,
    env: input.env
  }).catch(() => null);
  const resources = (status as (SksMenuBarStatusResult & { resources?: { checked?: boolean; ok?: boolean; missing?: string[]; mismatched?: string[] } }) | null)?.resources;
  const versionOk = status?.build_stamp?.package_version === input.expectedVersion;
  const signatureOk = status?.signature.checked === true && status.signature.ok === true;
  const resourcesOk = resources?.checked === true && resources.ok === true;
  const ok = status?.installed === true && versionOk && signatureOk && resourcesOk;
  return {
    ok,
    status: ok ? 'verified' : 'failed',
    detail: {
      installed: status?.installed === true,
      expected_version: input.expectedVersion,
      installed_version: status?.build_stamp?.package_version || null,
      signature_ok: signatureOk,
      resources_ok: resourcesOk,
      missing_resources: resources?.missing || [],
      mismatched_resources: resources?.mismatched || []
    }
  };
}

export async function installUpdateSksMenuBar(input: {
  root: string;
  env: NodeJS.ProcessEnv;
  stage: (id: string, ok: boolean, status: string, detail?: Record<string, unknown>) => void;
  quiet?: boolean;
  entrypoint?: string | null;
}): Promise<SksMenuBarInstallResult | null> {
  if (input.env.SKS_UPDATE_SKIP_SKS_MENUBAR === '1') {
    const [retiredLaunchAgent, retiredBindings] = await Promise.all([
      cleanupRetiredRemoteBridgeLaunchAgent({
        ...(input.env.HOME ? { home: input.env.HOME } : {}),
        env: input.env
      }),
      quarantineRetiredRemoteBridgeBindings(input.root)
    ]);
    const retiredCleanupOk = retiredLaunchAgent.ok && retiredBindings.ok;
    input.stage('menubar_rebuild', retiredCleanupOk, retiredCleanupOk ? 'skipped' : 'blocked', {
      reason: 'SKS_UPDATE_SKIP_SKS_MENUBAR=1',
      launch_agent_status: retiredLaunchAgent.status,
      binding_status: retiredBindings.status,
      quarantined_binding_count: retiredBindings.retired_binding_count,
      blockers: [...retiredLaunchAgent.blockers, ...retiredBindings.blockers],
      warnings: [...retiredLaunchAgent.warnings, ...retiredBindings.warnings]
    });
    return null;
  }
  const restartDeferred = input.env.SKS_UPDATE_DEFER_MENUBAR_RESTART === '1';
  const work = (input.entrypoint
    ? installSksMenuBarFromEntrypoint(input.entrypoint, input)
    : installSksMenuBar({
        root: input.root,
        apply: true,
        launch: !restartDeferred,
        env: input.env,
        quiet: input.quiet === true
      })).catch((err: any) => ({
    schema: 'sks.codex-app-sks-menubar.v1',
    ok: false,
    apply: true,
    status: 'blocked',
    platform: process.platform,
    app_path: null,
    executable_path: null,
    launch_agent_path: null,
    action_script_path: null,
    build_stamp_path: null,
    report_path: path.join(input.root, '.sneakoscope', 'reports', 'sks-menubar.json'),
    menu_items: [],
    actions: [],
    launch: { requested: !restartDeferred, method: 'none', ok: false, error: err?.message || String(err) },
    tcc_automation_status: 'unknown',
    next_actions: [
      'Run: sks menubar status',
      'Run: sks menubar install',
      'Run: sks menubar restart',
      'Rotate CODEX_LB_API_KEY and OPENROUTER_API_KEY if they were previously exposed in launchd.'
    ],
    blockers: [err?.message || String(err)],
    warnings: []
  } as SksMenuBarInstallResult));
  const result = input.quiet ? await work : await withHeartbeat('SKS menu bar install', work, { warnAfterMs: 30_000 });
  input.stage('menubar_rebuild', result.ok !== false, result.status, {
    app_path: result.app_path,
    launch_agent_path: result.launch_agent_path,
    launch: result.launch,
    restart_deferred: restartDeferred
  });
  return result;
}

async function installSksMenuBarFromEntrypoint(
  entrypoint: string,
  input: { root: string; env: NodeJS.ProcessEnv; quiet?: boolean }
): Promise<SksMenuBarInstallResult> {
  const restartDeferred = input.env.SKS_UPDATE_DEFER_MENUBAR_RESTART === '1';
  const run = await runProcess(process.execPath, [
    entrypoint,
    'menubar',
    'install',
    ...(restartDeferred ? ['--no-launch'] : []),
    '--json'
  ], {
    cwd: input.root,
    env: {
      ...input.env,
      SKS_DISABLE_UPDATE_CHECK: '1',
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1'
    },
    timeoutMs: updateDoctorTimeoutMs(input.env),
    maxOutputBytes: 128 * 1024
  });
  const output = String(run.stdout || '').trim();
  let parsed: SksMenuBarInstallResult | null = null;
  try {
    parsed = JSON.parse(output) as SksMenuBarInstallResult;
  } catch {
    parsed = null;
  }
  if (run.code !== 0 || parsed?.schema !== 'sks.codex-app-sks-menubar.v1') {
    throw new Error(String(run.stderr || output || `updated SKS menu bar installer exited ${run.code}`).trim());
  }
  return parsed;
}

async function detectNpmGlobalRoot(npmBin: string, env: NodeJS.ProcessEnv, opts: SksUpdateCheckOptions = {}): Promise<string | null> {
  const result = await runProcess(npmBin, ['root', '--global', '--silent'], {
    env,
    timeoutMs: opts.timeoutMs ?? 2500,
    maxOutputBytes: opts.maxOutputBytes ?? 4096
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return result.code === 0 ? String(result.stdout || '').trim().split(/\r?\n/).pop() || null : null;
}

function versionOverrideEnvName(packageName: string): string {
  return `SKS_NPM_VIEW_${packageName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_VERSION`;
}

function updateStatusOptionsFromNow(
  options: SksUpdateNowOptions,
  currentVersion: string,
  env: NodeJS.ProcessEnv
): SksUpdateStatusOptions {
  return {
    currentVersion,
    refresh: true,
    env,
    ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.npmBin === undefined ? {} : { npmBin: options.npmBin }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.projectRoot == null ? {} : { projectRoot: options.projectRoot })
  };
}

function parseVersionText(text: string): string | null {
  return extractSemVer(text);
}

function globalSksRootPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SKS_GLOBAL_ROOT) return path.resolve(env.SKS_GLOBAL_ROOT);
  return path.join(env.HOME || os.homedir(), '.sneakoscope-global');
}

function updateDoctorTimeoutMs(env: NodeJS.ProcessEnv): number {
  const override = Number.parseInt(env.SKS_UPDATE_NEW_DOCTOR_TIMEOUT_MS || env.SKS_MIGRATION_DOCTOR_TIMEOUT_MS || '', 10);
  return Number.isFinite(override) && override > 0 ? override : 180_000;
}

async function updateHeartbeat<T>(quiet: boolean, label: string, work: Promise<T>, warnAfterMs = 60_000): Promise<T> {
  return quiet ? work : withHeartbeat(label, work, { warnAfterMs });
}

async function runFinalUpdateVerification(input: {
  installOk: boolean;
  newBinary: string | null;
  installVersion: string | null;
  env: NodeJS.ProcessEnv;
  projectReceiptRoot: string;
}): Promise<SksUpdateVerification[]> {
  if (!input.installOk || !input.newBinary || !input.installVersion) return [];
  const verification: SksUpdateVerification[] = [];
  const versionProbe = await runProcess(process.execPath, [input.newBinary, '--version'], {
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    env: { ...input.env, SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_DISABLE_UPDATE_CHECK: '1' }
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
  const got = parseVersionText(`${(versionProbe as any).stdout || ''}\n${(versionProbe as any).stderr || ''}`);
  verification.push({
    id: 'version_match',
    ok: compareSemVer(got, input.installVersion) === 0,
    detail: `expected ${input.installVersion}, got ${got || 'missing'}`,
    remediation: 'Run: sks update now --version <expected>'
  });

  const hookState = await readCodexHookActualState(input.projectReceiptRoot).catch(() => null);
  const managedEntries = (hookState?.entries || []).filter((entry: any) => entry.managed === true);
  const untrusted = managedEntries.filter((entry: any) => entry.trust_status !== 'Trusted' && entry.trust_status !== 'Managed');
  verification.push({
    id: 'hooks_trusted',
    ok: Boolean(hookState && hookState.ok !== false && managedEntries.length > 0 && untrusted.length === 0),
    detail: untrusted.length ? untrusted.map((entry: any) => entry.key).slice(0, 3).join(', ') : `managed ${managedEntries.length}`,
    remediation: 'Run: sks codex trust-doctor --fix --managed --actual'
  });

  const stampPath = path.join(path.dirname(input.newBinary), '..', '.sks-build-stamp.json');
  const stamp = await readJson<any>(stampPath, null).catch(() => null);
  const stampVersion = stamp?.package_version || stamp?.version || null;
  verification.push({
    id: 'dist_stamp',
    ok: stampVersion === input.installVersion,
    detail: `expected ${input.installVersion}, got ${stampVersion || 'missing'}`,
    remediation: 'Run: npm run build:incremental'
  });

  const home = input.env.HOME || os.homedir();
  const skillsManifest = await readJson<any>(path.join(home, '.agents', 'skills', '.sks-generated.json'), null).catch(() => null);
  verification.push({
    id: 'skills_manifest',
    ok: skillsManifest?.version === input.installVersion,
    detail: `expected ${input.installVersion}, got ${skillsManifest?.version || 'missing'}`,
    remediation: 'Run: sks doctor --fix --yes'
  });
  if (process.platform === 'darwin' && input.env.SKS_UPDATE_SKIP_SKS_MENUBAR !== '1') {
    const menuStampPath = sksMenuBarPaths(home, input.projectReceiptRoot).build_stamp_path;
    const menuStamp = await readJson<any>(menuStampPath, null).catch(() => null);
    verification.push({
      id: 'sks_menubar_version',
      ok: menuStamp?.package_version === input.installVersion,
      detail: `expected ${input.installVersion}, got ${menuStamp?.package_version || 'missing'}`,
      remediation: `Run: ${process.execPath} ${input.newBinary} menubar install --json`
    });
  }
  return verification;
}

function verificationError(verification: SksUpdateVerification[]): string {
  const failed = verification.filter((item) => !item.ok);
  return failed.length
    ? `update self-verification failed: ${failed.map((item) => item.id).join(', ')}`
    : 'update self-verification did not run';
}

function updateNowError(
  install: { code: number | null; stdout: string; stderr: string },
  newBinary: string | null,
  newVersionDoctor: PackageLocalDoctorRun | null,
  migrationCurrent: boolean
): string {
  if (install.code !== 0) return `${install.stderr || install.stdout || 'npm global install failed'}`.trim();
  if (!newBinary) return 'new package-local sks binary could not be resolved after install';
  if (!newVersionDoctor?.ok) return newVersionDoctor?.error || 'new-version global Doctor failed';
  if (!migrationCurrent) return 'project update migration receipt was not current';
  return 'update failed';
}

function effectiveInstalledVersion(candidates: SksVersionCandidate[]): string {
  const firstBySource = (source: string) => candidates.find((candidate) => candidate.source === source)?.version || null;
  const firstByPrefix = (prefix: string) => candidates.find((candidate) => candidate.source.startsWith(prefix))?.version || null;
  return firstBySource('env:SKS_INSTALLED_SKS_VERSION')
    || firstByPrefix('npm-global:')
    || firstByPrefix('PATH:')
    || firstBySource('runtime')
    || firstBySource('packageRoot:package.json')
    || highestPackageVersion(candidates.map((candidate) => candidate.version));
}

function highestPackageVersion(versions: Array<string | null | undefined>): string {
  return versions
    .filter((version): version is string => typeof version === 'string' && version.length > 0)
    .reduce((best, candidate) => comparePackageVersions(candidate, best) > 0 ? candidate : best, '0.0.0');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
