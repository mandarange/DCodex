import path from 'node:path';
import {
  DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
  DESKTOP_BRIDGE_MANAGED_MARKER,
  DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
} from '../../../cli/install-helpers-codex-lb-config.js';
import { escapeRegExp } from '../../text/regex.js';
import type { BridgeProviderId } from '../bridge-contracts.js';
import {
  CANONICAL_OPENROUTER_ENDPOINT,
  HISTORICAL_DESKTOP_BRIDGE_MARKER,
  HISTORICAL_DESKTOP_COMPAT_MARKER,
  HISTORICAL_MODEL_CATALOG_MARKER,
  HISTORICAL_OAUTH_SELECTION_MARKER,
  HISTORICAL_OPENAI_ROUTING_MARKER,
  HISTORICAL_PROVIDER_MODE_MARKER,
  HISTORICAL_PROVIDER_SELECTION_MARKER,
  hasTomlTable,
  hasTopLevelMarker,
  isHistoricalProviderMode,
  secretFreeProviderEndpoint,
  tomlTableBoolean,
  tomlTableContainsCustomHeader,
  tomlTableString,
  topLevelTomlString
} from './historical-toml.js';
import type {
  HistoricalDesktopBridgeIntent,
  HistoricalProviderConfigState
} from './types.js';

/** Decode only historical SKS-owned provider intent; ambiguous user state fails closed. */
export function inspectHistoricalDesktopBridgeIntent(configText: string): HistoricalDesktopBridgeIntent {
  const source = String(configText || '');
  const topLevel = source.split(/\n\s*\[/)[0] || '';
  const markerValues = topLevel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(HISTORICAL_PROVIDER_MODE_MARKER))
    .map((line) => line.slice(HISTORICAL_PROVIDER_MODE_MARKER.length).trim());
  const providerMode = markerValues.length === 1 && isHistoricalProviderMode(markerValues[0])
    ? markerValues[0]
    : null;
  const selectedProvider = topLevelTomlString(source, 'model_provider') || null;
  const nativeBridge = hasTopLevelMarker(source, HISTORICAL_DESKTOP_BRIDGE_MARKER);
  const compatBridge = hasTopLevelMarker(source, HISTORICAL_DESKTOP_COMPAT_MARKER);
  const managedCodexLbSelection = hasTopLevelMarker(source, HISTORICAL_PROVIDER_SELECTION_MARKER);
  const managedOAuthSelection = hasTopLevelMarker(source, HISTORICAL_OAUTH_SELECTION_MARKER);
  const codexLbPresent = hasTomlTable(source, 'model_providers.codex-lb');
  const openRouterPresent = hasTomlTable(source, 'model_providers.openrouter');
  const combinedRouterPresent = hasTomlTable(source, 'model_providers.sks-router');
  const blockers: string[] = [];

  if (markerValues.length > 1) blockers.push('historical_provider_marker_conflict');
  else if (markerValues.length === 1 && !providerMode) blockers.push('historical_provider_marker_invalid');
  if (nativeBridge && compatBridge) blockers.push('historical_desktop_marker_conflict');
  if (nativeBridge && selectedProvider !== 'openai') blockers.push('historical_native_bridge_selection_mismatch');
  if (compatBridge && selectedProvider !== 'codex-lb') blockers.push('historical_compat_bridge_selection_mismatch');
  if (managedCodexLbSelection && selectedProvider !== 'codex-lb') {
    blockers.push('historical_codex_lb_selection_marker_mismatch');
  }
  if (managedOAuthSelection && selectedProvider !== 'openai') {
    blockers.push('historical_oauth_selection_marker_mismatch');
  }

  const knownSelections = new Set(['openai', 'codex-lb', 'openrouter', 'sks-router']);
  if (selectedProvider && !knownSelections.has(selectedProvider)) {
    blockers.push('historical_user_owned_provider_selection_conflict');
  } else if (
    selectedProvider === 'codex-lb'
    && !compatBridge
    && !managedCodexLbSelection
    && providerMode !== 'codex-lb'
  ) {
    blockers.push('historical_user_owned_provider_selection_conflict');
  } else if (selectedProvider === 'openrouter' && !openRouterPresent) {
    blockers.push('historical_openrouter_selection_table_missing');
  } else if (selectedProvider === 'sks-router' && !combinedRouterPresent) {
    blockers.push('historical_combined_router_table_missing');
  }

  if (providerMode === 'chatgpt-oauth' && selectedProvider !== null && selectedProvider !== 'openai') {
    blockers.push('historical_provider_mode_selection_mismatch');
  }
  if (
    providerMode === 'codex-lb'
    && selectedProvider !== null
    && selectedProvider !== 'openai'
    && selectedProvider !== 'codex-lb'
  ) blockers.push('historical_provider_mode_selection_mismatch');
  if (
    providerMode === 'openrouter'
    && selectedProvider !== null
    && selectedProvider !== 'openai'
    && selectedProvider !== 'openrouter'
  ) blockers.push('historical_provider_mode_selection_mismatch');

  const rawCodexLbEndpoint = tomlTableString(source, 'model_providers.codex-lb', 'base_url');
  const codexLbEndpoint = codexLbPresent ? secretFreeProviderEndpoint(rawCodexLbEndpoint) : null;
  if (codexLbPresent && !codexLbEndpoint) blockers.push('historical_codex_lb_endpoint_invalid');
  const rawOpenRouterEndpoint = tomlTableString(source, 'model_providers.openrouter', 'base_url');
  const openRouterEndpoint = rawOpenRouterEndpoint === CANONICAL_OPENROUTER_ENDPOINT
    ? CANONICAL_OPENROUTER_ENDPOINT
    : null;
  if (openRouterPresent && !openRouterEndpoint) blockers.push('historical_openrouter_endpoint_not_canonical');

  if ((nativeBridge || compatBridge || managedCodexLbSelection || providerMode === 'codex-lb') && !codexLbPresent) {
    blockers.push('historical_codex_lb_table_missing');
  }
  if ((selectedProvider === 'openrouter' || providerMode === 'openrouter') && !openRouterPresent) {
    blockers.push('historical_openrouter_table_missing');
  }

  const codexLbTransport = codexLbPresent
    ? compatBridge
      || tomlTableBoolean(source, 'model_providers.codex-lb', 'requires_openai_auth') === true
      || tomlTableContainsCustomHeader(source, 'model_providers.codex-lb')
        ? 'x-codex-lb-api-key' as const
        : 'authorization-bearer' as const
    : null;
  let defaultProvider: BridgeProviderId | null = null;
  if (providerMode === 'codex-lb' || nativeBridge || compatBridge || selectedProvider === 'codex-lb') {
    defaultProvider = 'codex-lb';
  } else if (providerMode === 'openrouter' || selectedProvider === 'openrouter') {
    defaultProvider = 'openrouter';
  }

  const uniqueBlockers = [...new Set(blockers)];
  const usable = uniqueBlockers.length === 0;
  return {
    schema: 'sks.desktop-bridge-historical-intent.v1',
    blockers: uniqueBlockers,
    providers: {
      'codex-lb': {
        present: codexLbPresent,
        enabled: usable && codexLbPresent,
        endpoint_url: codexLbEndpoint,
        auth_transport: codexLbTransport
      },
      openrouter: {
        present: openRouterPresent,
        enabled: usable && openRouterPresent,
        endpoint_url: openRouterEndpoint,
        auth_transport: openRouterPresent ? 'openrouter-bearer' : null
      }
    },
    default_provider_id: usable ? defaultProvider : null
  };
}

/** Remove only validated historical top-level routing before the current writer runs. */
export function prepareHistoricalConfigForDesktopBridgeWriter(
  text: string,
  state: HistoricalProviderConfigState
): string {
  const source = String(text || '');
  if ([
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  ].every((marker) => hasTopLevelMarker(source, marker))) return source;

  const historicalMarkers = historicalManagedMarkers();
  const hasHistoricalMarker = historicalMarkers.some((marker) => hasTopLevelMarker(source, marker));
  const hasHistoricalMode = topLevelLines(source).some((line) => line.startsWith(HISTORICAL_PROVIDER_MODE_MARKER));
  const codexLbSelectionOwned = state.model_provider === 'codex-lb'
    && (hasHistoricalMarker || state.provider_mode === 'codex-lb');
  const knownThirdPartySelection = state.model_provider === 'openrouter' || state.model_provider === 'sks-router';
  const historicalOpenAiSelection = state.model_provider === 'openai' && (hasHistoricalMarker || hasHistoricalMode);

  let next = source;
  if (codexLbSelectionOwned || knownThirdPartySelection || historicalOpenAiSelection) {
    next = removeTopLevelKey(next, 'model_provider');
  }
  if (
    hasTopLevelMarker(source, HISTORICAL_DESKTOP_BRIDGE_MARKER)
    || hasTopLevelMarker(source, HISTORICAL_OPENAI_ROUTING_MARKER)
  ) next = removeTopLevelKey(next, 'openai_base_url');

  const historicalCatalog = state.catalog_path || '';
  const historicalCatalogOwned = hasTopLevelMarker(source, HISTORICAL_MODEL_CATALOG_MARKER)
    || ['sks-codex-lb-tool-catalog.json', 'sks-openrouter-catalog.json', 'opencodex-catalog.json']
      .includes(path.basename(historicalCatalog));
  if (historicalCatalogOwned) next = removeTopLevelKey(next, 'model_catalog_json');

  for (const marker of historicalMarkers) next = removeTopLevelExactLine(next, marker);
  return removeTopLevelLinesWithPrefix(next, HISTORICAL_PROVIDER_MODE_MARKER);
}

export function parseHistoricalProviderConfig(text: string): HistoricalProviderConfigState {
  const source = String(text || '');
  const topLevel = source.split(/\n\s*\[/)[0] || '';
  const markerValues = topLevel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(HISTORICAL_PROVIDER_MODE_MARKER))
    .map((line) => line.slice(HISTORICAL_PROVIDER_MODE_MARKER.length).trim());
  const providerMode = markerValues.length === 1 && isHistoricalProviderMode(markerValues[0])
    ? markerValues[0]
    : null;
  const modelProvider = topLevelTomlString(source, 'model_provider') || null;
  const catalogPath = topLevelTomlString(source, 'model_catalog_json') || null;
  const markers = historicalManagedMarkers().filter((marker) => hasTopLevelMarker(source, marker));
  const migratedProfiles = new Set<BridgeProviderId>();
  if (
    providerMode === 'codex-lb'
    || modelProvider === 'codex-lb'
    || hasTomlTable(source, 'model_providers.codex-lb')
    || markers.includes(HISTORICAL_DESKTOP_COMPAT_MARKER)
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
  if (markerValues.length > 1) blockers.push('historical_provider_marker_conflict');
  else if (markerValues.length === 1 && !providerMode) blockers.push('historical_provider_marker_invalid');
  const desktopMode = markers.includes(HISTORICAL_DESKTOP_COMPAT_MARKER)
    ? 'desktop-dual-auth-compat'
    : markers.includes(HISTORICAL_DESKTOP_BRIDGE_MARKER)
      ? 'desktop-native-bridge'
      : modelProvider === 'codex-lb'
        ? 'cli-provider'
        : null;
  const gatewayAuthTransport = markers.includes(HISTORICAL_DESKTOP_COMPAT_MARKER)
    || tomlTableBoolean(source, 'model_providers.codex-lb', 'requires_openai_auth') === true
      ? 'x-codex-lb-api-key' as const
      : hasTomlTable(source, 'model_providers.codex-lb')
        ? 'authorization-bearer' as const
        : null;
  return {
    desktop_mode: desktopMode,
    provider_mode: providerMode,
    model_provider: modelProvider,
    catalog_path: catalogPath,
    migrated_profiles: [...migratedProfiles].sort() as BridgeProviderId[],
    gateway_auth_transport: gatewayAuthTransport,
    blockers
  };
}

function historicalManagedMarkers(): string[] {
  return [
    HISTORICAL_DESKTOP_BRIDGE_MARKER,
    HISTORICAL_DESKTOP_COMPAT_MARKER,
    HISTORICAL_PROVIDER_SELECTION_MARKER,
    HISTORICAL_OAUTH_SELECTION_MARKER,
    HISTORICAL_OPENAI_ROUTING_MARKER,
    HISTORICAL_MODEL_CATALOG_MARKER
  ];
}

function topLevelLines(text: string): string[] {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).map((line) => line.trim());
}

function removeTopLevelKey(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return filterTopLevelLines(text, (line) => !pattern.test(line));
}

function removeTopLevelExactLine(text: string, target: string): string {
  return filterTopLevelLines(text, (line) => line.trim() !== target);
}

function removeTopLevelLinesWithPrefix(text: string, prefix: string): string {
  return filterTopLevelLines(text, (line) => !line.trim().startsWith(prefix));
}

function filterTopLevelLines(text: string, keep: (line: string) => boolean): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  return lines
    .filter((line, index) => index >= end || keep(line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}
