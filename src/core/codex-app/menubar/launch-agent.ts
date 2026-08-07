import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson, runProcess, which, writeJsonAtomic } from '../../fsx.js';
import { CONTROL_CENTER_DOMAIN, CONTROL_CENTER_PREFERRED_POSITION, SKS_MENUBAR_LABEL } from './constants.js';
import { realUserHome } from './installer/runtime.js';
import type {
  SksMenuBarInstallResult,
  SksMenuBarRuntimeProcess,
  SksMenuBarStatusResult,
  SksMenuBarStopResult,
  SksMenuBarVersionProbe
} from './types.js';
import type { sksMenuBarPaths } from './paths.js';

export function launchAgentSource(executablePath: string, installDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SKS_MENUBAR_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(executablePath)}</string></array>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>${xml(path.join(installDir, 'menubar.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(installDir, 'menubar.err.log'))}</string>
</dict></plist>\n`;
}

// launchd's Menu Bar service label (gui/<uid>/com.sneakoscope.sks-menubar) is
// machine-global, not scoped to the install home. An implicitly resolved
// launchctl therefore always reaches the OPERATOR's real session: an
// install/rollback/uninstall running against any other home (isolated test
// homes, sandboxes, custom --home) would boot out the operator's real Menu Bar
// while writing its own files elsewhere. Callers that set SKS_MENUBAR_LAUNCHCTL
// explicitly own that boundary (every test fixture injects one); everyone else
// may only touch launchd when operating on the real user home.
export function menuBarLaunchdTouchAllowed(
  paths: Pick<ReturnType<typeof sksMenuBarPaths>, 'home'>,
  env: NodeJS.ProcessEnv
): boolean {
  return Boolean(env.SKS_MENUBAR_LAUNCHCTL) || path.resolve(paths.home) === realUserHome();
}

export async function seedMenuBarPreferredPosition(env: NodeJS.ProcessEnv): Promise<boolean> {
  const defaults = env.SKS_MENUBAR_DEFAULTS || await which('defaults').catch(() => null) || '/usr/bin/defaults';
  const writes = [
    ['write', CONTROL_CENTER_DOMAIN, `NSStatusItem Preferred Position ${SKS_MENUBAR_LABEL}`, '-int', String(CONTROL_CENTER_PREFERRED_POSITION)],
    ['write', CONTROL_CENTER_DOMAIN, `NSStatusItem Visible ${SKS_MENUBAR_LABEL}`, '-bool', 'true'],
    ['write', CONTROL_CENTER_DOMAIN, `NSStatusItem VisibleCC ${SKS_MENUBAR_LABEL}`, '-bool', 'true']
  ];
  for (const args of writes) {
    const result = await runProcess(defaults, args, { timeoutMs: 5_000, maxOutputBytes: 8 * 1024 }).catch(() => ({ code: 1 }));
    if (result.code !== 0) return false;
  }
  return true;
}

export async function launchMenuBar(input: {
  launchctl: string;
  open: string | null;
  paths: ReturnType<typeof sksMenuBarPaths>;
  env?: NodeJS.ProcessEnv;
  alreadyStopped?: boolean;
  expectedVersion?: string;
  executablePaths?: string[];
}): Promise<NonNullable<SksMenuBarInstallResult['launch']>> {
  const domain = launchDomain();
  const service = launchServiceName();
  if (!input.alreadyStopped) {
    const stopped = await stopMenuBarForReplacement({
      launchctl: input.launchctl,
      paths: input.paths,
      executablePaths: input.executablePaths || [input.paths.executable_path],
      ...(input.env ? { env: input.env } : {})
    });
    if (!stopped.ok) {
      return {
        requested: true,
        method: 'launchctl',
        ok: false,
        terminal_uncertain: stopped.timed_out,
        error: stopped.error || 'menubar_stop_failed'
      };
    }
  }
  const bootstrap = await runProcess(input.launchctl, ['bootstrap', domain, input.paths.launch_agent_path], {
    timeoutMs: timeoutFromEnv(input.env, 'SKS_MENUBAR_BOOTSTRAP_TIMEOUT_MS', 8_000),
    maxOutputBytes: 16 * 1024
  }).catch((error: unknown) => failedProcess(error));
  if (bootstrap.timedOut) {
    const probe = await waitForLaunchdServiceRunning(input.launchctl, service, input.env);
    const versionProbe = input.expectedVersion && probe.running
      ? await waitForRunningMenuBarVersion(input.paths, input.expectedVersion, probe.pid, input.env)
      : undefined;
    return {
      requested: true,
      method: 'launchctl',
      ok: probe.running && (versionProbe?.ok ?? true),
      bootstrap_code: bootstrap.code,
      bootstrap_timed_out: true,
      print_code: probe.code,
      verified_running_after_timeout: probe.running,
      terminal_uncertain: !probe.running,
      ...(versionProbe ? { version_probe: versionProbe } : {}),
      error: probe.running
        ? versionProbe?.error || null
        : probe.error || 'launchctl_bootstrap_timed_out'
    };
  }
  if (bootstrap.code === 0) {
    const kickstart = await runProcess(input.launchctl, ['kickstart', '-k', service], {
      timeoutMs: timeoutFromEnv(input.env, 'SKS_MENUBAR_KICKSTART_TIMEOUT_MS', 8_000),
      maxOutputBytes: 16 * 1024
    }).catch((error: unknown) => failedProcess(error));
    if (kickstart.code === 0 || kickstart.timedOut) {
      const probe = await waitForLaunchdServiceRunning(input.launchctl, service, input.env);
      const versionProbe = input.expectedVersion && probe.running
        ? await waitForRunningMenuBarVersion(input.paths, input.expectedVersion, probe.pid, input.env)
        : undefined;
      const terminalUncertain = !probe.running && (kickstart.timedOut || probe.code !== 0);
      return {
        requested: true,
        method: 'launchctl',
        ok: probe.running && (versionProbe?.ok ?? true),
        bootstrap_code: bootstrap.code,
        bootstrap_timed_out: false,
        kickstart_code: kickstart.code,
        kickstart_timed_out: kickstart.timedOut,
        print_code: probe.code,
        verified_running_after_timeout: kickstart.timedOut && probe.running,
        terminal_uncertain: terminalUncertain,
        ...(versionProbe ? { version_probe: versionProbe } : {}),
        error: probe.running
          ? versionProbe?.error || null
          : probe.error || (kickstart.timedOut ? 'launchctl_kickstart_timed_out' : 'launchctl_kickstart_not_running')
      };
    }
    return { requested: true, method: 'launchctl', ok: false, bootstrap_code: bootstrap.code, bootstrap_timed_out: false, kickstart_code: kickstart.code, kickstart_timed_out: false, error: String(kickstart.stderr || kickstart.stdout).trim() };
  }
  if (input.open) {
    const opened = await runProcess(input.open, [input.paths.app_path], { timeoutMs: 8_000, maxOutputBytes: 16 * 1024 })
      .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    const running = opened.code === 0
      && await waitForMenuBarProcessRunning(input.paths.executable_path, input.env);
    const versionProbe = input.expectedVersion && running
      ? await waitForRunningMenuBarVersion(input.paths, input.expectedVersion, null, input.env)
      : undefined;
    return {
      requested: true,
      method: 'open-fallback',
      ok: running && (versionProbe?.ok ?? true),
      bootstrap_code: bootstrap.code,
      bootstrap_timed_out: false,
      open_code: opened.code,
      open_verified_running: running,
      ...(versionProbe ? { version_probe: versionProbe } : {}),
      error: running
        ? versionProbe?.error || null
        : opened.code === 0
          ? 'open_succeeded_process_not_running'
          : String(opened.stderr || bootstrap.stderr).trim()
    };
  }
  return { requested: true, method: 'launchctl', ok: false, bootstrap_code: bootstrap.code, bootstrap_timed_out: false, error: String(bootstrap.stderr || bootstrap.stdout || 'launchctl_bootstrap_failed').trim() };
}

export async function stopMenuBarForReplacement(input: {
  launchctl: string;
  paths: ReturnType<typeof sksMenuBarPaths>;
  executablePaths: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<SksMenuBarStopResult> {
  const service = launchServiceName();
  const domain = launchDomain();
  const bootoutTimeout = timeoutFromEnv(input.env, 'SKS_MENUBAR_BOOTOUT_TIMEOUT_MS', 5_000);
  const bootoutResults = [await runProcess(input.launchctl, ['bootout', service], {
    timeoutMs: bootoutTimeout,
    maxOutputBytes: 16 * 1024
  }).catch((error: unknown) => failedProcess(error))];
  if (!bootoutAccepted(bootoutResults[0]!)) {
    bootoutResults.push(await runProcess(input.launchctl, ['bootout', domain, input.paths.launch_agent_path], {
      timeoutMs: bootoutTimeout,
      maxOutputBytes: 16 * 1024
    }).catch((error: unknown) => failedProcess(error)));
  }
  const bootoutVerified = bootoutResults.some(bootoutAccepted);
  const bootoutTimedOut = bootoutResults.some((result) => result.timedOut);
  if (!bootoutVerified || bootoutTimedOut) {
    const executablePaths = [...new Set(input.executablePaths.map((value) => path.resolve(value)))];
    const remaining = await exactMenuBarProcessIds(executablePaths, input.env);
    return {
      ok: false,
      service,
      executable_paths: executablePaths,
      bootout_codes: bootoutResults.map((result) => result.code),
      terminated_pids: [],
      remaining_pids: remaining,
      timed_out: bootoutTimedOut,
      error: bootoutTimedOut
        ? 'launchctl_bootout_timed_out'
        : `launchctl_bootout_failed:${bootoutResults.map((result) => result.code ?? 'unknown').join(',')}`
    };
  }
  const terminated = await terminateMenuBarProcesses(input.executablePaths, input.env);
  const executablePaths = terminated.executable_paths;
  const before = terminated.before_pids;
  const remaining = terminated.remaining_pids;
  const processTimedOut = terminated.timed_out;
  return {
    ok: !processTimedOut && !bootoutTimedOut && bootoutVerified,
    service,
    executable_paths: executablePaths,
    bootout_codes: bootoutResults.map((result) => result.code),
    terminated_pids: before.filter((pid) => !remaining.includes(pid)),
    remaining_pids: remaining,
    timed_out: bootoutTimedOut || processTimedOut,
    error: bootoutTimedOut
      ? 'launchctl_bootout_timed_out'
      : !bootoutVerified
        ? `launchctl_bootout_failed:${bootoutResults.map((result) => result.code ?? 'unknown').join(',')}`
      : remaining.length > 0
        ? `menubar_process_stop_timed_out:${remaining.join(',')}`
        : null
  };
}

export async function terminateMenuBarProcesses(
  requestedExecutablePaths: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  ok: boolean;
  executable_paths: string[];
  before_pids: number[];
  remaining_pids: number[];
  timed_out: boolean;
}> {
  const executablePaths = [...new Set(requestedExecutablePaths.map((value) => path.resolve(value)))];
  const before = await exactMenuBarProcessIds(executablePaths, env);
  const pkill = await processTool(env, 'SKS_MENUBAR_PKILL', '/usr/bin/pkill');
  if (before.length > 0 && pkill) {
    await runProcess(pkill, exactProcessArguments(executablePaths), {
      timeoutMs: 3_000,
      maxOutputBytes: 8 * 1024
    }).catch(() => undefined);
  }
  const readbackTimeout = timeoutFromEnv(env, 'SKS_MENUBAR_STOP_READBACK_TIMEOUT_MS', 5_000);
  const interval = timeoutFromEnv(env, 'SKS_MENUBAR_STOP_READBACK_INTERVAL_MS', 100);
  const deadline = Date.now() + readbackTimeout;
  let remaining = await exactMenuBarProcessIds(executablePaths, env);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(Math.min(interval, Math.max(1, deadline - Date.now())));
    remaining = await exactMenuBarProcessIds(executablePaths, env);
  }
  return {
    ok: remaining.length === 0,
    executable_paths: executablePaths,
    before_pids: before,
    remaining_pids: remaining,
    timed_out: remaining.length > 0
  };
}

export async function inspectLaunchdService(env: NodeJS.ProcessEnv = process.env): Promise<SksMenuBarStatusResult['launchd']> {
  if (process.platform !== 'darwin') return { checked: false, ok: true, service: null, state: null, pid: null, error: null };
  const launchctl = env.SKS_MENUBAR_LAUNCHCTL || await which('launchctl').catch(() => null) || '/bin/launchctl';
  const service = launchServiceName();
  const probe = await printLaunchdService(launchctl, service, timeoutFromEnv(env, 'SKS_MENUBAR_PRINT_TIMEOUT_MS', 2_000));
  return { checked: true, ok: probe.running, service, state: probe.state, pid: probe.pid, error: probe.running ? null : probe.error };
}

export async function restartLaunchAgent(paths: ReturnType<typeof sksMenuBarPaths>, env: NodeJS.ProcessEnv) {
  const launchctl = env.SKS_MENUBAR_LAUNCHCTL || await which('launchctl').catch(() => null) || '/bin/launchctl';
  const open = env.SKS_MENUBAR_OPEN || await which('open').catch(() => null) || '/usr/bin/open';
  const service = launchServiceName();
  const buildStamp = await readJson<{ package_version?: unknown } | null>(paths.build_stamp_path, null);
  const expectedVersion = typeof buildStamp?.package_version === 'string' ? buildStamp.package_version : null;
  const result = await runProcess(launchctl, ['kickstart', '-k', service], {
    timeoutMs: timeoutFromEnv(env, 'SKS_MENUBAR_KICKSTART_TIMEOUT_MS', 5_000),
    maxOutputBytes: 16 * 1024
  }).catch((error: unknown) => failedProcess(error));
  if (result.code === 0 || result.timedOut) {
    const probe = await waitForLaunchdServiceRunning(launchctl, service, env);
    const versionProbe = probe.running && expectedVersion
      ? await waitForRunningMenuBarVersion(paths, expectedVersion, probe.pid, env)
      : undefined;
    const terminalUncertain = !probe.running && (result.timedOut || probe.code !== 0);
    return {
      ok: probe.running && (versionProbe?.ok ?? true),
      code: result.code,
      timed_out: result.timedOut,
      print_code: probe.code,
      verified_running_after_timeout: result.timedOut && probe.running,
      terminal_uncertain: terminalUncertain,
      recovered_via_bootstrap: false,
      ...(versionProbe ? { version_probe: versionProbe } : {}),
      error: probe.running
        ? versionProbe?.error || null
        : probe.error || (result.timedOut ? 'launchctl_kickstart_timed_out' : 'launchctl_kickstart_not_running'),
      paths
    };
  }
  // Diagnostics "Restart Menu Bar" and `sks menubar restart` used to kickstart only.
  // When the LaunchAgent plist exists but is not loaded into the GUI domain
  // (common after bootout, logout, or a failed prior install), kickstart fails
  // with "Could not find service …" and Control Center becomes unreachable.
  // Re-bootstrap the existing agent instead of forcing a full rebuild.
  const kickstartError = String(result.stderr || result.stdout).trim();
  if (await exists(paths.launch_agent_path) && await exists(paths.executable_path) && isUnloadableLaunchdKickstartError(kickstartError)) {
    const launch = await launchMenuBar({
      launchctl,
      open,
      paths,
      env,
      ...(expectedVersion ? { expectedVersion } : {})
    });
    return {
      ok: launch.ok,
      code: launch.kickstart_code ?? launch.bootstrap_code ?? result.code,
      timed_out: Boolean(launch.kickstart_timed_out || launch.bootstrap_timed_out),
      print_code: launch.print_code ?? null,
      verified_running_after_timeout: Boolean(launch.verified_running_after_timeout),
      terminal_uncertain: Boolean(launch.terminal_uncertain),
      recovered_via_bootstrap: true,
      ...(launch.version_probe ? { version_probe: launch.version_probe } : {}),
      error: launch.error ?? (launch.ok ? null : kickstartError),
      paths
    };
  }
  return {
    ok: false,
    code: result.code,
    timed_out: false,
    print_code: null,
    verified_running_after_timeout: false,
    terminal_uncertain: false,
    recovered_via_bootstrap: false,
    error: kickstartError,
    paths
  };
}

export function isLaunchdServiceAbsent(result: {
  code: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): boolean {
  if (result.timedOut || result.code === 0) return false;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /could not find service|no such (?:process|file)|service[^\n]*not found|not found[^\n]*service|not loaded|does not exist/i.test(output)
    || (result.code === 113 && /\bbad request\b/i.test(output));
}

function bootoutAccepted(result: {
  code: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): boolean {
  return result.code === 0 || isLaunchdServiceAbsent(result);
}

export function isUnloadableLaunchdKickstartError(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('could not find service')
    || normalized.includes('could not kickstart service')
    || /\bbad request\b/.test(normalized)
    || normalized.includes('operation not permitted')
    || normalized.includes('no such process')
    || normalized.includes('input/output error');
}

export async function removeLaunchAgent(paths: ReturnType<typeof sksMenuBarPaths>, env: NodeJS.ProcessEnv): Promise<{ actions: string[]; warnings: string[]; blockers: string[] }> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (menuBarLaunchdTouchAllowed(paths, env)) {
    const launchctl = env.SKS_MENUBAR_LAUNCHCTL || await which('launchctl').catch(() => null) || '/bin/launchctl';
    const stopped = await stopMenuBarForReplacement({
      launchctl,
      paths,
      executablePaths: [paths.executable_path],
      env
    });
    if (!stopped.ok) blockers.push(stopped.error || 'menubar_process_stop_failed');
  } else {
    const terminated = await terminateMenuBarProcesses([paths.executable_path], env);
    if (!terminated.ok) blockers.push('menubar_process_stop_failed');
    else warnings.push('launchd_stop_skipped_non_user_home');
  }
  if (blockers.length > 0) return { actions, warnings, blockers };
  await fs.rm(paths.launch_agent_path, { force: true }).catch((error: unknown) => blockers.push(`remove_launch_agent_failed:${String(error)}`));
  await fs.rm(paths.install_dir, { recursive: true, force: true }).catch((error: unknown) => blockers.push(`remove_install_dir_failed:${String(error)}`));
  actions.push(`removed ${paths.launch_agent_path}`, `removed ${paths.install_dir}`);
  const defaults = env.SKS_MENUBAR_DEFAULTS || await which('defaults').catch(() => null) || '/usr/bin/defaults';
  for (const key of [`NSStatusItem Preferred Position ${SKS_MENUBAR_LABEL}`, `NSStatusItem Visible ${SKS_MENUBAR_LABEL}`, `NSStatusItem VisibleCC ${SKS_MENUBAR_LABEL}`]) {
    await runProcess(defaults, ['delete', CONTROL_CENTER_DOMAIN, key], { timeoutMs: 3_000, maxOutputBytes: 8 * 1024 }).catch(() => warnings.push(`defaults_cleanup_failed:${key}`));
  }
  return { actions, warnings, blockers };
}

export async function isMenuBarProcessRunning(
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return (await exactMenuBarProcessIds([executablePath], env)).length > 0;
}

export function launchDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === null ? 'gui' : `gui/${uid}`;
}

export function launchServiceName(): string {
  return `${launchDomain()}/${SKS_MENUBAR_LABEL}`;
}

type LaunchdServiceProbe = {
  code: number | null;
  timedOut: boolean;
  running: boolean;
  state: string | null;
  pid: number | null;
  activeCount: number | null;
  error: string | null;
};

async function waitForLaunchdServiceRunning(
  launchctl: string,
  service: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<LaunchdServiceProbe> {
  const readbackTimeoutMs = timeoutFromEnv(env, 'SKS_MENUBAR_LAUNCH_READBACK_TIMEOUT_MS', 8_000);
  const printTimeoutMs = timeoutFromEnv(env, 'SKS_MENUBAR_PRINT_TIMEOUT_MS', 2_000);
  const pollIntervalMs = timeoutFromEnv(env, 'SKS_MENUBAR_LAUNCH_READBACK_INTERVAL_MS', 100);
  const deadline = Date.now() + readbackTimeoutMs;
  let lastProbe: LaunchdServiceProbe | null = null;
  let lastCompletedProbe: LaunchdServiceProbe | null = null;
  while (true) {
    const remainingMs = deadline - Date.now();
    const minimumUsefulProbeMs = Math.min(printTimeoutMs, Math.max(pollIntervalMs, 250));
    if (lastProbe && remainingMs <= minimumUsefulProbeMs) return lastCompletedProbe || lastProbe;
    const probe = await printLaunchdService(launchctl, service, Math.min(printTimeoutMs, remainingMs));
    if (probe.running) return probe;
    lastProbe = probe;
    if (!probe.timedOut) lastCompletedProbe = probe;
    const remainingAfterProbeMs = deadline - Date.now();
    if (remainingAfterProbeMs <= 0) return lastCompletedProbe || probe;
    await delay(Math.min(pollIntervalMs, remainingAfterProbeMs));
  }
}

async function waitForMenuBarProcessRunning(
  executablePath: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<boolean> {
  const timeoutMs = timeoutFromEnv(env, 'SKS_MENUBAR_OPEN_READBACK_TIMEOUT_MS', 5_000);
  const intervalMs = timeoutFromEnv(env, 'SKS_MENUBAR_OPEN_READBACK_INTERVAL_MS', 100);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await isMenuBarProcessRunning(executablePath, env)) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(intervalMs, remainingMs));
  }
}

export async function inspectRunningMenuBarProcess(
  paths: ReturnType<typeof sksMenuBarPaths>,
  launchdPid: number | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<SksMenuBarRuntimeProcess> {
  const state = await readJson<any>(paths.runtime_state_path, null);
  if (!state || state.schema !== 'sks.menubar-runtime-state.v1') {
    return {
      checked: true, ok: false, pid: null, package_version: null, build_version: null,
      executable_path: null, started_at: null, source: 'none', error: 'runtime_state_missing'
    };
  }
  const pid = Number.isInteger(state.pid) && state.pid > 0 ? Number(state.pid) : null;
  const executablePath = typeof state.executable_path === 'string' ? path.resolve(state.executable_path) : null;
  const expectedExecutable = path.resolve(paths.executable_path);
  const exactPath = executablePath === expectedExecutable;
  const pidMatches = launchdPid === null || pid === launchdPid;
  const runningPids = exactPath ? await exactMenuBarProcessIds([expectedExecutable], env) : [];
  const running = pid !== null && runningPids.includes(pid);
  const singleton = runningPids.length === 1;
  const ok = Boolean(pid && pidMatches && running && singleton && typeof state.package_version === 'string');
  return {
    checked: true,
    ok,
    pid,
    package_version: typeof state.package_version === 'string' ? state.package_version : null,
    build_version: typeof state.build_version === 'string' ? state.build_version : null,
    executable_path: executablePath,
    started_at: typeof state.started_at === 'string' ? state.started_at : null,
    source: 'runtime-state',
    error: ok
      ? null
      : !exactPath
        ? 'runtime_executable_path_mismatch'
        : !pidMatches
          ? 'runtime_pid_mismatch'
          : !singleton && runningPids.length > 1
            ? `multiple_menubar_processes:${runningPids.join(',')}`
          : !running
            ? 'runtime_process_not_running'
            : 'runtime_state_invalid'
  };
}

export async function waitForRunningMenuBarVersion(
  paths: ReturnType<typeof sksMenuBarPaths>,
  expectedVersion: string,
  expectedPid: number | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<SksMenuBarVersionProbe> {
  const timeout = timeoutFromEnv(env, 'SKS_MENUBAR_VERSION_PROBE_TIMEOUT_MS', 5_000);
  const interval = timeoutFromEnv(env, 'SKS_MENUBAR_VERSION_PROBE_INTERVAL_MS', 100);
  const deadline = Date.now() + timeout;
  let runtime = await inspectRunningMenuBarProcess(paths, expectedPid, env);
  while ((!runtime.ok || runtime.package_version !== expectedVersion) && Date.now() < deadline) {
    await delay(Math.min(interval, Math.max(1, deadline - Date.now())));
    runtime = await inspectRunningMenuBarProcess(paths, expectedPid, env);
  }
  const ok = runtime.ok && runtime.package_version === expectedVersion;
  const probe: SksMenuBarVersionProbe = {
    schema: 'sks.menubar-version-probe.v1',
    checked: true,
    ok,
    expected_version: expectedVersion,
    running_version: runtime.package_version,
    pid: runtime.pid,
    generated_at: new Date().toISOString(),
    persisted_path: paths.version_probe_path,
    error: ok ? null : runtime.ok ? 'menubar_running_version_mismatch' : runtime.error
  };
  try {
    await writeJsonAtomic(paths.version_probe_path, probe, { mode: 0o600 });
    return probe;
  } catch {
    return { ...probe, ok: false, error: 'menubar_version_probe_persist_failed' };
  }
}

async function printLaunchdService(launchctl: string, service: string, timeoutMs: number): Promise<LaunchdServiceProbe> {
  const result = await runProcess(launchctl, ['print', service], { timeoutMs, maxOutputBytes: 32 * 1024 })
    .catch((error: unknown) => failedProcess(error));
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const state = text.match(/^[ \t]*state = ([^\n]+)/m)?.[1]?.trim() || null;
  const pidText = text.match(/^[ \t]*pid = (\d+)/m)?.[1] || null;
  const activeCountText = text.match(/^[ \t]*active count = (\d+)/m)?.[1] || null;
  const pid = pidText ? Number(pidText) : null;
  const activeCount = activeCountText ? Number(activeCountText) : null;
  const running = result.code === 0 && state === 'running' && (Boolean(pid) || (activeCount !== null && activeCount > 0));
  return {
    code: result.code,
    timedOut: result.timedOut,
    running,
    state,
    pid,
    activeCount,
    error: running ? null : launchdProbeError(result.code, result.stderr, state, pid, activeCount)
  };
}

function launchdProbeError(
  code: number | null,
  stderr: string,
  state: string | null,
  pid: number | null,
  activeCount: number | null
): string {
  if (code !== 0) {
    const detail = String(stderr || '').trim().split(/\r?\n/, 1)[0]?.slice(0, 512) || '';
    return detail ? `launchctl_print_failed:${code}:${detail}` : `launchctl_print_failed:${code}`;
  }
  return `launchd_not_running:state=${errorToken(state || 'unknown')}:active_count=${activeCount ?? 'unknown'}:pid=${pid ?? 'none'}`;
}

function errorToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9._-]/g, '_');
}

function posixExtendedRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function exactMenuBarProcessIds(
  executablePaths: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number[]> {
  const pgrep = await processTool(env, 'SKS_MENUBAR_PGREP', '/usr/bin/pgrep');
  if (!pgrep || executablePaths.length === 0) return [];
  const found = new Set<number>();
  const result = await runProcess(pgrep, exactProcessArguments(executablePaths), {
    timeoutMs: 2_000,
    maxOutputBytes: 8 * 1024
  }).catch(() => ({ code: 1, stdout: '' }));
  if (result.code === 0) {
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) found.add(pid);
    }
    // Some test seams and older pgrep variants return success without -l output.
    if (!String(result.stdout || '').trim()) found.add(-1);
  }
  return [...found].sort((a, b) => a - b);
}

function exactProcessArguments(executablePaths: string[]): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const alternatives = executablePaths
    .map((executablePath) => posixExtendedRegexLiteral(path.resolve(executablePath)));
  const pattern = alternatives.length === 1
    ? `^${alternatives[0]}$`
    : `^(${alternatives.join('|')})$`;
  return [
    ...(uid === null ? [] : ['-U', String(uid)]),
    '-f',
    '-x',
    pattern
  ];
}

async function processTool(env: NodeJS.ProcessEnv | undefined, key: string, fallback: string): Promise<string | null> {
  const injected = env?.SKS_MENUBAR_TEST_PROCESS_TOOLS === '1' ? env[key] : null;
  if (injected) return injected;
  return fs.access(fallback).then(() => fallback).catch(() => null);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutFromEnv(env: NodeJS.ProcessEnv | undefined, key: string, fallback: number): number {
  const value = Number.parseInt(String(env?.[key] || ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function failedProcess(error: unknown) {
  const timedOut = Boolean(error && typeof error === 'object' && 'timedOut' in error && error.timedOut === true);
  return {
    code: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    timedOut
  };
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
