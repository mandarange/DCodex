import path from 'node:path';
import fs from 'node:fs';
import { PACKAGE_VERSION, appendJsonlBounded, exists, nowIso, packageRoot, readJson, sksRoot, writeJsonAtomic } from '../fsx.js';
import { initProject } from '../init.js';
import { createMission, findLatestMission, missionDir, setCurrent, stateFile } from '../mission.js';
import { buildMadHighLaunchProfileNoWrite, madHighProfileName } from '../auto-review.js';
import { permissionGateSummary } from '../permission-gates.js';
import { createMadSksAuthorizationManifest, validateMadSksAuthorizationManifest } from '../mad-sks/authorization-manifest.js';
import { createMadSksAuditLedger, madSksAuditAction, writeMadSksAuditLedger } from '../mad-sks/audit-ledger.js';
import { compareProtectedCoreSnapshots, evaluateMadSksWrite, resolveProtectedCore, snapshotProtectedCore } from '../mad-sks/immutable-harness-guard.js';
import { buildMadSksPermissionModel, parseMadSksFlags } from '../mad-sks/permission-model.js';
import { createMadSksProofEvidence, writeMadSksProofEvidence } from '../mad-sks/proof-evidence.js';
import { createMadSksRollbackPlan, writeMadSksRollbackPlan } from '../mad-sks/rollback-plan.js';
import { runMadSksExecutor } from '../mad-sks/executors/index.js';
import { applyMadSksRollbackPlan } from '../mad-sks/rollback-apply.js';
import { repairCodexConfigEperm } from '../codex/codex-config-eperm-repair.js';
import { runCodexLaunchPreflight } from '../preflight/parallel-preflight-engine.js';
import { diffCodexAppUiSnapshots, writeCodexAppUiSnapshot } from '../codex-app/codex-app-ui-state-snapshot.js';
import { checkSksUpdateNotice } from '../update/update-notice.js';
import { writeCodex0138CapabilityArtifacts } from '../codex-control/codex-0138-capability.js';
import { writeCodex0139CapabilityArtifacts } from '../codex-control/codex-0139-capability.js';
import { resolveCodexNativeInvocationPlan } from '../codex-native/codex-native-invocation-router.js';
import { assertNonGlmMadRoute } from '../routes/model-mode-router.js';
import { evaluateGate } from '../stop-gate/gate-evaluator.js';
import {
  CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG,
  codexLbToolOutputRecoveryOverrideAcknowledged
} from '../codex-lb/codex-lb-tool-output-recovery.js';
import { writeMadNativeSession } from './mad-sks-headless.js';

const MAD_SKS_DEFAULT_TTL_MS = 10 * 60 * 1000;
// Compose unsupported flag names at runtime to keep retired option tokens out of packed dist.
const UNSUPPORTED_MAD_ARGUMENT_NAMES = new Set(
  [
    'naruto',
    'agent',
    'clones',
    'mad-db',
    'mad-native-swarm',
    'mad-swarm',
    'no-swarm',
    'no-mad-swarm',
    'mad-agents',
    'mad-swarm-agents',
    'mad-swarm-work-items',
    'mad-swarm-backend',
    'mad-swarm-prompt',
    'tmux-smoke',
    'require-tmux-smoke'
  ].map((name) => `--${name}`)
);

export async function madHighCommand(args: any = [], deps: any = {}) {
  const rawArgsForHelp = (args || []).map((arg: any) => String(arg));
  // 20차 P2-2: --help previously fell through to the full MAD launch flow
  // below (dependency checks, update prompts) with the flag simply ignored
  // — `sks mad-sks --help` took ~22s instead of printing usage. Must exit
  // before any of that work starts.
  if (rawArgsForHelp.includes('--help') || rawArgsForHelp.includes('-h')) {
    const usage = [
      'Usage: sks mad-sks [subcommand] [flags]',
      '',
      `Subcommands: ${MAD_SKS_COMMAND_SURFACE.join(', ')}`,
      '',
      'With no subcommand, prepares the scoped MAD-SKS permission state for the current base Codex CLI session.',
      'Bare `sks mad-sks --json` prints the launch profile and exits without launching.',
      '`sks mad-sks <subcommand> --help` shows this same summary — per-subcommand help is not yet implemented; see docs/mad-sks.md and docs/mad-sks-rollback.md for flag reference.'
    ].join('\n');
    if (rawArgsForHelp.includes('--json')) {
      console.log(JSON.stringify({ schema: 'sks.mad-sks-help.v1', ok: true, usage, command_surface: [...MAD_SKS_COMMAND_SURFACE] }, null, 2));
    } else {
      console.log(usage);
    }
    return { schema: 'sks.mad-sks-help.v1', ok: true, usage, command_surface: [...MAD_SKS_COMMAND_SURFACE] };
  }
  const argumentErrors = findUnsupportedMadArgumentErrors(rawArgsForHelp);
  if (argumentErrors.length) {
    const result = {
      schema: 'sks.mad-sks-argument-error.v1',
      ok: false,
      status: 'blocked',
      argument_errors: argumentErrors,
      blockers: argumentErrors,
      hint: 'Use `sks mad-sks --help` for the current command surface.'
    };
    process.exitCode = 1;
    if (rawArgsForHelp.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.error('SKS MAD argument error.');
      for (const error of argumentErrors) console.error(`- ${error}`);
    }
    return result;
  }
  const subcommand = firstSubcommand(args);
  if (subcommand) return madSksSubcommand(subcommand, args.filter((arg: any) => String(arg) !== subcommand));

  const rawArgs = (args || []).map((arg: any) => String(arg));
  const retiredGlmFlagBlockers = findRetiredGlmMadFlagBlockers(rawArgs);
  if (retiredGlmFlagBlockers.length) {
    const result = {
      ok: false,
      status: 'blocked',
      blockers: retiredGlmFlagBlockers,
      hint: 'GLM MAD CLI was removed. Use SKS Center Providers or sks codex-app use-openrouter --model <id>.'
    };
    if (rawArgs.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.error('SKS MAD launch blocked: retired GLM MAD flags are no longer supported.');
      for (const blocker of retiredGlmFlagBlockers) console.error(`- ${blocker}`);
    }
    process.exitCode = 1;
    return result;
  }
  assertNonGlmMadRoute(rawArgs.includes('--mad') ? rawArgs : ['--mad', ...rawArgs]);
  const cleanArgs = stripMadLaunchOnlyArgs(args);
  const dryRun = rawArgs.includes('--dry-run');
  if (rawArgs.includes('--json') && !dryRun) {
    const profile = buildMadHighLaunchProfileNoWrite();
    return console.log(JSON.stringify(profile, null, 2));
  }
  const launchRoot = process.cwd();
  if (!(await exists(path.join(launchRoot, '.sneakoscope')))) await initProject(launchRoot, {});
  await cleanupExpiredMadSks(launchRoot);
  if (dryRun) {
    const report = {
      schema: 'sks.mad-sks-native-dry-run.v1',
      ok: true,
      status: 'dry_run',
      generated_at: nowIso(),
      launch_skipped: true,
      execution_surface: 'base-codex-cli'
    };
    await writeJsonAtomic(path.join(launchRoot, '.sneakoscope', 'reports', 'mad-sks-native-dry-run.json'), report);
    if (rawArgs.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log('SKS MAD dry-run: base Codex CLI launch is ready.');
    return report;
  }
  const codexUpdate: any = { status: 'deferred_background', reason: 'update_prompt_deferred_until_after_native_session' };
  if (codexUpdate.status === 'failed' || codexUpdate.status === 'updated_not_reflected') {
    console.error(`Codex CLI update failed: ${codexUpdate.error || 'updated version was not visible on PATH'}`);
    process.exitCode = 1;
    return;
  }
  const profile = buildMadHighLaunchProfileNoWrite();
  const uiSnapshotId = Date.now().toString(36);
  const strictUiSnapshot = process.env.SKS_MAD_STRICT_UI_SNAPSHOT === '1';
  const beforeUi = strictUiSnapshot ? await writeCodexAppUiSnapshot(launchRoot, `mad-before-${uiSnapshotId}`).catch(() => null) : null;
  // launchFast skips the redundant live-`codex exec` config probe (up to ~20s, run
  // up to 3x via repair re-inspections): the real codex profile is exercised moments
  // later in the base Codex session. All filesystem/permission/EPERM/symlink/ACL
  // readability + repair checks still run. SKS_LAUNCH_FULL_CODEX_PROBE=1 restores the
  // old behavior.
  const allowMadRepair = rawArgs.includes('--repair-config') || rawArgs.includes('--fix') || rawArgs.includes('--yes-repair');
  const allowUnverifiedToolOutputRecovery = codexLbToolOutputRecoveryOverrideAcknowledged({ args: rawArgs });
  const launchPreflightOpts = {
    fix: allowMadRepair,
    launchFast: process.env.SKS_LAUNCH_FULL_CODEX_PROBE !== '1',
    profile: profile.profile_name,
    sandbox: 'danger-full-access',
    serviceTier: 'fast',
    skipCodexLbToolOutputRecovery: false,
    allowUnverifiedToolOutputRecovery
  };
  let launchPreflight = await runCodexLaunchPreflight(launchRoot, launchPreflightOpts);
  // Fresh-project bootstrap: when the ONLY blocker is that the managed Codex config does
  // not exist yet (`.codex/config.toml` absent), regenerate it — exactly what the blocker
  // action tells the user to run via `sks doctor --fix` — and re-run the preflight once,
  // instead of blocking the launch on a trivially-fixable missing config. An EXISTING but
  // unreadable/broken config is NOT auto-fixed here: it still blocks and routes the user
  // to `sks doctor --fix`, so genuine permission/EPERM/parse problems are never masked.
  if (!launchPreflight.ok && !fs.existsSync(path.join(launchRoot, '.codex', 'config.toml'))) {
    try {
      await initProject(launchRoot, { installScope: rawArgs.includes('--local-only') ? 'project' : 'global', localOnly: rawArgs.includes('--local-only'), globalCommand: 'sks' });
      console.error('SKS MAD bootstrapped the missing managed Codex config (`sks doctor --fix` equivalent) and re-ran preflight.');
      launchPreflight = await runCodexLaunchPreflight(launchRoot, launchPreflightOpts);
    } catch (bootstrapErr: any) {
      console.error(`SKS MAD could not bootstrap the managed Codex config: ${bootstrapErr?.message || bootstrapErr}. Run \`sks doctor --fix\`.`);
    }
  }
  const afterPreflightUi = beforeUi ? await writeCodexAppUiSnapshot(launchRoot, `mad-after-preflight-${uiSnapshotId}`).catch(() => null) : null;
  const preflightUiDiff = beforeUi && afterPreflightUi ? diffCodexAppUiSnapshots(beforeUi, afterPreflightUi) : null;
  if (preflightUiDiff && !preflightUiDiff.ok) {
    await writeJsonAtomic(path.join(launchRoot, '.sneakoscope', 'reports', 'mad-codex-app-ui-preflight-diff.json'), preflightUiDiff);
    console.error('SKS MAD launch changed Codex App UI state during preflight. Run `sks doctor --fix`.');
    process.exitCode = 1;
    return preflightUiDiff;
  }
  if (!launchPreflight.ok) {
    console.error('SKS MAD launch blocked by config preflight.');
    for (const blocker of launchPreflight.blockers || []) console.error(`- blocker: ${blocker}`);
    for (const action of launchPreflight.operator_actions || []) console.error(`- action: ${action}`);
    process.exitCode = 1;
    return launchPreflight;
  }
  const madLaunch = await activateMadPermissionState(process.cwd(), args);
  const launchLifecycleTasks: Promise<unknown>[] = [...(madLaunch.lifecycle_tasks || [])];
  try {
  const updateNotice = {
    schema: 'sks.update-notice.v1',
    checked_at: nowIso(),
    package_name: deps.packageName || 'sneakoscope',
    current_version: deps.packageVersion || PACKAGE_VERSION,
    latest_version: null,
    update_available: false,
    source: 'deferred_background',
    cache_ttl_ms: 0,
    message: 'SKS update notice refresh deferred until after native session preparation.'
  };
  const updateNoticePromise = checkSksUpdateNotice({
    packageName: deps.packageName || 'sneakoscope',
    currentVersion: deps.packageVersion || PACKAGE_VERSION,
    missionDir: madLaunch.dir
  }).then((notice: any) => appendJsonlBounded(path.join(madLaunch.dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.update_notice_refreshed_background', non_blocking: true, update_available: notice.update_available === true, source: notice.source })).catch((err: any) => appendJsonlBounded(path.join(madLaunch.dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.update_notice_background_failed', error: err?.message || String(err) }));
  launchLifecycleTasks.push(updateNoticePromise);
  await appendJsonlBounded(path.join(madLaunch.dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.update_notice_checked', non_blocking: true, update_available: updateNotice.update_available === true, source: updateNotice.source });
  console.log(`SKS MAD ready: ${madHighProfileName()} | gate ${madLaunch.mission_id}`);
  if (updateNotice.update_available === true) console.log(`SKS update notice: ${updateNotice.latest_version} available (non-blocking).`);
  console.log('Scoped high-power maintenance authority active; add explicit --allow-* flags for packages, services, network, browser/Computer Use, generated assets, file permissions, or system/admin scopes. SQL-plane execution is available through MAD-SKS sql-plane and still requires control-plane denial, read-back proof, and read-only restoration.');
  const explicitWorkspace = readOption(cleanArgs, '--workspace', readOption(cleanArgs, '--session', null));
  const workspace = explicitWorkspace || `sks-mad-${madLaunch.mission_id}`;
  const launch = await writeMadNativeSession(madLaunch, workspace);
  console.log('MAD permission state is ready in the current base Codex CLI session.');
  return launch;
  } finally {
    await settleMadLaunchLifecycle(launchLifecycleTasks, madLaunch.dir);
  }
}

export async function settleMadLaunchLifecycle(tasks: Promise<unknown>[], dir: string) {
  if (tasks.length === 0) return;
  const settled = await Promise.allSettled(tasks);
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'mad_sks.launch_lifecycle_settled',
    task_count: settled.length,
    fulfilled_count: settled.filter((row) => row.status === 'fulfilled').length,
    rejected_count: settled.filter((row) => row.status === 'rejected').length
  }).catch(() => undefined);
}

function missionDirLike(root: string, missionId: string) {
  return path.join(root, '.sneakoscope', 'missions', missionId);
}

async function activateMadPermissionState(cwd: any = process.cwd(), args: any[] = []) {
  const root = await sksRoot();
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const rawArgs = (args || []).map((arg: any) => String(arg));
  const activatedBy = 'sks --mad';
  const flags = parseMadSksFlags(['--mad-sks', ...args].filter(Boolean));
  const permission = buildMadSksPermissionModel({ targetRoot: cwd, userIntent: `${activatedBy} native Codex scoped high-power maintenance session`, flags });
  const allowedScopes = new Set(permission.allowed_scopes || []);
  const has = (scope: string) => allowedScopes.has(scope as any);
  const dbWriteAllowed = has('db_write');
  const { id, dir } = await createMission(root, { mode: 'mad-sks', prompt: `${activatedBy} native Codex scoped high-power maintenance session` });
  const protectedCore = resolveProtectedCore({ packageRoot: packageRoot(), targetRoot: cwd });
  // The interactive launch 'before' snapshot is only persisted (env + policy json)
  // and is never compared against an 'after' snapshot during the session, so the
  // strong full-content hash is wasted here. Use the cheap metadata digest (no file
  // reads) on the launch hot path. run/apply and the release gates still take their
  // own strong content snapshots where the digest is actually compared.
  const protectedCoreBefore = await snapshotProtectedCore(packageRoot(), 'mad-live-before', { mode: 'metadata' });
  const protectedCorePolicyPath = path.join(dir, 'mad-sks-protected-core-policy.json');
  const protectedCoreBeforePath = path.join(dir, 'mad-sks-live-protected-core-before.json');
  await writeJsonAtomic(protectedCorePolicyPath, {
    schema: 'sks.mad-sks-live-protected-core-policy.v1',
    generated_at: nowIso(),
    target_root: path.resolve(cwd || process.cwd()),
    protected_core: protectedCore,
    immutable_harness_guard: 'always_on'
  });
  await writeJsonAtomic(protectedCoreBeforePath, protectedCoreBefore);
  const gate = {
    schema_version: 1,
    passed: false,
    mad_sks_permission_active: true,
    permissions_deactivated: false,
    authority_concept: 'user_authorized_general_permission_widening',
    target_file_writes_allowed: has('target_files'),
    shell_commands_allowed: has('shell'),
    package_install_allowed: has('package_install'),
    service_control_allowed: has('service_control'),
    network_operations_allowed: has('network'),
    computer_use_allowed: has('computer_use'),
    browser_use_allowed: has('browser_use'),
    generated_asset_edits_allowed: has('generated_assets'),
    file_permission_changes_allowed: has('file_permissions'),
    live_server_writes_allowed: has('service_control') || has('system'),
    supabase_mcp_schema_cleanup_allowed: dbWriteAllowed,
    direct_execute_sql_allowed: dbWriteAllowed,
    normal_db_writes_allowed: dbWriteAllowed,
    migration_apply_allowed: dbWriteAllowed,
    sql_plane: {
      requested: false,
      capability_id: null,
      operation_classes: [],
      read_back_passed: false,
      profile_closed: false
    },
    catastrophic_safety_guard_active: true,
    permission_profile: permissionGateSummary(),
    permission_model: permission,
    protected_core_policy: protectedCorePolicyPath,
    protected_core_before: protectedCoreBeforePath,
    protected_core_digest: protectedCoreBefore.digest,
    expires_at: new Date(Date.now() + MAD_SKS_DEFAULT_TTL_MS).toISOString(),
    codex_native_invocation_plan: {
      selected_strategy: 'message-role-fallback',
      hook_evidence_policy: 'background-verification-do-not-count-until-refreshed',
      blockers: [],
      warnings: ['native_invocation_plan_deferred_until_after_ui'],
      artifact_path: 'mad-codex-native-invocation.json'
    },
    activated_by: activatedBy,
    cwd: path.resolve(cwd || process.cwd())
  };
  await writeJsonAtomic(path.join(dir, 'mad-sks-gate.json'), gate);
  await writeJsonAtomic(path.join(dir, 'route-context.json'), { route: 'MadSKS', command: '$MAD-SKS', mode: 'MADSKS', task: gate.activated_by, mad_sks_authorization: true, mad_sks_authority_concept: gate.authority_concept, execution_surface: 'base-codex-cli', permission_profile: gate.permission_profile, permission_model: permission });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.native_permission_opened', route: 'MadSKS', live_server_writes_allowed: gate.live_server_writes_allowed, allowed_scopes: permission.allowed_scopes, catastrophic_safety_guard_active: true });
  await setCurrent(root, {
    mission_id: id,
    route: 'MadSKS',
    route_command: '$MAD-SKS',
    mode: 'MADSKS',
    phase: 'MADSKS_NATIVE_PERMISSION_ACTIVE',
    questions_allowed: false,
    implementation_allowed: true,
    mad_sks_active: true,
    mad_sks_modifier: true,
    mad_sks_authority_concept: gate.authority_concept,
    mad_sks_gate_file: 'mad-sks-gate.json',
    mad_sks_gate_ready: true,
    mad_sks_protected_core_policy: protectedCorePolicyPath,
    mad_sks_protected_core_digest: protectedCoreBefore.digest,
    live_server_writes_allowed: gate.live_server_writes_allowed,
    supabase_mcp_schema_cleanup_allowed: gate.supabase_mcp_schema_cleanup_allowed,
    direct_execute_sql_allowed: gate.direct_execute_sql_allowed,
    normal_db_writes_allowed: gate.normal_db_writes_allowed,
    migration_apply_allowed: gate.migration_apply_allowed,
    catastrophic_safety_guard_active: true,
    permission_profile: gate.permission_profile,
    permission_model: permission,
    stop_gate: 'mad-sks-gate.json',
    prompt: gate.activated_by
  });
  const nativeArtifactsPromise = refreshMadNativeLaunchArtifacts(root, id, dir)
    .catch((err: any) => appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.native_artifact_background_failed', error: err?.message || String(err) }));
  return { mission_id: id, dir, gate, root, lifecycle_tasks: [nativeArtifactsPromise] };
}

async function refreshMadNativeLaunchArtifacts(root: string, missionId: string, dir: string) {
  await writeCodex0138CapabilityArtifacts(root, { missionId }).catch(() => null);
  await writeCodex0139CapabilityArtifacts(root, { missionId }).catch(() => null);
  const codexNativeInvocation = await resolveCodexNativeInvocationPlan({
    root,
    missionId,
    route: '$MAD',
    desiredCapability: 'hook-evidence'
  }).catch(() => null);
  if (codexNativeInvocation) await writeJsonAtomic(path.join(dir, 'mad-codex-native-invocation.json'), codexNativeInvocation).catch(() => undefined);
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.native_artifacts_refreshed_background', ok: Boolean(codexNativeInvocation) });
}

function baseMadLaunchOnlyFlags() {
  return new Set([
    '--mad',
    '--MAD',
    '--mad-sks',
    '--glm',
    '--high',
    '--allow-system',
    '--allow-db-write',
    '--allow-package-install',
    '--allow-service-control',
    '--allow-admin',
    '--allow-sudo',
    '--allow-network',
    '--allow-computer-use',
    '--allow-browser',
    '--allow-browser-use',
    '--allow-generated-assets',
    '--allow-file-permissions',
    '--allow-chmod',
	    '--allow-delete',
    '--confirm-delete',
    '--confirm-destructive-delete',
    '--repair-config',
    '--fix',
    '--yes-repair',
    '--yes',
    '-y',
    '--dry-run',
    '--plan-only',
	    '--ack',
    CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG
  ]);
}

function retiredGlmMadFlags() {
  return new Set([
    '--glm',
    '--deep',
    '--xhigh',
    '--strict',
    '--trace',
    '--ttft',
    '--exact-provider',
    '--bench'
  ]);
}

function madLaunchOnlyFlags() {
  return baseMadLaunchOnlyFlags();
}

function madLaunchValueFlags() {
  return new Set([
	    '--ack'
  ]);
}

export function findRetiredGlmMadFlagBlockers(args: readonly string[] = []): readonly string[] {
  const blockers: string[] = [];
  const retired = retiredGlmMadFlags();
  for (const arg of args) {
    const name = String(arg).includes('=') ? String(arg).slice(0, String(arg).indexOf('=')) : String(arg);
    if (retired.has(name)) blockers.push(`retired_glm_mad_flag:${name}`);
  }
  return blockers;
}

/** @deprecated Prefer findRetiredGlmMadFlagBlockers */
export function findGlmOnlyMadFlagBlockers(args: readonly string[] = [], _glmMadLaunch = false): readonly string[] {
  return findRetiredGlmMadFlagBlockers(args);
}

export function findUnsupportedMadArgumentErrors(args: readonly unknown[] = []): readonly string[] {
  const errors: string[] = [];
  for (const value of args) {
    const arg = String(value);
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (UNSUPPORTED_MAD_ARGUMENT_NAMES.has(name)) errors.push(`unsupported_argument:${name}`);
  }
  return [...new Set(errors)];
}

export function stripMadLaunchOnlyArgs(args: any[] = [], _opts: { readonly includeGlmFlags?: boolean } = {}) {
  const flags = madLaunchOnlyFlags();
  const valueFlags = madLaunchValueFlags();
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (!flags.has(arg)) {
      out.push(arg);
      continue;
    }
    if (valueFlags.has(arg) && args[i + 1] && !String(args[i + 1]).startsWith('--')) i += 1;
  }
  return out;
}

function readOption(args: any, name: any, fallback: any) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

export async function madSksFixture(root: any) {
  const { id, dir } = await createMission(root, { mode: 'mad-sks', prompt: '$MAD-SKS fixture permission gate' });
  await writeCodex0138CapabilityArtifacts(root, { missionId: id }).catch(() => null);
  await writeCodex0139CapabilityArtifacts(root, { missionId: id }).catch(() => null);
  const gate = {
    schema_version: 1,
    passed: false,
    execution_class: 'mock_fixture',
    mad_sks_permission_active: false,
    permissions_deactivated: false,
    catastrophic_safety_guard_active: true,
    permission_profile: permissionGateSummary(),
    fixture: true,
    blockers: ['mad_sks_fixture_mode_cannot_claim_real']
  };
  await writeJsonAtomic(path.join(dir, 'mad-sks-gate.json'), gate);
  return { mission_id: id, dir, gate };
}

const MAD_SKS_COMMAND_SURFACE = Object.freeze([
  'plan',
  'run',
  'apply',
  'sql',
  'apply-migration',
  'doctor',
  'status',
  'close',
  'revoke',
  'permissions',
  'proof',
  'repair-config',
  'rollback-plan',
  'rollback-apply',
  'audit',
  'explain'
]);

async function madSksSubcommand(subcommand: string, args: any[] = []) {
  const json = args.includes('--json');
  const targetRoot = path.resolve(readOption(args, '--target-root', process.cwd()));
  const userIntent = readOption(args, '--intent', 'MAD-SKS user-authorized maintenance');
  const sqlPlaneSubcommand = subcommand === 'sql' || subcommand === 'apply-migration';
  // --allow-db-write scope is implied by choosing the sql/apply-migration
  // subcommand itself, but --yes (explicit destructive-action confirmation)
  // must come from the caller's actual args — auto-injecting it here used to
  // silently satisfy guard-middleware's high_risk_confirmation_required check
  // for every sql/apply-migration call regardless of user intent (20차 P0-10).
  const flags = parseMadSksFlags([
    '--mad-sks',
    subcommand === 'plan' ? '--plan-only' : '',
    ...(sqlPlaneSubcommand ? ['--allow-db-write'] : []),
    ...args
  ].filter(Boolean));
  const permission = buildMadSksPermissionModel({ targetRoot, userIntent, flags });
  const root = await sksRoot();
  await cleanupExpiredMadSks(root);

  if (subcommand === 'permissions') {
    const protectedCore = resolveProtectedCore({ packageRoot: packageRoot(), targetRoot });
    return emit({
      schema: 'sks.mad-sks-permissions.v1',
      ok: true,
      command_surface: [...MAD_SKS_COMMAND_SURFACE],
      permission_flags: [
        '--mad-sks',
        '--allow-system',
        '--allow-db-write',
        '--allow-package-install',
        '--allow-service-control',
        '--allow-admin',
        '--allow-network',
        '--allow-computer-use',
        '--allow-browser-use',
        '--allow-generated-assets',
        '--allow-file-permissions',
        '--allow-delete',
        '--confirm-delete'
      ],
      permission_model: permission,
      protected_core: protectedCore,
      protected_core_immutable: !protectedCore.engine_source_exception,
      protected_core_write_allowed: protectedCore.engine_source_exception
    }, json);
  }

  if (subcommand === 'explain') {
    return emit({
      schema: 'sks.mad-sks-explain.v1',
      ok: true,
      summary: 'MAD-SKS is a user-authorized general permission widening mode and the SQL-plane execution route. Target project work can be widened by explicit flags, while SQL-plane work runs through the sql-plane executor with mission-bound capability/profile/read-back safeguards and SKS harness/package/dist/scripts/schemas/release metadata remain immutable protected core.',
      command_surface: [...MAD_SKS_COMMAND_SURFACE],
      catastrophic_safeguards: permission.forbidden_scopes,
      immutable_harness_guard: 'installed_harness_only_with_engine_source_exception'
    }, json);
  }

  if (subcommand === 'doctor' || subcommand === 'status') {
    const protectedCore = resolveProtectedCore({ packageRoot: packageRoot(), targetRoot });
    const before = await snapshotProtectedCore(packageRoot(), 'status');
    const statusMissionId = await findLatestMission(root, { mode: 'mad-sks', route: '$MAD-SKS', gateFile: 'mad-sks-gate.json' });
    const gateVerdict = statusMissionId
      ? await evaluateGate(root, statusMissionId, 'mad-sks-gate.json')
      : await evaluateGate(root, 'no-mission', 'mad-sks-gate.json');
    if (!json) console.log(gateVerdict.verdict);
    return emit({
      schema: subcommand === 'doctor' ? 'sks.mad-sks-doctor.v1' : 'sks.mad-sks-status.v1',
      ok: true,
      target_root: targetRoot,
      permission_model: permission,
      protected_core: protectedCore,
      protected_core_snapshot: before,
      protected_core_immutable: !protectedCore.engine_source_exception,
      protected_core_write_allowed: protectedCore.engine_source_exception,
      permission_active: false,
      mission_id: statusMissionId,
      gate_verdict: gateVerdict
    }, json);
  }

  if (subcommand === 'close' || subcommand === 'revoke') {
    return closeMadSks(root, args, json, subcommand);
  }

  if (subcommand === 'repair-config') {
    const apply = args.includes('--apply') || args.includes('--yes');
    const dryRun = args.includes('--dry-run') || !apply;
    const codexBin = readOption(args, '--codex-bin', process.env.SKS_DOCTOR_CODEX_BIN || '');
    const repair = await repairCodexConfigEperm(targetRoot, {
      fix: apply,
      codexProbe: true,
      actualCodex: true,
      requireActualCodex: args.includes('--require-actual-codex'),
      codexBin: codexBin || undefined
    });
    const blockers = [...new Set(repair.blockers || [])];
    const result = {
      schema: 'sks.mad-repair-config.v1',
      ok: blockers.length === 0,
      status: blockers.length ? 'blocked' : dryRun ? 'dry_run' : 'applied',
      dry_run: dryRun,
      applied: apply,
      target_root: targetRoot,
      repair,
      blockers,
      operator_actions: [...new Set(repair.operator_actions || [])]
    };
    if (!result.ok) process.exitCode = 1;
    return emit(result, json);
  }

  if (subcommand === 'plan') {
    const manifest = createMadSksAuthorizationManifest({ permission, userIntent });
    return emit({
      schema: 'sks.mad-sks-plan.v1',
      ok: true,
      dry_run: true,
      writes_performed: false,
      permission_model: permission,
      authorization_manifest_preview: manifest,
      protected_core: resolveProtectedCore({ packageRoot: packageRoot(), targetRoot }),
      required_artifacts: [
        'mad-sks-authorization.json',
        'mad-sks-audit-ledger.json',
        'mad-sks-rollback-plan.json',
        'mad-sks-proof-evidence.json',
        'mad-sks-protected-core-before.json',
        'mad-sks-protected-core-after.json'
      ]
    }, json);
  }

  if (subcommand === 'apply') {
    const manifestPath = readOption(args, '--authorization-manifest', null);
    const manifest = manifestPath ? await readJson(path.resolve(manifestPath), null) : null;
    const validation = validateMadSksAuthorizationManifest(manifest);
    if (!validation.ok) {
      const result = {
        schema: 'sks.mad-sks-apply.v1',
        ok: false,
        status: 'blocked',
        target_root: targetRoot,
        issues: ['authorization_manifest_required', ...validation.issues],
        permission_model: permission
      };
      process.exitCode = 1;
      return emit(result, json);
    }
    return materializeMadSksRun(root, targetRoot, permission, userIntent, json, { action: 'apply', args, authorizationManifest: validation.manifest, authorizationManifestPath: path.resolve(manifestPath) });
  }

  if (subcommand === 'run') {
    return materializeMadSksRun(root, targetRoot, permission, userIntent, json, { action: 'run', args });
  }

  if (subcommand === 'sql') {
    const sql = readOption(args, '--sql', null) || positionalText(args);
    return materializeMadSksRun(root, targetRoot, permission, sql || userIntent, json, {
      action: 'apply',
      resultSchema: 'sks.mad-sks-sql.v1',
      args,
      executor: 'sql-plane',
      sql,
      verifySql: readOption(args, '--verify-sql', null),
      rollbackSql: readOption(args, '--rollback-sql', null),
      acceptNotRollbackable: args.includes('--accept-not-rollbackable')
    });
  }

  if (subcommand === 'apply-migration') {
    const migrationFile = readOption(args, '--file', null) || args.find((arg: any) => !String(arg).startsWith('--')) || null;
    return materializeMadSksRun(root, targetRoot, permission, userIntent, json, {
      action: 'apply',
      resultSchema: 'sks.mad-sks-apply-migration.v1',
      args,
      executor: 'sql-plane',
      sqlAction: 'apply-migration',
      migrationFile,
      migrationName: readOption(args, '--name', null),
      verifySql: readOption(args, '--verify-sql', null),
      rollbackSql: readOption(args, '--rollback-sql', null),
      acceptNotRollbackable: args.includes('--accept-not-rollbackable')
    });
  }

  if (subcommand === 'rollback-apply') {
    const rollbackPlanPath = readOption(args, '--rollback-plan', readOption(args, '--plan', null));
    const result = await applyMadSksRollbackPlan({
      rollbackPlanPath,
      targetRoot,
      dryRun: args.includes('--dry-run'),
      yes: args.includes('--yes'),
      root: packageRoot()
    });
    if (!result.ok) process.exitCode = 1;
    return emit(result, json);
  }

  if (subcommand === 'rollback-plan' || subcommand === 'audit' || subcommand === 'proof') {
    const latest = await latestMadSksArtifact(root, subcommand);
    if (!latest) {
      const result = { schema: `sks.mad-sks-${subcommand}.v1`, ok: false, status: 'missing', missing: [`mad-sks-${subcommand}.json`] };
      process.exitCode = 1;
      return emit(result, json);
    }
    return emit(latest, json);
  }
}

async function materializeMadSksRun(root: string, targetRoot: string, permission: any, userIntent: string, json: boolean, opts: any = {}) {
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const { id, dir } = await createMission(root, { mode: 'mad-sks', prompt: userIntent });
  await writeCodex0138CapabilityArtifacts(root, { missionId: id }).catch(() => null);
  await writeCodex0139CapabilityArtifacts(root, { missionId: id }).catch(() => null);
  const before = await snapshotProtectedCore(packageRoot(), 'before');
  const authorization = opts.authorizationManifest || createMadSksAuthorizationManifest({ permission, userIntent });
  const authorizationPath = opts.authorizationManifestPath || path.join(dir, 'mad-sks-authorization.json');
  if (!opts.authorizationManifestPath) await writeJsonAtomic(authorizationPath, authorization);
  const args = Array.isArray(opts.args) ? opts.args : [];
  const executorId = opts.executor || readOption(args, '--executor', inferMadSksExecutor(args));
  const targetFile = readOption(args, '--write-file', readOption(args, '--path', path.join('.sneakoscope', 'mad-sks-target-file.txt')));
  const executorInput: any = {
    executor: executorId,
    dry_run: opts.action !== 'apply' || args.includes('--dry-run'),
    target_root: targetRoot,
    target_path: targetFile,
    path: targetFile,
    content: readOption(args, '--content', 'MAD-SKS authorized target mutation\n'),
    cwd: readOption(args, '--cwd', targetRoot),
    artifact_dir: dir,
    authorization_manifest: authorization,
    authorization_manifest_path: authorizationPath,
    permission_model: permission,
    yes: args.includes('--yes') || opts.acceptNotRollbackable === true,
    mission_id: id,
    user_intent: userIntent,
    args
  };
  const operation = readOption(args, '--operation', null);
  const command = readOption(args, '--command', null);
  const argv = readRepeatedOption(args, '--argv');
  const sql = opts.sql || readOption(args, '--sql', null);
  const rollbackSql = opts.rollbackSql || readOption(args, '--rollback-sql', null);
  const verifySql = opts.verifySql || readOption(args, '--verify-sql', null);
  const verifyExpectedRowCount = readOption(args, '--expect-row-count', null);
  const verifyExpectedResultDigest = readOption(args, '--expect-result-digest', null);
  const migrationFile = opts.migrationFile || readOption(args, '--migration-file', null) || readOption(args, '--file', null);
  const migrationName = opts.migrationName || readOption(args, '--name', null);
  const sqlAction = opts.sqlAction || null;
  if (operation) executorInput.operation = operation;
  if (command) executorInput.command = command;
  if (argv) executorInput.argv = argv;
  if (sql) executorInput.sql = sql;
  if (rollbackSql) executorInput.rollback_sql = rollbackSql;
  if (verifySql) executorInput.verify_sql = verifySql;
  if (verifyExpectedRowCount !== null) executorInput.verify_expected_row_count = Number(verifyExpectedRowCount);
  if (verifyExpectedResultDigest) executorInput.verify_expected_result_digest = verifyExpectedResultDigest;
  if (migrationFile) executorInput.migration_file = migrationFile;
  if (migrationName) executorInput.migration_name = migrationName;
  if (sqlAction) executorInput.action = sqlAction;
  if (opts.acceptNotRollbackable === true) executorInput.accept_not_rollbackable = true;
  const executorResult = await runMadSksExecutor(executorInput);
  const protectedProbe = await evaluateMadSksWrite({ packageRoot: packageRoot(), targetRoot, operation: 'file_write', path: path.join(packageRoot(), 'src', 'core', 'version.ts') });
  const audit = createMadSksAuditLedger({
    authorizationManifestPath: authorizationPath,
    targetRoot,
    actions: [
      madSksAuditAction({
        type: executorResult.action_type || 'file_write',
        target: executorResult.changed_files?.[0] || path.resolve(targetRoot, targetFile),
        rollback_available: Boolean(executorResult.rollback_plan_path),
        risk_level: executorResult.ok ? 'low' : 'high',
        protected_core_impact: 'none',
        notes: [`executor:${executorResult.executor}`, `status:${executorResult.status}`]
      })
    ],
    blockedActions: [protectedProbe, ...(executorResult.blocked_actions || [])]
  });
  const rollback = createMadSksRollbackPlan({
    targetRoot,
    authorizationManifestPath: authorizationPath,
    fileRollbacks: executorResult.rollback_plan_path ? [{ executor: executorResult.executor, rollback_plan_path: executorResult.rollback_plan_path }] : [],
    unavailable: [
      ...(permission.high_risk_confirmation_required ? ['high_risk_final_confirmation_required_before_apply'] : []),
      ...(executorResult.rollback_plan_path ? [] : ['executor_rollback_plan_missing'])
    ]
  });
  const after = await snapshotProtectedCore(packageRoot(), 'after');
  const comparison = compareProtectedCoreSnapshots(before, after);
  const auditPath = path.join(dir, 'mad-sks-audit-ledger.json');
  const rollbackPath = path.join(dir, 'mad-sks-rollback-plan.json');
  const beforePath = path.join(dir, 'mad-sks-protected-core-before.json');
  const afterPath = path.join(dir, 'mad-sks-protected-core-after.json');
  const proofPath = path.join(dir, 'mad-sks-proof-evidence.json');
  await writeJsonAtomic(beforePath, before);
  await writeJsonAtomic(afterPath, after);
  await writeJsonAtomic(path.join(dir, 'mad-sks-protected-core-comparison.json'), comparison);
  await writeMadSksAuditLedger(auditPath, audit);
  await writeMadSksRollbackPlan(rollbackPath, rollback);
  const proof = createMadSksProofEvidence({
    authorizationManifestPath: authorizationPath,
    auditLedgerPath: auditPath,
    rollbackPlanPath: rollbackPath,
    immutableHarnessGuard: protectedProbe,
    protectedCoreBefore: beforePath,
    protectedCoreAfter: afterPath,
    protectedCoreComparison: comparison,
    changedTargetFiles: executorResult.changed_files || [],
    blockedActions: [protectedProbe, ...(executorResult.blocked_actions || [])],
    verification: [
      { command: 'mad-sks executor result', ok: executorResult.ok === true, executor: executorResult.executor, status: executorResult.status },
      { command: 'mad-sks protected core snapshot compare', ok: comparison.ok }
    ]
  });
  await writeMadSksProofEvidence(proofPath, proof);
  await setCurrent(root, {
    mission_id: id,
    route: 'MadSKS',
    route_command: '$MAD-SKS',
    mode: 'MADSKS',
    phase: 'MADSKS_PERMISSION_CLOSED',
    mad_sks_active: false,
    mad_sks_modifier: true,
    mad_sks_gate_file: 'mad-sks-gate.json',
    prompt: userIntent
  });
  const restore = await verifyMadSksPermissionRestored(root, id);
  const sqlPlane = executorResult.sql_plane && typeof executorResult.sql_plane === 'object'
    ? executorResult.sql_plane
    : { requested: false, capability_id: null, operation_classes: [], read_back_passed: false, profile_closed: false };
  const sqlPlaneRequested = (sqlPlane as any).requested === true;
  const sqlPlanePassed = !sqlPlaneRequested || ((sqlPlane as any).read_back_passed === true && (sqlPlane as any).profile_closed === true);
  const gateBlockers = [
    ...(restore.permissions_deactivated === true ? [] : ['permission_restore_failed']),
    ...(comparison.ok === true ? [] : ['protected_core_changed']),
    ...(executorResult.ok === true ? [] : (executorResult.blockers || ['mad_sks_executor_failed'])),
    ...(sqlPlanePassed ? [] : ['mad_sks_sql_plane_read_back_or_profile_close_failed'])
  ];
  const gate = {
    schema_version: 1,
    passed: proof.ok === true && executorResult.ok === true && restore.permissions_deactivated === true && comparison.ok === true && sqlPlanePassed,
    mad_sks_permission_active: false,
    permissions_deactivated: restore.permissions_deactivated === true,
    full_system_authority: permission.mode === 'full_system_authority',
    immutable_harness_guard_passed: comparison.ok === true,
    audit_ledger: auditPath,
    rollback_plan: rollbackPath,
    proof_evidence: proofPath,
    permission_restore_read_back: restore,
    permission_profile: permissionGateSummary(),
    sql_plane: sqlPlane,
    blockers: [...new Set(gateBlockers)]
  };
  await writeJsonAtomic(path.join(dir, 'mad-sks-gate.json'), gate);
  return emit({
    schema: opts.resultSchema || (opts.action === 'apply' ? 'sks.mad-sks-apply.v1' : 'sks.mad-sks-run.v1'),
    ok: gate.passed === true,
    status: executorResult.status,
    mission_id: id,
    target_root: targetRoot,
    permission_model: permission,
    authorization_manifest: authorizationPath,
    audit_ledger: auditPath,
    rollback_plan: rollbackPath,
    proof_evidence: proofPath,
    executor_result: executorResult,
    protected_core_before: beforePath,
    protected_core_after: afterPath,
    protected_core_unchanged: comparison.ok === true,
    blocked_actions: [protectedProbe, ...(executorResult.blocked_actions || [])]
  }, json);
}

async function closeMadSks(root: string, args: any[] = [], json = false, action = 'close') {
  const missionId = readOption(args, '--mission', null) || args.find((arg: any) => !String(arg).startsWith('--')) || await findLatestMission(root, { mode: 'mad-sks', route: '$MAD-SKS', gateFile: 'mad-sks-gate.json' });
  if (!missionId) {
    const result = { schema: 'sks.mad-sks-close.v1', ok: false, action, mission_id: null, blockers: ['mad_sks_mission_missing'] };
    process.exitCode = 1;
    return emit(result, json);
  }
  await setCurrent(root, {
    mission_id: missionId,
    route: 'MadSKS',
    route_command: '$MAD-SKS',
    mode: 'MADSKS',
    phase: action === 'revoke' ? 'MADSKS_PERMISSION_REVOKED' : 'MADSKS_PERMISSION_CLOSED',
    mad_sks_active: false,
    mad_sks_modifier: false,
    mad_sks_gate_file: 'mad-sks-gate.json',
    mad_sks_closed_at: nowIso()
  });
  const restore = await verifyMadSksPermissionRestored(root, missionId);
  const result = await writeMadSksCloseGate(root, missionId, action, restore);
  if (!result.ok) process.exitCode = 1;
  return emit(result, json);
}

async function cleanupExpiredMadSks(root: string) {
  const missionId = await findLatestMission(root, { mode: 'mad-sks', route: '$MAD-SKS', gateFile: 'mad-sks-gate.json' });
  if (!missionId) return null;
  const gate = await readJson(path.join(missionDir(root, missionId), 'mad-sks-gate.json'), null);
  const expires = Date.parse(String(gate?.expires_at || ''));
  if (gate?.mad_sks_permission_active !== true || !Number.isFinite(expires) || expires > Date.now()) return gate;
  await setCurrent(root, {
    mission_id: missionId,
    route: 'MadSKS',
    route_command: '$MAD-SKS',
    mode: 'MADSKS',
    phase: 'MADSKS_PERMISSION_EXPIRED_CLOSED',
    mad_sks_active: false,
    mad_sks_modifier: false,
    mad_sks_gate_file: 'mad-sks-gate.json'
  });
  const restore = await verifyMadSksPermissionRestored(root, missionId);
  return writeMadSksCloseGate(root, missionId, 'ttl_expired_lazy_cleanup', restore);
}

async function writeMadSksCloseGate(root: string, missionId: string, action: string, restore: any) {
  const file = path.join(missionDir(root, missionId), 'mad-sks-gate.json');
  const previous = await readJson(file, {});
  const gate = {
    ...previous,
    schema_version: previous.schema_version || 1,
    passed: restore.permissions_deactivated === true,
    mad_sks_permission_active: false,
    permissions_deactivated: restore.permissions_deactivated === true,
    permission_restore_read_back: restore,
    closed_at: nowIso(),
    close_reason: action,
    blockers: restore.permissions_deactivated === true ? [] : ['permission_restore_failed']
  };
  await writeJsonAtomic(file, gate);
  return { schema: 'sks.mad-sks-close.v1', ok: gate.passed === true, action, mission_id: missionId, gate };
}

async function verifyMadSksPermissionRestored(root: string, missionId: string) {
  const state = await readJson(stateFile(root), {});
  const gate = await readJson(path.join(missionDir(root, missionId), 'mad-sks-gate.json'), {});
  const permissionsDeactivated = state.mission_id === missionId
    && state.mad_sks_active !== true
    && gate.mad_sks_permission_active !== true;
  return {
    schema: 'sks.mad-sks-permission-restore-readback.v1',
    checked_at: nowIso(),
    mission_id: missionId,
    permissions_deactivated: permissionsDeactivated,
    state_mad_sks_active: state.mad_sks_active === true,
    gate_mad_sks_permission_active: gate.mad_sks_permission_active === true
  };
}

function inferMadSksExecutor(args: any[] = []) {
  if (readOption(args, '--sql', null)) return 'sql-plane';
  if (readOption(args, '--command', null) || args.includes('--argv')) return 'shell-command';
  if (readOption(args, '--package', null) || args.includes('--allow-package-install')) return 'package-install';
  if (readOption(args, '--service', null) || args.includes('--allow-service-control')) return 'service-control';
  if (args.includes('--allow-computer-use')) return 'computer-use';
  if (args.includes('--allow-browser-use') || args.includes('--allow-browser')) return 'browser-use';
  if (args.includes('--allow-generated-assets')) return 'generated-asset';
  return 'file-write';
}

function positionalText(args: any[] = []) {
  const valueFlags = new Set([
    '--sql',
    '--verify-sql',
    '--expect-row-count',
    '--expect-result-digest',
    '--rollback-sql',
    '--target-root',
    '--intent',
    '--executor',
    '--cwd',
    '--name',
    '--file',
    '--migration-file'
  ]);
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (!arg || arg === '--json' || arg === '--yes' || arg === '-y' || arg === '--accept-not-rollbackable') continue;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out.join(' ').trim();
}

function readRepeatedOption(args: any[] = [], name: string) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    if (args[i + 1]) values.push(String(args[i + 1]));
  }
  return values.length ? values : undefined;
}

async function latestMadSksArtifact(root: string, kind: string) {
  const current = await readJson(stateFile(root), null);
  const missionId = current?.mission_id;
  if (!missionId) return null;
  const fileMap: Record<string, string> = {
    proof: 'mad-sks-proof-evidence.json',
    audit: 'mad-sks-audit-ledger.json',
    'rollback-plan': 'mad-sks-rollback-plan.json'
  };
  const file = path.join(root, '.sneakoscope', 'missions', missionId, fileMap[kind] || '');
  return readJson(file, null);
}

function firstSubcommand(args: any[] = []) {
  const found = args.find((arg) => MAD_SKS_COMMAND_SURFACE.includes(String(arg)));
  return found ? String(found) : null;
}

function emit(result: any, json: boolean) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) {
    console.error(`${result.schema}: ${result.status || 'blocked'}`);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}
