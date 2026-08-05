import path from 'node:path';
import {
  ensureTrailingNewline,
  upsertTopLevelTomlString
} from '../core/codex-runtime/codex-desktop-config-policy.js';
import { escapeRegExp } from '../core/text/regex.js';

export interface DesktopBridgeManagedConfigInput {
  bridgeBaseUrl: string;
  combinedCatalogPath: string;
}

export const DESKTOP_BRIDGE_MANAGED_MARKER = '# sks-desktop-bridge-managed';
export const DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER = '# sks-desktop-bridge-managed-base-url';
export const DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER = '# sks-desktop-bridge-managed-model-catalog';

/** Write the only current managed Codex routing binding. */
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

  const orphanCleanup = removeDesktopBridgeOrphanManagedMarkers(String(text || ''));
  let next = orphanCleanup.text;
  const selectedProvider = topLevelTomlString(next, 'model_provider');
  if (selectedProvider && (
    selectedProvider !== 'openai'
    || !topLevelHasLine(next, DESKTOP_BRIDGE_MANAGED_MARKER)
  )) {
    throw new Error('legacy_user_owned_config_conflict:model_provider');
  }

  const existingBaseUrl = topLevelTomlString(next, 'openai_base_url');
  const baseUrlOwned = topLevelHasLine(next, DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER);
  if (existingBaseUrl && !baseUrlOwned) {
    throw new Error('legacy_user_owned_config_conflict:openai_base_url');
  }

  const existingCatalog = topLevelTomlString(next, 'model_catalog_json');
  const catalogOwned = topLevelHasLine(next, DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER);
  if (existingCatalog && !catalogOwned) {
    throw new Error('legacy_user_owned_config_conflict:model_catalog_json');
  }

  next = removeManagedBridgeTopLevelBindings(next);
  next = upsertTopLevelTomlString(next, 'model_provider', 'openai');
  next = addTopLevelMarkerBeforeKey(next, 'model_provider', DESKTOP_BRIDGE_MANAGED_MARKER);
  next = upsertTopLevelTomlString(next, 'openai_base_url', bridgeBaseUrl);
  next = addTopLevelMarkerBeforeKey(next, 'openai_base_url', DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER);
  next = upsertTopLevelTomlString(next, 'model_catalog_json', combinedCatalogPath);
  next = addTopLevelMarkerBeforeKey(next, 'model_catalog_json', DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER);
  return ensureTrailingNewline(next);
}

/** Remove only explicitly current SKS-owned Desktop Bridge bindings. */
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
      const value = key === 'model_provider' ? selectedProvider : key === 'openai_base_url' ? baseUrl : catalog;
      if (value) throw new Error(`desktop_bridge_unmanage_ownership_missing:${key}`);
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

function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[2] || '';
}

function topLevelHasLine(text: string, line: string): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((candidate) => candidate.trim() === line);
}

function addTopLevelMarkerBeforeKey(text: string, key: string, marker: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyIndex = lines.slice(0, end).findIndex((line) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line));
  if (keyIndex >= 0 && !lines.slice(0, end).some((line) => line.trim() === marker)) lines.splice(keyIndex, 0, marker);
  return lines.join('\n');
}

function removeTopLevelLine(text: string, target: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === target) lines.splice(index, 1);
  }
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
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

function removeManagedBridgeTopLevelBindings(text: string): string {
  let next = String(text || '');
  next = removeTopLevelTomlKey(next, 'model_provider');
  next = removeTopLevelTomlKey(next, 'openai_base_url');
  next = removeTopLevelTomlKey(next, 'model_catalog_json');
  for (const marker of [
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  ]) next = removeTopLevelLine(next, marker);
  return next;
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
    || parsed.pathname.replace(/\/+$/, '') !== '/backend-api/codex'
  ) throw new Error('desktop_bridge_loopback_base_url_required');
  return normalized;
}
