import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { canonicalFilesystemPath, PACKAGE_VERSION, packageRoot, readJson, runProcess, throttleLines, which } from './fsx.js';
import { createRequestedScopeContract } from './safety/requested-scope-contract.js';
import { guardedPackageInstall, guardContextForRoute } from './safety/mutation-guard.js';
import {
  isUpdateMigrationReceiptCurrent,
  readProjectUpdateMigrationReceipt,
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
import { readCodexHookActualState } from './codex-hooks/codex-hook-actual-discovery.js';
import { compareSemVer, extractSemVer, parseSemVer } from './update/semver.js';
import {
  countUpdates,
  emptyUpdateStatus,
  resolveSksUpdateStatus,
  UpdateStatusRefreshError,
  type SksUpdateStatusV3
} from './update/update-status.js';
import {
  acquireUpdateOperationLock,
  authorizeUpdateRollback,
  buildUpdateNowCommand,
  buildUpdateRollbackCommand,
  canonicalUpdateRegistry,
  UpdateOperationRecorder,
  updateOperationLastInstallPath,
  updateReceiptHasConfirmedGlobalInstall,
  type UpdateRollbackAuthorization
} from './update/update-operation.js';
import { runTemporaryInstallSmoke, type TemporaryInstallSmokeResult } from './update/temporary-install-smoke.js';
import { updateStageFailureDiagnostics } from './update/update-stage-diagnostics.js';
import {
  executableOnInjectedPath,
  inspectInstalledCliResolution,
  type InstalledCliResolution
} from './update/installed-cli-resolution.js';
import { ui as cliUi, withHeartbeat } from '../cli/cli-theme.js';
import { uniqueTruthyStrings as uniqueStrings } from './text/strings.js';

export interface SksUpdateCheckOptions {
  packageName?: string;
  currentVersion?: string;
  registry?: string;
  npmBin?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  refresh?: boolean;
  projectRoot?: string | null;
}

export interface SksUpdateStatusDependencies {
  inspectCodexCliUpdateImpl?: typeof inspectCodexCliUpdate;
  inspectSksMenuBarStatusImpl?: typeof inspectSksMenuBarStatus;
}

export interface SksUpdateStatusOptions extends SksUpdateCheckOptions {
  home?: string;
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
export interface SksLockedInstalledVersionProbeInput {
  packageName: string;
  npmBin: string | null;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SksLockedInstalledVersionObservation {
  ok: boolean;
  version: string | null;
  source: 'npm-global' | 'PATH' | null;
  npm_global_version: string | null;
  path_version: string | null;
  path_binary: string | null;
  errors: string[];
}

export interface SksUpdateNowOptions extends SksUpdateCheckOptions {
  version?: string | null;
  dryRun?: boolean;
  projectRoot?: string | null;
  json?: boolean;
  quiet?: boolean;
  /** @internal deterministic concurrency seam for the lock-boundary regression. */
  beforeOperationLock?: () => Promise<void>;
  /** @internal test-only seam; production observes npm-global/PATH after acquiring the update lock. */
  lockedInstalledVersionProbe?: (
    input: SksLockedInstalledVersionProbeInput
  ) => Promise<SksLockedInstalledVersionObservation>;
}

export interface SksUpdateNowStage {
  id: string;
  ok: boolean;
  status: string;
  detail?: Record<string, unknown>;
}

export interface SksUpdateVerification {
  id: 'version_match' | 'package_manifest' | 'path_version_match' | 'hooks_trusted' | 'skills_manifest' | 'sks_menubar_version';
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
  project_root: string;
  registry: string;
  global_root: string | null;
  install_code: number | null;
  old_version_doctor: PackageLocalDoctorRun | null;
  new_binary: string | null;
  new_version: string | null;
  installed_cli_resolution: InstalledCliResolution | null;
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
  project_root: string;
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
  return runSksUpdateStatusInternal(await canonicalizeUpdateProjectRootOption(options));
}

export async function runSksUpdateCheck(options: SksUpdateCheckOptions = {}): Promise<SksUpdateCheckResult> {
  const resolvedOptions = await canonicalizeUpdateProjectRootOption(options);
  let liveCheck: SksUpdateCheckResult | null = null;
  const status = await runSksUpdateStatusInternal({ ...resolvedOptions, refresh: resolvedOptions.refresh !== false }, (check) => { liveCheck = check; });
  const packageName = resolvedOptions.packageName || 'sneakoscope';
  const registry = canonicalUpdateRegistry(resolvedOptions.registry || DEFAULT_REGISTRY);
  const env = resolvedOptions.env || process.env;
  const npmBin = resolvedOptions.npmBin === undefined ? await which('npm') : resolvedOptions.npmBin;
  const capturedCheck = liveCheck as SksUpdateCheckResult | null;
  const effective = capturedCheck
    ? effectiveFromCheck(capturedCheck)
    : await detectEffectiveSksVersion({ ...resolvedOptions, packageName, registry, env, npmBin });
  return buildResult({
    packageName,
    current: status.sks.current || effective.current,
    effective,
    latest: status.sks.latest,
    registry,
    npmBin,
    projectRoot: resolvedOptions.projectRoot,
    commandRegistry: resolvedOptions.registry,
    error: capturedCheck?.error || (status.source === 'error' ? status.public_error || 'update status unavailable' : null)
  });
}

async function canonicalizeUpdateProjectRootOption<T extends SksUpdateCheckOptions>(options: T): Promise<T> {
  const registry = options.registry ? canonicalUpdateRegistry(options.registry) : null;
  if (!options.projectRoot && !registry) return options;
  return {
    ...options,
    ...(options.projectRoot ? { projectRoot: await canonicalUpdateProjectRoot(options.projectRoot) } : {}),
    ...(registry ? { registry } : {})
  };
}

async function canonicalUpdateProjectRoot(value: string): Promise<string> {
  const root = await canonicalFilesystemPath(value);
  if (root === path.parse(root).root) throw new Error('update_project_root_filesystem_root_refused');
  return root;
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
        ...(options.projectRoot == null ? {} : { root: options.projectRoot }),
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
  const registry = canonicalUpdateRegistry(options.registry || DEFAULT_REGISTRY);
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
  if (override) return buildResult({
    packageName,
    current,
    effective,
    latest: override,
    registry,
    npmBin,
    projectRoot: options.projectRoot,
    commandRegistry: options.registry
  });

  if (!npmBin) {
    return buildResult({
      packageName,
      current,
      effective,
      latest: null,
      registry,
      npmBin: null,
      projectRoot: options.projectRoot,
      commandRegistry: options.registry,
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
      projectRoot: options.projectRoot,
      commandRegistry: options.registry,
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
      projectRoot: options.projectRoot,
      commandRegistry: options.registry,
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
    npmBin,
    projectRoot: options.projectRoot,
    commandRegistry: options.registry
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
  'menubar_version_probe',
  'update_finalize_doctor',
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
  const registry = canonicalUpdateRegistry(options.registry || DEFAULT_REGISTRY);
  const env = options.env || process.env;
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const check = await runSksUpdateCheck({ ...options, packageName, registry, env, npmBin, refresh: true });
  const target = parseVersionText(options.version || '') || check.latest;
  const globalRoot = npmBin ? await detectNpmGlobalRoot(npmBin, env, options).catch(() => null) : null;
  const projectReceiptRoot = await canonicalUpdateProjectRoot(options.projectRoot || env.SKS_MUTATION_LEDGER_ROOT || process.cwd());
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
    expected_migrations: ['hook_trust_repair', 'global_skills_reconcile', 'native_capability_setup', 'update_finalize_doctor'],
    project_root: projectReceiptRoot,
    rollback_command: buildUpdateRollbackCommand(check.current, projectReceiptRoot, registry),
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
  const env = options.env || process.env;
  const projectReceiptRoot = await canonicalUpdateProjectRoot(options.projectRoot || env.SKS_MUTATION_LEDGER_ROOT || process.cwd());
  const registry = canonicalUpdateRegistry(options.registry || DEFAULT_REGISTRY);
  const authorization = await authorizeUpdateRollback({
    targetVersion: version,
    currentVersion,
    projectRoot: projectReceiptRoot,
    registry,
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
  const update = await runSksUpdateNowInternal(
    { ...options, version, registry: authorization.receipt.registry },
    authorization
  );
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
  return runSksUpdateNowInternal(options, null);
}

type AuthorizedRollback = Extract<UpdateRollbackAuthorization, { ok: true }>;

async function runSksUpdateNowInternal(
  options: SksUpdateNowOptions,
  rollbackAuthorization: AuthorizedRollback | null
): Promise<SksUpdateNowResult> {
  const packageName = options.packageName || 'sneakoscope';
  const registry = canonicalUpdateRegistry(options.registry || DEFAULT_REGISTRY);
  const env = options.env || process.env;
  const nestedProcessEnv = updateNestedProcessEnvironment(env);
  const npmBin = options.npmBin === undefined ? await which('npm') : options.npmBin;
  const cwd = env.HOME || os.homedir();
  let check = await runSksUpdateCheck({
    ...options,
    packageName,
    registry,
    npmBin,
    env
  });
  const requestedVersion = parseVersionText(options.version || '') || null;
  let installVersion = requestedVersion || check.latest;
  let npmArgs = installVersion ? sksGlobalInstallArgs(packageName, installVersion, registry) : [];
  let command = npmBin && npmArgs.length ? [npmBin, ...npmArgs].join(' ') : null;
  let globalRoot = npmBin ? await detectNpmGlobalRoot(npmBin, env, options).catch(() => null) : null;
  const projectReceiptRoot = await canonicalUpdateProjectRoot(options.projectRoot || env.SKS_MUTATION_LEDGER_ROOT || process.cwd());
  const stages: SksUpdateNowStage[] = [];
  let temporaryInstallSmoke: TemporaryInstallSmokeResult | null = null;
  await options.beforeOperationLock?.();
  const operationLock = await acquireUpdateOperationLock(env);
  if (!operationLock.ok) {
    stages.push({
      id: 'preflight',
      ok: false,
      status: 'blocked',
      detail: { reason: operationLock.blocker }
    });
    return buildUpdateNowResult({
      packageName,
      from: check.current,
      latest: check.latest,
      requestedVersion,
      installVersion,
      npmBin,
      npmArgs,
      command,
      cwd,
      projectRoot: projectReceiptRoot,
      registry,
      globalRoot,
      status: 'failed',
      ok: false,
      installCode: null,
      oldVersionDoctor: null,
      newBinary: null,
      newVersion: null,
      newVersionDoctor: null,
      projectReceipt: null,
      migrationCurrent: false,
      stages,
      error: operationLock.blocker
    });
  }
  let operation: UpdateOperationRecorder | null = null;
  let operationFinished = false;
  try {
  let activeRollbackAuthorization = rollbackAuthorization;
  let rollbackReauthorizationBlocker: string | null = null;
  try {
    const lockedProbeInput: SksLockedInstalledVersionProbeInput = {
      packageName,
      npmBin,
      env,
      timeoutMs: boundedLockedProbeTimeout(options.timeoutMs),
      maxOutputBytes: boundedLockedProbeOutput(options.maxOutputBytes)
    };
    const lockedObservation = normalizeLockedInstalledVersionObservation(
      await (options.lockedInstalledVersionProbe
        ? options.lockedInstalledVersionProbe(lockedProbeInput)
        : probeLockedInstalledSksVersion(lockedProbeInput))
    );
    if (!lockedObservation.ok || !lockedObservation.version) {
      stages.push({
        id: 'preflight',
        ok: false,
        status: 'blocked',
        detail: {
          reason: 'locked_installed_version_probe_failed',
          npm_global_version: lockedObservation.npm_global_version,
          path_version: lockedObservation.path_version,
          path_binary: lockedObservation.path_binary,
          errors: lockedObservation.errors
        }
      });
      return buildUpdateNowResult({
        packageName,
        from: check.current,
        latest: check.latest,
        requestedVersion,
        installVersion,
        npmBin,
        npmArgs,
        command,
        cwd,
        projectRoot: projectReceiptRoot,
        registry,
        globalRoot,
        status: 'failed',
        ok: false,
        installCode: null,
        oldVersionDoctor: null,
        newBinary: null,
        newVersion: null,
        newVersionDoctor: null,
        projectReceipt: null,
        migrationCurrent: false,
        stages,
        error: 'locked_installed_version_probe_failed'
      });
    }
    const lockedCandidates: SksVersionCandidate[] = [
      ...(lockedObservation.npm_global_version
        ? [{ version: lockedObservation.npm_global_version, source: `npm-global:${packageName}` }]
        : []),
      ...(lockedObservation.path_version && lockedObservation.path_binary
        ? [{ version: lockedObservation.path_version, source: `PATH:${lockedObservation.path_binary}` }]
        : [])
    ];
    check = buildResult({
      packageName,
      current: lockedObservation.version,
      effective: {
        current: lockedObservation.version,
        runtime_current: check.runtime_current,
        package_root_current: check.package_root_current,
        path_current: lockedObservation.path_version,
        npm_global_current: lockedObservation.npm_global_version,
        candidates: lockedCandidates,
        errors: lockedObservation.errors
      },
      latest: check.latest,
      registry,
      npmBin,
      projectRoot: options.projectRoot,
      commandRegistry: options.registry,
      error: check.error
    });
    installVersion = requestedVersion || check.latest;
    npmArgs = installVersion ? sksGlobalInstallArgs(packageName, installVersion, registry) : [];
    command = npmBin && npmArgs.length ? [npmBin, ...npmArgs].join(' ') : null;
    globalRoot = npmBin ? await detectNpmGlobalRoot(npmBin, env, options).catch(() => null) : null;
    if (rollbackAuthorization && installVersion) {
      const refreshed = await authorizeUpdateRollback({
        targetVersion: installVersion,
        currentVersion: check.current,
        projectRoot: projectReceiptRoot,
        registry,
        env,
        repairMissingPointer: true
      });
      if (refreshed.ok) activeRollbackAuthorization = refreshed;
      else rollbackReauthorizationBlocker = refreshed.blocker;
    }
  } catch (error) {
    throw error;
  }
  try {
    operation = await UpdateOperationRecorder.create({
      env,
      kind: options.dryRun ? 'update_dry_run' : rollbackAuthorization ? 'rollback' : 'update',
      fromVersion: check.current,
      targetVersion: installVersion,
      projectRoot: projectReceiptRoot,
      registry,
      publishLatest: !options.dryRun
    });
  } catch (error) {
    throw error;
  }
  const operationRecorder = operation;
  const quiet = options.quiet === true || /^(1|true)$/i.test(String(env.SKS_UPDATE_QUIET || ''));
  const machineOutput = quiet || options.json === true;
  const stageStart = (id: string, status: string) => {
    if (!machineOutput) cliUi.step(`▸ ${id} - ${status}`);
  };
  const stage = (id: string, ok: boolean, status: string, detail: Record<string, unknown> = {}) => {
    stages.push({ id, ok, status, detail });
    operationRecorder.recordStage(id, ok, status, detail);
    if (!machineOutput) cliUi.step(`${ok ? '✔' : '✖'} ${id} - ${status}`);
  };
  const durableStageIntent = async (id: string, status: string, detail: Record<string, unknown> = {}) => {
    operationRecorder.recordStage(id, false, status, detail);
    await operationRecorder.flush();
  };
  const finalize = async (
    result: SksUpdateNowResult,
    operationError: unknown = result.error
  ): Promise<SksUpdateNowResult> => {
    result.temporary_install_smoke = temporaryInstallSmoke;
    result.operation_receipt_path = operationRecorder.receiptPath;
    const finished = await operationRecorder.finish({
      state: result.status === 'terminal_uncertain'
        ? 'terminal_uncertain'
        : result.ok ? (activeRollbackAuthorization ? 'rolled_back' : 'succeeded') : 'failed',
      resultStatus: result.status,
      error: operationError
    });
    operationFinished = true;
    if (finished.state === 'terminal_uncertain' && result.status !== 'terminal_uncertain') {
      result.ok = false;
      result.status = 'terminal_uncertain';
      result.error = finished.public_error || 'rollback authorization commit failed';
    }
    const rollbackCommitted = finished.kind === 'update'
      && finished.state !== 'terminal_uncertain'
      && updateReceiptHasConfirmedGlobalInstall(finished);
    result.rollback = {
      available: rollbackCommitted,
      previous_version: check.current,
      command: buildUpdateRollbackCommand(check.current, projectReceiptRoot, registry),
      receipt_path: rollbackCommitted
        ? updateOperationLastInstallPath(projectReceiptRoot, env)
        : null
    };
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
      projectRoot: projectReceiptRoot,
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
      projectRoot: projectReceiptRoot,
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
      projectRoot: projectReceiptRoot,
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
  if (compareSemVer(installVersion, check.current) === -1 && !activeRollbackAuthorization) {
    stage('preflight', false, 'blocked', {
      reason: 'downgrade_requires_authorized_rollback',
      current_version: check.current,
      requested_version: installVersion
    });
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
      projectRoot: projectReceiptRoot,
      registry,
      globalRoot,
      status: 'failed',
      ok: false,
      installCode: null,
      oldVersionDoctor: null,
      newBinary: null,
      newVersion: null,
      newVersionDoctor: null,
      projectReceipt: null,
      migrationCurrent: false,
      stages,
      error: 'downgrade_requires_authorized_rollback'
    }));
  }
  if (rollbackAuthorization) {
    const authorizedReceipt = activeRollbackAuthorization?.receipt || rollbackAuthorization.receipt;
    const authorizationCurrent = parseVersionText(authorizedReceipt.target_version || '');
    const authorizationPrevious = parseVersionText(authorizedReceipt.previous_version || '');
    const authorizationProjectRoot = await canonicalUpdateProjectRoot(authorizedReceipt.project_root)
      .catch(() => null);
    const authorizationValid = rollbackReauthorizationBlocker === null
      && authorizationCurrent === check.current
      && authorizationPrevious === installVersion
      && authorizationProjectRoot === projectReceiptRoot
      && canonicalUpdateRegistry(authorizedReceipt.registry) === registry;
    if (!authorizationValid) {
      stage('preflight', false, 'blocked', {
        reason: rollbackReauthorizationBlocker || 'rollback_authorization_stale',
        authorized_current_version: authorizationCurrent,
        observed_current_version: check.current,
        authorized_previous_version: authorizationPrevious,
        requested_version: installVersion,
        authorized_project_root: authorizationProjectRoot,
        observed_project_root: projectReceiptRoot,
        authorized_registry: canonicalUpdateRegistry(authorizedReceipt.registry),
        observed_registry: registry
      });
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
        projectRoot: projectReceiptRoot,
        registry,
        globalRoot,
        status: 'failed',
        ok: false,
        installCode: null,
        oldVersionDoctor: null,
        newBinary: null,
        newVersion: null,
        newVersionDoctor: null,
        projectReceipt: null,
        migrationCurrent: false,
        stages,
        error: rollbackReauthorizationBlocker || 'rollback_authorization_stale'
      }));
    }
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
    let receipt = await writeProjectUpdateMigrationReceipt({
      root: projectReceiptRoot,
      source: 'update-now-current',
      fromVersion: check.current,
      blockers: [],
      warnings: ['package_already_current']
    }).catch(() => null);
    let migrationCurrent = isUpdateMigrationReceiptCurrent(receipt);
    recordMigrationReceiptStage(stage, 'hook_trust_repair', receipt, 'hook-trust-refresh');
    stage('project_receipt', migrationCurrent, migrationCurrent ? 'current' : 'failed', {
      root: projectReceiptRoot,
      receipt_status: receipt?.status || null,
      receipt_version: receipt?.sks_version || null,
      required_blockers: receipt?.required_blockers || [],
      optional_warnings: receipt?.optional_warnings || [],
      installation_epoch_sha256: receipt?.installation_epoch_sha256 || null
    });
    recordMigrationReceiptStage(stage, 'global_skills_reconcile', receipt, 'skills-reconcile');
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
    stage('menubar_version_probe', menuVerification.versionProbe.ok, menuVerification.versionProbe.status, menuVerification.versionProbe.detail);
    // The migration receipt above is the only mutator. Close with a read-only
    // Doctor so verification cannot silently repair its own evidence.
    const currentFinalizeDoctor = await runUpdateFinalizeDoctor({
      root: projectReceiptRoot,
      env: nestedProcessEnv,
      machineOutput
    });
    stage('update_finalize_doctor', currentFinalizeDoctor.ok, currentFinalizeDoctor.status, {
      entrypoint: currentFinalizeDoctor.entrypoint,
      args: currentFinalizeDoctor.args,
      exit_code: currentFinalizeDoctor.exit_code,
      timed_out: currentFinalizeDoctor.timed_out,
      required_blockers: currentFinalizeDoctor.required_blockers,
      optional_warnings: currentFinalizeDoctor.optional_warnings
    });
    const finalCurrentReceipt = await readProjectUpdateMigrationReceipt(projectReceiptRoot);
    if (finalCurrentReceipt) receipt = finalCurrentReceipt;
    migrationCurrent = isUpdateMigrationReceiptCurrent(receipt);
    stage('final_self_verification', migrationCurrent && menuVerification.ok && currentFinalizeDoctor.ok, migrationCurrent && menuVerification.ok && currentFinalizeDoctor.ok ? 'verified_current' : 'issues', {});
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
    const currentStageFailures = requiredUpdateStageFailures(stages, UPDATE_STAGE_ORDER);
    const currentOk = migrationCurrent
      && menuVerification.ok
      && currentFinalizeDoctor.ok
      && snapshotOk
      && currentStageFailures.length === 0
      && !currentMenuBarTerminalUncertain;
    const currentError = currentOk ? null : currentMenuBarTerminalUncertain
      ? 'Menu Bar launch or rollback completion could not be confirmed'
      : currentFinalizeDoctor.ok
        ? currentStageFailures.length
          ? `current-version repair verification failed: ${currentStageFailures.join(',')}`
          : 'current-version repair verification failed'
        : 'current-version repair verification failed: update_finalize_doctor';
    const currentOperationError = currentError && currentStageFailures.length
      ? requiredUpdateStageFailureError(
          currentError,
          stages,
          currentStageFailures,
          projectReceiptRoot
        )
      : currentError;
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
      projectRoot: projectReceiptRoot,
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
      error: currentError
    }), currentOperationError);
  }

  const oldDoctorTimeoutOverride = Number.parseInt(env.SKS_UPDATE_OLD_DOCTOR_TIMEOUT_MS || '', 10);
  const oldDoctorTimeoutMs = Number.isFinite(oldDoctorTimeoutOverride) && oldDoctorTimeoutOverride > 0
    ? oldDoctorTimeoutOverride
    : 60_000;
  let oldVersionDoctor: PackageLocalDoctorRun | null = null;
  if (env.SKS_UPDATE_SKIP_OLD_DOCTOR_PREFLIGHT === '1') {
    stage('preflight', true, 'skipped', { reason: 'SKS_UPDATE_SKIP_OLD_DOCTOR_PREFLIGHT=1' });
  } else {
    stageStart('preflight', 'running read-only migration preflight on current install');
    oldVersionDoctor = await updateHeartbeat(machineOutput, 'old-version doctor', runPackageLocalDoctor({
      root: projectReceiptRoot,
      args: ['doctor', '--profile', 'migration', '--machine-only', '--report-file', path.join(projectReceiptRoot, '.sneakoscope', 'update', 'old-version-doctor.json')],
      env: {
        ...nestedProcessEnv,
        ...(env.SKS_TEST_OLD_DOCTOR_FAIL === '1' ? { SKS_TEST_DOCTOR_FAIL: '1' } : {})
      },
      timeoutMs: oldDoctorTimeoutMs,
      maxOutputBytes: 32 * 1024
    }), 60_000);
    stage('preflight', true, oldVersionDoctor.ok ? oldVersionDoctor.status : 'failed_continuing', {
      doctor_ok: oldVersionDoctor.ok,
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
      projectRoot: projectReceiptRoot,
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
  await durableStageIntent('global_install', 'started', {
    command,
    target_version: installVersion
  });
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
  let installedCliResolution: InstalledCliResolution | null = null;
  let installedPackageIdentityOk = false;
  let newVersionDoctor: PackageLocalDoctorRun | null = null;
  let preDoctorReceipt: UpdateMigrationReceipt | null = null;
  let projectReceipt: UpdateMigrationReceipt | null = null;
  let migrationCurrent = false;
  let sksMenuBar: SksMenuBarInstallResult | null = null;
  let menubarVerified = process.platform !== 'darwin' || env.SKS_UPDATE_SKIP_SKS_MENUBAR === '1';
  if (installOk) {
    installedCliResolution = env.SKS_UPDATE_FAKE_INSTALL === '1'
      ? null
      : await inspectInstalledCliResolution({
        packageName,
        expectedVersion: installVersion,
        globalRoot,
        env,
        cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      });
    newBinary = env.SKS_UPDATE_FAKE_INSTALL === '1'
      ? path.resolve(env.SKS_UPDATE_FAKE_NEW_ENTRYPOINT || path.join(packageRoot(), 'dist', 'bin', 'sks.js'))
      : installedCliResolution?.entrypoint
        || await resolveInstalledSksEntrypoint({ packageName, globalRoot, env });
    installedPackageIdentityOk = env.SKS_UPDATE_FAKE_INSTALL === '1'
      ? Boolean(newBinary)
      : Boolean(
        newBinary
        && installedCliResolution?.manifest_name === packageName
        && installedCliResolution.manifest_version === installVersion
      );
    stage('resolve_new_binary', installedPackageIdentityOk, installedPackageIdentityOk ? 'resolved_exact_global_package' : 'missing_or_mismatched', {
      new_binary: newBinary,
      package_root: installedCliResolution?.package_root || null,
      manifest_name: installedCliResolution?.manifest_name || null,
      manifest_version: installedCliResolution?.manifest_version || null,
      path_binary: installedCliResolution?.path_binary || null,
      path_version_before_doctor: installedCliResolution?.path_version || null,
      blockers: installedCliResolution?.blockers || []
    });
    if (newBinary) {
      let versionProbeCode: number | null = installedCliResolution?.entrypoint_version ? 0 : 1;
      newVersion = installedCliResolution?.entrypoint_version || null;
      if (!newVersion) {
        const versionProbe = await runProcess(process.execPath, [newBinary, '--version'], {
          cwd,
          env: { ...env, SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_DISABLE_UPDATE_CHECK: '1' },
          timeoutMs: 5000,
          maxOutputBytes: 4096
        }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }));
        versionProbeCode = versionProbe.code;
        newVersion = parseVersionText(versionProbe.stdout || versionProbe.stderr || '') || null;
      }
      const exactVersion = compareSemVer(newVersion, installVersion) === 0;
      stage('version_probe', exactVersion, exactVersion ? 'exact_version_detected' : 'version_mismatch', {
        expected_version: installVersion,
        new_version: newVersion,
        code: versionProbeCode
      });
      if (installedPackageIdentityOk && exactVersion) {
        preDoctorReceipt = await readProjectUpdateMigrationReceipt(projectReceiptRoot);
        stageStart('new_version_doctor', 'running migration doctor on updated install');
        newVersionDoctor = await updateHeartbeat(machineOutput, 'new-version doctor', runPackageLocalDoctor({
          root: projectReceiptRoot,
          entrypoint: newBinary,
          args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', path.join(projectReceiptRoot, '.sneakoscope', 'update', 'new-version-doctor.json')],
          env: nestedProcessEnv,
          timeoutMs: updateDoctorTimeoutMs(env),
          maxOutputBytes: 32 * 1024
        }), 60_000);
        stage('new_version_doctor', newVersionDoctor.ok, newVersionDoctor.status, {
          entrypoint: newBinary,
          exit_code: newVersionDoctor.exit_code,
          timeout_ms: updateDoctorTimeoutMs(env),
          timed_out: newVersionDoctor.timedOut,
          required_blockers: newVersionDoctor.required_blockers
        });
      } else {
        stage('new_version_doctor', false, 'skipped_unverified_install_identity', {
          expected_version: installVersion,
          manifest_version: installedCliResolution?.manifest_version || null,
          entrypoint_version: newVersion
        });
      }
    } else {
      stage('version_probe', false, 'entrypoint_missing', { expected_version: installVersion });
      stage('new_version_doctor', false, 'skipped_entrypoint_missing', { expected_version: installVersion });
    }
    if (newBinary && newVersionDoctor?.ok) {
      const doctorReceipt = await readProjectUpdateMigrationReceipt(projectReceiptRoot);
      const doctorReceiptCurrent = isFreshDoctorMigrationReceipt({
        receipt: doctorReceipt,
        priorReceipt: preDoctorReceipt,
        expectedVersion: installVersion,
        root: projectReceiptRoot
      });
      const receiptResult = doctorReceiptCurrent
        ? { receipt: doctorReceipt, error: null, via: 'new_version_doctor' }
        : {
            receipt: doctorReceipt,
            error: 'new_version_doctor_receipt_missing_or_stale',
            via: 'new_version_doctor_receipt_required'
          };
      projectReceipt = receiptResult.receipt;
      migrationCurrent = isUpdateMigrationReceiptCurrent(projectReceipt, installVersion);
      recordMigrationReceiptStage(stage, 'hook_trust_repair', projectReceipt, 'hook-trust-refresh');
      stage('project_receipt', migrationCurrent, migrationCurrent ? 'current' : 'failed', {
        root: projectReceiptRoot,
        via: receiptResult.via,
        expected_version: installVersion,
        receipt_version: projectReceipt?.sks_version || null,
        required_blockers: projectReceipt?.required_blockers || [],
        optional_warnings: projectReceipt?.optional_warnings || [],
        error: receiptResult.error
      });
      recordMigrationReceiptStage(stage, 'global_skills_reconcile', projectReceipt, 'skills-reconcile');
      stage('native_capability_setup', migrationCurrent, migrationCurrent
        ? 'owned_by_new_version_doctor'
        : 'doctor_migration_not_current', {
        owner: 'new_version_doctor',
        doctor_status: newVersionDoctor.status,
        receipt_source: projectReceipt?.source || null,
        receipt_version: projectReceipt?.sks_version || null
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
        stage('menubar_version_probe', menuVerification.versionProbe.ok, menuVerification.versionProbe.status, menuVerification.versionProbe.detail);
      }
    }
  }
  // The new-version migration Doctor is the one post-install mutator. The
  // final Doctor is deliberately read-only so verification cannot mask a
  // failed or incomplete migration by changing the state it is checking.
  const finalizeDoctor = installOk && newBinary && installedPackageIdentityOk
    ? await runUpdateFinalizeDoctor({
      entrypoint: newBinary,
      root: projectReceiptRoot,
      env: nestedProcessEnv,
      machineOutput
    })
    : null;
  stage('update_finalize_doctor', finalizeDoctor?.ok === true, finalizeDoctor ? finalizeDoctor.status : 'skipped_install_failed', {
    ...(finalizeDoctor ? {
      entrypoint: finalizeDoctor.entrypoint,
      args: finalizeDoctor.args,
      exit_code: finalizeDoctor.exit_code,
      timed_out: finalizeDoctor.timed_out,
      required_blockers: finalizeDoctor.required_blockers,
      optional_warnings: finalizeDoctor.optional_warnings
    } : {})
  });
  if (finalizeDoctor) {
    const finalDoctorReceipt = await readProjectUpdateMigrationReceipt(projectReceiptRoot);
    if (finalDoctorReceipt) projectReceipt = finalDoctorReceipt;
    migrationCurrent = isUpdateMigrationReceiptCurrent(projectReceipt, installVersion);
  }
  if (installOk && installVersion && env.SKS_UPDATE_FAKE_INSTALL !== '1') {
    installedCliResolution = await inspectInstalledCliResolution({
      packageName,
      expectedVersion: installVersion,
      globalRoot,
      env,
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    });
  }
  const verification = await runFinalUpdateVerification({
    installOk,
    packageName,
    newBinary,
    installVersion,
    env,
    projectReceiptRoot,
    installedCliResolution
  });
  const verifyOk = verification.length > 0 && verification.every((item) => item.ok) && finalizeDoctor?.ok === true;
  if (verification.length) {
    stage('final_self_verification', verifyOk, verifyOk ? 'verified' : 'issues', {
      failed: [
        ...verification.filter((item) => !item.ok).map((item) => item.id),
        ...(finalizeDoctor?.ok === true ? [] : ['update_finalize_doctor'])
      ]
    });
  } else stage('final_self_verification', false, 'not_run', {});
  const snapshot = await runSksUpdateStatus(updateStatusOptionsFromNow(
    options,
    newVersion || check.current,
    {
      ...env,
      ...(env.SKS_UPDATE_FAKE_INSTALL === '1' && installVersion
        ? { SKS_INSTALLED_SKS_VERSION: installVersion }
        : {}),
      ...(installVersion ? { [versionOverrideEnvName(packageName)]: check.latest || installVersion } : {})
    }
  )).catch(() => null);
  const snapshotVersionOk = compareSemVer(snapshot?.sks.current || null, installVersion) === 0;
  const snapshotOk = snapshot?.schema === 'sks.update-status.v3'
    && snapshot.source !== 'error'
    && snapshotVersionOk;
  stage('snapshot_refresh', snapshotOk, snapshotOk ? snapshot!.source : snapshot?.source === 'error' ? 'failed' : 'resolved_version_mismatch', {
    current: snapshot?.sks.current || null,
    expected: installVersion,
    update_count: snapshot?.update_count ?? null,
    public_error: snapshot?.public_error || null
  });
  const executionStageIds = UPDATE_STAGE_ORDER.filter(
    (id) => !['update_finalize_doctor', 'final_self_verification', 'snapshot_refresh'].includes(id)
  );
  const executionStageFailures = requiredUpdateStageFailures(stages, executionStageIds);
  const allStageFailures = requiredUpdateStageFailures(stages, UPDATE_STAGE_ORDER);
  const installedCliOk = env.SKS_UPDATE_FAKE_INSTALL === '1'
    || installedCliResolution?.ok === true;
  const baseOk = installOk && Boolean(newBinary) && newVersionDoctor?.ok === true
    && installedCliOk && migrationCurrent && menubarVerified && executionStageFailures.length === 0;
  const ok = baseOk && verifyOk && snapshotOk;
  const menuBarTerminalUncertain = menuBarInstallIsTerminalUncertain(sksMenuBar);
  const terminalUncertain = install.timedOut === true || menuBarTerminalUncertain;
  const status: SksUpdateNowResult['status'] = terminalUncertain
    ? 'terminal_uncertain'
    : ok ? 'updated' : baseOk ? 'updated_with_issues' : 'failed';
  const stageFailureError = executionStageFailures.length
    ? requiredUpdateStageFailureError(
        `required update stages failed: ${executionStageFailures.join(',')}`,
        stages,
        executionStageFailures,
        projectReceiptRoot
      )
    : null;
  const resultError = terminalUncertain
    ? menuBarTerminalUncertain
      ? 'Menu Bar launch or rollback completion could not be confirmed'
      : 'global install timed out; package side-effect completion is uncertain'
    : ok ? null
      : stageFailureError
        ? stageFailureError.message
        : status === 'updated_with_issues'
          ? !snapshotOk
            ? `update status still resolves SKS ${snapshot?.sks.current || 'unknown'} instead of ${installVersion}`
            : verificationError(verification, finalizeDoctor)
          : updateNowError(install, newBinary, newVersionDoctor, migrationCurrent, installedCliResolution);
  const resultOperationError = stageFailureError
    || (resultError && allStageFailures.length
      ? requiredUpdateStageFailureError(
          resultError,
          stages,
          allStageFailures,
          projectReceiptRoot
        )
      : resultError);
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
    projectRoot: projectReceiptRoot,
    registry,
    globalRoot,
    status,
    ok,
    installCode: install.code,
    oldVersionDoctor,
    newBinary,
    newVersion,
    installedCliResolution,
    newVersionDoctor,
    projectReceipt,
    migrationCurrent,
    sksMenuBar,
    stages,
    verification,
    error: resultError
  }), resultOperationError);
  } catch (error) {
    if (operation && !operationFinished) {
      try {
        await operation.finish({
          state: 'failed',
          resultStatus: 'failed',
          error
        });
        operationFinished = true;
      } catch {
        await operation.flush().catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await operationLock.release();
  }
}

function requiredUpdateStageFailures(
  stages: SksUpdateNowStage[],
  requiredIds: readonly string[]
): string[] {
  return requiredIds.filter((id) => {
    const matches = stages.filter((stage) => stage.id === id);
    return matches.length !== 1 || matches[0]?.ok !== true;
  });
}

function requiredUpdateStageFailureError(
  message: string,
  stages: SksUpdateNowStage[],
  failedIds: readonly string[],
  projectRoot: string
): Error {
  for (const id of failedIds) {
    for (const stage of stages.filter((entry) => entry.id === id && entry.ok !== true)) {
      const rootCause = updateStageFailureDiagnostics(stage, projectRoot)[0];
      if (rootCause) return new Error(message, { cause: new Error(rootCause) });
    }
  }
  return new Error(message);
}

export function menuBarInstallIsTerminalUncertain(result: SksMenuBarInstallResult | null | undefined): boolean {
  return result?.status === 'terminal_uncertain'
    || result?.launch?.terminal_uncertain === true
    || result?.rollback?.status === 'terminal_uncertain';
}

async function runUpdateFinalizeDoctor(opts: {
  entrypoint?: string | null;
  root: string;
  env: NodeJS.ProcessEnv;
  machineOutput: boolean;
}): Promise<PackageLocalDoctorRun> {
  const env = opts.env.SKS_TEST_FINALIZE_DOCTOR_USER_CONFIG_PRESERVED === '1'
    ? {
        ...opts.env,
        SKS_TEST_DOCTOR_FAIL: undefined,
        SKS_TEST_DOCTOR_USER_CONFIG_PRESERVED: '1'
      }
    : opts.env.SKS_TEST_FINALIZE_DOCTOR_FAIL === '1'
      ? { ...opts.env, SKS_TEST_DOCTOR_FAIL: '1' }
      : opts.env;
  return updateHeartbeat(opts.machineOutput, 'update finalize doctor', runPackageLocalDoctor({
    root: opts.root,
    ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}),
    args: ['doctor', '--profile', 'migration', '--machine-only', '--report-file', path.join(opts.root, '.sneakoscope', 'update', 'update-finalize-doctor.json')],
    env,
    timeoutMs: updateDoctorTimeoutMs(env),
    maxOutputBytes: 32 * 1024
  }), 60_000);
}

function recordMigrationReceiptStage(
  stage: (id: string, ok: boolean, status: string, detail?: Record<string, unknown>) => void,
  updateStageId: 'hook_trust_repair' | 'global_skills_reconcile',
  receipt: UpdateMigrationReceipt | null,
  migrationStageId: 'hook-trust-refresh' | 'skills-reconcile'
): void {
  const matches = (receipt?.migration_stages || []).filter((entry) => entry.id === migrationStageId);
  const evidence = matches.length === 1 ? matches[0] : null;
  const ok = evidence?.ok === true;
  stage(updateStageId, ok, ok ? evidence.status : evidence?.status || 'migration_stage_missing', {
    via: 'project_migration_receipt',
    migration_stage_id: migrationStageId,
    receipt_source: receipt?.source || null,
    action_count: evidence?.action_count ?? null,
    blocker_count: evidence?.blocker_count ?? null,
    warning_count: evidence?.warning_count ?? null,
    match_count: matches.length
  });
}

function isFreshDoctorMigrationReceipt(input: {
  receipt: UpdateMigrationReceipt | null;
  priorReceipt: UpdateMigrationReceipt | null;
  expectedVersion: string;
  root: string;
}): boolean {
  const { receipt, priorReceipt } = input;
  if (!isUpdateMigrationReceiptCurrent(receipt, input.expectedVersion)) return false;
  if (!receipt || path.resolve(receipt.root) !== path.resolve(input.root)) return false;
  if (!String(receipt.source || '').startsWith('doctor-')) return false;
  if (!priorReceipt) return true;
  return receipt.generated_at !== priorReceipt.generated_at
    || receipt.source !== priorReceipt.source
    || receipt.installation_epoch_sha256 !== priorReceipt.installation_epoch_sha256;
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
  const pathSksPromise = executableOnInjectedPath('sks', env)
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

async function probeLockedInstalledSksVersion(
  input: SksLockedInstalledVersionProbeInput
): Promise<SksLockedInstalledVersionObservation> {
  const probeEnv: NodeJS.ProcessEnv = {
    ...input.env,
    SKS_DISABLE_UPDATE_CHECK: '1'
  };
  delete probeEnv.SKS_INSTALLED_SKS_VERSION;
  const npmGlobalPromise = input.npmBin
    ? detectNpmGlobalPackageVersion(input.npmBin, input.packageName, probeEnv, {
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes
    }).catch((error: unknown) => ({
      version: null,
      error: error instanceof Error ? error.message : String(error)
    }))
    : Promise.resolve({ version: null, error: 'npm_not_found' });
  const pathProbePromise = executableOnInjectedPath('sks', probeEnv)
    .then(async (binary) => {
      if (!binary) return { binary: null, version: null, error: 'path_sks_not_found' };
      const result = await runProcess(binary, ['--version'], {
        env: probeEnv,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes
      }).catch((error: unknown) => ({
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      }));
      const version = result.code === 0 ? parseVersionText(result.stdout || '') : null;
      return {
        binary,
        version,
        error: version
          ? null
          : `path_sks_version:${String(result.stderr || result.stdout || 'failed').trim().slice(-500)}`
      };
    })
    .catch((error: unknown) => ({
      binary: null,
      version: null,
      error: `path_sks_probe:${error instanceof Error ? error.message : String(error)}`
    }));
  const [npmGlobal, pathProbe] = await Promise.all([npmGlobalPromise, pathProbePromise]);
  const npmGlobalVersion = parseVersionText(npmGlobal.version || '');
  const pathVersion = parseVersionText(pathProbe.version || '');
  const authoritiesAgree = !npmGlobalVersion || !pathVersion || npmGlobalVersion === pathVersion;
  const version = authoritiesAgree ? npmGlobalVersion || pathVersion : null;
  return {
    ok: Boolean(version),
    version,
    source: npmGlobalVersion ? 'npm-global' : pathVersion ? 'PATH' : null,
    npm_global_version: npmGlobalVersion,
    path_version: pathVersion,
    path_binary: pathProbe.binary,
    errors: uniqueStrings([
      ...(npmGlobal.error ? [`npm_global_version:${String(npmGlobal.error).slice(-500)}`] : []),
      ...(pathProbe.error ? [pathProbe.error] : []),
      ...(authoritiesAgree
        ? []
        : [`locked_installed_version_authorities_disagree:${npmGlobalVersion}:${pathVersion}`])
    ])
  };
}

function normalizeLockedInstalledVersionObservation(
  value: SksLockedInstalledVersionObservation
): SksLockedInstalledVersionObservation {
  const npmGlobalVersion = parseVersionText(value?.npm_global_version || '');
  const pathVersion = parseVersionText(value?.path_version || '');
  const declaredVersion = parseVersionText(value?.version || '');
  const authoritiesAgree = !npmGlobalVersion || !pathVersion || npmGlobalVersion === pathVersion;
  const selectedVersion = value?.source === 'npm-global'
    ? npmGlobalVersion
    : value?.source === 'PATH'
      ? pathVersion
      : null;
  const valid = value?.ok === true
    && authoritiesAgree
    && Boolean(declaredVersion)
    && declaredVersion === selectedVersion;
  return {
    ok: valid,
    version: valid ? declaredVersion : null,
    source: valid ? value.source : null,
    npm_global_version: npmGlobalVersion,
    path_version: pathVersion,
    path_binary: typeof value?.path_binary === 'string' && value.path_binary ? value.path_binary : null,
    errors: uniqueStrings([
      ...(Array.isArray(value?.errors) ? value.errors.map((error) => String(error).slice(-500)) : []),
      ...(authoritiesAgree
        ? []
        : [`locked_installed_version_authorities_disagree:${npmGlobalVersion}:${pathVersion}`]),
      ...(valid ? [] : ['locked_probe_result_invalid'])
    ])
  };
}

function boundedLockedProbeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 2500;
  // The mutation timeout may intentionally be tiny in failure probes, but the
  // lock-held authority check must still allow a real npm/CLI process to start
  // under load. Keep it independently reliable while remaining bounded.
  return Math.max(2500, Math.min(10_000, Math.floor(value!)));
}

function boundedLockedProbeOutput(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8192;
  return Math.max(1024, Math.min(64 * 1024, Math.floor(value!)));
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
  projectRoot?: string | null | undefined;
  commandRegistry?: string | null | undefined;
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
    command: updateAvailable ? buildUpdateNowCommand(latest!, input.projectRoot, input.commandRegistry) : null,
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
  projectRoot: string;
  registry: string;
  globalRoot: string | null;
  status: SksUpdateNowResult['status'];
  ok: boolean;
  installCode: number | null;
  oldVersionDoctor: PackageLocalDoctorRun | null;
  newBinary: string | null;
  newVersion: string | null;
  installedCliResolution?: InstalledCliResolution | null;
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
    project_root: input.projectRoot,
    registry: input.registry,
    global_root: input.globalRoot,
    install_code: input.installCode,
    old_version_doctor: input.oldVersionDoctor,
    new_binary: input.newBinary,
    new_version: input.newVersion,
    installed_cli_resolution: input.installedCliResolution || null,
    new_version_doctor: input.newVersionDoctor,
    project_receipt: input.projectReceipt,
    migration_current: input.migrationCurrent,
    sks_menubar: input.sksMenuBar || null,
    stages: input.stages,
    verification: input.verification || [],
    temporary_install_smoke: null,
    operation_receipt_path: null,
    rollback: {
      available: false,
      previous_version: input.from,
      command: buildUpdateRollbackCommand(input.from, input.projectRoot, input.registry),
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
}): Promise<{
  ok: boolean;
  status: string;
  detail: Record<string, unknown>;
  versionProbe: { ok: boolean; status: string; detail: Record<string, unknown> };
}> {
  if (process.platform !== 'darwin' || input.env.SKS_UPDATE_SKIP_SKS_MENUBAR === '1') {
    const reason = process.platform !== 'darwin' ? 'not_macos' : 'SKS_UPDATE_SKIP_SKS_MENUBAR=1';
    return {
      ok: true,
      status: 'skipped',
      detail: { reason },
      versionProbe: {
        ok: true,
        status: 'skipped',
        detail: {
          running_version: null,
          running_pid: null,
          expected_version: input.expectedVersion,
          probe_ok: true,
          reason
        }
      }
    };
  }
  if (!input.install || input.install.ok === false) {
    const blockers = input.install?.blockers || ['menubar_install_missing'];
    return {
      ok: false,
      status: 'install_failed',
      detail: { blockers },
      versionProbe: {
        ok: false,
        status: 'install_failed',
        detail: {
          running_version: null,
          running_pid: null,
          expected_version: input.expectedVersion,
          probe_ok: false,
          blockers
        }
      }
    };
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
  const runningProcess = status?.running_process || input.install.running_process;
  const probe = status?.menubar_version_probe || input.install.menubar_version_probe;
  const launchExpected = input.install.launch?.requested === true;
  const restartDeferred = input.env.SKS_UPDATE_DEFER_MENUBAR_RESTART === '1';
  const runningVersion = runningProcess?.package_version || probe?.running_version || null;
  const runningPid = runningProcess?.pid || probe?.pid || null;
  const runningProcessOk = runningProcess?.ok === true && runningPid !== null;
  const runningVersionOk = runningVersion === input.expectedVersion;
  const probeOk = probe?.ok === true && runningProcessOk && runningVersionOk;
  const versionProbeOk = !launchExpected || probeOk;
  const versionProbeStatus = !launchExpected
    ? restartDeferred ? 'restart_deferred' : 'launch_not_requested'
    : !runningProcessOk
      ? 'running_process_missing'
      : !runningVersionOk
        ? 'running_version_mismatch'
        : probe?.ok !== true
          ? 'probe_failed'
          : 'verified';
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
    },
    versionProbe: {
      ok: versionProbeOk,
      status: versionProbeStatus,
      detail: {
        running_version: runningVersion,
        running_pid: runningPid,
        expected_version: input.expectedVersion,
        probe_ok: probeOk,
        launch_expected: launchExpected,
        restart_deferred: restartDeferred,
        probe_error: probe?.error || runningProcess?.error || null
      }
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
  packageName: string;
  newBinary: string | null;
  installVersion: string | null;
  env: NodeJS.ProcessEnv;
  projectReceiptRoot: string;
  installedCliResolution: InstalledCliResolution | null;
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

  if (input.installedCliResolution) {
    const resolution = input.installedCliResolution;
    verification.push({
      id: 'package_manifest',
      ok: resolution.manifest_name === input.packageName
        && resolution.manifest_version === input.installVersion
        && resolution.entrypoint === input.newBinary,
      detail: `expected ${input.packageName}@${input.installVersion}, got ${resolution.manifest_name || 'missing'}@${resolution.manifest_version || 'missing'} from ${resolution.package_root || 'missing'}`,
      remediation: `Run: npm install --global ${input.packageName}@${input.installVersion}`
    });
    verification.push({
      id: 'path_version_match',
      ok: resolution.path_version === input.installVersion && resolution.path_targets_entrypoint,
      detail: `expected PATH sks ${input.installVersion} at the verified entrypoint; got ${resolution.path_version || 'missing'} from ${resolution.path_binary || 'missing'} (exact target: ${resolution.path_targets_entrypoint ? 'yes' : 'no'})`,
      remediation: 'Remove or reorder the older SKS npm prefix on PATH, then rerun: sks update now'
    });
  }

  const hookState = await readCodexHookActualState(input.projectReceiptRoot).catch(() => null);
  const managedEntries = (hookState?.entries || []).filter((entry: any) => entry.managed === true);
  const untrusted = managedEntries.filter((entry: any) => entry.trust_status !== 'Trusted' && entry.trust_status !== 'Managed');
  verification.push({
    id: 'hooks_trusted',
    ok: Boolean(hookState && hookState.ok !== false && managedEntries.length > 0 && untrusted.length === 0),
    detail: untrusted.length ? untrusted.map((entry: any) => entry.key).slice(0, 3).join(', ') : `managed ${managedEntries.length}`,
    remediation: 'Run: sks codex trust-doctor --fix --managed --actual'
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

function verificationError(
  verification: SksUpdateVerification[],
  finalizeDoctor: PackageLocalDoctorRun | null
): string {
  const failed = [
    ...verification.filter((item) => !item.ok).map((item) => item.id),
    ...(finalizeDoctor?.ok === true ? [] : ['update_finalize_doctor'])
  ];
  return failed.length
    ? `update self-verification failed: ${failed.join(', ')}`
    : 'update self-verification did not run';
}

function updateNowError(
  install: { code: number | null; stdout: string; stderr: string },
  newBinary: string | null,
  newVersionDoctor: PackageLocalDoctorRun | null,
  migrationCurrent: boolean,
  installedCliResolution: InstalledCliResolution | null
): string {
  if (install.code !== 0) return `${install.stderr || install.stdout || 'npm global install failed'}`.trim();
  if (!newBinary) return 'new package-local sks binary could not be resolved after install';
  if (installedCliResolution && !installedCliResolution.ok) {
    return `installed SKS CLI resolution failed: ${installedCliResolution.blockers.join(', ') || 'unknown resolution blocker'}; PATH sks=${installedCliResolution.path_binary || 'missing'} version=${installedCliResolution.path_version || 'missing'}`;
  }
  if (!newVersionDoctor?.ok) return newVersionDoctor?.error || 'new-version global Doctor failed';
  if (!migrationCurrent) return 'project update migration receipt was not current';
  return 'update failed';
}

function effectiveInstalledVersion(candidates: SksVersionCandidate[]): string {
  const firstBySource = (source: string) => candidates.find((candidate) => candidate.source === source)?.version || null;
  const firstByPrefix = (prefix: string) => candidates.find((candidate) => candidate.source.startsWith(prefix))?.version || null;
  return firstBySource('env:SKS_INSTALLED_SKS_VERSION')
    || firstByPrefix('PATH:')
    || firstByPrefix('npm-global:')
    || firstBySource('runtime')
    || firstBySource('packageRoot:package.json')
    || highestPackageVersion(candidates.map((candidate) => candidate.version));
}

function highestPackageVersion(versions: Array<string | null | undefined>): string {
  return versions
    .filter((version): version is string => typeof version === 'string' && version.length > 0)
    .reduce((best, candidate) => comparePackageVersions(candidate, best) > 0 ? candidate : best, '0.0.0');
}
