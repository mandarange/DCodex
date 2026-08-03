import { nowIso } from '../../fsx.js';
import { normalizeOpenRouterModelId } from '../../codex-app/openrouter-provider.js';
import { resolveOpenRouterApiKey } from './openrouter-secret-store.js';
import { invalidOpenRouterResponseIssue, normalizeOpenRouterError } from './openrouter-error.js';
import type { OpenRouterIssue } from './openrouter-types.js';
import { isRecord } from '../../json/records.js';

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key' as const;
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models' as const;
export const OPENROUTER_MODEL_ROW_LIMIT = 1_000 as const;
export const OPENROUTER_MODEL_IDS_MAX_OUTPUT_BYTES = 48 * 1024;

export interface OpenRouterNormalizedModel {
  readonly id: string;
  readonly name: string;
  readonly context_length: number | null;
  readonly pricing: Readonly<Record<string, string>>;
  readonly supported_parameters: readonly string[];
  readonly features: {
    readonly tools: boolean;
    readonly reasoning: boolean;
    readonly structured_outputs: boolean;
    readonly vision: boolean;
    readonly audio: boolean;
    readonly input_modalities: readonly string[];
    readonly output_modalities: readonly string[];
  };
}

export interface OpenRouterModelsResult {
  readonly schema: 'sks.openrouter-models.v1';
  readonly generated_at: string;
  readonly ok: boolean;
  readonly authenticated: boolean;
  readonly models: readonly OpenRouterNormalizedModel[];
  readonly model_count: number;
  readonly source_model_count: number;
  readonly truncated: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly error?: OpenRouterIssue;
  readonly authentication_error?: OpenRouterIssue;
}

export interface OpenRouterModelIdsResult {
  readonly schema: 'sks.openrouter-model-ids.v1';
  readonly generated_at: string;
  readonly ok: boolean;
  readonly authenticated: boolean;
  readonly models: readonly string[];
  readonly model_count: number;
  readonly catalog_model_count: number;
  readonly source_model_count: number;
  readonly truncated: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly error?: OpenRouterIssue;
  readonly authentication_error?: OpenRouterIssue;
}

export function compactOpenRouterModelsResult(
  result: OpenRouterModelsResult,
  maxOutputBytes = OPENROUTER_MODEL_IDS_MAX_OUTPUT_BYTES
): OpenRouterModelIdsResult {
  const byteLimit = Math.max(1_024, Math.floor(Number(maxOutputBytes) || OPENROUTER_MODEL_IDS_MAX_OUTPUT_BYTES));
  const base = {
    schema: 'sks.openrouter-model-ids.v1' as const,
    generated_at: result.generated_at,
    ok: result.ok,
    authenticated: result.authenticated,
    catalog_model_count: result.model_count,
    source_model_count: result.source_model_count,
    blockers: result.blockers,
    warnings: result.warnings,
    ...(result.error ? { error: result.error } : {}),
    ...(result.authentication_error ? { authentication_error: result.authentication_error } : {})
  };
  const models: string[] = [];
  for (const row of result.models) {
    const candidate = [...models, row.id];
    const payload = {
      ...base,
      models: candidate,
      model_count: candidate.length,
      truncated: result.truncated || candidate.length < result.models.length
    };
    if (Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8') > byteLimit) break;
    models.push(row.id);
  }
  let truncated = result.truncated || models.length < result.models.length;
  let compact: OpenRouterModelIdsResult = {
    ...base,
    models,
    model_count: models.length,
    truncated,
    warnings: truncated
      ? [...new Set([...result.warnings, 'openrouter_model_ids_truncated_for_client'])]
      : result.warnings
  };
  while (models.length > 0 && Buffer.byteLength(JSON.stringify(compact, null, 2), 'utf8') > byteLimit) {
    models.pop();
    truncated = true;
    compact = {
      ...compact,
      models,
      model_count: models.length,
      truncated,
      warnings: [...new Set([...result.warnings, 'openrouter_model_ids_truncated_for_client'])]
    };
  }
  return compact;
}

export async function listOpenRouterModels(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly limit?: number;
} = {}): Promise<OpenRouterModelsResult> {
  const resolved = await resolveOpenRouterApiKey({ env: input.env || process.env });
  if (!resolved.key) return emptyModelsResult('openrouter_key_missing', resolved.warnings);
  const keyProbe = await fetchOpenRouterJson(OPENROUTER_KEY_URL, resolved.key, input);
  const authenticationError = keyProbe.ok
    ? (isRecord(keyProbe.value)
        ? null
        : invalidOpenRouterResponseIssue('OpenRouter key validation response was not an object.'))
    : keyProbe.error;
  const models = await listOpenRouterModelsWithKey(resolved.key, input, authenticationError === null);
  if (!authenticationError) return models;
  return {
    ...emptyModelsResult(`openrouter_authentication_failed:${authenticationError.code}`, models.warnings),
    generated_at: models.generated_at,
    authenticated: false,
    warnings: [...models.warnings],
    authentication_error: authenticationError
  };
}

export async function testOpenRouterConnection(input: {
  readonly model?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
} = {}) {
  const generatedAt = nowIso();
  const requestedModel = input.model === undefined || input.model === null || String(input.model).trim() === ''
    ? null
    : normalizeOpenRouterModelId(input.model);
  if (input.model && !requestedModel) {
    return {
      schema: 'sks.openrouter-test.v1',
      generated_at: generatedAt,
      ok: false,
      authenticated: false,
      key_accepted: false,
      requested_model: null,
      model_exists: false,
      blockers: ['openrouter_model_invalid'],
      warnings: []
    };
  }
  const resolved = await resolveOpenRouterApiKey({ env: input.env || process.env });
  if (!resolved.key) {
    return {
      schema: 'sks.openrouter-test.v1',
      generated_at: generatedAt,
      ok: false,
      authenticated: false,
      key_accepted: false,
      requested_model: requestedModel,
      model_exists: requestedModel ? false : null,
      blockers: ['openrouter_key_missing'],
      warnings: resolved.warnings
    };
  }

  const keyProbe = await fetchOpenRouterJson(OPENROUTER_KEY_URL, resolved.key, input);
  if (!keyProbe.ok) {
    return {
      schema: 'sks.openrouter-test.v1',
      generated_at: generatedAt,
      ok: false,
      authenticated: false,
      key_accepted: false,
      requested_model: requestedModel,
      model_exists: requestedModel ? false : null,
      blockers: [keyProbe.error.code],
      warnings: resolved.warnings,
      error: keyProbe.error
    };
  }
  if (!isRecord(keyProbe.value)) {
    const error = invalidOpenRouterResponseIssue('OpenRouter key validation response was not an object.');
    return {
      schema: 'sks.openrouter-test.v1',
      generated_at: generatedAt,
      ok: false,
      authenticated: true,
      key_accepted: true,
      requested_model: requestedModel,
      model_exists: requestedModel ? false : null,
      blockers: [error.code],
      warnings: resolved.warnings,
      error
    };
  }

  if (!requestedModel) {
    return {
      schema: 'sks.openrouter-test.v1',
      generated_at: generatedAt,
      ok: true,
      authenticated: true,
      key_accepted: true,
      requested_model: null,
      model_exists: null,
      blockers: [],
      warnings: resolved.warnings
    };
  }

  const models = await listOpenRouterModelsWithKey(resolved.key, input, true);
  const modelExists = models.ok && models.models.some((row) => row.id === requestedModel);
  return {
    schema: 'sks.openrouter-test.v1',
    generated_at: generatedAt,
    ok: models.ok && modelExists,
    authenticated: true,
    key_accepted: true,
    requested_model: requestedModel,
    model_exists: modelExists,
    model_count: models.model_count,
    blockers: [
      ...models.blockers,
      ...(models.ok && !modelExists ? ['openrouter_model_not_found'] : [])
    ],
    warnings: [...resolved.warnings, ...models.warnings],
    ...(models.error ? { error: models.error } : {})
  };
}

async function listOpenRouterModelsWithKey(
  key: string,
  input: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number; readonly limit?: number },
  authenticated: boolean
): Promise<OpenRouterModelsResult> {
  const response = await fetchOpenRouterJson(OPENROUTER_MODELS_URL, key, input);
  if (!response.ok) {
    return {
      ...emptyModelsResult(response.error.code, []),
      error: response.error
    };
  }
  const rows = isRecord(response.value) && Array.isArray(response.value.data) ? response.value.data : null;
  if (!rows) {
    const error = invalidOpenRouterResponseIssue('OpenRouter models response did not contain a data array.');
    return { ...emptyModelsResult(error.code, []), error };
  }
  const limit = Math.max(1, Math.min(OPENROUTER_MODEL_ROW_LIMIT, Math.floor(Number(input.limit) || OPENROUTER_MODEL_ROW_LIMIT)));
  const models = rows.slice(0, limit).map(normalizeOpenRouterModel).filter((row): row is OpenRouterNormalizedModel => row !== null);
  return {
    schema: 'sks.openrouter-models.v1',
    generated_at: nowIso(),
    ok: true,
    authenticated,
    models,
    model_count: models.length,
    source_model_count: rows.length,
    truncated: rows.length > limit,
    blockers: [],
    warnings: []
  };
}

async function fetchOpenRouterJson(
  url: string,
  apiKey: string,
  input: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number }
): Promise<{ ok: true; value: unknown } | { ok: false; error: OpenRouterIssue }> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(input.timeoutMs || 10_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (input.fetchImpl || fetch)(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    });
    const body = await response.text();
    const redactionEnv = { OPENROUTER_API_KEY: apiKey } as NodeJS.ProcessEnv;
    if (!response.ok) return { ok: false, error: normalizeOpenRouterError(response.status, body, redactionEnv) };
    try {
      return { ok: true, value: JSON.parse(body) as unknown };
    } catch {
      return { ok: false, error: invalidOpenRouterResponseIssue('OpenRouter response was not valid JSON.', body, redactionEnv) };
    }
  } catch (err: unknown) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      error: {
        code: timedOut ? 'glm_request_timeout' : 'glm_openrouter_request_failed',
        message: timedOut ? `OpenRouter request timed out after ${timeoutMs}ms.` : 'OpenRouter request failed.',
        severity: 'failed'
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOpenRouterModel(value: unknown): OpenRouterNormalizedModel | null {
  if (!isRecord(value)) return null;
  const id = normalizeOpenRouterModelId(value.id);
  if (!id) return null;
  const supportedParameters = stringArray(value.supported_parameters, 64);
  const architecture = isRecord(value.architecture) ? value.architecture : {};
  const inputModalities = stringArray(architecture.input_modalities, 16);
  const outputModalities = stringArray(architecture.output_modalities, 16);
  const modality = String(architecture.modality || '').toLowerCase();
  return {
    id,
    name: boundedString(value.name, 240) || id,
    context_length: finiteInteger(value.context_length),
    pricing: pricingStrings(value.pricing),
    supported_parameters: supportedParameters,
    features: {
      tools: supportedParameters.includes('tools') || supportedParameters.includes('tool_choice'),
      reasoning: supportedParameters.includes('reasoning') || supportedParameters.includes('include_reasoning'),
      structured_outputs: supportedParameters.includes('response_format') || supportedParameters.includes('structured_outputs'),
      vision: inputModalities.includes('image') || modality.includes('image'),
      audio: inputModalities.includes('audio') || outputModalities.includes('audio') || modality.includes('audio'),
      input_modalities: inputModalities,
      output_modalities: outputModalities
    }
  };
}

function pricingStrings(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  const rows = Object.entries(value)
    .filter(([key, entry]) => /^[a-z0-9_]{1,64}$/i.test(key) && (typeof entry === 'string' || typeof entry === 'number'))
    .slice(0, 32)
    .map(([key, entry]) => [key, boundedString(entry, 80)] as const)
    .filter(([, entry]) => Boolean(entry));
  return Object.fromEntries(rows);
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => boundedString(entry, 80)).filter(Boolean))].slice(0, limit);
}

function boundedString(value: unknown, limit: number): string {
  return String(value ?? '').trim().slice(0, limit);
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function emptyModelsResult(blocker: string, warnings: readonly string[]): OpenRouterModelsResult {
  return {
    schema: 'sks.openrouter-models.v1',
    generated_at: nowIso(),
    ok: false,
    authenticated: false,
    models: [],
    model_count: 0,
    source_model_count: 0,
    truncated: false,
    blockers: [blocker],
    warnings
  };
}
