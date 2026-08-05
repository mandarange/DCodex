import { escapeRegExp } from '../../text/regex.js';
import type { BridgeProviderId } from '../bridge-contracts.js';

export const LEGACY_PROVIDER_MODE_MARKER_PREFIX = '# sks-managed-provider-mode:' as const;
export const LEGACY_DESKTOP_BRIDGE_MARKER = '# sks-codex-lb-managed-desktop-bridge' as const;
export const LEGACY_DESKTOP_COMPAT_MARKER = '# sks-codex-lb-managed-desktop-compat' as const;
export const LEGACY_PROVIDER_SELECTION_MARKER = '# sks-codex-lb-managed-provider-selection' as const;
export const LEGACY_OAUTH_SELECTION_MARKER = '# sks-codex-lb-managed-oauth-selection' as const;
export const LEGACY_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url' as const;
export const LEGACY_MODEL_CATALOG_MARKER = '# sks-codex-lb-managed-model-catalog' as const;

export type LegacyProviderMode = 'chatgpt-oauth' | 'codex-lb' | 'openrouter';

export interface LegacyProviderConfigState {
  schema: 'sks.legacy-provider-config-state.v1';
  provider_mode: LegacyProviderMode | null;
  provider_mode_marker_count: number;
  model_provider: string | null;
  catalog_path: string | null;
  openai_base_url: string | null;
  migrated_profiles: BridgeProviderId[];
  gateway_auth_transport: 'authorization-bearer' | 'x-codex-lb-api-key' | null;
  markers: string[];
  blockers: string[];
}

export function parseLegacyProviderConfig(text: string): LegacyProviderConfigState {
  const source = String(text || '');
  const topLevel = source.split(/\n\s*\[/)[0] || '';
  const markerValues = topLevel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(LEGACY_PROVIDER_MODE_MARKER_PREFIX))
    .map((line) => line.slice(LEGACY_PROVIDER_MODE_MARKER_PREFIX.length).trim());
  const providerMode = markerValues.length === 1 && isLegacyProviderMode(markerValues[0])
    ? markerValues[0]
    : null;
  const modelProvider = topLevelTomlString(source, 'model_provider') || null;
  const catalogPath = topLevelTomlString(source, 'model_catalog_json') || null;
  const openAiBaseUrl = topLevelTomlString(source, 'openai_base_url') || null;
  const markers = [
    LEGACY_DESKTOP_BRIDGE_MARKER,
    LEGACY_DESKTOP_COMPAT_MARKER,
    LEGACY_PROVIDER_SELECTION_MARKER,
    LEGACY_OAUTH_SELECTION_MARKER,
    LEGACY_OPENAI_ROUTING_MARKER,
    LEGACY_MODEL_CATALOG_MARKER
  ].filter((marker) => topLevelHasLine(source, marker));
  const migratedProfiles = new Set<BridgeProviderId>();
  if (
    providerMode === 'codex-lb'
    || modelProvider === 'codex-lb'
    || hasTomlTable(source, 'model_providers.codex-lb')
    || markers.includes(LEGACY_DESKTOP_COMPAT_MARKER)
  ) migratedProfiles.add('codex-lb');
  if (
    providerMode === 'openrouter'
    || modelProvider === 'openrouter'
    || hasTomlTable(source, 'model_providers.openrouter')
  ) migratedProfiles.add('openrouter');
  if (modelProvider === 'sks-router' || hasTomlTable(source, 'model_providers.sks-router')) {
    if (hasTomlTable(source, 'model_providers.codex-lb')) migratedProfiles.add('codex-lb');
    if (hasTomlTable(source, 'model_providers.openrouter')) migratedProfiles.add('openrouter');
  }
  const blockers: string[] = [];
  if (markerValues.length > 1) blockers.push('legacy_provider_mode_marker_conflict');
  else if (markerValues.length === 1 && !providerMode) blockers.push('legacy_provider_mode_marker_invalid');
  const gatewayAuthTransport = markers.includes(LEGACY_DESKTOP_COMPAT_MARKER)
    || tomlTableBoolean(source, 'model_providers.codex-lb', 'requires_openai_auth') === true
      ? 'x-codex-lb-api-key'
      : hasTomlTable(source, 'model_providers.codex-lb')
        ? 'authorization-bearer'
        : null;
  return {
    schema: 'sks.legacy-provider-config-state.v1',
    provider_mode: providerMode,
    provider_mode_marker_count: markerValues.length,
    model_provider: modelProvider,
    catalog_path: catalogPath,
    openai_base_url: openAiBaseUrl,
    migrated_profiles: [...migratedProfiles].sort() as BridgeProviderId[],
    gateway_auth_transport: gatewayAuthTransport,
    markers,
    blockers
  };
}

function isLegacyProviderMode(value: unknown): value is LegacyProviderMode {
  return ['chatgpt-oauth', 'codex-lb', 'openrouter'].includes(String(value || ''));
}

function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1] || '';
}

function topLevelHasLine(text: string, line: string): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((candidate) => candidate.trim() === line);
}

function hasTomlTable(text: string, table: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*\\[${escapeRegExp(table)}\\]\\s*(?=\\n|$)`).test(text);
}

function tomlTableBoolean(text: string, table: string, key: string): boolean | null {
  const block = String(text || '').match(
    new RegExp(`(?:^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`)
  )?.[1] || '';
  const value = block.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1];
  return value === 'true' ? true : value === 'false' ? false : null;
}
