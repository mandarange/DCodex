import path from 'node:path';
import os from 'node:os';
import { ensureDir, readText } from '../core/fsx.js';
import {
  GLM_CODEX_CONFIG_PROVIDER_ID,
  GLM_52_OPENROUTER_MODEL,
  OPENROUTER_AUTH_COMMAND,
  OPENROUTER_AUTH_REFRESH_INTERVAL_MS,
  OPENROUTER_AUTH_TIMEOUT_MS,
  openRouterAuthCommandArgs,
  OPENROUTER_DEFAULT_PROFILE_ID,
  RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS
} from '../core/codex-app/openrouter-provider.js';
import { openRouterSecretPaths, resolveOpenRouterApiKey } from '../core/providers/openrouter/openrouter-secret-store.js';
import { reconcileRetiredSksConfigText } from '../core/auto-review.js';
import type { CodexLbPersistenceMode } from '../core/codex-lb/codex-lb-setup.js';
import {
  ensureTrailingNewline,
  removeTopLevelTomlKeyIfValue,
  safeWriteCodexConfigToml,
  upsertTopLevelTomlString,
  upsertTomlTable
} from '../core/codex-runtime/codex-desktop-config-policy.js';
import {
  codexLbConfigPath,
  normalizeCodexLbBaseUrl
} from './install-helpers-codex-lb-shared.js';
import { escapeRegExp } from '../core/text/regex.js';

export interface NativeDesktopConfigInput {
  bridgeBaseUrl: string;
  remoteBaseUrl: string;
}

export interface CompatDesktopConfigInput {
  remoteBaseUrl: string;
}

export interface CliProviderConfigInput {
  remoteBaseUrl: string;
  selectGlobally?: boolean;
}

export const CODEX_LB_DESKTOP_BRIDGE_MARKER = '# sks-codex-lb-managed-desktop-bridge';
export const CODEX_LB_DESKTOP_COMPAT_MARKER = '# sks-codex-lb-managed-desktop-compat';
export const CODEX_LB_MODEL_CATALOG_MARKER = '# sks-codex-lb-managed-model-catalog';
const LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';

export function upsertCodexLbNativeDesktopConfig(
  text: string,
  input: NativeDesktopConfigInput
): string {
  let next = String(text || '');
  const selectedProvider = topLevelTomlString(next, 'model_provider');
  if (selectedProvider && selectedProvider !== 'openai' && selectedProvider !== 'codex-lb') {
    throw new Error('codex_lb_user_owned_model_provider_conflict');
  }
  if (selectedProvider === 'codex-lb' && !topLevelHasLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER)) {
    throw new Error('codex_lb_legacy_desktop_config_requires_migration');
  }
  if (
    topLevelHasLine(next, LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER)
    && !topLevelHasLine(next, CODEX_LB_DESKTOP_BRIDGE_MARKER)
  ) {
    throw new Error('codex_lb_legacy_desktop_config_requires_migration');
  }
  const modelCatalog = topLevelTomlString(next, 'model_catalog_json');
  if (modelCatalog && !topLevelHasLine(next, CODEX_LB_MODEL_CATALOG_MARKER)) {
    throw new Error('codex_lb_user_owned_model_catalog_json_conflict');
  }
  next = removeTopLevelTomlKeyIfValue(next, 'model_provider', 'codex-lb');
  next = removeTopLevelLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER);
  next = removeManagedModelCatalogJson(next);
  next = upsertManagedTopLevelTomlString(
    next,
    'openai_base_url',
    input.bridgeBaseUrl,
    CODEX_LB_DESKTOP_BRIDGE_MARKER
  );
  next = upsertTomlTable(next, 'model_providers.codex-lb', cliProviderBlock(input.remoteBaseUrl));
  return ensureTrailingNewline(next);
}

export function upsertCodexLbCompatDesktopConfig(
  text: string,
  input: CompatDesktopConfigInput
): string {
  let next = removeManagedDesktopBridgeRouting(String(text || ''));
  next = removeManagedModelCatalogJson(next);
  next = upsertManagedTopLevelTomlString(
    next,
    'model_provider',
    'codex-lb',
    CODEX_LB_DESKTOP_COMPAT_MARKER
  );
  const block = [
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    `base_url = ${JSON.stringify(input.remoteBaseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = true',
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }'
  ].join('\n');
  next = upsertTomlTable(next, 'model_providers.codex-lb', block);
  return ensureTrailingNewline(next);
}

export function upsertCodexLbCliProviderConfig(
  text: string,
  input: CliProviderConfigInput
): string {
  let next = input.selectGlobally === true
    ? upsertTopLevelTomlString(text, 'model_provider', 'codex-lb')
    : removeTopLevelTomlKeyIfValue(text, 'model_provider', 'codex-lb');
  next = upsertTomlTable(next, 'model_providers.codex-lb', cliProviderBlock(input.remoteBaseUrl));
  return ensureTrailingNewline(next);
}

export function removeCodexLbManagedDesktopConfig(text: string): string {
  let next = removeManagedDesktopBridgeRouting(String(text || ''));
  if (topLevelHasLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER)) {
    next = removeTopLevelTomlKeyIfValue(next, 'model_provider', 'codex-lb');
    next = removeTopLevelLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER);
  }
  next = removeManagedModelCatalogJson(next);
  return ensureTrailingNewline(next);
}

export function removeManagedModelCatalogJson(text: string): string {
  if (!topLevelHasLine(text, CODEX_LB_MODEL_CATALOG_MARKER)) return text;
  const withoutKey = removeTopLevelTomlKey(text, 'model_catalog_json');
  return removeTopLevelLine(withoutKey, CODEX_LB_MODEL_CATALOG_MARKER);
}

export function removeManagedDesktopBridgeRouting(text: string): string {
  const markers = [
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER
  ].filter((marker) => topLevelHasLine(text, marker));
  if (markers.length === 0) return text;
  let next = removeTopLevelTomlKey(text, 'openai_base_url');
  for (const marker of markers) next = removeTopLevelLine(next, marker);
  return next;
}

export function upsertCodexLbConfig(text: any = '', baseUrl: any, selectDefault = true) {
  return upsertCodexLbCliProviderConfig(text, {
    remoteBaseUrl: String(baseUrl || ''),
    selectGlobally: selectDefault === true
  });
}

function cliProviderBlock(remoteBaseUrl: string): string {
  return [
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = ${JSON.stringify(remoteBaseUrl)}`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false'
  ].join('\n');
}

function upsertManagedTopLevelTomlString(
  text: string,
  key: string,
  value: string,
  marker: string,
  legacyMarkers: string[] = []
): string {
  const acceptedMarkers = [marker, ...legacyMarkers];
  const existing = topLevelTomlString(text, key);
  const ownedMarker = acceptedMarkers.find((candidate) => topLevelHasLine(text, candidate));
  if (existing && !ownedMarker) {
    if (existing === value) return text;
    throw new Error(`codex_lb_user_owned_${key}_conflict`);
  }
  let next = text;
  for (const candidate of acceptedMarkers) next = removeTopLevelLine(next, candidate);
  next = upsertTopLevelTomlString(next, key, value);
  return addTopLevelMarkerBeforeKey(next, key, marker);
}

function removeTopLevelTomlKey(text: string, key: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return lines
    .filter((line, index) => index >= end || !keyPattern.test(line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

export type CodexLbSharedOpenAiRoutingState = {
  status: 'missing' | 'matched' | 'conflict';
  expected_base_url: string;
  configured_base_url: string | null;
  managed: boolean;
};

const CODEX_LB_SHARED_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';

// Codex App can retain a per-thread `model_provider = "openai"` selection even
// after the global provider changes. While SKS places the codex-lb key in the
// shared OpenAI auth store, pin the built-in provider to the same LB endpoint so
// that stale threads cannot send that key to api.openai.com. A different existing
// override is user-owned and must never be clobbered.
export function codexLbSharedOpenAiRoutingState(text: any = '', baseUrl: any = ''): CodexLbSharedOpenAiRoutingState {
  const expectedBaseUrl = normalizeCodexLbBaseUrl(baseUrl);
  const configuredBaseUrl = topLevelTomlString(text, 'openai_base_url');
  return {
    status: !configuredBaseUrl ? 'missing' : configuredBaseUrl === expectedBaseUrl ? 'matched' : 'conflict',
    expected_base_url: expectedBaseUrl,
    configured_base_url: configuredBaseUrl || null,
    managed: topLevelHasLine(text, CODEX_LB_SHARED_OPENAI_ROUTING_MARKER)
  };
}

export function upsertCodexLbSharedOpenAiRouting(text: any = '', baseUrl: any = '') {
  const state = codexLbSharedOpenAiRoutingState(text, baseUrl);
  if (!state.expected_base_url) return { ...state, routing_status: state.status, ok: false, status: 'missing_base_url', text: String(text || '') };
  if (state.status === 'conflict') return { ...state, routing_status: state.status, ok: false, status: 'conflicting_user_openai_base_url', text: String(text || '') };
  if (state.status === 'matched' && state.managed) {
    return { ...state, routing_status: state.status, ok: true, status: 'present', text: String(text || '') };
  }
  // Matched-but-unmanaged means the URL already points at codex-lb. Claim the SKS
  // marker so release/unselect can remove only this activation pin later.
  const withValue = state.status === 'matched'
    ? String(text || '')
    : upsertTopLevelTomlString(text, 'openai_base_url', state.expected_base_url);
  const next = addTopLevelMarkerBeforeKey(withValue, 'openai_base_url', CODEX_LB_SHARED_OPENAI_ROUTING_MARKER);
  return { ...state, routing_status: state.status, ok: true, status: 'added', text: `${next.trim()}\n`, managed: true };
}

export function removeCodexLbSharedOpenAiRouting(text: any = '', baseUrl: any = '') {
  const state = codexLbSharedOpenAiRoutingState(text, baseUrl);
  if (state.status !== 'matched' || !state.managed) return { ...state, changed: false, text: String(text || '') };
  const withoutValue = removeTopLevelTomlKeyIfValue(text, 'openai_base_url', state.expected_base_url);
  return {
    ...state,
    changed: true,
    text: removeTopLevelLine(withoutValue, CODEX_LB_SHARED_OPENAI_ROUTING_MARKER)
  };
}

/** Ensure OpenRouter provider exists and strip retired GLM Desktop profile tables. */
export function upsertCodexAppGlmConfig(text: any = '', input: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
  let next = String(text || '');
  const authEnv = { ...(input.env || process.env), ...(input.home ? { HOME: input.home } : {}) };
  const authArgs = openRouterAuthCommandArgs(openRouterSecretPaths(authEnv).keyPath);
  const providerBlock = [
    `[model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}]`,
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false'
  ].join('\n');
  next = upsertTomlTable(next, `model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}`, providerBlock);
  const authBlock = [
    `[model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}.auth]`,
    `command = ${JSON.stringify(OPENROUTER_AUTH_COMMAND)}`,
    `args = [${authArgs.map((value) => JSON.stringify(value)).join(', ')}]`,
    `timeout_ms = ${OPENROUTER_AUTH_TIMEOUT_MS}`,
    `refresh_interval_ms = ${OPENROUTER_AUTH_REFRESH_INTERVAL_MS}`
  ].join('\n');
  next = upsertTomlTable(next, `model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}.auth`, authBlock);
  next = next.replace(
    new RegExp(`\\n+\\[model_providers\\.${GLM_CODEX_CONFIG_PROVIDER_ID}\\.auth\\]`),
    `\n\n[model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}.auth]`
  );
  next = reconcileRetiredSksConfigText(next).text;
  return `${next.trim()}\n`;
}

export async function ensureGlobalCodexAppGlmProfile(opts: any = {}) {
  const env = opts.env || process.env;
  if (env.SKS_SKIP_CODEX_GLM_PROFILE_REPAIR === '1' && opts.force !== true) {
    return { ok: true, status: 'skipped', reason: 'SKS_SKIP_CODEX_GLM_PROFILE_REPAIR=1' };
  }
  const home = opts.home || env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  try {
    await ensureDir(path.dirname(configPath));
    const current = await readText(configPath, '');
    const next = upsertCodexAppGlmConfig(current, { home, env: opts.env });
    const safeWrite = await safeWriteCodexConfigToml(configPath, current, next, 'openrouter-provider');
    return {
      ...safeWrite,
      status: safeWrite.status === 'written' ? 'updated' : safeWrite.status,
      provider: GLM_CODEX_CONFIG_PROVIDER_ID,
      model: GLM_52_OPENROUTER_MODEL,
      codex_config_profile: OPENROUTER_DEFAULT_PROFILE_ID,
      reasoning_profiles: [] as string[],
      retired_glm_profiles: [...RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS]
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 'failed',
      config_path: configPath,
      error: err.message,
      provider: GLM_CODEX_CONFIG_PROVIDER_ID,
      model: GLM_52_OPENROUTER_MODEL,
      codex_config_profile: OPENROUTER_DEFAULT_PROFILE_ID,
      reasoning_profiles: [] as string[],
      retired_glm_profiles: [...RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS]
    };
  }
}

export async function ensureStoredOpenRouterProviderDuringInstall(opts: any = {}) {
  const home = opts.home || opts.env?.HOME || process.env.HOME || os.homedir();
  const env = { ...(opts.env || process.env), HOME: home } as NodeJS.ProcessEnv;
  const key = await resolveOpenRouterApiKey({ env });
  if (!key.key) {
    return {
      schema: 'sks.openrouter-provider-upgrade-repair.v1',
      ok: true,
      status: 'skipped',
      reason: 'openrouter_key_missing',
      key_present: false,
      key_source: null,
      blockers: [],
      warnings: key.warnings
    };
  }
  const repair = await ensureGlobalCodexAppGlmProfile({
    ...opts,
    home,
    env
  });
  const configPath = repair?.config_path || opts.configPath || codexLbConfigPath(home);
  // When OpenRouter is the active Desktop provider, also repair the SKS-managed
  // ModelInfo catalog so per-model feature UI (reasoning picker, multi-agent v2,
  // list visibility) stays enabled for the third-party model after updates.
  const { ensureOpenRouterModelCatalog } = await import('../core/codex-app/openrouter-model-catalog.js');
  const catalogRepair = await ensureOpenRouterModelCatalog({ configPath, home, env })
    .catch((err: any) => ({ ok: false, status: 'failed', error: err?.message || String(err) }));
  const ok = repair?.ok !== false && (catalogRepair as any)?.ok !== false;
  return {
    schema: 'sks.openrouter-provider-upgrade-repair.v1',
    ok,
    status: ok ? repair?.status || 'present' : 'failed',
    reason: ok ? 'stored_openrouter_key_provider_reconciled' : 'stored_openrouter_key_provider_repair_failed',
    key_present: true,
    key_source: key.source,
    config_path: configPath,
    provider: GLM_CODEX_CONFIG_PROVIDER_ID,
    blockers: ok ? [] : ['openrouter_provider_repair_failed'],
    warnings: key.warnings,
    repair,
    model_catalog_repair: catalogRepair
  };
}

export function detectCodexLbSetupDrift(state: any = {}): string[] {
  const drift: string[] = [];
  if (state.useDefaultProvider && state.selected !== true) drift.push('default_provider_not_selected');
  if (!state.useDefaultProvider && state.selected === true) drift.push('default_provider_selected_despite_no_default_provider');
  if (state.writeEnvFile && state.envFile !== true) drift.push('env_file_not_written');
  if (!state.writeEnvFile && state.beforeState && state.afterState && state.beforeState.envHash !== state.afterState.envHash) drift.push('env_file_changed_despite_no_env_file');
  if (!state.writeEnvFile && !state.beforeState && state.envFile === true) drift.push('env_file_written_despite_no_env_file');
  if (!state.storeKeychain && state.keychain?.status && state.keychain.status !== 'skipped') drift.push('keychain_touched_despite_no_keychain');
  if (!state.syncLaunchctl && state.codexEnvironment?.launch_environment?.status === 'synced') drift.push('launchctl_base_url_synced_despite_no_launchctl');
  if (state.codexEnvironment?.launch_environment?.secret_env_cleanup?.status === 'partial') drift.push('launchctl_secret_env_cleanup_incomplete');
  if (state.shellProfile === 'skip' && state.shellProfileResult?.status === 'installed') drift.push('shell_profile_written_despite_skip');
  if (state.shellProfile === 'skip' && state.beforeState && state.afterState && state.beforeState.profileHash !== state.afterState.profileHash) drift.push('shell_profile_changed_despite_skip');
  return drift;
}

export async function captureCodexLbSetupWriteState({ home, configPath, envPath, shellProfile }: any = {}) {
  const profileFiles = profileFilesForDrift(home, shellProfile);
  return {
    configHash: await fileHashOrMissing(configPath),
    envHash: await fileHashOrMissing(envPath),
    profileHash: (await Promise.all(profileFiles.map((file: string) => fileHashOrMissing(file)))).join('|')
  };
}

async function fileHashOrMissing(file: string) {
  const text = await readText(file, null).catch(() => null);
  return text === null ? 'missing' : await sha256Text(String(text));
}

function profileFilesForDrift(home: string, shellProfile: string) {
  const targets = {
    zsh: path.join(home, '.zshrc'),
    bash: path.join(home, '.bashrc'),
    fish: path.join(home, '.config', 'fish', 'config.fish')
  };
  if (shellProfile === 'zsh') return [targets.zsh];
  if (shellProfile === 'bash') return [targets.bash];
  if (shellProfile === 'fish') return [targets.fish];
  if (shellProfile === 'all') return [targets.zsh, targets.bash, targets.fish];
  return [targets.zsh, targets.bash, targets.fish];
}

export function appliedCodexLbPersistenceModes(state: any = {}): CodexLbPersistenceMode[] {
  const modes: CodexLbPersistenceMode[] = [];
  if (state.writeEnvFile && state.envFile === true) modes.push('durable_env_file');
  if (state.storeKeychain && state.keychain?.ok === true) modes.push('durable_keychain');
  if (state.syncLaunchctl && state.codexEnvironment?.launch_environment?.status === 'synced') modes.push('process_only_ephemeral');
  if (state.shellProfile !== 'skip' && state.shellProfileResult?.status === 'installed') modes.push('shell_profile');
  if (!modes.length && state.apiKeySource === 'process.env') modes.push('process_only_ephemeral');
  if (!modes.length) modes.push('none');
  return modes;
}

export function shellSingleQuote(value: any) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}


export function parseCodexLbEnvBaseUrl(text: any = '') {
  const value = parseShellEnvValue(text, 'CODEX_LB_BASE_URL');
  return value ? normalizeCodexLbBaseUrl(value) : '';
}

export function parseCodexSharedLoginApiKey(text: any = '') {
  try {
    const parsed = JSON.parse(String(text || ''));
    const authMode = String(parsed?.auth_mode || parsed?.authMode || parsed?.mode || '').toLowerCase();
    const key = parsed?.key || parsed?.api_key || parsed?.apiKey || parsed?.openai_api_key || parsed?.OPENAI_API_KEY;
    if (!key || typeof key !== 'string') return '';
    if (authMode && !/api[-_]?key|apikey/.test(authMode)) return '';
    return key.trim();
  } catch {
    return '';
  }
}

function parseShellEnvValue(text: any = '', key: any = '') {
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, 'm');
  const envMatch = String(text || '').match(re);
  const raw = envMatch?.[1]?.trim() || '';
  if (!raw) return '';
  if (raw.startsWith("'")) return raw.endsWith("'") && raw.length > 1 ? raw.slice(1, -1).replace(/'\\''/g, "'") : '';
  if (raw.startsWith('"')) return raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1).replace(/\\"/g, '"') : '';
  if (raw.includes("'") || raw.includes('"') || /\s/.test(raw)) return '';
  return raw;
}


export async function sha256Text(value: any = '') {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function topLevelTomlString(text: any = '', key: string) {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[2] || '';
}

function topLevelHasLine(text: any = '', line: string) {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((candidate) => candidate.trim() === line);
}

function addTopLevelMarkerBeforeKey(text: any = '', key: string, marker: string) {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyIndex = lines.slice(0, end).findIndex((line) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line));
  if (keyIndex >= 0 && !lines.slice(0, end).some((line) => line.trim() === marker)) lines.splice(keyIndex, 0, marker);
  return lines.join('\n');
}

function removeTopLevelLine(text: any = '', target: string) {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === target) lines.splice(index, 1);
  }
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}
