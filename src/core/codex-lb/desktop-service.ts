import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDir,
  exists,
  runProcess,
  which,
  writeTextAtomic
} from '../fsx.js';
import { loadCodexLbEnv, type CodexLbEnvLoadResult } from './codex-lb-env.js';
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  DESKTOP_BRIDGE_LAUNCHD_LABEL,
  desktopBridgeConfigGeneration,
  desktopBridgeLaunchdPlistPath,
  desktopBridgeProcessExists,
  desktopBridgeStatePath,
  getDesktopBridgeStatus,
  preflightDesktopBridge,
  readDesktopBridgeState,
  renderDesktopBridgeLaunchdPlist,
  safeBridgeErrorCode,
  selectAvailableDesktopBridgePort,
  startPreparedDesktopBridge,
  type DesktopBridgeConfig,
  type DesktopBridgeHandle,
  type DesktopBridgePublicState,
  type DesktopBridgeStatus
} from './desktop-bridge/index.js';
import {
  DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
  parseCodexLbGatewayAuthTransport,
  type CodexLbGatewayAuthTransport
} from './desktop-mode.js';

export const DEFAULT_CODEX_LB_DESKTOP_BRIDGE_HOST = '127.0.0.1' as const;
export const DEFAULT_CODEX_LB_DESKTOP_BRIDGE_PORT = 49_152;
export const CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA = 'sks.codex-lb-desktop-bridge-settings.v1' as const;
export const CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA = 'sks.codex-lb-desktop-bridge-service.v1' as const;

const DEFAULT_ALLOWED_ORIGINS = ['app://codex'] as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface DesktopBridgeServiceSettings {
  schema: typeof CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA;
  listen_host: '127.0.0.1' | '::1';
  listen_port: number;
  gateway_auth_transport: CodexLbGatewayAuthTransport;
  allowed_origins: string[];
  connect_timeout_ms: number;
  idle_timeout_ms: number;
}

export interface DesktopBridgeServicePaths {
  settings_path: string;
  state_path: string;
  launch_agent_path: string;
  stdout_log_path: string;
  stderr_log_path: string;
}

export interface DesktopBridgeServiceStatus {
  schema: typeof CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA;
  ok: boolean;
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  status: DesktopBridgeStatus['status'] | 'unsupported' | 'settings_missing' | 'credentials_unavailable';
  service: string;
  paths: DesktopBridgeServicePaths;
  state: DesktopBridgePublicState | null;
  settings: DesktopBridgeServiceSettings | null;
  expected_config_generation: string | null;
  credential_source: CodexLbEnvLoadResult['source'] | null;
  blockers: string[];
}

export interface DesktopBridgeServiceOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  metadataPath?: string;
  settings?: Partial<Omit<DesktopBridgeServiceSettings, 'schema'>>;
  settingsPath?: string;
  statePath?: string;
  launchAgentPath?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  launchctl?: string;
  executablePath?: string;
  executableArguments?: string[];
  run?: typeof runProcess;
  processExists?: (pid: number) => boolean;
  selectAvailablePort?: typeof selectAvailableDesktopBridgePort;
}

export function desktopBridgeServicePaths(
  home = process.env.HOME || os.homedir()
): DesktopBridgeServicePaths {
  const resolvedHome = path.resolve(home);
  const runtimeDir = path.join(resolvedHome, '.codex', 'sks');
  const logDir = path.join(runtimeDir, 'logs');
  return {
    settings_path: path.join(runtimeDir, 'codex-lb-desktop-bridge-settings.json'),
    state_path: desktopBridgeStatePath(resolvedHome),
    launch_agent_path: desktopBridgeLaunchdPlistPath(resolvedHome),
    stdout_log_path: path.join(logDir, 'codex-lb-desktop-bridge.out.log'),
    stderr_log_path: path.join(logDir, 'codex-lb-desktop-bridge.err.log')
  };
}

export function defaultDesktopBridgeServiceSettings(
  input: Partial<Omit<DesktopBridgeServiceSettings, 'schema'>> = {}
): DesktopBridgeServiceSettings {
  return validateDesktopBridgeServiceSettings({
    schema: CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA,
    listen_host: input.listen_host || DEFAULT_CODEX_LB_DESKTOP_BRIDGE_HOST,
    listen_port: input.listen_port ?? DEFAULT_CODEX_LB_DESKTOP_BRIDGE_PORT,
    gateway_auth_transport: parseCodexLbGatewayAuthTransport(
      input.gateway_auth_transport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT
    ),
    allowed_origins: [...(input.allowed_origins || DEFAULT_ALLOWED_ORIGINS)],
    connect_timeout_ms: input.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS,
    idle_timeout_ms: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS
  });
}

export async function resolveDesktopBridgeActivationSettings(
  options: DesktopBridgeServiceOptions = {}
): Promise<DesktopBridgeServiceSettings> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const paths = overridePaths(desktopBridgeServicePaths(home), options);
  const persisted = await readDesktopBridgeServiceSettings(paths.settings_path);
  const listenHost = options.settings?.listen_host
    || persisted?.listen_host
    || DEFAULT_CODEX_LB_DESKTOP_BRIDGE_HOST;
  const listenPort = options.settings?.listen_port
    ?? persisted?.listen_port
    ?? await (options.selectAvailablePort || selectAvailableDesktopBridgePort)(listenHost);
  return defaultDesktopBridgeServiceSettings({
    ...(persisted || {}),
    ...(options.settings || {}),
    listen_host: listenHost,
    listen_port: listenPort
  });
}

export async function readDesktopBridgeServiceSettings(
  file: string
): Promise<DesktopBridgeServiceSettings | null> {
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('desktop_bridge_settings_not_regular_file');
  }
  if ((stat.mode & 0o077) !== 0) throw new Error('desktop_bridge_settings_permissions_unsafe');
  const raw = await fsp.readFile(file, 'utf8');
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('desktop_bridge_settings_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('desktop_bridge_settings_invalid_json');
  }
  return validateDesktopBridgeServiceSettings(parsed);
}

export async function writeDesktopBridgeServiceSettings(
  file: string,
  settings: DesktopBridgeServiceSettings
): Promise<void> {
  const validated = validateDesktopBridgeServiceSettings(settings);
  await writeTextAtomic(file, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(file, 0o600);
}

export async function resolveDesktopBridgeRuntimeConfig(
  options: DesktopBridgeServiceOptions = {}
): Promise<{
  config: DesktopBridgeConfig;
  settings: DesktopBridgeServiceSettings;
  loaded_env: CodexLbEnvLoadResult;
  paths: DesktopBridgeServicePaths;
}> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const defaults = desktopBridgeServicePaths(home);
  const paths = overridePaths(defaults, options);
  const persisted = await readDesktopBridgeServiceSettings(paths.settings_path);
  const settings = defaultDesktopBridgeServiceSettings({
    ...(persisted || {}),
    ...(options.settings || {})
  });
  const loadedEnv = await loadCodexLbEnv({
    home,
    ...(options.envPath ? { envPath: options.envPath } : {}),
    ...(options.metadataPath ? { metadataPath: options.metadataPath } : {}),
    ...(options.env ? { processEnv: options.env } : {})
  });
  if (!loadedEnv.base_url || !loadedEnv.secret_api_key || !loadedEnv.configured) {
    throw new Error(
      loadedEnv.credential_binding.blockers[0]
      || loadedEnv.missing[0]
      || 'codex_lb_credentials_unavailable'
    );
  }
  return {
    config: {
      listenHost: settings.listen_host,
      listenPort: settings.listen_port,
      remoteBaseUrl: loadedEnv.base_url,
      gatewayKey: loadedEnv.secret_api_key,
      gatewayAuthTransport: settings.gateway_auth_transport,
      allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
      allowedOrigins: settings.allowed_origins,
      connectTimeoutMs: settings.connect_timeout_ms,
      idleTimeoutMs: settings.idle_timeout_ms
    },
    settings,
    loaded_env: loadedEnv,
    paths
  };
}

export async function desktopBridgeServiceStatus(
  options: DesktopBridgeServiceOptions = {}
): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const paths = overridePaths(desktopBridgeServicePaths(home), options);
  const service = desktopBridgeLaunchService(options.uid);
  if ((options.platform || process.platform) !== 'darwin') {
    return {
      schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA,
      ok: false,
      supported: false,
      installed: await exists(paths.launch_agent_path),
      loaded: false,
      running: false,
      status: 'unsupported',
      service,
      paths,
      state: await readDesktopBridgeState(paths.state_path).catch(() => null),
      settings: await readDesktopBridgeServiceSettings(paths.settings_path).catch(() => null),
      expected_config_generation: null,
      credential_source: null,
      blockers: ['desktop_bridge_service_requires_macos']
    };
  }

  const installed = await exists(paths.launch_agent_path);
  const settings = await readDesktopBridgeServiceSettings(paths.settings_path).catch(() => null);
  let expectedConfigGeneration: string | null = null;
  let credentialSource: CodexLbEnvLoadResult['source'] | null = null;
  const credentialBlockers: string[] = [];
  if (settings) {
    try {
      const runtime = await resolveDesktopBridgeRuntimeConfig({ ...options, home, settingsPath: paths.settings_path });
      expectedConfigGeneration = desktopBridgeConfigGeneration(runtime.config);
      credentialSource = runtime.loaded_env.source;
    } catch (error: unknown) {
      credentialBlockers.push(safeServiceError(error));
    }
  }
  const bridgeStatus = await getDesktopBridgeStatus({
    statePath: paths.state_path,
    ...(expectedConfigGeneration ? { expectedConfigGeneration } : {}),
    ...(options.processExists ? { processExists: options.processExists } : {})
  });
  const launchd = await inspectLaunchdService(options, service);
  const blockers = [
    ...(settings ? [] : ['desktop_bridge_settings_missing']),
    ...credentialBlockers,
    ...(bridgeStatus.status === 'running' ? [] : [bridgeStatusBlocker(bridgeStatus)]),
    ...(launchd.loaded && !launchd.running ? ['desktop_bridge_launchd_not_running'] : [])
  ].filter(Boolean);
  const running = bridgeStatus.status === 'running';
  return {
    schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA,
    ok: running && blockers.length === 0,
    supported: true,
    installed,
    loaded: launchd.loaded,
    running,
    status: !settings
      ? 'settings_missing'
      : credentialBlockers.length
        ? 'credentials_unavailable'
        : bridgeStatus.status,
    service,
    paths,
    state: bridgeStatus.state,
    settings,
    expected_config_generation: expectedConfigGeneration,
    credential_source: credentialSource,
    blockers
  };
}

export async function installAndStartDesktopBridgeService(
  options: DesktopBridgeServiceOptions = {}
): Promise<DesktopBridgeServiceStatus> {
  const platform = options.platform || process.platform;
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const paths = overridePaths(desktopBridgeServicePaths(home), options);
  if (platform !== 'darwin') {
    return desktopBridgeServiceStatus({ ...options, home, platform });
  }
  const settings = await resolveDesktopBridgeActivationSettings({
    ...options,
    home,
    settingsPath: paths.settings_path
  });
  const loadedEnv = await loadCodexLbEnv({
    home,
    ...(options.envPath ? { envPath: options.envPath } : {}),
    ...(options.metadataPath ? { metadataPath: options.metadataPath } : {}),
    ...(options.env ? { processEnv: options.env } : {})
  });
  if (!loadedEnv.base_url || !loadedEnv.secret_api_key || !loadedEnv.configured) {
    return {
      schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA,
      ok: false,
      supported: true,
      installed: await exists(paths.launch_agent_path),
      loaded: false,
      running: false,
      status: 'credentials_unavailable',
      service: desktopBridgeLaunchService(options.uid),
      paths,
      state: await readDesktopBridgeState(paths.state_path).catch(() => null),
      settings,
      expected_config_generation: null,
      credential_source: loadedEnv.source,
      blockers: [
        loadedEnv.credential_binding.blockers[0]
        || loadedEnv.missing[0]
        || 'codex_lb_credentials_unavailable'
      ]
    };
  }
  const config: DesktopBridgeConfig = {
    listenHost: settings.listen_host,
    listenPort: settings.listen_port,
    remoteBaseUrl: loadedEnv.base_url,
    gatewayKey: loadedEnv.secret_api_key,
    gatewayAuthTransport: settings.gateway_auth_transport,
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: settings.allowed_origins,
    connectTimeoutMs: settings.connect_timeout_ms,
    idleTimeoutMs: settings.idle_timeout_ms
  };
  try {
    await preflightDesktopBridge(config);
  } catch (error: unknown) {
    return failedServiceStatus({
      paths,
      settings,
      service: desktopBridgeLaunchService(options.uid),
      status: 'credentials_unavailable',
      credentialSource: loadedEnv.source,
      expectedConfigGeneration: desktopBridgeConfigGeneration(config),
      blocker: safeBridgeErrorCode(error)
    });
  }

  const launchCommand = await resolveDesktopBridgeLaunchCommand(options);
  if (!launchCommand) {
    return failedServiceStatus({
      paths,
      settings,
      service: desktopBridgeLaunchService(options.uid),
      status: 'settings_missing',
      credentialSource: loadedEnv.source,
      expectedConfigGeneration: desktopBridgeConfigGeneration(config),
      blocker: 'desktop_bridge_sks_executable_missing'
    });
  }
  await Promise.all([
    ensureDir(path.dirname(paths.settings_path)),
    ensureDir(path.dirname(paths.launch_agent_path)),
    ensureDir(path.dirname(paths.stdout_log_path))
  ]);
  await writeDesktopBridgeServiceSettings(paths.settings_path, settings);
  const launchArguments = [
    ...launchCommand.arguments,
    'codex-lb',
    'bridge',
    'serve',
    '--settings',
    paths.settings_path,
    '--json'
  ];
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: launchCommand.executable,
    arguments: launchArguments,
    stdoutPath: paths.stdout_log_path,
    stderrPath: paths.stderr_log_path
  });
  await writeTextAtomic(paths.launch_agent_path, plist, { mode: 0o600 });
  await fsp.chmod(paths.launch_agent_path, 0o600);

  const run = options.run || runProcess;
  const launchctl = options.launchctl || '/bin/launchctl';
  const domain = desktopBridgeLaunchDomain(options.uid);
  const service = desktopBridgeLaunchService(options.uid);
  await run(launchctl, ['bootout', service], {
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  }).catch(() => undefined);
  await run(launchctl, ['bootout', domain, paths.launch_agent_path], {
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  }).catch(() => undefined);
  await removeStaleBridgeState(paths.state_path, options.processExists);
  const bootstrap = await run(launchctl, ['bootstrap', domain, paths.launch_agent_path], {
    timeoutMs: 10_000,
    maxOutputBytes: 32 * 1024
  }).catch((error: unknown) => failedProcess(error));
  if (bootstrap.code !== 0 && !bootstrap.timedOut) {
    return failedServiceStatus({
      paths,
      settings,
      service,
      status: 'missing',
      credentialSource: loadedEnv.source,
      expectedConfigGeneration: desktopBridgeConfigGeneration(config),
      blocker: 'desktop_bridge_launchd_bootstrap_failed'
    });
  }
  await run(launchctl, ['kickstart', '-k', service], {
    timeoutMs: 10_000,
    maxOutputBytes: 32 * 1024
  }).catch(() => undefined);
  const status = await waitForDesktopBridge({
    ...options,
    home,
    platform,
    settingsPath: paths.settings_path,
    statePath: paths.state_path,
    launchAgentPath: paths.launch_agent_path,
    stdoutLogPath: paths.stdout_log_path,
    stderrLogPath: paths.stderr_log_path
  });
  if (!status.ok) {
    await run(launchctl, ['bootout', service], {
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024
    }).catch(() => undefined);
  }
  return status;
}

export async function bootstrapExistingDesktopBridgeService(
  options: DesktopBridgeServiceOptions = {}
): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const paths = overridePaths(desktopBridgeServicePaths(home), options);
  if ((options.platform || process.platform) !== 'darwin') {
    return desktopBridgeServiceStatus({ ...options, home });
  }
  if (!(await exists(paths.launch_agent_path)) || !(await exists(paths.settings_path))) {
    return desktopBridgeServiceStatus({ ...options, home });
  }
  const run = options.run || runProcess;
  const launchctl = options.launchctl || '/bin/launchctl';
  const domain = desktopBridgeLaunchDomain(options.uid);
  const service = desktopBridgeLaunchService(options.uid);
  await run(launchctl, ['bootout', service], {
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  }).catch(() => undefined);
  const bootstrap = await run(launchctl, ['bootstrap', domain, paths.launch_agent_path], {
    timeoutMs: 10_000,
    maxOutputBytes: 32 * 1024
  }).catch((error: unknown) => failedProcess(error));
  if (bootstrap.code === 0 || bootstrap.timedOut) {
    await run(launchctl, ['kickstart', '-k', service], {
      timeoutMs: 10_000,
      maxOutputBytes: 32 * 1024
    }).catch(() => undefined);
  }
  return waitForDesktopBridge({ ...options, home });
}

export async function stopDesktopBridgeService(
  options: DesktopBridgeServiceOptions & {
    removePlist?: boolean;
    removeSettings?: boolean;
  } = {}
): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const paths = overridePaths(desktopBridgeServicePaths(home), options);
  if ((options.platform || process.platform) !== 'darwin') {
    return desktopBridgeServiceStatus({ ...options, home });
  }
  const run = options.run || runProcess;
  const launchctl = options.launchctl || '/bin/launchctl';
  const service = desktopBridgeLaunchService(options.uid);
  await run(launchctl, ['bootout', service], {
    timeoutMs: 8_000,
    maxOutputBytes: 32 * 1024
  }).catch(() => undefined);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await readDesktopBridgeState(paths.state_path).catch(() => null);
    if (!state || !(options.processExists || desktopBridgeProcessExists)(state.pid)) break;
    await delay(100);
  }
  await removeStaleBridgeState(paths.state_path, options.processExists);
  if (options.removePlist === true) await fsp.unlink(paths.launch_agent_path).catch(() => undefined);
  if (options.removeSettings === true) await fsp.unlink(paths.settings_path).catch(() => undefined);
  const status = await desktopBridgeServiceStatus({ ...options, home });
  return {
    ...status,
    ok: !status.running,
    blockers: status.running ? ['desktop_bridge_process_still_running'] : []
  };
}

export async function serveDesktopBridge(
  options: DesktopBridgeServiceOptions = {}
): Promise<{
  schema: 'sks.codex-lb-desktop-bridge-serve.v1';
  ok: boolean;
  status: 'stopped' | 'failed';
  state: DesktopBridgePublicState | null;
  blocker?: string;
}> {
  let handle: DesktopBridgeHandle | null = null;
  try {
    const runtime = await resolveDesktopBridgeRuntimeConfig(options);
    const prepared = await preflightDesktopBridge(runtime.config);
    handle = await startPreparedDesktopBridge(prepared, { statePath: runtime.paths.state_path });
    process.stdout.write(`${JSON.stringify({
      schema: 'sks.codex-lb-desktop-bridge-log.v1',
      event: 'sks.codex_lb.bridge.started',
      pid: handle.state.pid,
      listen_origin: handle.state.listen_origin,
      remote_origin_sha256: handle.state.remote_origin_sha256,
      gateway_auth_transport: handle.state.gateway_auth_transport,
      secret_fields_redacted: true
    })}\n`);
    await waitForShutdownSignal(handle);
    return {
      schema: 'sks.codex-lb-desktop-bridge-serve.v1',
      ok: true,
      status: 'stopped',
      state: handle.state
    };
  } catch (error: unknown) {
    return {
      schema: 'sks.codex-lb-desktop-bridge-serve.v1',
      ok: false,
      status: 'failed',
      state: handle?.state || null,
      blocker: safeServiceError(error)
    };
  } finally {
    if (handle) await handle.stop().catch(() => undefined);
  }
}

function validateDesktopBridgeServiceSettings(value: unknown): DesktopBridgeServiceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop_bridge_settings_invalid');
  }
  const row = value as Record<string, unknown>;
  if (row.schema !== CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA) {
    throw new Error('desktop_bridge_settings_schema_invalid');
  }
  const listenHost = row.listen_host;
  const listenPort = Number(row.listen_port);
  const gatewayAuthTransport = parseCodexLbGatewayAuthTransport(row.gateway_auth_transport);
  const allowedOrigins = Array.isArray(row.allowed_origins)
    ? row.allowed_origins.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const connectTimeoutMs = Number(row.connect_timeout_ms);
  const idleTimeoutMs = Number(row.idle_timeout_ms);
  if (listenHost !== '127.0.0.1' && listenHost !== '::1') {
    throw new Error('desktop_bridge_settings_listen_host_invalid');
  }
  if (!Number.isInteger(listenPort) || listenPort < 49_152 || listenPort > 65_535) {
    throw new Error('desktop_bridge_settings_listen_port_invalid');
  }
  if (!allowedOrigins.length) throw new Error('desktop_bridge_settings_allowed_origins_empty');
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 120_000) {
    throw new Error('desktop_bridge_settings_connect_timeout_invalid');
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1_000 || idleTimeoutMs > 86_400_000) {
    throw new Error('desktop_bridge_settings_idle_timeout_invalid');
  }
  return {
    schema: CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA,
    listen_host: listenHost,
    listen_port: listenPort,
    gateway_auth_transport: gatewayAuthTransport,
    allowed_origins: [...new Set(allowedOrigins)],
    connect_timeout_ms: connectTimeoutMs,
    idle_timeout_ms: idleTimeoutMs
  };
}

function overridePaths(
  defaults: DesktopBridgeServicePaths,
  options: DesktopBridgeServiceOptions
): DesktopBridgeServicePaths {
  return {
    settings_path: options.settingsPath || defaults.settings_path,
    state_path: options.statePath || defaults.state_path,
    launch_agent_path: options.launchAgentPath || defaults.launch_agent_path,
    stdout_log_path: options.stdoutLogPath || defaults.stdout_log_path,
    stderr_log_path: options.stderrLogPath || defaults.stderr_log_path
  };
}

function desktopBridgeLaunchDomain(uid = typeof process.getuid === 'function' ? process.getuid() : 0): string {
  return `gui/${uid}`;
}

function desktopBridgeLaunchService(uid?: number): string {
  return `${desktopBridgeLaunchDomain(uid)}/${DESKTOP_BRIDGE_LAUNCHD_LABEL}`;
}

async function resolveDesktopBridgeLaunchCommand(
  options: DesktopBridgeServiceOptions
): Promise<{ executable: string; arguments: string[] } | null> {
  if (options.executablePath) {
    const executable = path.resolve(options.executablePath);
    return await exists(executable)
      ? { executable, arguments: [...(options.executableArguments || [])] }
      : null;
  }
  const entry = String(process.argv[1] || '').trim();
  const entryName = path.basename(entry).replace(/\.js$/i, '');
  if (
    entry
    && (entryName === 'sks' || entryName === 'sneakoscope')
    && await exists(entry)
  ) {
    return {
      executable: path.resolve(process.execPath),
      arguments: [path.resolve(entry)]
    };
  }
  const sks = await which('sks').catch(() => null);
  if (sks) return { executable: path.resolve(sks), arguments: [] };
  return null;
}

async function inspectLaunchdService(
  options: DesktopBridgeServiceOptions,
  service: string
): Promise<{ loaded: boolean; running: boolean }> {
  if ((options.platform || process.platform) !== 'darwin') return { loaded: false, running: false };
  const run = options.run || runProcess;
  const launchctl = options.launchctl || '/bin/launchctl';
  const result = await run(launchctl, ['print', service], {
    timeoutMs: 3_000,
    maxOutputBytes: 32 * 1024
  }).catch(() => null);
  if (!result || result.code !== 0) return { loaded: false, running: false };
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const state = text.match(/^[ \t]*state = ([^\n]+)/m)?.[1]?.trim() || null;
  const pid = Number(text.match(/^[ \t]*pid = (\d+)/m)?.[1] || 0);
  return { loaded: true, running: state === 'running' && pid > 0 };
}

async function waitForDesktopBridge(
  options: DesktopBridgeServiceOptions
): Promise<DesktopBridgeServiceStatus> {
  let status = await desktopBridgeServiceStatus(options);
  for (let attempt = 0; attempt < 40 && !status.ok; attempt += 1) {
    await delay(100);
    status = await desktopBridgeServiceStatus(options);
  }
  return status;
}

async function removeStaleBridgeState(
  statePath: string,
  processExists: ((pid: number) => boolean) | undefined
): Promise<void> {
  const state = await readDesktopBridgeState(statePath).catch(() => null);
  if (!state || !(processExists || desktopBridgeProcessExists)(state.pid)) {
    await fsp.unlink(statePath).catch(() => undefined);
  }
}

async function waitForShutdownSignal(handle: DesktopBridgeHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    handle.server.once('close', finish);
  });
}

function failedServiceStatus(input: {
  paths: DesktopBridgeServicePaths;
  settings: DesktopBridgeServiceSettings;
  service: string;
  status: DesktopBridgeServiceStatus['status'];
  credentialSource: CodexLbEnvLoadResult['source'] | null;
  expectedConfigGeneration: string | null;
  blocker: string;
}): DesktopBridgeServiceStatus {
  return {
    schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA,
    ok: false,
    supported: true,
    installed: false,
    loaded: false,
    running: false,
    status: input.status,
    service: input.service,
    paths: input.paths,
    state: null,
    settings: input.settings,
    expected_config_generation: input.expectedConfigGeneration,
    credential_source: input.credentialSource,
    blockers: [input.blocker]
  };
}

function bridgeStatusBlocker(status: DesktopBridgeStatus): string {
  if (status.status === 'missing') return 'desktop_bridge_state_missing';
  if (status.status === 'running') return '';
  return status.blocker;
}

function safeServiceError(error: unknown): string {
  const bridge = safeBridgeErrorCode(error);
  if (bridge !== 'bridge_upstream_unavailable') return bridge;
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]+$/i.test(message) ? message : 'desktop_bridge_service_failed';
}

function failedProcess(error: unknown) {
  return {
    code: 1,
    stdout: '',
    stderr: safeServiceError(error),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    timedOut: false
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
