import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { assertTestHomeWriteAllowed, ensureDir, readText, writeBinaryAtomic } from '../core/fsx.js';
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
import { upsertExplicitCodexProviderMode } from '../core/codex-app/provider-mode.js';

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

export interface DesktopBridgeManagedConfigInput {
  bridgeBaseUrl: string;
  combinedCatalogPath: string;
}

/** 8.1.3 managed-runtime markers. Legacy markers below remain facade-only. */
export const DESKTOP_BRIDGE_MANAGED_MARKER = '# sks-desktop-bridge-managed';
export const DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER = '# sks-desktop-bridge-managed-base-url';
export const DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER = '# sks-desktop-bridge-managed-model-catalog';

export const CODEX_LB_DESKTOP_BRIDGE_MARKER = '# sks-codex-lb-managed-desktop-bridge';
export const CODEX_LB_DESKTOP_COMPAT_MARKER = '# sks-codex-lb-managed-desktop-compat';
export const CODEX_LB_MODEL_CATALOG_MARKER = '# sks-codex-lb-managed-model-catalog';
export const CODEX_LB_PROVIDER_SELECTION_MARKER = '# sks-codex-lb-managed-provider-selection';
export const CODEX_LB_OAUTH_SELECTION_MARKER = '# sks-codex-lb-managed-oauth-selection';
export const LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';

// SKS's own OpenRouter / Multi-Provider Router activation writes an unmarked
// top-level model_provider selection. Those providers only exist when SKS
// configured them, so an explicit provider switch (Use Codex LB, Desktop
// Bridge, Use ChatGPT OAuth Only) may reclaim that selection instead of
// failing with codex_lb_user_owned_model_provider_conflict. Any other
// model_provider value stays user-owned and fail-closed.
const SKS_SWITCHABLE_THIRD_PARTY_PROVIDER_IDS = ['openrouter', 'sks-router'] as const;
const SKS_THIRD_PARTY_CATALOG_BASENAMES = ['sks-openrouter-catalog.json', 'opencodex-catalog.json'];

/**
 * Write the only 8.1.3 managed Codex routing binding.
 *
 * Provider profiles and credentials deliberately remain outside these three
 * top-level values. Existing provider tables are byte-preserved; this writer
 * only takes over a selection when legacy SKS ownership is explicit.
 */
export function upsertDesktopBridgeManagedConfig(
  text: string,
  input: DesktopBridgeManagedConfigInput
): string {
  const bridgeBaseUrl = normalizeManagedBridgeBaseUrl(input.bridgeBaseUrl);
  const combinedCatalogPath = String(input.combinedCatalogPath || '').trim();
  if (!combinedCatalogPath || !path.isAbsolute(combinedCatalogPath)) {
    throw new Error('desktop_bridge_combined_catalog_path_invalid');
  }
  if (path.basename(combinedCatalogPath) !== 'sks-bridge-catalog.json') {
    throw new Error('desktop_bridge_combined_catalog_path_invalid');
  }

  const source = String(text || '');
  const orphanCleanup = removeDesktopBridgeOrphanManagedMarkers(source);
  let next = releaseSksManagedThirdPartySelection(orphanCleanup.text);
  const selectedProvider = topLevelTomlString(next, 'model_provider');
  if (selectedProvider === 'codex-lb' && !legacyCodexLbSelectionOwnedBySks(next)) {
    throw new Error('legacy_user_owned_config_conflict:model_provider');
  }
  if (selectedProvider && selectedProvider !== 'openai' && selectedProvider !== 'codex-lb') {
    throw new Error('legacy_user_owned_config_conflict:model_provider');
  }

  const existingBaseUrl = topLevelTomlString(next, 'openai_base_url');
  const baseUrlOwned = hasAnyTopLevelMarker(next, [
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER
  ]);
  if (existingBaseUrl && !baseUrlOwned) {
    throw new Error('legacy_user_owned_config_conflict:openai_base_url');
  }

  const existingCatalog = topLevelTomlString(next, 'model_catalog_json');
  const catalogOwned = hasAnyTopLevelMarker(next, [
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER,
    CODEX_LB_MODEL_CATALOG_MARKER
  ]) || isRecognizedSksCatalogBinding(next, existingCatalog);
  if (existingCatalog && !catalogOwned) {
    throw new Error('legacy_user_owned_config_conflict:model_catalog_json');
  }

  next = removeManagedBridgeTopLevelBindings(next);
  next = upsertTopLevelTomlString(next, 'model_provider', 'openai');
  next = addTopLevelMarkerBeforeKey(next, 'model_provider', DESKTOP_BRIDGE_MANAGED_MARKER);
  next = upsertTopLevelTomlString(next, 'openai_base_url', bridgeBaseUrl);
  next = addTopLevelMarkerBeforeKey(next, 'openai_base_url', DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER);
  next = upsertTopLevelTomlString(next, 'model_catalog_json', combinedCatalogPath);
  next = addTopLevelMarkerBeforeKey(
    next,
    'model_catalog_json',
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  );
  return ensureTrailingNewline(next);
}

/**
 * Remove only the three explicitly SKS-owned 8.1.3 bindings. Provider tables,
 * credentials, auth.json, and every user-owned key remain untouched.
 */
export function removeDesktopBridgeManagedConfig(text: string): string {
  let next = String(text || '');
  const selectedProvider = topLevelTomlString(next, 'model_provider');
  const baseUrl = topLevelTomlString(next, 'openai_base_url');
  const catalog = topLevelTomlString(next, 'model_catalog_json');
  const owned = [
    [DESKTOP_BRIDGE_MANAGED_MARKER, 'model_provider', selectedProvider === 'openai'],
    [DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER, 'openai_base_url', Boolean(baseUrl)],
    [DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER, 'model_catalog_json', Boolean(catalog)]
  ] as const;
  for (const [marker, key, valid] of owned) {
    if (!topLevelHasLine(next, marker)) {
      if ((key === 'model_provider' ? selectedProvider : key === 'openai_base_url' ? baseUrl : catalog)) {
        throw new Error(`desktop_bridge_unmanage_ownership_missing:${key}`);
      }
      continue;
    }
    if (!valid) throw new Error(`desktop_bridge_unmanage_owned_value_invalid:${key}`);
    next = removeTopLevelTomlKey(next, key);
    next = removeTopLevelLine(next, marker);
  }
  return ensureTrailingNewline(next);
}

export type DesktopBridgeOrphanManagedMarkerCleanup = {
  schema: 'sks.desktop-bridge-orphan-managed-marker-cleanup.v1';
  changed: boolean;
  orphan_markers: string[];
  text: string;
};

export function removeDesktopBridgeOrphanManagedMarkers(
  text: string
): DesktopBridgeOrphanManagedMarkerCleanup {
  const source = String(text || '');
  const selectedProvider = topLevelTomlString(source, 'model_provider');
  const markerTargets = [
    [DESKTOP_BRIDGE_MANAGED_MARKER, selectedProvider === 'openai'],
    [DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER, Boolean(topLevelTomlString(source, 'openai_base_url'))],
    [DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER, Boolean(topLevelTomlString(source, 'model_catalog_json'))]
  ] as const;
  const orphanMarkers = markerTargets
    .filter(([marker, hasManagedContent]) => topLevelHasLine(source, marker) && !hasManagedContent)
    .map(([marker]) => marker);
  let next = source;
  for (const marker of orphanMarkers) next = removeTopLevelLine(next, marker);
  return {
    schema: 'sks.desktop-bridge-orphan-managed-marker-cleanup.v1',
    changed: orphanMarkers.length > 0,
    orphan_markers: orphanMarkers,
    text: next
  };
}

export function releaseSksManagedThirdPartySelection(text: string): string {
  let next = String(text || '');
  const selected = topLevelTomlString(next, 'model_provider');
  if (!selected || !(SKS_SWITCHABLE_THIRD_PARTY_PROVIDER_IDS as readonly string[]).includes(selected)) {
    return next;
  }
  // Evidence that SKS authored this selection: its provider table exists.
  if (!new RegExp(`(^|\\n)\\[model_providers\\.${escapeRegExp(selected)}\\]`).test(next)) return next;
  next = removeTopLevelTomlKeyIfValue(next, 'model_provider', selected);
  const catalog = topLevelTomlString(next, 'model_catalog_json');
  if (
    catalog
    && !topLevelHasLine(next, CODEX_LB_MODEL_CATALOG_MARKER)
    && SKS_THIRD_PARTY_CATALOG_BASENAMES.some((name) => catalog.endsWith(`/${name}`) || catalog === name)
  ) {
    // The third-party catalog binding follows its selection out; the provider
    // table and its credentials stay for a later switch back.
    next = removeTopLevelTomlKey(next, 'model_catalog_json');
  }
  return next;
}

export type CodexLbOrphanManagedMarkerCleanup = {
  schema: 'sks.codex-lb-orphan-managed-marker-cleanup.v1';
  changed: boolean;
  orphan_markers: string[];
  text: string;
};

/**
 * Remove only marker-only residue. A marker whose corresponding value still
 * exists remains intact so callers can fail closed on ambiguous legacy state.
 */
export function removeCodexLbOrphanManagedMarkers(text: string): CodexLbOrphanManagedMarkerCleanup {
  const source = String(text || '');
  const selectedProvider = topLevelTomlString(source, 'model_provider');
  const markerTargets = [
    [CODEX_LB_DESKTOP_BRIDGE_MARKER, Boolean(topLevelTomlString(source, 'openai_base_url'))],
    [LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER, Boolean(topLevelTomlString(source, 'openai_base_url'))],
    [CODEX_LB_DESKTOP_COMPAT_MARKER, selectedProvider === 'codex-lb'],
    [CODEX_LB_MODEL_CATALOG_MARKER, Boolean(topLevelTomlString(source, 'model_catalog_json'))],
    [CODEX_LB_PROVIDER_SELECTION_MARKER, selectedProvider === 'codex-lb'],
    [CODEX_LB_OAUTH_SELECTION_MARKER, selectedProvider === 'openai']
  ] as const;
  const orphanMarkers = markerTargets
    .filter(([marker, hasManagedContent]) => topLevelHasLine(source, marker) && !hasManagedContent)
    .map(([marker]) => marker);
  let next = source;
  for (const marker of orphanMarkers) next = removeTopLevelLine(next, marker);
  return {
    schema: 'sks.codex-lb-orphan-managed-marker-cleanup.v1',
    changed: orphanMarkers.length > 0,
    orphan_markers: orphanMarkers,
    text: next
  };
}

export function upsertCodexLbNativeDesktopConfig(
  text: string,
  input: NativeDesktopConfigInput
): string {
  let next = releaseSksManagedThirdPartySelection(
    removeCodexLbOrphanManagedMarkers(String(text || '')).text
  );
  const selectedProvider = topLevelTomlString(next, 'model_provider');
  if (selectedProvider && selectedProvider !== 'openai' && selectedProvider !== 'codex-lb') {
    throw new Error('codex_lb_user_owned_model_provider_conflict');
  }
  if (
    selectedProvider === 'codex-lb'
    && !topLevelHasLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER)
    && !topLevelHasLine(next, CODEX_LB_PROVIDER_SELECTION_MARKER)
  ) {
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
  next = removeManagedCodexLbSelection(next);
  next = removeTopLevelLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER);
  next = removeManagedModelCatalogJson(next);
  next = upsertManagedTopLevelTomlString(
    next,
    'openai_base_url',
    input.bridgeBaseUrl,
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    [LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER]
  );
  next = upsertTopLevelTomlString(next, 'model_provider', 'openai');
  next = upsertTomlTable(next, 'model_providers.codex-lb', cliProviderBlock(input.remoteBaseUrl));
  return ensureTrailingNewline(upsertExplicitCodexProviderMode(next, 'codex-lb'));
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
  const cleaned = removeCodexLbOrphanManagedMarkers(String(text || '')).text;
  if (topLevelHasLine(cleaned, LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER)) {
    throw new Error('codex_lb_legacy_desktop_config_requires_migration');
  }
  // Explicit global selection may reclaim an SKS-authored OpenRouter/router
  // selection; credential-only writes (selectGlobally false) never touch it.
  const cliBase = input.selectGlobally === true
    ? releaseSksManagedThirdPartySelection(removeCodexLbManagedDesktopConfig(cleaned))
    : removeCodexLbManagedDesktopConfig(cleaned);
  const claimedSelection = input.selectGlobally === true
    && topLevelTomlString(cliBase, 'model_provider') === 'codex-lb'
    && !topLevelHasLine(cliBase, CODEX_LB_PROVIDER_SELECTION_MARKER)
      ? addTopLevelMarkerBeforeKey(cliBase, 'model_provider', CODEX_LB_PROVIDER_SELECTION_MARKER)
      : cliBase;
  let next = input.selectGlobally === true
    ? upsertManagedTopLevelTomlString(
        removeTopLevelTomlKeyIfValue(
          removeManagedOAuthSelection(claimedSelection),
          'model_provider',
          'openai'
        ),
        'model_provider',
        'codex-lb',
        CODEX_LB_PROVIDER_SELECTION_MARKER
      )
    : removeManagedCodexLbSelection(cliBase);
  next = upsertTomlTable(next, 'model_providers.codex-lb', cliProviderBlock(input.remoteBaseUrl));
  return ensureTrailingNewline(next);
}

/** Explicit Center OFF state: select built-in OpenAI and remove the LB marker+value as one unit. */
export function restoreCodexLbOAuthSelectionConfig(text: string): string {
  let next = removeManagedCodexLbSelection(String(text || ''));
  next = upsertManagedTopLevelTomlString(
    next,
    'model_provider',
    'openai',
    CODEX_LB_OAUTH_SELECTION_MARKER
  );
  return ensureTrailingNewline(upsertExplicitCodexProviderMode(next, 'chatgpt-oauth'));
}

export function removeManagedCodexLbSelection(text: string): string {
  let next = removeTopLevelTomlKeyIfValue(String(text || ''), 'model_provider', 'codex-lb');
  next = removeTopLevelLine(next, CODEX_LB_PROVIDER_SELECTION_MARKER);
  return next;
}

function removeManagedOAuthSelection(text: string): string {
  let next = String(text || '');
  if (topLevelHasLine(next, CODEX_LB_OAUTH_SELECTION_MARKER)) {
    next = removeTopLevelTomlKeyIfValue(next, 'model_provider', 'openai');
    next = removeTopLevelLine(next, CODEX_LB_OAUTH_SELECTION_MARKER);
  }
  return next;
}

export function removeCodexLbManagedDesktopConfig(text: string): string {
  let next = removeManagedDesktopBridgeRouting(
    removeCodexLbOrphanManagedMarkers(String(text || '')).text
  );
  if (topLevelHasLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER)) {
    next = removeTopLevelTomlKeyIfValue(next, 'model_provider', 'codex-lb');
    next = removeTopLevelLine(next, CODEX_LB_DESKTOP_COMPAT_MARKER);
  }
  next = removeManagedModelCatalogJson(next);
  // OFF is an explicit provider transition. When codex-lb owns (or is still
  // left as) the active provider, restore the built-in OpenAI selection in the
  // same config write. Shared auth.json remains byte-for-byte untouched.
  if (topLevelTomlString(next, 'model_provider') === 'codex-lb') {
    next = restoreCodexLbOAuthSelectionConfig(next);
  }
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
  // Codex maps env_key to Authorization: Bearer. Custom X-Codex-LB-API-Key
  // headers are not used for the atomic CLI provider — gateways that only
  // accept Bearer (e.g. Hyper-Lab) stay reachable without a transport picker.
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
  if (state.status === 'missing' && state.managed) {
    return {
      ...state,
      changed: true,
      text: removeTopLevelLine(String(text || ''), CODEX_LB_SHARED_OPENAI_ROUTING_MARKER)
    };
  }
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

export async function captureCodexLbSetupWriteState({ home, configPath, envPath, metadataPath, shellProfile }: any = {}) {
  const profileFiles = profileFilesForDrift(home, shellProfile);
  const paths = [configPath, envPath, metadataPath, ...profileFiles].filter(Boolean);
  const files = await Promise.all(paths.map(captureSetupFile));
  const hashesByPath = new Map(
    await Promise.all(files.map(async (file) => [file.path, await capturedSetupFileHash(file)] as const))
  );
  const hashForPath = (file: string) => file ? hashesByPath.get(file) || 'missing' : 'missing';
  return {
    configHash: hashForPath(configPath),
    envHash: hashForPath(envPath),
    metadataHash: hashForPath(metadataPath),
    profileHash: profileFiles.map(hashForPath).join('|'),
    files,
    stateHash: await sha256Text(JSON.stringify(files))
  };
}

export type CodexLbSetupFileState = {
  path: string;
  existed: boolean;
  kind: 'missing' | 'regular' | 'symlink' | 'non_regular';
  bytes_base64: string;
  mode: number | null;
};

export type CodexLbSetupFileWriteResult = {
  ok: boolean;
  status: 'written' | 'present' | 'concurrent_change_detected' | 'unsafe_setup_write_target' | 'write_failed';
  installed: boolean;
  expected_after: CodexLbSetupFileState;
  recovery_path?: string;
  error?: string;
};

/**
 * Replace one setup-owned file only while its exact bytes, kind, and mode still
 * match the authoritative setup snapshot. The rename/verify/link sequence makes
 * the final install no-replace and retains the claimed inode for recovery so an
 * edit made through a descriptor opened before the rename cannot be lost.
 */
export async function writeCodexLbSetupFileIfUnchanged(input: {
  file: string;
  expected: CodexLbSetupFileState;
  text: string;
  mode: number;
  beforeReplacement?: (input: { path: string }) => void | Promise<void>;
}): Promise<CodexLbSetupFileWriteResult> {
  const file = path.resolve(input.file);
  if (path.resolve(String(input.expected.path || '')) !== file) {
    return {
      ok: false,
      status: 'write_failed',
      installed: false,
      expected_after: {
        path: file,
        existed: true,
        kind: 'regular',
        bytes_base64: Buffer.from(input.text).toString('base64'),
        mode: Number(input.mode) & 0o777
      },
      error: 'setup_snapshot_path_mismatch'
    };
  }
  const expected = { ...input.expected, path: file };
  const mode = Number(input.mode) & 0o777;
  const expectedAfter: CodexLbSetupFileState = {
    path: file,
    existed: true,
    kind: 'regular',
    bytes_base64: Buffer.from(input.text).toString('base64'),
    mode
  };
  if (expected.existed === true && expected.kind !== 'regular') {
    return {
      ok: false,
      status: 'unsafe_setup_write_target',
      installed: false,
      expected_after: expectedAfter
    };
  }

  assertTestHomeWriteAllowed(file);
  await ensureDir(path.dirname(file));
  const token = `${Date.now().toString(36)}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const claimedPath = `${file}.sks-setup-claimed-${token}`;
  const candidatePath = `${file}.sks-setup-candidate-${token}`;
  let claimed = false;
  let installed = false;
  try {
    await writeBinaryAtomic(candidatePath, Buffer.from(input.text), { mode });
    const observed = await captureSetupFile(file);
    if (!setupFileStatesEqual(observed, expected)) {
      return {
        ok: false,
        status: 'concurrent_change_detected',
        installed: false,
        expected_after: expectedAfter
      };
    }
    if (setupFileStatesEqual(expected, expectedAfter)) {
      return {
        ok: true,
        status: 'present',
        installed: false,
        expected_after: expectedAfter
      };
    }

    if (expected.existed === true) {
      try {
        await fsp.rename(file, claimedPath);
        claimed = true;
      } catch {
        return {
          ok: false,
          status: 'concurrent_change_detected',
          installed: false,
          expected_after: expectedAfter
        };
      }
      const claimedState = await captureSetupFile(claimedPath);
      if (!setupFileStatesEqual(claimedState, { ...expected, path: claimedPath })) {
        const recovered = await restoreClaimedSetupPathIfAbsent(claimedPath, file, claimedState);
        claimed = !recovered;
        const hardened = !claimed || await hardenCodexLbSetupRecoveryPath(claimedPath);
        return {
          ok: false,
          status: hardened ? 'concurrent_change_detected' : 'write_failed',
          installed: false,
          expected_after: expectedAfter,
          ...(claimed ? { recovery_path: claimedPath } : {}),
          ...(hardened ? {} : { error: 'setup_recovery_mode_hardening_failed' })
        };
      }
    }

    await input.beforeReplacement?.({ path: file });
    try {
      await fsp.link(candidatePath, file);
      installed = true;
    } catch {
      if (claimed) {
        const claimedState = await captureSetupFile(claimedPath).catch(() => null);
        const recovered = claimedState
          ? await restoreClaimedSetupPathIfAbsent(claimedPath, file, claimedState)
          : false;
        claimed = !recovered;
      }
      const hardened = !claimed || await hardenCodexLbSetupRecoveryPath(claimedPath);
      return {
        ok: false,
        status: hardened ? 'concurrent_change_detected' : 'write_failed',
        installed: false,
        expected_after: expectedAfter,
        ...(claimed ? { recovery_path: claimedPath } : {}),
        ...(hardened ? {} : { error: 'setup_recovery_mode_hardening_failed' })
      };
    }

    const committed = await captureSetupFile(file);
    if (!setupFileStatesEqual(committed, expectedAfter)) {
      const hardened = !claimed || await hardenCodexLbSetupRecoveryPath(claimedPath);
      return {
        ok: false,
        status: hardened ? 'concurrent_change_detected' : 'write_failed',
        installed: true,
        expected_after: expectedAfter,
        ...(claimed ? { recovery_path: claimedPath } : {}),
        ...(hardened ? {} : { error: 'setup_recovery_mode_hardening_failed' })
      };
    }
    if (claimed && !await hardenCodexLbSetupRecoveryPath(claimedPath)) {
      return {
        ok: false,
        status: 'write_failed',
        installed: true,
        expected_after: expectedAfter,
        recovery_path: claimedPath,
        error: 'setup_recovery_mode_hardening_failed'
      };
    }
    return {
      ok: true,
      status: 'written',
      installed: true,
      expected_after: expectedAfter,
      ...(claimed ? { recovery_path: claimedPath } : {})
    };
  } catch (error: unknown) {
    if (claimed && !installed) {
      const claimedState = await captureSetupFile(claimedPath).catch(() => null);
      const recovered = claimedState
        ? await restoreClaimedSetupPathIfAbsent(claimedPath, file, claimedState)
        : false;
      claimed = !recovered;
    }
    const hardened = !claimed || await hardenCodexLbSetupRecoveryPath(claimedPath);
    return {
      ok: false,
      status: 'write_failed',
      installed,
      expected_after: expectedAfter,
      ...(claimed ? { recovery_path: claimedPath } : {}),
      error: [
        error instanceof Error ? error.message : String(error),
        ...(hardened ? [] : ['setup_recovery_mode_hardening_failed'])
      ].join(':')
    };
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

export async function hardenCodexLbSetupRecoveryPath(file: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return false;
    await handle.chmod(0o600);
    const hardened = await handle.stat();
    const pathStat = await fsp.lstat(file);
    return hardened.isFile()
      && (hardened.mode & 0o777) === 0o600
      && pathStat.isFile()
      && !pathStat.isSymbolicLink()
      && pathStat.dev === hardened.dev
      && pathStat.ino === hardened.ino;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function removeCodexLbSetupRecoveryPath(file: string): Promise<boolean> {
  if (!path.basename(file).includes('.sks-setup-claimed-')) return false;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    const pathStat = await fsp.lstat(file);
    if (!opened.isFile()
      || !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.dev !== opened.dev
      || pathStat.ino !== opened.ino) return false;
    await fsp.unlink(file);
    return await fsp.lstat(file).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function restoreCodexLbSetupWriteState(
  state: any,
  expectedCurrentState?: any,
  opts: {
    beforeReplacement?: (input: { path: string }) => void | Promise<void>;
  } = {}
): Promise<{
  ok: boolean;
  restored: string[];
  removed: string[];
  blockers: string[];
  recovery: string[];
}> {
  const restored: string[] = [];
  const removed: string[] = [];
  const blockers: string[] = [];
  const recovery: string[] = [];
  const expectedByPath = new Map(
    (Array.isArray(expectedCurrentState?.files) ? expectedCurrentState.files : [])
      .map((entry: any) => [String(entry?.path || ''), entry])
  );
  for (const entry of Array.isArray(state?.files) ? [...state.files].reverse() : []) {
    const file = String(entry?.path || '');
    if (!file) continue;
    try {
      const expected = expectedByPath.get(file);
      if (!expected) {
        blockers.push(`setup_rollback_missing_expected_state:${file}`);
        continue;
      }
      if (expected && setupFileStatesEqual(entry, expected)) continue;
      const commit = await commitSetupRollbackIfUnchanged({
        file,
        before: entry,
        expected,
        ...(opts.beforeReplacement ? { beforeReplacement: opts.beforeReplacement } : {})
      });
      if (commit.recoveryPath) recovery.push(commit.recoveryPath);
      if (!commit.ok) {
        blockers.push(`${commit.failed ? 'setup_rollback_failed' : 'setup_rollback_conflict'}:${file}`);
        continue;
      }
      if (commit.restored) restored.push(file);
      if (commit.removed) removed.push(file);
    } catch {
      blockers.push(`setup_rollback_failed:${file}`);
    }
  }
  return { ok: blockers.length === 0, restored, removed, blockers, recovery };
}

function setupFileStatesEqual(left: any, right: any): boolean {
  return left?.existed === right?.existed
    && String(left?.kind || (left?.existed ? 'regular' : 'missing')) === String(right?.kind || (right?.existed ? 'regular' : 'missing'))
    && String(left?.bytes_base64 || '') === String(right?.bytes_base64 || '')
    && (left?.existed !== true || Number(left?.mode) === Number(right?.mode));
}

async function captureSetupFile(file: string): Promise<CodexLbSetupFileState> {
  let pathStat;
  try {
    pathStat = await fsp.lstat(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { path: file, existed: false, kind: 'missing', bytes_base64: '', mode: null };
    }
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    return { path: file, existed: true, kind: 'symlink', bytes_base64: '', mode: pathStat.mode & 0o777 };
  }
  if (!pathStat.isFile()) {
    return { path: file, existed: true, kind: 'non_regular', bytes_base64: '', mode: pathStat.mode & 0o777 };
  }
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { path: file, existed: true, kind: 'non_regular', bytes_base64: '', mode: stat.mode & 0o777 };
    }
    const bytes = await handle.readFile();
    return {
      path: file,
      existed: true,
      kind: 'regular',
      bytes_base64: bytes.toString('base64'),
      mode: stat.mode & 0o777
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { path: file, existed: false, kind: 'missing', bytes_base64: '', mode: null };
    }
    if ((error as NodeJS.ErrnoException | null)?.code === 'ELOOP') {
      const stat = await fsp.lstat(file).catch(() => null);
      return {
        path: file,
        existed: true,
        kind: 'symlink',
        bytes_base64: '',
        mode: stat ? stat.mode & 0o777 : null
      };
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function commitSetupRollbackIfUnchanged(input: {
  file: string;
  before: any;
  expected: any;
  beforeReplacement?: (input: { path: string }) => void | Promise<void>;
}): Promise<{
  ok: boolean;
  restored: boolean;
  removed: boolean;
  failed?: boolean;
  recoveryPath?: string;
}> {
  const { file, before, expected } = input;
  await ensureDir(path.dirname(file));
  const token = `${Date.now().toString(36)}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const claimedPath = `${file}.sks-rollback-claimed-${token}`;
  const candidatePath = `${file}.sks-rollback-candidate-${token}`;
  let claimed = false;
  try {
    if (expected.existed === true) {
      const currentStat = await fsp.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isFile()) {
        return { ok: false, restored: false, removed: false };
      }
      try {
        await fsp.rename(file, claimedPath);
        claimed = true;
      } catch {
        return { ok: false, restored: false, removed: false };
      }
      const claimedState = await captureSetupFile(claimedPath);
      if (!setupFileStatesEqual(claimedState, { ...expected, path: claimedPath })) {
        const recovered = await restoreClaimedSetupPathIfAbsent(claimedPath, file, claimedState);
        claimed = !recovered;
        return {
          ok: false,
          restored: false,
          removed: false,
          ...(claimed ? { recoveryPath: claimedPath } : {})
        };
      }
    } else {
      const current = await captureSetupFile(file);
      if (!setupFileStatesEqual(current, expected)) {
        return { ok: false, restored: false, removed: false };
      }
    }

    await input.beforeReplacement?.({ path: file });

    if (before.existed === true) {
      if (String(before.kind || 'regular') !== 'regular') {
        if (claimed) {
          const claimedState = await captureSetupFile(claimedPath);
          const recovered = await restoreClaimedSetupPathIfAbsent(claimedPath, file, claimedState);
          claimed = !recovered;
        }
        return {
          ok: false,
          restored: false,
          removed: false,
          failed: true,
          ...(claimed ? { recoveryPath: claimedPath } : {})
        };
      }
      const bytes = Buffer.from(String(before.bytes_base64 || ''), 'base64');
      await writeBinaryAtomic(candidatePath, bytes, { mode: Number(before.mode || 0o600) });
      try {
        await fsp.link(candidatePath, file);
      } catch {
        return {
          ok: false,
          restored: false,
          removed: false,
          ...(claimed ? { recoveryPath: claimedPath } : {})
        };
      }
      const committed = await captureSetupFile(file);
      if (!setupFileStatesEqual(committed, before)) {
        return {
          ok: false,
          restored: false,
          removed: false,
          ...(claimed ? { recoveryPath: claimedPath } : {})
        };
      }
      return {
        ok: true,
        restored: true,
        removed: false,
        ...(claimed ? { recoveryPath: claimedPath } : {})
      };
    }

    const committed = await captureSetupFile(file);
    if (!setupFileStatesEqual(committed, before)) {
      return {
        ok: false,
        restored: false,
        removed: false,
        ...(claimed ? { recoveryPath: claimedPath } : {})
      };
    }
    return {
      ok: true,
      restored: false,
      removed: true,
      ...(claimed ? { recoveryPath: claimedPath } : {})
    };
  } catch {
    if (claimed) {
      const claimedState = await captureSetupFile(claimedPath).catch(() => null);
      const recovered = claimedState
        ? await restoreClaimedSetupPathIfAbsent(claimedPath, file, claimedState)
        : false;
      claimed = !recovered;
    }
    return {
      ok: false,
      restored: false,
      removed: false,
      failed: true,
      ...(claimed ? { recoveryPath: claimedPath } : {})
    };
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

async function restoreClaimedSetupPathIfAbsent(claimedPath: string, file: string, claimedState: any): Promise<boolean> {
  try {
    if (claimedState?.kind === 'regular') {
      await fsp.link(claimedPath, file);
    } else if (claimedState?.kind === 'symlink') {
      await fsp.symlink(await fsp.readlink(claimedPath), file);
    } else {
      return false;
    }
    await fsp.unlink(claimedPath);
    return true;
  } catch {
    return false;
  }
}

async function capturedSetupFileHash(file: CodexLbSetupFileState) {
  if (file.kind !== 'regular') return 'missing';
  return await sha256Text(Buffer.from(file.bytes_base64, 'base64').toString('utf8'));
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

function hasAnyTopLevelMarker(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => topLevelHasLine(text, marker));
}

function legacyCodexLbSelectionOwnedBySks(text: string): boolean {
  if (topLevelTomlString(text, 'model_provider') !== 'codex-lb') return false;
  return hasAnyTopLevelMarker(text, [
    CODEX_LB_DESKTOP_COMPAT_MARKER,
    CODEX_LB_PROVIDER_SELECTION_MARKER,
    LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER
  ]) || (
    topLevelHasLine(text, '# sks-managed-provider-mode:codex-lb')
    && new RegExp(`(^|\\n)\\[model_providers\\.${escapeRegExp('codex-lb')}\\]`).test(text)
  );
}

function isRecognizedSksCatalogBinding(text: string, catalogPath: string): boolean {
  if (!catalogPath) return false;
  const basename = path.basename(catalogPath);
  if (basename === 'sks-codex-lb-tool-catalog.json') {
    return new RegExp(`(^|\\n)\\[model_providers\\.${escapeRegExp('codex-lb')}\\]`).test(text)
      && (
        legacyCodexLbSelectionOwnedBySks(text)
        || topLevelHasLine(text, LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER)
      );
  }
  return false;
}

function removeManagedBridgeTopLevelBindings(text: string): string {
  let next = String(text || '');
  next = removeTopLevelTomlKey(next, 'model_provider');
  next = removeTopLevelTomlKey(next, 'openai_base_url');
  next = removeTopLevelTomlKey(next, 'model_catalog_json');
  for (const marker of [
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER,
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    CODEX_LB_DESKTOP_COMPAT_MARKER,
    CODEX_LB_MODEL_CATALOG_MARKER,
    CODEX_LB_PROVIDER_SELECTION_MARKER,
    CODEX_LB_OAUTH_SELECTION_MARKER,
    LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER
  ]) {
    next = removeTopLevelLine(next, marker);
  }
  next = removeTopLevelLinesWithPrefix(next, '# sks-managed-provider-mode:');
  return next;
}

function removeTopLevelLinesWithPrefix(text: string, prefix: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  return lines
    .filter((line, index) => index >= end || !line.trim().startsWith(prefix))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeManagedBridgeBaseUrl(value: string): string {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('desktop_bridge_loopback_base_url_required');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('desktop_bridge_loopback_base_url_required');
  }
  if (parsed.pathname.replace(/\/+$/, '') !== '/backend-api/codex') {
    throw new Error('desktop_bridge_loopback_base_url_required');
  }
  return normalized;
}
