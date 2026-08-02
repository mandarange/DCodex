import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists, readText, writeTextAtomic } from '../fsx.js';
import {
  CODEX_LB_SECURE_KEYCHAIN_SERVICE,
  codexLbBaseUrlSecurityBlocker,
  codexLbEnvPath,
  codexLbMetadataPath,
  normalizeCodexLbBaseUrl
} from './codex-lb-env.js';
import {
  DEFAULT_CODEX_LB_DESKTOP_MODE,
  DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
  type CodexLbDesktopMode,
  type CodexLbGatewayAuthTransport
} from './desktop-mode.js';

export type CodexLbApiKeySource = 'hidden_prompt' | 'stdin' | 'keychain_existing';
export type CodexLbShellProfileChoice = 'zsh' | 'bash' | 'fish' | 'all' | 'skip';
export type CodexLbPersistenceMode =
  | 'durable_env_file'
  | 'durable_keychain'
  | 'shell_profile'
  | 'process_only_ephemeral'
  | 'none';
export type CodexLbSetupActionType =
  | 'write_cli_provider'
  | 'configure_desktop_native_bridge'
  | 'configure_desktop_compat_provider'
  | 'start_desktop_bridge'
  | 'verify_oauth_preserved'
  | 'write_env_file'
  | 'store_keychain'
  | 'sync_launchctl'
  | 'install_shell_profile_snippet'
  | 'run_capability_check'
  | 'write_metadata';

export interface CodexLbSetupAnswers {
  host_or_base_url: string;
  api_key_source: CodexLbApiKeySource;
  desktop_mode?: CodexLbDesktopMode;
  gateway_auth_transport?: CodexLbGatewayAuthTransport;
  /** @deprecated Accepted only so older callers can render a safe native plan. */
  use_as_default_provider?: boolean;
  write_env_file: boolean;
  store_keychain: boolean;
  /** Internal dependency contract for a dedicated, identity-verified helper. */
  keychain_helper_verified?: boolean;
  sync_launchctl: boolean;
  install_shell_profile: CodexLbShellProfileChoice;
  run_health_check: boolean;
  allow_insecure_localhost: boolean;
}

export interface CodexLbSetupAction {
  type: CodexLbSetupActionType;
  target: string;
  effect: string;
  command?: string;
}

export interface CodexLbSetupPlan {
  schema: 'sks.codex-lb-setup-plan.v1';
  base_url: string;
  actions: CodexLbSetupAction[];
  expected_actions: CodexLbSetupAction[];
  selected_persistence_modes: CodexLbPersistenceMode[];
  persistence: CodexLbPersistenceSummary;
  redactions: string[];
  warnings: string[];
  blockers: string[];
}

export interface CodexLbPersistenceSummary {
  selected_modes: CodexLbPersistenceMode[];
  applied_modes: CodexLbPersistenceMode[];
  effective_mode: CodexLbPersistenceMode;
  durable: boolean;
  warning: string | null;
  warnings: string[];
}

export function buildCodexLbSetupPlan(answers: CodexLbSetupAnswers, opts: {
  home?: string;
  configPath?: string;
  envPath?: string;
  metadataPath?: string;
} = {}): CodexLbSetupPlan {
  const home = opts.home || process.env.HOME || os.homedir();
  const baseUrl = normalizeCodexLbBaseUrl(answers.host_or_base_url);
  const configPath = opts.configPath || path.join(home, '.codex', 'config.toml');
  const envPath = opts.envPath || codexLbEnvPath(home);
  const metadataPath = opts.metadataPath || codexLbMetadataPath(home);
  const desktopMode = answers.desktop_mode || DEFAULT_CODEX_LB_DESKTOP_MODE;
  const gatewayAuthTransport = answers.gateway_auth_transport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT;
  const blockers: string[] = [];
  if (!baseUrl) blockers.push('missing_host_or_base_url');
  else {
    const transportBlocker = codexLbBaseUrlSecurityBlocker(baseUrl);
    if (transportBlocker) blockers.push(transportBlocker);
  }
  if (answers.install_shell_profile !== 'skip' && !answers.write_env_file) blockers.push('shell_profile_snippet_requires_env_file');
  if (answers.store_keychain && answers.keychain_helper_verified !== true) {
    blockers.push('keychain_acl_helper_unavailable');
  }
  const actions: CodexLbSetupAction[] = [];
  if (desktopMode === 'desktop-native-bridge') {
    actions.push({
      type: 'configure_desktop_native_bridge',
      target: configPath,
      effect: `keep built-in OpenAI and ChatGPT OAuth, route model traffic through a loopback bridge, and use explicit gateway auth transport ${gatewayAuthTransport}`
    });
    actions.push({
      type: 'start_desktop_bridge',
      target: 'SKS Codex Desktop bridge',
      effect: 'start the loopback-only bridge without changing Codex Desktop auth'
    });
    actions.push({
      type: 'verify_oauth_preserved',
      target: path.join(home, '.codex', 'auth.json'),
      effect: 'verify byte identity before App restart and semantic OAuth identity afterward'
    });
  } else if (desktopMode === 'desktop-dual-auth-compat') {
    blockers.push('desktop_dual_auth_compat_requires_global_secret_environment');
    if (gatewayAuthTransport !== 'x-codex-lb-api-key') {
      blockers.push('desktop_compat_requires_x_codex_lb_api_key_transport');
    }
    actions.push({
      type: 'configure_desktop_compat_provider',
      target: configPath,
      effect: 'configure exact provider name "OpenAI", retain ChatGPT OAuth, and send the separate LB key only with X-Codex-LB-API-Key'
    });
    actions.push({
      type: 'verify_oauth_preserved',
      target: path.join(home, '.codex', 'auth.json'),
      effect: 'verify Desktop configuration did not change shared OAuth bytes'
    });
  } else if (desktopMode === 'cli-provider') {
    actions.push({
      type: 'write_cli_provider',
      target: configPath,
      effect: answers.use_as_default_provider === true
        ? 'atomically write and select the codex-lb provider using CODEX_LB_API_KEY without changing auth.json'
        : 'write an unselected CLI-only codex-lb provider using CODEX_LB_API_KEY without changing Desktop OAuth'
    });
  }
  if (answers.write_env_file) {
    actions.push({ type: 'write_env_file', target: envPath, effect: 'write CODEX_LB_BASE_URL and redacted CODEX_LB_API_KEY env loader with chmod 0600' });
  }
  if (answers.store_keychain) {
    actions.push({
      type: 'store_keychain',
      target: `macOS Keychain service ${CODEX_LB_SECURE_KEYCHAIN_SERVICE}`,
      effect: 'blocked until SKS ships a dedicated signed Keychain helper; reusable interpreters are never trusted for secret access'
    });
  }
  if (answers.sync_launchctl) {
    const cliProviderSelected = desktopMode === 'cli-provider'
      && answers.use_as_default_provider === true;
    actions.push({
      type: 'sync_launchctl',
      target: 'macOS launchctl user environment',
      effect: cliProviderSelected
        ? 'set CODEX_LB_API_KEY and CODEX_LB_BASE_URL from the canonical owner-only env file for selected CLI-provider mode'
        : 'remove CODEX_LB_API_KEY outside selected CLI-provider mode and reconcile the non-secret base URL for the chosen mode',
      command: cliProviderSelected
        ? 'launchctl setenv CODEX_LB_API_KEY <canonical-env-file-value>; launchctl setenv CODEX_LB_BASE_URL ...; launchctl unsetenv OPENROUTER_API_KEY'
        : 'launchctl unsetenv CODEX_LB_API_KEY OPENROUTER_API_KEY; reconcile CODEX_LB_BASE_URL for the chosen mode'
    });
  }
  if (answers.install_shell_profile !== 'skip') {
    actions.push({ type: 'install_shell_profile_snippet', target: profileTargets(home, answers.install_shell_profile).join(', '), effect: `install managed shell snippet for ${answers.install_shell_profile}` });
  }
  if (answers.run_health_check) {
    actions.push({ type: 'run_capability_check', target: 'codex-lb response chain', effect: 'run codex-lb capability check after apply' });
  }
  actions.push({ type: 'write_metadata', target: metadataPath, effect: 'write redacted setup metadata and key fingerprint with chmod 0600' });
  const selectedModes = selectedCodexLbPersistenceModes(answers);
  const persistence = codexLbPersistenceSummary({
    selectedModes,
    appliedModes: selectedModes.length ? [] : ['process_only_ephemeral'],
    processOnly: selectedModes.length === 0
  });
  return {
    schema: 'sks.codex-lb-setup-plan.v1',
    base_url: baseUrl,
    actions,
    expected_actions: actions,
    selected_persistence_modes: selectedModes.length ? selectedModes : ['process_only_ephemeral'],
    persistence,
    redactions: ['CODEX_LB_API_KEY', 'api_key', 'sk-*', 'sk-clb-*'],
    warnings: persistence.warnings,
    blockers
  };
}

export function renderCodexLbSetupPlan(plan: CodexLbSetupPlan): string {
  const lines = [
    'codex-lb setup plan',
    `base_url: ${plan.base_url || '(missing)'}`,
    'actions:'
  ];
  for (const action of plan.actions) lines.push(`- ${action.type}: ${action.target} (${action.effect})`);
  if (plan.persistence.warning) lines.push(`warning: ${plan.persistence.warning}`);
  if (plan.blockers.length) {
    lines.push('blockers:');
    for (const blocker of plan.blockers) lines.push(`- ${blocker}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function installCodexLbShellProfileSnippet(opts: {
  home?: string;
  envPath: string;
  shellProfile: CodexLbShellProfileChoice;
  expectedFiles?: Array<{
    path: string;
    existed: boolean;
    kind: string;
    bytes_base64: string;
    mode: number | null;
  }>;
  writeFileIfUnchanged?: (input: {
    file: string;
    expected: {
      path: string;
      existed: boolean;
      kind: string;
      bytes_base64: string;
      mode: number | null;
    };
    text: string;
    mode: number;
  }) => Promise<{
    ok: boolean;
    status: string;
    installed?: boolean;
    recovery_path?: string;
    error?: string;
  }>;
  onFileWritten?: (input: { file: string; text: string; mode: number }) => void | Promise<void>;
}): Promise<{
  ok: boolean;
  status: string;
  files: string[];
  recovery_paths?: string[];
  skipped?: boolean;
  reason?: string;
  error?: string;
}> {
  if (opts.shellProfile === 'skip') return { ok: true, status: 'skipped', skipped: true, files: [] };
  if (!(await exists(opts.envPath))) {
    return { ok: true, status: 'skipped', skipped: true, reason: 'env_file_not_written', files: [] };
  }
  if (Boolean(opts.expectedFiles) !== Boolean(opts.writeFileIfUnchanged)) {
    return {
      ok: false,
      status: 'setup_cas_contract_incomplete',
      files: [],
      error: 'expectedFiles and writeFileIfUnchanged must be provided together'
    };
  }
  const home = opts.home || process.env.HOME || os.homedir();
  const targets = profileTargets(home, opts.shellProfile);
  const files: string[] = [];
  const recoveryPaths: string[] = [];
  for (const file of targets) {
    const expected = opts.expectedFiles?.find((entry) => path.resolve(entry.path) === path.resolve(file));
    if (opts.expectedFiles && !expected) {
      return {
        ok: false,
        status: 'setup_snapshot_missing',
        files,
        recovery_paths: recoveryPaths,
        error: `setup_snapshot_missing:${file}`
      };
    }
    if (expected?.existed === true && expected.kind !== 'regular') {
      return {
        ok: false,
        status: 'unsafe_setup_write_target',
        files,
        recovery_paths: recoveryPaths,
        error: `unsafe_setup_write_target:${file}:${expected.kind}`
      };
    }
    const current = expected
      ? (expected.existed === true
          ? Buffer.from(String(expected.bytes_base64 || ''), 'base64').toString('utf8')
          : '')
      : await readText(file, '');
    const block = shellProfileBlock(file, opts.envPath);
    const text = upsertManagedBlock(current, block);
    const existingMode = expected
      ? (expected.existed === true ? Number(expected.mode) & 0o777 : null)
      : await fsp.lstat(file)
        .then((stat) => stat.isFile() && !stat.isSymbolicLink() ? stat.mode & 0o777 : null)
        .catch(() => null);
    const mode = existingMode ?? (0o666 & ~process.umask());
    if (expected && opts.writeFileIfUnchanged) {
      const result = await opts.writeFileIfUnchanged({ file, expected, text, mode });
      if (result.recovery_path) recoveryPaths.push(result.recovery_path);
      if (!result.ok) {
        return {
          ok: false,
          status: result.status,
          files,
          recovery_paths: recoveryPaths,
          error: result.error || `${result.status}:${file}`
        };
      }
    } else {
      await ensureDir(path.dirname(file));
      await writeTextAtomic(file, text);
    }
    await opts.onFileWritten?.({ file, text, mode });
    files.push(file);
  }
  return {
    ok: true,
    status: 'installed',
    files,
    ...(recoveryPaths.length ? { recovery_paths: recoveryPaths } : {})
  };
}

export function selectedCodexLbPersistenceModes(answers: Pick<CodexLbSetupAnswers, 'write_env_file' | 'store_keychain' | 'sync_launchctl' | 'install_shell_profile'>): CodexLbPersistenceMode[] {
  const modes: CodexLbPersistenceMode[] = [];
  if (answers.write_env_file) modes.push('durable_env_file');
  if (answers.store_keychain) modes.push('durable_keychain');
  if (answers.install_shell_profile !== 'skip') modes.push('shell_profile');
  return modes;
}

export function codexLbPersistenceSummary({
  selectedModes = [],
  appliedModes = [],
  processOnly = false
}: {
  selectedModes?: CodexLbPersistenceMode[];
  appliedModes?: CodexLbPersistenceMode[];
  processOnly?: boolean;
} = {}): CodexLbPersistenceSummary {
  const selected = normalizePersistenceModes(selectedModes);
  const applied = normalizePersistenceModes(appliedModes);
  const effective = applied.find((mode) => mode !== 'process_only_ephemeral' && mode !== 'none')
    || selected.find((mode) => mode !== 'process_only_ephemeral' && mode !== 'none')
    || (processOnly || applied.includes('process_only_ephemeral') || selected.length === 0 ? 'process_only_ephemeral' : 'none');
  const durable = ['durable_env_file', 'durable_keychain', 'shell_profile'].some((mode) => applied.includes(mode as CodexLbPersistenceMode) || selected.includes(mode as CodexLbPersistenceMode));
  const warnings = effective === 'process_only_ephemeral'
    ? [
      'process_only_ephemeral',
      'next_session_requires_center_or_setup',
      'Save credentials in SKS Center (or sks codex-lb setup --write-env-file --keychain) so Desktop can load them automatically'
    ]
    : [];
  return {
    selected_modes: selected.length ? selected : ['process_only_ephemeral'],
    applied_modes: applied.length ? applied : (effective === 'none' ? ['none'] : [effective]),
    effective_mode: effective,
    durable,
    warning: warnings[0] || null,
    warnings
  };
}

function normalizePersistenceModes(modes: CodexLbPersistenceMode[] = []) {
  const allowed = new Set<CodexLbPersistenceMode>([
    'durable_env_file',
    'durable_keychain',
    'shell_profile',
    'process_only_ephemeral',
    'none'
  ]);
  return [...new Set(modes.filter((mode) => allowed.has(mode)))];
}

function profileTargets(home: string, choice: CodexLbShellProfileChoice): string[] {
  const targets: Record<Exclude<CodexLbShellProfileChoice, 'all' | 'skip'>, string> = {
    zsh: path.join(home, '.zshrc'),
    bash: path.join(home, '.bashrc'),
    fish: path.join(home, '.config', 'fish', 'config.fish')
  };
  if (choice === 'all') return [targets.zsh, targets.bash, targets.fish];
  if (choice === 'skip') return [];
  return [targets[choice]];
}

function shellProfileBlock(file: string, envPath: string): string {
  const fish = file.endsWith(path.join('fish', 'config.fish'));
  const sourceLine = fish
    ? `test -f ${fishQuote(envPath)}; and source ${fishQuote(envPath)}`
    : `[ -f ${shellSingleQuote(envPath)} ] && . ${shellSingleQuote(envPath)}`;
  return [
    '# BEGIN SKS CODEX-LB',
    sourceLine,
    '# END SKS CODEX-LB'
  ].join('\n');
}

function upsertManagedBlock(text: string, block: string): string {
  const re = /# BEGIN SKS CODEX-LB[\s\S]*?# END SKS CODEX-LB/g;
  const trimmed = String(text || '').trimEnd();
  const next = re.test(trimmed) ? trimmed.replace(re, block) : `${trimmed}${trimmed ? '\n\n' : ''}${block}`;
  return `${next.trimEnd()}\n`;
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function fishQuote(value: string): string {
  return `'${String(value).replace(/'/g, "\\'")}'`;
}
