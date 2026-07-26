import os from 'node:os';
import path from 'node:path';
import { readJson, readText } from '../fsx.js';
import { loadCodexLbEnv } from '../codex-lb/codex-lb-env.js';

/**
 * When `model_provider = "codex-lb"` is the selected provider, image generation
 * runs through that provider's Responses endpoint. Two details decide whether
 * the call succeeds, and both were previously guessed rather than resolved:
 *
 * - The API key. A shell may export a stale `CODEX_LB_API_KEY` that shadows the
 *   SKS-managed env file; the proxy answers 401. `loadCodexLbEnv` already picks
 *   the candidate whose fingerprint matches `sks-codex-lb.json`, so imagegen
 *   resolves the key through it instead of re-reading process.env by hand.
 * - The model. `config.toml`'s `model` may be a slug the codex-lb key has no
 *   access to (the proxy answers 403 `model_not_allowed`), so only a slug from
 *   the served catalog is a safe default.
 */

export const CODEX_LB_IMAGEGEN_TARGET_SCHEMA = 'sks.codex-lb-imagegen-target.v1';

export interface CodexLbImagegenTarget {
  readonly schema: typeof CODEX_LB_IMAGEGEN_TARGET_SCHEMA;
  readonly selected: boolean;
  readonly base_url: string | null;
  readonly api_key: string | null;
  readonly api_key_source: string | null;
  readonly model: string | null;
  readonly model_source: 'explicit' | 'configured_model_in_catalog' | 'catalog_default' | null;
  readonly catalog_models: readonly string[];
  readonly blocker: string | null;
}

export async function resolveCodexLbImagegenTarget(opts: {
  home?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  configText?: string;
  explicitModel?: string;
} = {}): Promise<CodexLbImagegenTarget> {
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const codexHome = opts.codexHome || env.CODEX_HOME || path.join(home, '.codex');
  const configText = typeof opts.configText === 'string'
    ? opts.configText
    : await readText(path.join(codexHome, 'config.toml'), '').catch(() => '');
  const selected = topLevelTomlString(configText, 'model_provider') === 'codex-lb';
  const loaded = await loadCodexLbEnv({
    home,
    processEnv: env,
    envPath: path.join(codexHome, 'sks-codex-lb.env'),
    legacyEnvPath: path.join(codexHome, 'sks.env'),
    metadataPath: path.join(codexHome, 'sks-codex-lb.json')
  }).catch(() => null);
  const catalogModels = await readCatalogModels(configText, home, codexHome);
  const explicit = String(opts.explicitModel || env.SKS_IMAGEGEN_RESPONSES_MODEL || '').trim();
  const configuredModel = topLevelTomlString(configText, 'model');
  const { model, model_source } = explicit
    ? { model: explicit, model_source: 'explicit' as const }
    : catalogModels.includes(configuredModel)
      ? { model: configuredModel, model_source: 'configured_model_in_catalog' as const }
      : catalogModels.length
        ? { model: catalogModels[0]!, model_source: 'catalog_default' as const }
        : { model: null, model_source: null };
  return {
    schema: CODEX_LB_IMAGEGEN_TARGET_SCHEMA,
    selected,
    base_url: loaded?.base_url || null,
    api_key: loaded?.secret_api_key || null,
    api_key_source: loaded?.api_key?.source || null,
    model,
    model_source,
    catalog_models: catalogModels,
    blocker: codexLbImagegenBlocker({ selected, loaded, model })
  };
}

function codexLbImagegenBlocker(state: { selected: boolean; loaded: any; model: string | null }): string | null {
  if (!state.selected) return 'codex_lb_not_selected';
  if (!state.loaded?.base_url) return 'codex_lb_base_url_missing';
  if (!state.loaded?.secret_api_key) return state.loaded?.missing?.includes('CODEX_LB_CREDENTIAL_BINDING')
    ? 'codex_lb_credential_binding_invalid'
    : 'codex_lb_api_key_missing';
  if (!state.model) return 'codex_lb_imagegen_model_unresolved';
  return null;
}

async function readCatalogModels(configText: string, home: string, codexHome: string): Promise<string[]> {
  const configured = topLevelTomlString(configText, 'model_catalog_json');
  const candidates = [
    configured ? resolveCatalogPath(configured, home, codexHome) : '',
    path.join(codexHome, 'sks-codex-lb-tool-catalog.json')
  ].filter(Boolean);
  for (const file of candidates) {
    const payload = await readJson<any>(file, null).catch(() => null);
    const rows = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
    const slugs = rows
      .filter((row: any) => row?.supported_in_api !== false && !hiddenCatalogRow(row))
      .map((row: any) => String(row?.slug || row?.id || row?.model || '').trim())
      .filter(Boolean);
    if (slugs.length) return [...new Set<string>(slugs)];
  }
  return [];
}

function resolveCatalogPath(configured: string, home: string, codexHome: string): string {
  const expanded = configured.replace(/^~(?=\/|$)/, home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(codexHome, expanded);
}

function hiddenCatalogRow(row: any): boolean {
  return ['hide', 'hidden', 'internal', 'none', 'unavailable'].includes(String(row?.visibility || '').trim().toLowerCase());
}

function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  const re = new RegExp(`(^|\\n)\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?(?=\\n|$)`);
  return topLevel.match(re)?.[2] || '';
}
