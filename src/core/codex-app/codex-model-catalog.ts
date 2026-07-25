import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { escapeRegExp } from '../text/regex.js';
import { isRecord } from '../json/records.js';
import { uniqueStrings } from '../text/strings.js';

export const CODEX_MODEL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const CODEX_MODEL_CATALOG_MAX_MODELS = 512;

export interface CodexCatalogModel {
  readonly model: string;
  readonly provider: string;
  readonly display_name: string;
  readonly reasoning_efforts: readonly string[];
  readonly default_reasoning_effort: string | null;
  readonly supported_in_api: boolean;
  readonly multi_agent_version: 'v1' | 'v2' | 'disabled' | null;
}

export interface CodexModelCatalogReadResult {
  readonly schema: 'sks.codex-model-catalog-read.v1';
  readonly ok: boolean;
  readonly configured: boolean;
  readonly path: string | null;
  readonly model_count: number;
  readonly total_model_count: number;
  readonly truncated: boolean;
  readonly models: readonly CodexCatalogModel[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface CodexModelRoutingContext {
  readonly schema: 'sks.codex-model-routing-context.v1';
  readonly config_path: string;
  readonly selected_provider: string | null;
  readonly selected_model: string | null;
  readonly catalog: CodexModelCatalogReadResult;
}

export function codexHomePath(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  return path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
}

export function codexUserConfigPath(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): string {
  return path.join(codexHomePath(input), 'config.toml');
}

export function defaultOpenCodexCatalogPath(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): string {
  return path.join(codexHomePath(input), 'opencodex-catalog.json');
}

/** SKS-managed ModelInfo catalog for OpenRouter Desktop activation. */
export function sksOpenRouterCatalogPath(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): string {
  return path.join(codexHomePath(input), 'sks-openrouter-catalog.json');
}

export async function readConfiguredCodexModelCatalog(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
} = {}): Promise<CodexModelCatalogReadResult> {
  return (await readConfiguredCodexModelRoutingContext(input)).catalog;
}

export async function readConfiguredCodexModelRoutingContext(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
} = {}): Promise<CodexModelRoutingContext> {
  const configPath = input.configPath || codexUserConfigPath(input);
  let config = '';
  try {
    config = await fs.readFile(configPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        schema: 'sks.codex-model-routing-context.v1',
        config_path: configPath,
        selected_provider: null,
        selected_model: null,
        catalog: emptyCatalogResult(null, false, ['codex_model_catalog_config_unreadable'])
      };
    }
  }
  const configuredPath = readTopLevelTomlString(config, 'model_catalog_json');
  const catalog = configuredPath
    ? await readCodexModelCatalogFile({
        filePath: expandCatalogPath(configuredPath, { ...input, configPath }),
        configured: true
      })
    : emptyCatalogResult(null, false, []);
  return {
    schema: 'sks.codex-model-routing-context.v1',
    config_path: configPath,
    selected_provider: readTopLevelTomlString(config, 'model_provider'),
    selected_model: readTopLevelTomlString(config, 'model'),
    catalog
  };
}

export async function readCodexModelCatalogFile(input: {
  readonly filePath: string;
  readonly configured?: boolean;
}): Promise<CodexModelCatalogReadResult> {
  const filePath = path.resolve(String(input.filePath || ''));
  if (!String(input.filePath || '').trim()) {
    return emptyCatalogResult(null, Boolean(input.configured), ['codex_model_catalog_path_missing']);
  }
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return emptyCatalogResult(filePath, Boolean(input.configured), [
      code === 'ENOENT' ? 'codex_model_catalog_missing' : 'codex_model_catalog_unreadable'
    ]);
  }
  const fileBlockers = secureCatalogFileBlockers(stat);
  if (fileBlockers.length) return emptyCatalogResult(filePath, Boolean(input.configured), fileBlockers);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return emptyCatalogResult(filePath, Boolean(input.configured), ['codex_model_catalog_invalid_json']);
  }
  const rawRows = catalogRows(parsed);
  if (!rawRows) {
    return emptyCatalogResult(filePath, Boolean(input.configured), ['codex_model_catalog_shape_invalid']);
  }
  const totalModelCount = rawRows.length;
  const normalized = rawRows
    .slice(0, CODEX_MODEL_CATALOG_MAX_MODELS)
    .map((row, index) => normalizeCatalogModel(row, index));
  const models = normalized
    .map((row) => row.model)
    .filter((row): row is CodexCatalogModel => row !== null);
  const duplicateModels = duplicateModelIds(models);
  const blockers = uniqueStrings([
    ...(totalModelCount > CODEX_MODEL_CATALOG_MAX_MODELS
      ? [`codex_model_catalog_model_limit_exceeded:${totalModelCount}:${CODEX_MODEL_CATALOG_MAX_MODELS}`]
      : []),
    ...normalized.flatMap((row) => row.blockers),
    ...duplicateModels.map((model) => `codex_model_catalog_duplicate_model:${model}`),
    ...(models.length ? [] : ['codex_model_catalog_empty'])
  ]);
  return {
    schema: 'sks.codex-model-catalog-read.v1',
    ok: blockers.length === 0,
    configured: Boolean(input.configured),
    path: filePath,
    model_count: models.length,
    total_model_count: totalModelCount,
    truncated: totalModelCount > CODEX_MODEL_CATALOG_MAX_MODELS,
    models,
    blockers,
    warnings: []
  };
}

export function normalizeCodexModelId(value: unknown): string | null {
  const model = String(value || '').trim();
  if (!model || model.length > 240) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/.test(model) ? model : null;
}

export function normalizeCodexReasoningEffort(value: unknown): string | null {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort || effort.length > 32) return null;
  return /^[a-z0-9][a-z0-9_-]*$/.test(effort) ? effort : null;
}

export function inferProviderFromModel(model: unknown): string {
  const normalized = normalizeCodexModelId(model) || '';
  const slash = normalized.indexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : 'openai';
}

export function readTopLevelTomlString(text: string, key: string): string | null {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*(?:#.*)?$`);
  for (let index = 0; index < rootEnd; index += 1) {
    const match = lines[index]?.match(pattern);
    if (!match) continue;
    return decodeTomlBasicString(match[1] || '');
  }
  return null;
}

function expandCatalogPath(value: string, input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
}): string {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const trimmed = String(value || '').trim();
  if (trimmed === '~') return path.resolve(home);
  if (trimmed.startsWith('~/')) return path.resolve(home, trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.resolve(
    input.configPath ? path.dirname(input.configPath) : codexHomePath({ home, env }),
    trimmed
  );
}

function catalogRows(value: unknown): unknown[] | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  return value.models;
}

function normalizeCatalogModel(value: unknown, index: number): {
  readonly model: CodexCatalogModel | null;
  readonly blockers: string[];
} {
  if (!isRecord(value)) {
    return { model: null, blockers: [`codex_model_catalog_row_invalid:${index}:object`] };
  }
  const blockers = validateCatalogModelInfo(value, index);
  const visibility = String(value.visibility || '').trim().toLowerCase();
  const model = normalizeCodexModelId(value.slug);
  const efforts = normalizeReasoningEfforts(value.supported_reasoning_levels);
  const defaultReasoning = value.default_reasoning_level === undefined || value.default_reasoning_level === null
    ? null
    : normalizeCodexReasoningEffort(value.default_reasoning_level);
  const provider = normalizeProvider(value.provider) || inferProviderFromModel(model);
  const multiAgentVersion = normalizeMultiAgentVersion(value.multi_agent_version);
  if (blockers.length || !model || !provider || visibility === 'hide' || value.supported_in_api !== true) {
    return { model: null, blockers };
  }
  return {
    model: {
      model,
      provider,
      display_name: String(value.display_name).trim(),
      reasoning_efforts: efforts,
      default_reasoning_effort: defaultReasoning && efforts.includes(defaultReasoning) ? defaultReasoning : null,
      supported_in_api: true,
      multi_agent_version: multiAgentVersion
    },
    blockers
  };
}

/** Row-level ModelInfo validation blockers; empty means the row is acceptable. */
export function catalogModelRowBlockers(value: unknown, index = 0): string[] {
  if (!isRecord(value)) return [`codex_model_catalog_row_invalid:${index}:object`];
  return validateCatalogModelInfo(value, index);
}

function validateCatalogModelInfo(value: Record<string, any>, index: number): string[] {
  const blockers: string[] = [];
  const required: ReadonlyArray<readonly [string, 'string' | 'number' | 'boolean' | 'array' | 'object']> = [
    ['slug', 'string'],
    ['display_name', 'string'],
    ['supported_reasoning_levels', 'array'],
    ['shell_type', 'string'],
    ['visibility', 'string'],
    ['supported_in_api', 'boolean'],
    ['priority', 'number'],
    ['base_instructions', 'string'],
    ['support_verbosity', 'boolean'],
    ['truncation_policy', 'object'],
    ['supports_parallel_tool_calls', 'boolean'],
    ['experimental_supported_tools', 'array']
  ];
  for (const [field, expected] of required) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      blockers.push(`codex_model_catalog_required_field_missing:${index}:${field}`);
    } else if (valueType(value[field]) !== expected) {
      blockers.push(`codex_model_catalog_field_type_invalid:${index}:${field}`);
    }
  }
  // Codex CLI 0.145 renamed supports_reasoning_summaries to
  // supports_reasoning_summary_parameter (serde default true). Accept either
  // spelling so newer provider/router catalogs are not rejected.
  const reasoningSummaryFields = ['supports_reasoning_summaries', 'supports_reasoning_summary_parameter']
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field));
  if (!reasoningSummaryFields.length) {
    blockers.push(`codex_model_catalog_required_field_missing:${index}:supports_reasoning_summaries`);
  } else {
    for (const field of reasoningSummaryFields) {
      if (valueType(value[field]) !== 'boolean') {
        blockers.push(`codex_model_catalog_field_type_invalid:${index}:${field}`);
      }
    }
  }

  if (!normalizeCodexModelId(value.slug)) blockers.push(`codex_model_catalog_field_invalid:${index}:slug`);
  if (typeof value.display_name === 'string' && !value.display_name.trim()) {
    blockers.push(`codex_model_catalog_field_empty:${index}:display_name`);
  }
  if (typeof value.shell_type === 'string'
    && !['default', 'local', 'unified_exec', 'disabled', 'shell_command'].includes(value.shell_type)) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:shell_type`);
  }
  if (typeof value.visibility === 'string' && !['list', 'hide', 'none'].includes(value.visibility)) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:visibility`);
  }
  if (typeof value.priority === 'number' && !Number.isFinite(value.priority)) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:priority`);
  }
  if (Array.isArray(value.supported_reasoning_levels)) {
    for (const entry of value.supported_reasoning_levels) {
      if (!isRecord(entry) || !normalizeCodexReasoningEffort(entry.effort)) {
        blockers.push(`codex_model_catalog_reasoning_level_invalid:${index}`);
        break;
      }
    }
  }
  const defaultReasoning = value.default_reasoning_level === undefined || value.default_reasoning_level === null
    ? null
    : normalizeCodexReasoningEffort(value.default_reasoning_level);
  const efforts = normalizeReasoningEfforts(value.supported_reasoning_levels);
  if (value.default_reasoning_level !== undefined
    && value.default_reasoning_level !== null
    && !defaultReasoning) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:default_reasoning_level`);
  } else if (defaultReasoning && !efforts.includes(defaultReasoning)) {
    blockers.push(`codex_model_catalog_default_reasoning_not_supported:${index}`);
  }
  if (isRecord(value.truncation_policy)) {
    if (!['bytes', 'tokens'].includes(String(value.truncation_policy.mode || ''))) {
      blockers.push(`codex_model_catalog_truncation_policy_invalid:${index}:mode`);
    }
    if (typeof value.truncation_policy.limit !== 'number'
      || !Number.isFinite(value.truncation_policy.limit)
      || value.truncation_policy.limit <= 0) {
      blockers.push(`codex_model_catalog_truncation_policy_invalid:${index}:limit`);
    }
  }
  if (Array.isArray(value.experimental_supported_tools)
    && value.experimental_supported_tools.some((entry: unknown) => typeof entry !== 'string')) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:experimental_supported_tools`);
  }
  if (value.provider !== undefined && !normalizeProvider(value.provider)) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:provider`);
  }
  if (value.multi_agent_version !== undefined
    && value.multi_agent_version !== null
    && !normalizeMultiAgentVersion(value.multi_agent_version)) {
    blockers.push(`codex_model_catalog_field_invalid:${index}:multi_agent_version`);
  }
  return uniqueStrings(blockers);
}

function normalizeReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const entry of value) {
    const raw = isRecord(entry)
      ? entry.effort || entry.reasoning_effort || entry.reasoningEffort || entry.id
      : entry;
    const effort = normalizeCodexReasoningEffort(raw);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts;
}

function normalizeProvider(value: unknown): string | null {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider || provider.length > 80) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(provider) ? provider : null;
}

function normalizeMultiAgentVersion(value: unknown): 'v1' | 'v2' | 'disabled' | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'v1' || normalized === 'v2' || normalized === 'disabled'
    ? normalized
    : null;
}

function secureCatalogFileBlockers(stat: Awaited<ReturnType<typeof fs.lstat>>): string[] {
  const blockers: string[] = [];
  if (!stat.isFile() || stat.isSymbolicLink()) blockers.push('codex_model_catalog_not_regular_file');
  if (stat.size > CODEX_MODEL_CATALOG_MAX_BYTES) blockers.push('codex_model_catalog_too_large');
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) blockers.push('codex_model_catalog_owner_mismatch');
  if (process.platform !== 'win32') {
    const mode = Number(stat.mode) & 0o777;
    if ((mode & 0o077) !== 0 || (mode & 0o400) === 0 || (mode & 0o100) !== 0) {
      blockers.push(`codex_model_catalog_mode_insecure:${mode.toString(8).padStart(3, '0')}`);
    }
  }
  return blockers;
}

function duplicateModelIds(models: readonly CodexCatalogModel[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const model of models) {
    if (seen.has(model.model)) duplicates.add(model.model);
    seen.add(model.model);
  }
  return [...duplicates].sort();
}

function valueType(value: unknown): 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'undefined' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'undefined';
}

function emptyCatalogResult(
  filePath: string | null,
  configured: boolean,
  blockers: string[]
): CodexModelCatalogReadResult {
  return {
    schema: 'sks.codex-model-catalog-read.v1',
    ok: blockers.length === 0,
    configured,
    path: filePath,
    model_count: 0,
    total_model_count: 0,
    truncated: false,
    models: [],
    blockers,
    warnings: []
  };
}

function decodeTomlBasicString(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}
