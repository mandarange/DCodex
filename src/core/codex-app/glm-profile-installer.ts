import path from 'node:path';
import { codexLbConfigPath, ensureGlobalCodexAppGlmProfile } from '../../cli/install-helpers.js';
import { readText, writeJsonAtomic, nowIso, rmrf } from '../fsx.js';
import {
  OPENROUTER_DEFAULT_PROFILE_ID,
  OPENROUTER_AUTH_COMMAND,
  OPENROUTER_AUTH_REFRESH_INTERVAL_MS,
  OPENROUTER_AUTH_TIMEOUT_MS,
  openRouterAuthCommandArgs,
  OPENROUTER_PROVIDER_ID,
  RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS,
  buildGlmCodexAppModelProfile,
  type SksCodexAppModelProfile
} from './openrouter-provider.js';
import { openRouterSecretPaths, resolveOpenRouterApiKey } from '../providers/openrouter/openrouter-secret-store.js';
import { escapeRegExp } from '../text/regex.js';

type CodexAppGlmConfigWrite = Awaited<ReturnType<typeof ensureGlobalCodexAppGlmProfile>>;

interface CodexAppGlmConfigStatus {
  readonly schema: 'sks.codex-app-glm-config-status.v1';
  readonly ok: boolean;
  readonly config_path: string;
  readonly provider_present: boolean;
  readonly provider_auth_present: boolean;
  readonly profiles_present: readonly string[];
  readonly profiles_missing: readonly string[];
  readonly retired_profiles_remaining: readonly string[];
  readonly blockers: readonly string[];
}

export interface GlmProfileInstallResult {
  readonly schema: 'sks.codex-app-glm-profile-result.v1';
  readonly generated_at: string;
  readonly ok: boolean;
  readonly status: 'installed' | 'valid' | 'blocked' | 'removed';
  readonly profile: SksCodexAppModelProfile;
  readonly profile_path: string;
  readonly report_path: string;
  readonly config_path: string;
  readonly codex_config_profile: string;
  readonly codex_reasoning_profiles: readonly string[];
  readonly config_write: CodexAppGlmConfigWrite | null;
  readonly config_status: CodexAppGlmConfigStatus;
  readonly openrouter_key_source: string | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Ensure OpenRouter provider is present and remove retired GLM Desktop profile tables.
 * Does not write Desktop picker profile metadata — use `sks codex-app use-openrouter`.
 */
export async function installCodexAppGlmProfile(input: {
  readonly root: string;
  readonly apply?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly configPath?: string;
}): Promise<GlmProfileInstallResult> {
  const root = path.resolve(input.root);
  const profile = buildGlmCodexAppModelProfile();
  const profilePath = path.join(root, '.sneakoscope', 'codex-app', 'glm-model-profile.json');
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'codex-app-glm-profile.json');
  const key = await resolveOpenRouterApiKey({ env: input.env || process.env });
  const home = input.home || input.env?.HOME;
  const configWrite = input.apply === false
    ? null
    : await ensureGlobalCodexAppGlmProfile({ home, configPath: input.configPath, env: input.env });
  if (input.apply !== false) {
    await rmrf(profilePath).catch(() => undefined);
    await rmrf(reportPath).catch(() => undefined);
  }
  const configStatus = input.apply === false
    ? await previewCodexAppGlmConfigStatus({ home, configPath: input.configPath, ...(input.env ? { env: input.env } : {}) })
    : await inspectCodexAppOpenRouterConfig({ home, configPath: input.configPath, ...(input.env ? { env: input.env } : {}) });
  const configWriteBlockers = configWrite?.ok === false
    ? [`glm_codex_app_config_${configWrite.status || 'failed'}`]
    : [];
  const blockers = input.apply === false ? [] : [...configWriteBlockers, ...configStatus.blockers];
  const warnings = [
    ...key.warnings,
    ...(key.key ? [] : ['openrouter_key_missing_until_sks_codex_app_set_openrouter_key']),
    ...(input.apply === false ? ['codex_desktop_openrouter_config_not_written_apply_false'] : []),
    'glm_desktop_profiles_retired_use_openrouter'
  ];
  const result: GlmProfileInstallResult = {
    schema: 'sks.codex-app-glm-profile-result.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    status: blockers.length === 0
      ? input.apply === false
        ? 'valid'
        : 'removed'
      : 'blocked',
    profile,
    profile_path: '.sneakoscope/codex-app/glm-model-profile.json',
    report_path: '.sneakoscope/reports/codex-app-glm-profile.json',
    config_path: configStatus.config_path,
    codex_config_profile: OPENROUTER_DEFAULT_PROFILE_ID,
    codex_reasoning_profiles: [],
    config_write: configWrite,
    config_status: configStatus,
    openrouter_key_source: key.source,
    blockers,
    warnings
  };
  return result;
}

export async function doctorCodexAppGlmProfile(input: {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly configPath?: string;
}): Promise<GlmProfileInstallResult> {
  const root = path.resolve(input.root);
  const profilePath = path.join(root, '.sneakoscope', 'codex-app', 'glm-model-profile.json');
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'codex-app-glm-profile.json');
  const key = await resolveOpenRouterApiKey({ env: input.env || process.env });
  const profile = buildGlmCodexAppModelProfile();
  const home = input.home || input.env?.HOME;
  const configStatus = await inspectCodexAppOpenRouterConfig({ home, configPath: input.configPath, ...(input.env ? { env: input.env } : {}) });
  const leftoverMeta = await readText(profilePath, '').catch(() => '');
  const blockers = [
    ...configStatus.blockers,
    ...(leftoverMeta.trim() ? ['retired_glm_model_profile_metadata_present'] : [])
  ];
  const warnings = [
    ...key.warnings,
    ...(key.key ? [] : ['openrouter_key_missing_until_sks_codex_app_set_openrouter_key']),
    'glm_desktop_profiles_retired_use_openrouter'
  ];
  const result: GlmProfileInstallResult = {
    schema: 'sks.codex-app-glm-profile-result.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'valid' : 'blocked',
    profile,
    profile_path: '.sneakoscope/codex-app/glm-model-profile.json',
    report_path: '.sneakoscope/reports/codex-app-glm-profile.json',
    config_path: configStatus.config_path,
    codex_config_profile: OPENROUTER_DEFAULT_PROFILE_ID,
    codex_reasoning_profiles: [],
    config_write: null,
    config_status: configStatus,
    openrouter_key_source: key.source,
    blockers,
    warnings
  };
  await writeJsonAtomic(reportPath, result).catch(() => undefined);
  return result;
}

async function previewCodexAppGlmConfigStatus(input: { readonly home?: string | undefined; readonly configPath?: string | undefined; readonly env?: NodeJS.ProcessEnv }): Promise<CodexAppGlmConfigStatus> {
  const configPath = input.configPath || codexLbConfigPath(input.home);
  return {
    schema: 'sks.codex-app-glm-config-status.v1',
    ok: true,
    config_path: configPath,
    provider_present: false,
    provider_auth_present: false,
    profiles_present: [],
    profiles_missing: [],
    retired_profiles_remaining: [],
    blockers: []
  };
}

async function inspectCodexAppOpenRouterConfig(input: { readonly home?: string | undefined; readonly configPath?: string | undefined; readonly env?: NodeJS.ProcessEnv }): Promise<CodexAppGlmConfigStatus> {
  const configPath = input.configPath || codexLbConfigPath(input.home);
  const text = await readText(configPath, '').catch(() => '');
  const providerBody = tomlTableBody(text, `model_providers.${OPENROUTER_PROVIDER_ID}`);
  const providerPresent = Boolean(providerBody);
  const authBody = tomlTableBody(text, `model_providers.${OPENROUTER_PROVIDER_ID}.auth`);
  const providerAuthPresent = Boolean(authBody);
  const providerEnvKeyPresent = hasTomlKey(providerBody, 'env_key');
  const authEnv = { ...(input.env || process.env), ...(input.home ? { HOME: input.home } : {}) };
  const authArgs = openRouterAuthCommandArgs(openRouterSecretPaths(authEnv).keyPath);
  const blockers: string[] = [];
  if (!providerPresent) {
    blockers.push('glm_codex_app_config_missing_openrouter_provider');
  } else {
    if (!hasTomlString(providerBody, 'base_url', 'https://openrouter.ai/api/v1')) blockers.push('glm_codex_app_config_invalid_openrouter_base_url');
    if (!hasTomlString(providerBody, 'wire_api', 'responses')) blockers.push('glm_codex_app_config_invalid_openrouter_wire_api');
    if (providerEnvKeyPresent) blockers.push('glm_codex_app_config_openrouter_auth_env_key_conflict');
  }
  if (!providerAuthPresent) {
    blockers.push('glm_codex_app_config_missing_openrouter_auth');
  } else {
    if (!hasTomlString(authBody, 'command', OPENROUTER_AUTH_COMMAND)) blockers.push('glm_codex_app_config_invalid_openrouter_auth_command');
    if (!hasTomlStringArray(authBody, 'args', authArgs)) blockers.push('glm_codex_app_config_invalid_openrouter_auth_args');
    if (!hasTomlInteger(authBody, 'timeout_ms', OPENROUTER_AUTH_TIMEOUT_MS)) blockers.push('glm_codex_app_config_invalid_openrouter_auth_timeout');
    if (!hasTomlInteger(authBody, 'refresh_interval_ms', OPENROUTER_AUTH_REFRESH_INTERVAL_MS)) blockers.push('glm_codex_app_config_invalid_openrouter_auth_refresh');
  }
  const retiredRemaining: string[] = [];
  for (const profileId of RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS) {
    if (tomlTableBody(text, `profiles.${profileId}`)) {
      retiredRemaining.push(profileId);
      blockers.push(`retired_glm_desktop_profile_present:${profileId}`);
    }
  }
  return {
    schema: 'sks.codex-app-glm-config-status.v1',
    ok: blockers.length === 0,
    config_path: configPath,
    provider_present: providerPresent,
    provider_auth_present: providerAuthPresent,
    profiles_present: [],
    profiles_missing: [],
    retired_profiles_remaining: retiredRemaining,
    blockers
  };
}

function tomlTableBody(text: string, table: string): string {
  const header = `[${table}]`;
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return '';
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[[^\]]+\]\s*$/.test(line || '')) break;
    body.push(line || '');
  }
  return body.join('\n');
}

function hasTomlString(text: string, key: string, value: string): boolean {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*(?:#.*)?$`, 'm');
  return pattern.test(text);
}

function hasTomlKey(text: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'm').test(text);
}

function hasTomlStringArray(text: string, key: string, values: readonly string[]): boolean {
  const expected = values.map((value) => JSON.stringify(value)).join(', ');
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[${escapeRegExp(expected)}\\]\\s*(?:#.*)?$`, 'm').test(text);
}

function hasTomlInteger(text: string, key: string, value: number): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*${value}\\s*(?:#.*)?$`, 'm').test(text);
}
