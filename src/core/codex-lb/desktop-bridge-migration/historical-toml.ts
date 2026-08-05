import { escapeRegExp } from '../../text/regex.js';
import type { HistoricalProviderMode } from './types.js';

export const HISTORICAL_PROVIDER_MODE_MARKER = '# sks-managed-provider-mode:';
export const HISTORICAL_DESKTOP_BRIDGE_MARKER = '# sks-codex-lb-managed-desktop-bridge';
export const HISTORICAL_DESKTOP_COMPAT_MARKER = '# sks-codex-lb-managed-desktop-compat';
export const HISTORICAL_PROVIDER_SELECTION_MARKER = '# sks-codex-lb-managed-provider-selection';
export const HISTORICAL_OAUTH_SELECTION_MARKER = '# sks-codex-lb-managed-oauth-selection';
export const HISTORICAL_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';
export const HISTORICAL_MODEL_CATALOG_MARKER = '# sks-codex-lb-managed-model-catalog';
export const CANONICAL_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

export function isHistoricalProviderMode(value: unknown): value is HistoricalProviderMode {
  return value === 'chatgpt-oauth' || value === 'codex-lb' || value === 'openrouter';
}

export function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1] || '';
}

export function hasTopLevelMarker(text: string, marker: string): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((line) => line.trim() === marker);
}

export function hasTomlTable(text: string, table: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*\\[${escapeRegExp(table)}\\]\\s*(?=\\n|$)`).test(text);
}

export function tomlTableString(text: string, table: string, key: string): string | null {
  const block = tomlTableBlock(text, table);
  return block.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1] || null;
}

export function tomlTableBoolean(text: string, table: string, key: string): boolean | null {
  const block = tomlTableBlock(text, table);
  const value = block.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1];
  return value === 'true' ? true : value === 'false' ? false : null;
}

export function tomlTableContainsCustomHeader(text: string, table: string): boolean {
  return /(?:^|[\s"'{,])x-codex-lb-api-key(?:[\s"'}=,]|$)/i.test(tomlTableBlock(text, table));
}

function tomlTableBlock(text: string, table: string): string {
  return String(text || '').match(
    new RegExp(`(?:^|\\n)\\s*\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\s*\\[[^\\]]+\\]|\\s*$)`)
  )?.[1] || '';
}

export function secretFreeProviderEndpoint(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null;
    return value;
  } catch {
    return null;
  }
}
