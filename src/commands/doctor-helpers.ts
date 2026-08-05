import { flag } from '../cli/args.js';
import { projectRoot, exists, nowIso } from '../core/fsx.js';
import { normalizeInstallScope } from '../core/init.js';
import { appendMigrationEvents, hashConfigText } from '../core/migration/migration-transaction-journal.js';
import { inspectSksMenuBarStatus, sksMenuBarPaths, sksMenuBarRestartDeferred } from '../core/codex-app/menubar/index.js';
import { restartLaunchAgent } from '../core/codex-app/menubar/launch-agent.js';

export function buildRuntimeReadiness(matrix: any) {
  const defaults = matrix?.invocation_defaults || {};
  const hookPolicy = defaults.hook_evidence_policy || 'unknown-do-not-count';
  const agentStrategy = defaults.loop_worker_role_strategy || 'message-role';
  const multiAgentMode = defaults.multi_agent_mode || 'none';
  const rolloutBudget = defaults.rollout_budget_strategy || 'sks-local-only';
  const researchSource = defaults.research_source_strategy || 'local-files';
  const codexNative = matrix?.ok === true ? 'ok' : matrix?.codex_cli?.available ? 'degraded' : 'blocked';
  const repairActions: string[] = [];
  if (codexNative !== 'ok') {
    repairActions.push([
      'Codex Native managed assets: sks doctor',
      '--fix',
      '--repair-codex-native',
      '--yes'
    ].join(' '));
  }
  if (matrix?.features?.project_memory?.ok !== true) repairActions.push('Project memory: sks codex-native init-deep --apply --directory-local');
  return {
    schema: 'sks.runtime-readiness-story.v1',
    codex_native: codexNative,
    loop_mesh: agentStrategy === 'agent_type' ? 'ok' : 'fallback',
    qa_visual: defaults.qa_visual_review_strategy || 'blocked',
    research_sources: researchSource,
    image_followup: defaults.image_followup_strategy || 'blocked',
    hook_evidence_policy: hookPolicy,
    agent_role_strategy: agentStrategy,
    multi_agent_mode: multiAgentMode,
    rollout_budget_strategy: rolloutBudget,
    current_time_source: defaults.current_time_source || 'external-clock',
    overload_retry_policy: defaults.overload_retry_policy || 'generic',
    notes: [
      ...(hookPolicy !== 'approved-only' ? ['hook-derived evidence will not count'] : []),
      ...(agentStrategy !== 'agent_type' ? ['message-role fallback active'] : []),
      ...(multiAgentMode === 'proactive' ? ['Proactive multi-agent mode is available for Naruto-style routes'] : []),
      ...(rolloutBudget === 'codex-current-shared' ? ['Shared rollout budgeting is available for route proof'] : []),
      ...(researchSource === 'indexed-web-search' ? ['Indexed web search is selected for source-intelligence routes'] : [])
    ],
    repair_actions: [...new Set(repairActions)]
  };
}

export function deferredNativeRepair(schema: string, doctorFix: boolean, nextActions: string[]) {
  return {
    schema,
    generated_at: nowIso(),
    ok: true,
    skipped: true,
    status: 'deferred_to_explicit_native_capability_probe',
    attempted: false,
    apply: doctorFix,
    recovered: false,
    blockers: [],
    next_actions: nextActions,
    manual_actions: nextActions
  };
}

export function fallbackCodexNativeFeatureMatrix(codex: any, blockers: string[] = [], warnings: string[] = []) {
  return {
    schema: 'sks.codex-native-feature-matrix.v1',
    ok: blockers.length === 0,
    skipped: blockers.length === 0,
    codex_cli: { available: Boolean(codex?.bin || codex?.available), version: codex?.version || null, bin: codex?.bin || null },
    features: {},
    invocation_defaults: {
      loop_worker_role_strategy: 'message-role',
      multi_agent_mode: 'none',
      rollout_budget_strategy: 'sks-local-only',
      qa_visual_review_strategy: 'route-gated',
      research_source_strategy: 'local-files',
      image_followup_strategy: 'artifact-path',
      hook_evidence_policy: 'unknown-do-not-count',
      skill_bridge_strategy: 'cli-only',
      current_time_source: 'external-clock',
      overload_retry_policy: 'generic'
    },
    blockers,
    warnings
  };
}

export async function writeJsonReportFile(file: string, value: unknown): Promise<void> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function nativeCapabilityStatus(rows: any[], id: string, fallback: string): string {
  const row = rows.find((entry: any) => entry?.id === id);
  if (!row) return fallback;
  if (row.after === 'verified' || row.before === 'verified') return 'verified';
  if (id === 'image_path_exposure') {
    if (row.before === 'degraded' || row.after === 'degraded' || row.repairability === 'doctor-fix') return 'fallback';
    return fallback;
  }
  if (id === 'app_handoff') return 'unavailable';
  if (row.repairability === 'manual-required') return 'manual_required';
  if (row.before === 'degraded' || row.after === 'degraded') return 'degraded';
  if (row.repairability === 'doctor-fix') return row.after === 'blocked' ? 'blocked' : 'repair_required';
  if (row.repairability === 'unavailable') return 'unavailable';
  return fallback;
}

export function uniqueNativeManualActions(rows: any[]): string[] {
  return [...new Set(rows
    .filter((row: any) => row?.repairability === 'manual-required' && row?.after !== 'verified')
    .flatMap((row: any) => Array.isArray(row.repair_actions) ? row.repair_actions : [])
    .filter((action: any) => typeof action === 'string' && action.trim()))];
}

export function doctorSkillStatus(coreSkills: any): string {
  if (!coreSkills) return 'drift_detected';
  if (Array.isArray(coreSkills.restored) && coreSkills.restored.length) return 'repaired';
  if (Array.isArray(coreSkills.blockers) && coreSkills.blockers.length) return 'drift_detected';
  return 'current';
}

export function doctorDedupeStatus(skillDedupe: any): string {
  if (!skillDedupe) return 'manual_required';
  if (Array.isArray(skillDedupe.actions) && skillDedupe.actions.some((action: any) => action.action === 'quarantined')) return 'repaired';
  if (Array.isArray(skillDedupe.blockers) && skillDedupe.blockers.length) return 'manual_required';
  return 'none';
}

async function codexHomeConfigPath(): Promise<string> {
  const path = await import('node:path');
  const os = await import('node:os');
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

export async function captureCodexConfigSnapshot(): Promise<Record<string, string | null>> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const read = async (p: string | null | undefined) => {
    if (!p) return null;
    try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
  };
  const root = await projectRoot();
  const projectPath = root ? path.join(root, '.codex', 'config.toml') : null;
  const homePath = await codexHomeConfigPath();
  return {
    project_path: projectPath,
    project_text: await read(projectPath),
    home_path: homePath,
    home_text: await read(homePath)
  };
}

export async function writeFixMigrationJournal(
  root: string,
  preFix: Record<string, string | null> | null,
  configRepair: any,
  setupRepair: any
) {
  if (!preFix) return null;
  const fsp = await import('node:fs/promises');
  const read = async (p: string | null | undefined) => {
    if (!p) return null;
    try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
  };
  const projectAfter = await read(preFix.project_path);
  const homeAfter = await read(preFix.home_path);
  const structureRepairs: any[] = Array.isArray(configRepair?.structure_repairs) ? configRepair.structure_repairs : [];
  const projectStructure = structureRepairs.find((repair) => repair.scope === 'project');
  const homeStructure = structureRepairs.find((repair) => repair.scope === 'codex_home');
  const events = [
    {
      step: 'doctor_fix_project_config',
      target: preFix.project_path || '.codex/config.toml',
      beforeHash: preFix.project_text != null ? hashConfigText(preFix.project_text) : null,
      afterHash: projectAfter != null ? hashConfigText(projectAfter) : null,
      backupPath: setupRepair?.config_backup_path || projectStructure?.backup_path || configRepair?.policy?.backup_path || null
    },
    {
      step: 'doctor_fix_codex_home_config',
      target: preFix.home_path || '~/.codex/config.toml',
      beforeHash: preFix.home_text != null ? hashConfigText(preFix.home_text) : null,
      afterHash: homeAfter != null ? hashConfigText(homeAfter) : null,
      backupPath: homeStructure?.backup_path || null
    }
  ].filter((event) => event.beforeHash != null || event.afterHash != null);
  if (!events.length) return null;
  return appendMigrationEvents(root, events);
}

async function backupProjectConfigBeforeFix(): Promise<string | null> {
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const root = await projectRoot();
    if (!root) return null;
    const configPath = path.join(root, '.codex', 'config.toml');
    if (!(await exists(configPath))) return null;
    const text = await fsp.readFile(configPath, 'utf8');
    const backupPath = `${configPath}.doctor-pre-fix-${Date.now().toString(36)}.bak`;
    await fsp.writeFile(backupPath, text);
    return backupPath;
  } catch {
    return null;
  }
}

export function installScopeFromArgs(args: any = []) {
  if (flag(args, '--project')) return 'project';
  if (flag(args, '--global')) return 'global';
  const index = args.indexOf('--install-scope');
  return normalizeInstallScope(index >= 0 && args[index + 1] ? args[index + 1] : 'global');
}

export function isMigrationUserOwnedProjectConfigBlocker(blocker: string): boolean {
  const value = String(blocker || '').trim();
  return value === 'user_owned_file_without_sks_marker'
    || value.endsWith(':user_owned_file_without_sks_marker')
    || value === 'config_write_guard:blocked_unmanaged_project_config'
    || value.endsWith(':config_write_guard:blocked_unmanaged_project_config');
}

export function readOption(args: any = [], name: string, fallback: any = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function buildCodexAppUiDiagnosticFailure(apply: boolean, error: unknown) {
  return {
    schema: 'sks.codex-app-fast-ui-repair.v1' as const,
    ok: false,
    apply,
    safe_auto_apply: false,
    requires_confirmation: true,
    fast_selector: 'manual_action_required' as const,
    provider_selector: 'manual_action_required' as const,
    host_owned_config: 'diagnostic_failed' as const,
    next_action: 'Review Codex App UI config manually.',
    actions: [],
    blockers: [error instanceof Error ? error.message : String(error)]
  };
}

export function formatCodexDoctorConsoleStatus(report: any) {
  if (!report || report.available !== true) return 'unavailable';
  return report.disposition || (report.exit_code === 0 ? 'pass' : 'warn');
}

export function sksMenuBarRunningVersionConsoleLines(status: any): string[] {
  const runningVersion = status?.running_process?.package_version
    || status?.menubar_version_probe?.running_version
    || null;
  const runningPid = status?.running_process?.pid ?? status?.menubar_version_probe?.pid ?? null;
  if (typeof runningVersion !== 'string' || !runningVersion || !Number.isInteger(runningPid) || runningPid <= 0) {
    return [];
  }
  const expectedVersion = status?.menubar_version_probe?.expected_version
    || status?.action_target?.expected_version
    || status?.package_version
    || null;
  const installedVersion = status?.installed_version || status?.build_stamp?.package_version || null;
  return [
    `  RUNNING: version ${runningVersion} (PID ${runningPid})`,
    ...(typeof expectedVersion === 'string' && expectedVersion && expectedVersion !== runningVersion
      ? [`  expected: version ${expectedVersion}`]
      : []),
    ...(typeof installedVersion === 'string' && installedVersion && installedVersion !== runningVersion
      ? [`  installed: version ${installedVersion}`]
      : [])
  ];
}

export async function rebootstrapSksMenuBarLaunchdForDoctorFix(input: {
  fix: boolean;
  root: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  status: any;
}, deps: {
  inspectSksMenuBarStatusImpl?: typeof inspectSksMenuBarStatus;
  restartLaunchAgentImpl?: typeof restartLaunchAgent;
} = {}) {
  const env = input.env || process.env;
  const status = input.status;
  const expectedVersion = status?.menubar_version_probe?.expected_version
    || status?.action_target?.expected_version
    || status?.installed_version
    || null;
  const warningOnlyVerifiedProcess = input.fix
    && !sksMenuBarRestartDeferred(env)
    && status?.launchd?.checked === true
    && status?.launchd?.ok === false
    && Array.isArray(status?.warnings)
    && status.warnings.includes('launchd_not_running_process_active')
    && !(Array.isArray(status?.blockers) && status.blockers.includes('launchd_not_running'))
    && status?.running_process?.ok === true
    && typeof expectedVersion === 'string'
    && status.running_process.package_version === expectedVersion;
  if (!warningOnlyVerifiedProcess) {
    return { attempted: false, ok: true, status, restart: null };
  }

  const paths = sksMenuBarPaths(input.home || env.HOME, input.root);
  const restartImpl = deps.restartLaunchAgentImpl || restartLaunchAgent;
  const inspectImpl = deps.inspectSksMenuBarStatusImpl || inspectSksMenuBarStatus;
  const restart = await restartImpl(paths, env).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  if (restart?.ok !== true) {
    const detail = restart?.error ? `:${restart.error}` : '';
    return {
      attempted: true,
      ok: false,
      restart,
      status: {
        ...status,
        ok: false,
        blockers: [...new Set([...(status?.blockers || []), `launchd_rebootstrap_failed${detail}`])]
      }
    };
  }

  const refreshed = await inspectImpl({
    root: input.root,
    ...(input.home ? { home: input.home } : {}),
    ...(input.env ? { env: input.env } : {})
  }).catch((error: unknown) => ({
    ...status,
    ok: false,
    blockers: [...new Set([
      ...(status?.blockers || []),
      `launchd_rebootstrap_status_failed:${error instanceof Error ? error.message : String(error)}`
    ])]
  }));
  if (refreshed?.launchd?.checked !== true || refreshed?.launchd?.ok !== true) {
    return {
      attempted: true,
      ok: false,
      restart,
      status: {
        ...refreshed,
        ok: false,
        blockers: [...new Set([...(refreshed?.blockers || []), 'launchd_rebootstrap_not_confirmed'])]
      }
    };
  }
  return { attempted: true, ok: true, status: refreshed, restart };
}

export function mergeObservedCodexStartupWarnings(startupRepair: any, codexDoctor: any) {
  const text = `${codexDoctor?.stdout_tail || ''}\n${codexDoctor?.stderr_tail || ''}`;
  const manual = new Set<string>(Array.isArray(startupRepair?.manual_actions) ? startupRepair.manual_actions : []);
  const warnings = new Set<string>(Array.isArray(startupRepair?.warnings) ? startupRepair.warnings : []);
  const blockers = new Set<string>(Array.isArray(startupRepair?.blockers) ? startupRepair.blockers : []);
  if (/codex_apps[\s\S]{0,500}token_expired|token_expired[\s\S]{0,500}codex_apps/i.test(text)) {
    manual.add('Codex Apps MCP token is expired; sign in to Codex App/CLI again so the connector can mint a fresh token.');
    warnings.add('codex_apps_token_expired_observed');
    blockers.add('codex_apps_token_expired_manual_reauth_required');
  }
  if (/SUPABASE_ACCESS_TOKEN[\s\S]{0,500}mcp server ['"`]?supabase['"`]?|mcp server ['"`]?supabase['"`]?[\s\S]{0,500}SUPABASE_ACCESS_TOKEN/i.test(text)) {
    manual.add('Supabase MCP uses SUPABASE_ACCESS_TOKEN but the variable is unset; export the token or migrate that server to a read-only remote URL.');
    warnings.add('supabase_access_token_missing_observed');
    blockers.add('supabase_access_token_missing_manual_auth_required');
  }
  if (/node_repl[\s\S]{0,500}No such file or directory|No such file or directory[\s\S]{0,500}node_repl/i.test(text)) {
    warnings.add('node_repl_missing_command_observed');
  }
  return {
    ...startupRepair,
    ok: blockers.size === 0 && startupRepair?.ok !== false,
    manual_actions: [...manual],
    warnings: [...warnings],
    blockers: [...blockers]
  };
}
