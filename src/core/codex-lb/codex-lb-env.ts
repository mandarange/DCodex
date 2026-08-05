import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { exists, readJson, readText } from '../fsx.js';
import { escapeRegExp } from '../text/regex.js';
import {
  PrivateCredentialFileError,
  readPrivateCredentialFile
} from '../security/private-credential-file.js';

const CODEX_LB_CREDENTIAL_AUTH_TRANSPORTS = [
  'x-codex-lb-api-key',
  'authorization-bearer-compat'
] as const;
type CodexLbCredentialAuthTransport = (typeof CODEX_LB_CREDENTIAL_AUTH_TRANSPORTS)[number];
const DEFAULT_CODEX_LB_CREDENTIAL_AUTH_TRANSPORT: CodexLbCredentialAuthTransport = 'authorization-bearer-compat';

export const CODEX_LB_SECURE_KEYCHAIN_SERVICE = 'com.sneakoscope.codex-lb.api-key.v2' as const;
export const CODEX_LB_LEGACY_KEYCHAIN_SERVICE = 'sks-codex-lb' as const;

export type CodexLbEnvSource = 'process.env' | 'keychain' | 'env-file' | 'project-local' | 'missing';

export type CodexLbEnvLoadResult = {
  schema: 'sks.codex-lb-env.v1';
  configured: boolean;
  missing: string[];
  source: CodexLbEnvSource;
  source_priority: CodexLbEnvSource[];
  base_url: string | null;
  gateway_auth_transport?: CodexLbCredentialAuthTransport | null;
  api_key: {
    present: boolean;
    usable: boolean;
    source: CodexLbEnvSource | null;
    redacted: true;
    fingerprint: string | null;
  };
  secret_api_key: string | null;
  blockers?: string[];
  guidance?: string[];
  credential_binding: {
    checked: boolean;
    present: boolean;
    valid: boolean;
    status: 'matched' | 'missing' | 'invalid_metadata' | 'key_missing' | 'api_key_mismatch' | 'base_url_mismatch';
    metadata_path: string;
    api_key_matches: boolean | null;
    base_url_matches: boolean | null;
    blockers: string[];
  };
  env_paths: string[];
  keychain: {
    checked: boolean;
    available: boolean;
    status: string;
  };
};

export type CodexLbModelCatalogResult = {
  schema: 'sks.codex-lb-model-catalog.v1';
  ok: boolean;
  status: 'ready' | 'blocked';
  models: string[];
  model_efforts: Record<string, string[]>;
  http_status: number | null;
  blockers: string[];
};

export function codexLbEnvPath(home: unknown = process.env.HOME || os.homedir()): string {
  return path.join(String(home || os.homedir()), '.codex', 'sks-codex-lb.env');
}

export function codexLbMetadataPath(home: unknown = process.env.HOME || os.homedir()): string {
  return path.join(String(home || os.homedir()), '.codex', 'sks-codex-lb.json');
}

export function codexLbHealthPath(home: unknown = process.env.HOME || os.homedir()): string {
  return path.join(String(home || os.homedir()), '.codex', 'sks-codex-lb-health.json');
}

export async function removeStoredCodexLbCredential(input: {
  home?: string;
  envPath?: string;
  metadataPath?: string;
  confirmed: boolean;
}): Promise<{
  schema: 'sks.codex-lb-credential-removal.v1';
  removed: boolean;
  removed_paths: string[];
  blockers: string[];
}> {
  if (input.confirmed !== true) {
    return {
      schema: 'sks.codex-lb-credential-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: ['codex_lb_credential_removal_confirmation_required']
    };
  }
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  const codexHome = path.join(home, '.codex');
  const files = [
    path.resolve(input.envPath || codexLbEnvPath(home)),
    path.resolve(input.metadataPath || codexLbMetadataPath(home))
  ];
  if (files.some((file) => file !== codexHome && !file.startsWith(`${codexHome}${path.sep}`))) {
    return {
      schema: 'sks.codex-lb-credential-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: ['codex_lb_credential_path_outside_codex_home']
    };
  }
  const existing: string[] = [];
  for (const file of files) {
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        schema: 'sks.codex-lb-credential-removal.v1',
        removed: false,
        removed_paths: [],
        blockers: ['codex_lb_credential_path_not_regular_file']
      };
    }
    existing.push(file);
  }
  const removed: string[] = [];
  for (const file of existing) {
    await fsp.unlink(file);
    removed.push(file);
  }
  return {
    schema: 'sks.codex-lb-credential-removal.v1',
    removed: removed.length > 0,
    removed_paths: removed,
    blockers: []
  };
}

export async function readLbHealth(home: unknown = process.env.HOME || os.homedir()) {
  const file = codexLbHealthPath(home);
  const raw = await readJson<any>(file, null);
  if (!raw || typeof raw !== 'object') return null;
  const degraded = Array.isArray(raw.degraded_models)
    ? raw.degraded_models.map((model: unknown) => String(model)).filter(Boolean)
    : [];
  return {
    ok: raw.ok !== false,
    degraded_models: degraded,
    quota_low: raw.quota_low === true,
    source: file,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null
  };
}

export async function readCodexLbModelCatalog(opts: {
  loadedEnv?: CodexLbEnvLoadResult;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  gatewayAuthTransport?: 'x-codex-lb-api-key' | 'authorization-bearer-compat' | 'authorization-bearer';
} = {}): Promise<CodexLbModelCatalogResult> {
  const loaded = opts.loadedEnv || await loadCodexLbEnv();
  if (!loaded.configured || !loaded.base_url || !loaded.secret_api_key) {
    return {
      schema: 'sks.codex-lb-model-catalog.v1',
      ok: false,
      status: 'blocked',
      models: [],
      model_efforts: {},
      http_status: null,
      blockers: loaded.missing.length ? loaded.missing.map((item) => `codex_lb_missing:${item}`) : ['codex_lb_not_configured']
    };
  }
  const transportBlocker = codexLbBaseUrlSecurityBlocker(loaded.base_url);
  if (transportBlocker) {
    return {
      schema: 'sks.codex-lb-model-catalog.v1',
      ok: false,
      status: 'blocked',
      models: [],
      model_efforts: {},
      http_status: null,
      blockers: [transportBlocker]
    };
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const gatewayAuthTransport = opts.gatewayAuthTransport || DEFAULT_CODEX_LB_CREDENTIAL_AUTH_TRANSPORT;
  const gatewayHeaders = gatewayAuthTransport === 'x-codex-lb-api-key'
    ? { 'X-Codex-LB-API-Key': loaded.secret_api_key }
    : { Authorization: `Bearer ${loaded.secret_api_key}` };
  try {
    const response = await fetchImpl(`${loaded.base_url}/models`, {
      headers: gatewayHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(250, Number(opts.timeoutMs || 5000)))
    });
    const payload = await response.json().catch(() => null);
    const models = normalizeCodexLbModelCatalogPayload(payload);
    const apiEfforts = normalizeCodexModelEffortCatalogPayload(payload);
    const cachePath = path.join(String(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), 'models_cache.json');
    const cachePayload = await readJson<any>(cachePath, null).catch(() => null);
    const cachedEfforts = normalizeCodexModelEffortCatalogPayload(cachePayload);
    const modelEfforts = Object.fromEntries(models.map((model) => [model, apiEfforts[model] || cachedEfforts[model] || []]));
    const ok = response.ok && models.length > 0;
    return {
      schema: 'sks.codex-lb-model-catalog.v1',
      ok,
      status: ok ? 'ready' : 'blocked',
      models,
      model_efforts: modelEfforts,
      http_status: response.status,
      blockers: [
        ...(response.ok ? [] : [`codex_lb_models_http_${response.status}`]),
        ...(models.length ? [] : ['codex_lb_model_catalog_empty'])
      ]
    };
  } catch {
    return {
      schema: 'sks.codex-lb-model-catalog.v1',
      ok: false,
      status: 'blocked',
      models: [],
      model_efforts: {},
      http_status: null,
      blockers: ['codex_lb_model_catalog_unavailable']
    };
  }
}

export function normalizeCodexModelEffortCatalogPayload(payload: any): Record<string, string[]> {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    const model = String(row?.id || row?.model || row?.slug || row?.name || '').trim();
    if (!model) continue;
    const effortRows = row?.supportedReasoningEfforts
      || row?.supported_reasoning_levels
      || row?.supported_reasoning_efforts
      || row?.reasoning_efforts
      || [];
    const efforts = (Array.isArray(effortRows) ? effortRows : [])
      .map((entry: any) => String(entry?.reasoningEffort || entry?.effort || entry || '').trim().toLowerCase())
      .filter(Boolean);
    result[model] = [...new Set<string>(efforts)];
  }
  return result;
}

export function normalizeCodexLbModelCatalogPayload(payload: any): string[] {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models: string[] = rows
    .map((row: any) => String(row?.id || row?.model || row?.slug || row?.name || '').trim())
    .filter(Boolean);
  return [...new Set<string>(models)];
}

export function normalizeCodexLbBaseUrl(input: unknown = ''): string {
  let host = String(input || '').trim();
  if (!host) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');
  return /\/backend-api\/codex$/i.test(host) ? host : `${host}/backend-api/codex`;
}

export function codexLbBaseUrlSecurityBlocker(input: unknown): string | null {
  try {
    const url = new URL(String(input || ''));
    if (url.username || url.password) return 'codex_lb_base_url_userinfo_forbidden';
    if (url.protocol === 'https:') return null;
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (url.protocol === 'http:' && loopback) return null;
    return 'codex_lb_insecure_base_url';
  } catch {
    return 'codex_lb_invalid_base_url';
  }
}

export async function loadCodexLbEnv(opts: any = {}): Promise<CodexLbEnvLoadResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const metadataPath = opts.metadataPath || codexLbMetadataPath(home);
  const envPaths = [opts.envPath || codexLbEnvPath(home)];
  // Center / official store first. Ambient process.env is last-resort only so a
  // stale shell export cannot override SKS Center credentials.
  const sourcePriority: CodexLbEnvSource[] = ['env-file', 'process.env'];
  if (opts.allowProjectSecrets) sourcePriority.push('project-local');

  const processEnv = pickEnv(opts.processEnv || process.env);
  const envFile = await readEnvFile(envPaths[0], { privateFile: true });
  const projectLocal: { apiKey?: string; baseUrl?: string } = opts.allowProjectSecrets
    ? await readEnvFile(path.join(opts.root || process.cwd(), '.env'))
    : {};
  const metadata = await readCodexLbCredentialMetadata(metadataPath);

  const apiKeyCandidates = [
    { source: 'env-file' as const, apiKey: envFile.apiKey },
    { source: 'process.env' as const, apiKey: processEnv.apiKey },
    ...(opts.allowProjectSecrets ? [{ source: 'project-local' as const, apiKey: String(projectLocal.apiKey || '') }] : [])
  ].filter((candidate) => Boolean(candidate.apiKey));
  const candidateFingerprints = await Promise.all(apiKeyCandidates.map(async (candidate) => ({
    ...candidate,
    sha256: await sha256Full(candidate.apiKey)
  })));
  const selectedApiKey = candidateFingerprints[0];
  const keySource = selectedApiKey?.source || 'missing';
  const apiKey = selectedApiKey?.apiKey || '';
  const configuredBaseUrl = normalizeCodexLbBaseUrl(envFile.baseUrl || processEnv.baseUrl || projectLocal.baseUrl || '');
  const apiKeySha256 = selectedApiKey?.sha256 || '';
  const binding = evaluateCodexLbCredentialBinding({
    metadata,
    metadataPath,
    apiKeySha256,
    configuredBaseUrl
  });
  const resolutionBlockers = [
    ...envFile.blockers,
    ...(apiKey ? [] : ['codex_lb_api_key_missing'])
  ];
  const baseUrl = binding.present && metadata.baseUrl ? metadata.baseUrl : configuredBaseUrl;
  const apiKeyUsable = Boolean(apiKey) && binding.blockers.length === 0 && resolutionBlockers.length === 0;
  const missing = [
    ...(apiKey ? [] : ['CODEX_LB_API_KEY']),
    ...(baseUrl ? [] : ['CODEX_LB_BASE_URL']),
    ...(binding.blockers.length ? ['CODEX_LB_CREDENTIAL_BINDING'] : []),
    ...(envFile.blockers.length ? ['CODEX_LB_CREDENTIAL_FILE'] : [])
  ];
  const guidance = [
    ...envFile.guidance,
    ...(!apiKey
      ? [`Configure CODEX_LB_API_KEY with \`sks bridge provider configure codex-lb --host <host> --api-key-stdin --json\`, put it in ${envPaths[0]} (mode 0600), or export CODEX_LB_API_KEY.`]
      : [])
  ];
  return {
    schema: 'sks.codex-lb-env.v1',
    configured: missing.length === 0 && apiKeyUsable,
    missing,
    source: apiKey ? keySource : 'missing',
    source_priority: sourcePriority,
    base_url: baseUrl || null,
    gateway_auth_transport: metadata.gatewayAuthTransport,
    api_key: {
      present: Boolean(apiKey),
      usable: apiKeyUsable,
      source: apiKey ? keySource : null,
      redacted: true,
      fingerprint: apiKeySha256 ? apiKeySha256.slice(0, 16) : null
    },
    secret_api_key: apiKeyUsable ? apiKey : null,
    blockers: [...new Set([...binding.blockers, ...resolutionBlockers])],
    guidance: [...new Set(guidance)],
    credential_binding: {
      ...binding,
      blockers: [...new Set([...binding.blockers, ...resolutionBlockers])]
    },
    env_paths: envPaths,
    keychain: {
      checked: false,
      available: false,
      status: 'not_used'
    }
  };
}

async function readCodexLbCredentialMetadata(file: string): Promise<{
  present: boolean;
  valid: boolean;
  baseUrl: string;
  apiKeySha256: string;
  gatewayAuthTransport: CodexLbCredentialAuthTransport | null;
}> {
  if (!(await exists(file))) {
    return {
      present: false,
      valid: false,
      baseUrl: '',
      apiKeySha256: '',
      gatewayAuthTransport: DEFAULT_CODEX_LB_CREDENTIAL_AUTH_TRANSPORT
    };
  }
  const value = await readJson<any>(file, null).catch(() => null);
  const baseUrl = normalizeCodexLbBaseUrl(value?.base_url || '');
  const apiKeySha256 = String(value?.api_key?.sha256 || '').trim().toLowerCase();
  let gatewayAuthTransport: CodexLbCredentialAuthTransport | null = null;
  try {
    gatewayAuthTransport = parseCodexLbCredentialAuthTransport(
      value?.gateway_auth_transport || DEFAULT_CODEX_LB_CREDENTIAL_AUTH_TRANSPORT
    );
  } catch {
    gatewayAuthTransport = null;
  }
  const valid = value?.schema === 'sks.codex-lb-metadata.v1'
    && Boolean(baseUrl)
    && codexLbBaseUrlSecurityBlocker(baseUrl) === null
    && /^[a-f0-9]{64}$/.test(apiKeySha256)
    && gatewayAuthTransport !== null;
  return { present: true, valid, baseUrl, apiKeySha256, gatewayAuthTransport };
}

function parseCodexLbCredentialAuthTransport(value: unknown): CodexLbCredentialAuthTransport {
  const normalized = String(value || '').trim();
  if ((CODEX_LB_CREDENTIAL_AUTH_TRANSPORTS as readonly string[]).includes(normalized)) {
    return normalized as CodexLbCredentialAuthTransport;
  }
  throw new Error('codex_lb_credential_auth_transport_invalid');
}

function evaluateCodexLbCredentialBinding(input: {
  metadata: {
    present: boolean;
    valid: boolean;
    baseUrl: string;
    apiKeySha256: string;
    gatewayAuthTransport: CodexLbCredentialAuthTransport | null;
  };
  metadataPath: string;
  apiKeySha256: string;
  configuredBaseUrl: string;
}): CodexLbEnvLoadResult['credential_binding'] {
  const base = {
    checked: input.metadata.present,
    present: input.metadata.present,
    metadata_path: input.metadataPath
  };
  if (!input.metadata.present) {
    return {
      ...base,
      valid: false,
      status: 'missing',
      api_key_matches: null,
      base_url_matches: null,
      blockers: []
    };
  }
  if (!input.metadata.valid) {
    return {
      ...base,
      valid: false,
      status: 'invalid_metadata',
      api_key_matches: null,
      base_url_matches: null,
      blockers: ['codex_lb_credential_metadata_invalid']
    };
  }
  if (!input.apiKeySha256) {
    return {
      ...base,
      valid: false,
      status: 'key_missing',
      api_key_matches: false,
      base_url_matches: input.configuredBaseUrl ? input.configuredBaseUrl === input.metadata.baseUrl : true,
      blockers: []
    };
  }
  const apiKeyMatches = input.apiKeySha256 === input.metadata.apiKeySha256;
  const baseUrlMatches = input.configuredBaseUrl ? input.configuredBaseUrl === input.metadata.baseUrl : true;
  if (!apiKeyMatches) {
    return {
      ...base,
      valid: false,
      status: 'api_key_mismatch',
      api_key_matches: false,
      base_url_matches: baseUrlMatches,
      blockers: ['codex_lb_credential_key_fingerprint_mismatch']
    };
  }
  if (!baseUrlMatches) {
    return {
      ...base,
      valid: false,
      status: 'base_url_mismatch',
      api_key_matches: true,
      base_url_matches: false,
      blockers: ['codex_lb_credential_base_url_mismatch']
    };
  }
  return {
    ...base,
    valid: true,
    status: 'matched',
    api_key_matches: true,
    base_url_matches: true,
    blockers: []
  };
}

async function readEnvFile(file: string, opts: { privateFile?: boolean } = {}) {
  let text = '';
  const blockers: string[] = [];
  const guidance: string[] = [];
  if (opts.privateFile) {
    let pathExists = false;
    try {
      await fsp.lstat(file);
      pathExists = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        blockers.push('codex_lb_env_file_read_failed');
        guidance.push(`Replace the unreadable credential file at ${file} with \`sks bridge provider configure codex-lb --host <host> --api-key-stdin --json\`.`);
      }
    }
    if (!pathExists) {
      return { apiKey: '', baseUrl: '', blockers, guidance };
    }
    try {
      text = (await readPrivateCredentialFile(path.dirname(file), file, 'codex_lb_env_file')).bytes.toString('utf8');
    } catch (error: unknown) {
      if (!(error instanceof PrivateCredentialFileError) || error.code !== 'missing') {
        const code = error instanceof PrivateCredentialFileError ? error.code : 'read_failed';
        blockers.push(`codex_lb_env_file_${code}`);
        guidance.push(code === 'mode_not_0600'
          ? `Run \`chmod 600 ${file}\` or \`sks doctor --fix\`, then retry.`
          : `Replace the unsafe credential file at ${file} with \`sks bridge provider configure codex-lb --host <host> --api-key-stdin --json\`.`);
      }
    }
  } else {
    text = await readText(file, '');
  }
  return {
    apiKey: parseShellEnvValue(text, 'CODEX_LB_API_KEY'),
    baseUrl: parseShellEnvValue(text, 'CODEX_LB_BASE_URL'),
    blockers,
    guidance
  };
}

function pickEnv(env: NodeJS.ProcessEnv) {
  const apiKey = String(env.CODEX_LB_API_KEY || '').trim();
  let baseUrl = String(env.CODEX_LB_BASE_URL || '').trim();
  // Fixture hosts like *.example.test are often left in developer/agent shells.
  // Prefer durable env-file / metadata URLs unless the operator explicitly allows them.
  if (baseUrl && isReservedCodexLbTestHost(baseUrl) && env.SKS_ALLOW_CODEX_LB_TEST_HOST !== '1') {
    baseUrl = '';
  }
  return { apiKey, baseUrl };
}

function isReservedCodexLbTestHost(baseUrl: string): boolean {
  try {
    const hostname = new URL(normalizeCodexLbBaseUrl(baseUrl) || baseUrl).hostname.toLowerCase();
    return hostname === 'example.test' || hostname.endsWith('.example.test');
  } catch {
    return false;
  }
}

export function parseShellEnvValue(text: unknown = '', key: unknown = ''): string {
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, 'm');
  const envMatch = String(text || '').match(re);
  const raw = envMatch?.[1]?.trim() || '';
  if (!raw) return '';
  if (raw.startsWith("'")) return raw.endsWith("'") && raw.length > 1 ? raw.slice(1, -1).replace(/'\\''/g, "'") : '';
  if (raw.startsWith('"')) return raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1).replace(/\\"/g, '"') : '';
  if (raw.includes("'") || raw.includes('"') || /\s/.test(raw)) return '';
  return raw;
}

async function sha256Full(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}
