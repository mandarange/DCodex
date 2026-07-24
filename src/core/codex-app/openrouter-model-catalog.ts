import os from 'node:os';
import path from 'node:path';
import { nowIso, readText, writeTextAtomic } from '../fsx.js';
import {
  CODEX_MODEL_CATALOG_MAX_MODELS,
  catalogModelRowBlockers,
  normalizeCodexModelId,
  readCodexModelCatalogFile,
  readTopLevelTomlString,
  sksOpenRouterCatalogPath,
  type CodexModelCatalogReadResult
} from './codex-model-catalog.js';
import { isSksManagedCatalogPath, resolveCatalogPath } from './multi-provider-router-support.js';
import { OPENROUTER_SELECTABLE_REASONING_EFFORTS } from './openrouter-provider.js';
import { OPENROUTER_CATALOG_BASE_INSTRUCTIONS } from './openrouter-base-instructions.js';
import {
  ensureTrailingNewline,
  removeTopLevelTomlKeyIfValue,
  safeWriteCodexConfigToml,
  upsertTopLevelTomlString
} from '../codex-runtime/codex-desktop-config-policy.js';
import { readRoleModelPreferences } from '../subagents/role-model-preferences.js';
import { stampRoleModelCatalogPriorities } from './role-model-catalog-priority.js';
import { invalidateCodexModelsCache } from './codex-models-cache.js';

const OPENROUTER_REASONING_LEVEL_DESCRIPTIONS: Record<string, string> = {
  none: 'No extra reasoning pass',
  minimal: 'Fastest responses with minimal reasoning',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems'
};

/**
 * Full Codex ModelInfo row for an OpenRouter model. Without a catalog row the
 * Desktop app falls back to `used_fallback_model_metadata` metadata that
 * disables the reasoning picker, multi-agent v2 eligibility, and list
 * visibility for third-party models. The row mirrors what Codex itself uses
 * for uncataloged models (fallback base instructions, bytes truncation) while
 * declaring the capabilities OpenRouter's Responses endpoint supports.
 */
export function openRouterCatalogModelRow(model: string): Record<string, unknown> {
  return {
    slug: model,
    display_name: model,
    description: 'OpenRouter model activated by SKS',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: OPENROUTER_SELECTABLE_REASONING_EFFORTS.map((effort) => ({
      effort,
      description: OPENROUTER_REASONING_LEVEL_DESCRIPTIONS[effort] || `${effort} reasoning`
    })),
    shell_type: 'default',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    base_instructions: OPENROUTER_CATALOG_BASE_INSTRUCTIONS,
    default_reasoning_summary: 'auto',
    supports_reasoning_summaries: true,
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    // Codex's own uncataloged-model fallback context window; without these the
    // context-left UI and ~90% auto-compaction have no token budget to track.
    context_window: 272_000,
    max_context_window: 272_000,
    multi_agent_version: 'v2'
  };
}

export interface OpenRouterManagedCatalogWriteResult {
  readonly schema: 'sks.openrouter-model-catalog-write.v1';
  readonly ok: boolean;
  readonly status: 'written' | 'current' | 'failed';
  readonly path: string;
  readonly models: readonly string[];
  readonly catalog: CodexModelCatalogReadResult | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly models_cache?: unknown;
  readonly role_model_priority?: {
    readonly stamped: boolean;
    readonly stamped_models: readonly string[];
    readonly missing_from_catalog: readonly string[];
  };
}

/**
 * Write (or refresh) the SKS-managed OpenRouter ModelInfo catalog file.
 * Existing rows for other previously activated models are preserved so the
 * Desktop model picker keeps every model the user has activated.
 */
export async function writeOpenRouterManagedCatalog(input: {
  readonly model: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<OpenRouterManagedCatalogWriteResult> {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const catalogPath = sksOpenRouterCatalogPath({ home, env });
  const model = normalizeCodexModelId(input.model);
  if (!model) {
    return {
      schema: 'sks.openrouter-model-catalog-write.v1',
      ok: false,
      status: 'failed',
      path: catalogPath,
      models: [],
      catalog: null,
      blockers: ['openrouter_model_invalid'],
      warnings: []
    };
  }
  const warnings: string[] = [];
  const existingRows: Record<string, unknown>[] = [];
  const seenSlugs = new Set<string>([model]);
  const existingText = await readText(catalogPath, '');
  if (existingText.trim()) {
    try {
      const parsed = JSON.parse(existingText);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.models)) {
        for (const row of parsed.models) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          const slug = normalizeCodexModelId((row as Record<string, unknown>).slug);
          if (!slug || seenSlugs.has(slug)) continue;
          // Never re-persist a row that would poison the whole catalog: one
          // invalid carried row makes readCodexModelCatalogFile (and Codex)
          // reject the file forever.
          if (catalogModelRowBlockers(row).length) {
            warnings.push(`openrouter_model_catalog_previous_row_dropped:${slug}`);
            continue;
          }
          seenSlugs.add(slug);
          existingRows.push(row as Record<string, unknown>);
        }
      } else {
        warnings.push('openrouter_model_catalog_previous_shape_invalid');
      }
    } catch {
      warnings.push('openrouter_model_catalog_previous_invalid_json');
    }
  }
  const baseRows = [openRouterCatalogModelRow(model), ...existingRows].slice(0, CODEX_MODEL_CATALOG_MAX_MODELS);
  const rolePrefs = await readRoleModelPreferences({ env }).catch(() => null);
  const stamped = stampRoleModelCatalogPriorities(baseRows, rolePrefs?.store || null);
  if (stamped.missing_from_catalog.length) {
    warnings.push(...stamped.missing_from_catalog.map((slug) => `role_model_not_in_openrouter_catalog:${slug}`));
  }
  const rows = stamped.rows;
  const nextText = `${JSON.stringify({ generated_at: nowIso(), generated_by: 'sks-openrouter-activation', models: rows }, null, 2)}\n`;
  try {
    await writeTextAtomic(catalogPath, nextText, { mode: 0o600 });
  } catch (err: any) {
    return {
      schema: 'sks.openrouter-model-catalog-write.v1',
      ok: false,
      status: 'failed',
      path: catalogPath,
      models: rows.map((row) => String(row.slug)),
      catalog: null,
      blockers: [`openrouter_model_catalog_write_failed:${err?.code || err?.message || 'unknown'}`],
      warnings
    };
  }
  const cache = await invalidateCodexModelsCache({ home, env, catalogPath, seedMode: 'merge' });
  if (!cache.ok) warnings.push(...cache.blockers);
  else warnings.push(...cache.warnings);
  const catalog = await readCodexModelCatalogFile({ filePath: catalogPath, configured: true });
  return {
    schema: 'sks.openrouter-model-catalog-write.v1',
    ok: catalog.ok && catalog.models.some((entry) => entry.model === model),
    status: existingText.trim() === nextText.trim() ? 'current' : 'written',
    path: catalogPath,
    models: catalog.models.map((entry) => entry.model),
    catalog,
    models_cache: cache,
    role_model_priority: {
      stamped: stamped.stamped,
      stamped_models: stamped.stamped_models,
      missing_from_catalog: stamped.missing_from_catalog
    },
    blockers: catalog.blockers,
    warnings
  };
}

export interface OpenRouterCatalogBindDecision {
  readonly bindable: boolean;
  readonly bound: boolean;
  readonly configured_path: string | null;
  readonly reason: 'unconfigured' | 'already_bound' | 'sks_managed_replaceable' | 'user_catalog_preserved';
}

/**
 * Decide whether `model_catalog_json` may be pointed at the SKS OpenRouter
 * catalog. Only unconfigured or SKS-managed bindings are replaced; an
 * unrecognized user catalog is preserved and reported instead.
 */
export function openRouterCatalogBindDecision(configText: string, input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
} = {}): OpenRouterCatalogBindDecision {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const catalogPath = sksOpenRouterCatalogPath({ home, env });
  const configured = readTopLevelTomlString(String(configText || ''), 'model_catalog_json');
  if (!configured) return { bindable: true, bound: false, configured_path: null, reason: 'unconfigured' };
  const resolved = resolveCatalogPath(configured, {
    home,
    env,
    ...(input.configPath === undefined ? {} : { configPath: input.configPath })
  });
  if (resolved === path.resolve(catalogPath)) {
    return { bindable: true, bound: true, configured_path: configured, reason: 'already_bound' };
  }
  if (isSksManagedCatalogPath(resolved, { home, env })) {
    return { bindable: true, bound: false, configured_path: configured, reason: 'sks_managed_replaceable' };
  }
  return { bindable: false, bound: false, configured_path: configured, reason: 'user_catalog_preserved' };
}

/**
 * Standalone repair used by doctor/install: when OpenRouter is the selected
 * Desktop provider, make sure the managed catalog file covers the active model
 * and `model_catalog_json` points at it (unless a user catalog is configured).
 */
export async function ensureOpenRouterModelCatalog(input: {
  readonly configPath: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const current = await readText(input.configPath, '');
  const selectedProvider = readTopLevelTomlString(current, 'model_provider');
  if (selectedProvider !== 'openrouter') {
    // A dangling binding to the OpenRouter catalog while another provider is
    // active REPLACES Codex's bundled catalog and hides every OpenAI model —
    // unbind it so the built-in catalog comes back.
    const bind = openRouterCatalogBindDecision(current, { home, env, configPath: input.configPath });
    if (bind.bound) {
      const configured = readTopLevelTomlString(current, 'model_catalog_json') || '';
      const next = ensureTrailingNewline(removeTopLevelTomlKeyIfValue(current, 'model_catalog_json', configured));
      const safeWrite = await safeWriteCodexConfigToml(input.configPath, current, next, 'openrouter-model-catalog-unbind');
      return {
        schema: 'sks.openrouter-model-catalog-repair.v1',
        ok: safeWrite.ok,
        status: safeWrite.ok ? 'unbound_dangling' : String(safeWrite.status || 'config_write_blocked'),
        selected_provider: selectedProvider,
        write: safeWrite,
        blockers: safeWrite.ok ? [] : [String(safeWrite.status || 'openrouter_model_catalog_unbind_failed')],
        warnings: []
      };
    }
    return { schema: 'sks.openrouter-model-catalog-repair.v1', ok: true, status: 'skipped', reason: 'openrouter_not_selected' };
  }
  const model = normalizeCodexModelId(readTopLevelTomlString(current, 'model'));
  if (!model) {
    return { schema: 'sks.openrouter-model-catalog-repair.v1', ok: false, status: 'blocked', blockers: ['openrouter_model_missing'] };
  }
  const write = await writeOpenRouterManagedCatalog({ model, home, env });
  const bind = openRouterCatalogBindDecision(current, { home, env, configPath: input.configPath });
  if (!write.ok || !bind.bindable || bind.bound) {
    return {
      schema: 'sks.openrouter-model-catalog-repair.v1',
      ok: write.ok,
      status: write.ok ? (bind.bound ? 'current' : 'catalog_written_not_bound') : 'failed',
      model,
      catalog: write,
      bind,
      blockers: write.blockers,
      warnings: [
        ...write.warnings,
        ...(bind.bindable || bind.bound ? [] : ['openrouter_model_catalog_user_catalog_preserved'])
      ]
    };
  }
  const next = ensureTrailingNewline(upsertTopLevelTomlString(current, 'model_catalog_json', write.path));
  const safeWrite = await safeWriteCodexConfigToml(input.configPath, current, next, 'openrouter-model-catalog');
  return {
    schema: 'sks.openrouter-model-catalog-repair.v1',
    ok: safeWrite.ok,
    status: safeWrite.ok ? 'bound' : String(safeWrite.status || 'config_write_blocked'),
    model,
    catalog: write,
    bind,
    write: safeWrite,
    blockers: safeWrite.ok ? [] : [String(safeWrite.status || 'openrouter_model_catalog_bind_failed')],
    warnings: write.warnings
  };
}
