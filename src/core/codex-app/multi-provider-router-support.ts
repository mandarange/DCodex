import os from 'node:os';
import path from 'node:path';
import { nowIso } from '../fsx.js';
import {
  codexHomePath,
  defaultOpenCodexCatalogPath,
  normalizeCodexModelId,
  sksOpenRouterCatalogPath
} from './codex-model-catalog.js';
import { escapeRegExp } from '../text/regex.js';
import { isRecord } from '../json/records.js';
import { uniqueStrings } from '../text/strings.js';

export { uniqueStrings };

const MULTI_PROVIDER_ROUTER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function probeRouterModels(input: {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}): Promise<{
  readonly ok: boolean;
  readonly status: number | null;
  readonly url: string;
  readonly models: string[];
  readonly blockers: string[];
}> {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await input.fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MULTI_PROVIDER_ROUTER_MAX_RESPONSE_BYTES) {
      return oversizedModelsResponse(response.status, url);
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url,
        models: [],
        blockers: [`multi_provider_router_models_http_${response.status}`]
      };
    }
    const body = await readResponseTextBounded(response, MULTI_PROVIDER_ROUTER_MAX_RESPONSE_BYTES);
    const models = liveModelIds(JSON.parse(body));
    return {
      ok: models.length > 0,
      status: response.status,
      url,
      models,
      blockers: models.length ? [] : ['multi_provider_router_live_models_empty']
    };
  } catch (err: unknown) {
    const name = String((err as Error)?.name || '');
    const message = String((err as Error)?.message || '');
    return {
      ok: false,
      status: null,
      url,
      models: [],
      blockers: [
        name === 'TimeoutError'
          ? 'multi_provider_router_probe_timeout'
          : message === 'multi_provider_router_models_response_too_large'
            ? message
            : err instanceof SyntaxError
              ? 'multi_provider_router_models_json_invalid'
              : 'multi_provider_router_probe_failed'
      ]
    };
  }
}

export function resolveCatalogPath(value: string, input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
}): string {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const trimmed = String(value || '').trim();
  if (trimmed === '~') return path.resolve(home);
  if (trimmed.startsWith('~/')) return path.resolve(home, trimmed.slice(2));
  if (!path.isAbsolute(trimmed)) {
    return path.resolve(
      input.configPath ? path.dirname(input.configPath) : codexHomePath({ home, env }),
      trimmed
    );
  }
  return path.resolve(trimmed);
}

export function isSksManagedCatalogPath(filePath: string | null, input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  if (!filePath) return false;
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const codexHome = codexHomePath({ home, env });
  return [
    defaultOpenCodexCatalogPath({ home, env }),
    sksOpenRouterCatalogPath({ home, env }),
    path.join(codexHome, 'sks-codex-lb-tool-catalog.json')
  ].some((candidate) => path.resolve(candidate) === path.resolve(filePath));
}

export function isLoopbackHostname(value: string): boolean {
  const hostname = String(value || '').trim().toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

export function tomlTableBody(text: string, table: string): string {
  const header = `[${table}]`;
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return '';
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line || '')) break;
    body.push(line || '');
  }
  return body.join('\n');
}

export function tomlString(text: string, key: string): string | null {
  const match = String(text || '').match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*(?:#.*)?$`, 'm'));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1] || ''}"`);
  } catch {
    return match[1] || '';
  }
}

export function tomlBoolean(text: string, key: string): boolean | null {
  const match = String(text || '').match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, 'mi'));
  if (!match) return null;
  return match[1]?.toLowerCase() === 'true';
}

export function hasTomlKey(text: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'm').test(text);
}

export function hasUnexpectedTomlKeys(text: string, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return String(text || '').split('\n').some((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    return Boolean(match?.[1] && !allowed.has(match[1]));
  });
}

export function hasTomlTablePrefix(text: string, prefix: string): boolean {
  return String(text || '').split('\n').some((line) => {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    return Boolean(match?.[1]?.startsWith(prefix));
  });
}

export function routerBlocked(schema: string, ...blockers: Array<string | null | undefined>) {
  return {
    schema,
    generated_at: nowIso(),
    ok: false,
    status: 'blocked',
    blockers: uniqueStrings(blockers),
    warnings: []
  };
}

function liveModelIds(value: unknown): string[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : isRecord(value) && Array.isArray(value.models)
        ? value.models
        : [];
  return uniqueStrings(rows.map((entry) => {
    if (typeof entry === 'string') return normalizeCodexModelId(entry);
    if (!isRecord(entry)) return null;
    return normalizeCodexModelId(entry.id || entry.model || entry.slug || entry.name);
  }).filter((entry): entry is string => Boolean(entry)));
}

function oversizedModelsResponse(status: number, url: string) {
  return {
    ok: false,
    status,
    url,
    models: [],
    blockers: ['multi_provider_router_models_response_too_large']
  };
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('multi_provider_router_models_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}
