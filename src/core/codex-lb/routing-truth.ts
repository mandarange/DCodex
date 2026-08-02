import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../fsx.js';
import { codexLbBaseUrlSecurityBlocker, normalizeCodexLbBaseUrl } from './codex-lb-env.js';

export const CODEX_LB_ROUTING_TRUTH_SCHEMA = 'sks.codex-lb-routing-truth.v1' as const;
export const CODEX_LB_ROUTING_TRUTH_RECEIPT = 'sks-codex-lb-routing-truth.json' as const;
export const CODEX_LB_ROUTING_TRUTH_STAMP = CODEX_LB_ROUTING_TRUTH_RECEIPT;
export const CODEX_LB_ROUTING_TRUTH_STALE_AFTER_MS = 5 * 60 * 1_000;

export type CodexLbRoutingTruthStatus =
  | 'verified'
  | 'selected_unmeasured'
  | 'ready_unselected'
  | 'missing_base_url'
  | 'missing_api_key'
  | 'transport_blocked'
  | 'endpoint_unreachable'
  | 'auth_rejected'
  | 'http_error'
  | 'stale'
  | 'receipt_write_failed';

export type CodexLbRoutingTruthAuthTransport =
  | 'authorization-bearer'
  | 'x-codex-lb-api-key';

export type CodexLbRoutingTruthMode = 'bridge' | 'cli-provider';

export type CodexLbRoutingTruth = {
  schema: typeof CODEX_LB_ROUTING_TRUTH_SCHEMA;
  ok: boolean;
  status: CodexLbRoutingTruthStatus;
  observed_status?: Exclude<CodexLbRoutingTruthStatus, 'stale' | 'receipt_write_failed'>;
  mode: CodexLbRoutingTruthMode;
  selected: boolean;
  measured: boolean;
  fresh: boolean;
  stale_after_ms: number;
  age_ms: number | null;
  configured_base_url: string | null;
  configured_host: string | null;
  actual_url: string | null;
  actual_host: string | null;
  measurement_path: 'direct' | 'bridge-loopback';
  auth_transport: CodexLbRoutingTruthAuthTransport;
  auth_outcome: 'accepted' | 'rejected' | 'not_attempted' | 'indeterminate';
  http_status: number | null;
  measured_at: string;
  /** Compatibility alias for early v1 consumers. New consumers use measured_at. */
  checked_at: string;
  latency_ms: number | null;
  blockers: string[];
};

export type CodexLbRoutingTruthMeasureOptions = {
  mode?: CodexLbRoutingTruthMode;
  selected: boolean;
  baseUrl?: string | null;
  /**
   * Optional loopback bridge route used to prove the configured upstream.
   * This is accepted only for bridge mode and only for an HTTP loopback URL.
   */
  probeBaseUrl?: string | null;
  apiKey?: string | null;
  authTransport?: CodexLbRoutingTruthAuthTransport;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  measure?: boolean;
  now?: () => number;
  nowIso?: () => string;
};

export type CodexLbRoutingTruthStampOptions = {
  home?: string;
  receiptPath?: string;
  staleAfterMs?: number;
  now?: () => number;
  expectedMode?: CodexLbRoutingTruthMode;
  expectedSelected?: boolean;
  expectedConfiguredHost?: string | null;
  expectedAuthTransport?: CodexLbRoutingTruthAuthTransport;
};

export function codexLbRoutingTruthReceiptPath(home = process.env.HOME || os.homedir()): string {
  return path.join(home, '.codex', CODEX_LB_ROUTING_TRUTH_RECEIPT);
}

export const codexLbRoutingTruthStampPath = codexLbRoutingTruthReceiptPath;

/**
 * Produce the redacted route contract for config-only and measured state.
 * The only network path is an authenticated GET to the provider's own /models
 * endpoint, with redirects disabled so `actual_host` cannot silently differ.
 * Bridge activation may instead traverse the selected loopback bridge; in that
 * case the receipt records the loopback host and `measurement_path` explicitly.
 */
export async function measureCodexLbRoutingTruth(
  options: CodexLbRoutingTruthMeasureOptions
): Promise<CodexLbRoutingTruth> {
  const now = options.now || Date.now;
  const measuredAt = options.nowIso?.() || new Date(now()).toISOString();
  const baseUrl = normalizeCodexLbBaseUrl(options.baseUrl || '');
  const configured = safePublicUrl(baseUrl);
  const mode = options.mode || 'cli-provider';
  const probeBaseUrl = normalizeCodexLbBaseUrl(options.probeBaseUrl || '');
  const bridgeLoopbackProbe = Boolean(probeBaseUrl);
  const authTransport = options.authTransport || 'authorization-bearer';
  const base = {
    schema: CODEX_LB_ROUTING_TRUTH_SCHEMA,
    mode,
    selected: options.selected,
    fresh: false,
    stale_after_ms: CODEX_LB_ROUTING_TRUTH_STALE_AFTER_MS,
    age_ms: 0,
    configured_base_url: configured?.url || null,
    configured_host: configured?.host || null,
    actual_url: null,
    actual_host: null,
    measurement_path: bridgeLoopbackProbe ? 'bridge-loopback' as const : 'direct' as const,
    auth_transport: authTransport,
    http_status: null,
    measured_at: measuredAt,
    checked_at: measuredAt,
    latency_ms: null
  };
  if (!baseUrl) {
    return {
      ...base,
      ok: false,
      status: 'missing_base_url',
      measured: false,
      auth_outcome: 'not_attempted',
      blockers: ['codex_lb_missing:CODEX_LB_BASE_URL']
    };
  }
  const transportBlocker = codexLbBaseUrlSecurityBlocker(baseUrl);
  if (transportBlocker) {
    return {
      ...base,
      ok: false,
      status: 'transport_blocked',
      measured: false,
      auth_outcome: 'not_attempted',
      blockers: [transportBlocker]
    };
  }
  if (bridgeLoopbackProbe && (mode !== 'bridge' || !isHttpLoopbackUrl(probeBaseUrl))) {
    return {
      ...base,
      ok: false,
      status: 'transport_blocked',
      measured: false,
      auth_outcome: 'not_attempted',
      blockers: ['codex_lb_bridge_probe_target_not_loopback']
    };
  }
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) {
    return {
      ...base,
      ok: false,
      status: 'missing_api_key',
      measured: false,
      auth_outcome: 'not_attempted',
      blockers: ['codex_lb_missing:CODEX_LB_API_KEY']
    };
  }
  if (options.measure === false) {
    return {
      ...base,
      ok: !options.selected,
      status: options.selected ? 'selected_unmeasured' : 'ready_unselected',
      measured: false,
      auth_outcome: 'not_attempted',
      blockers: options.selected ? ['codex_lb_routing_truth_unmeasured'] : []
    };
  }
  if (!options.selected) {
    return {
      ...base,
      ok: true,
      status: 'ready_unselected',
      measured: false,
      auth_outcome: 'not_attempted',
      blockers: []
    };
  }

  const measurementBaseUrl = bridgeLoopbackProbe ? probeBaseUrl : baseUrl;
  const measurementTarget = safePublicUrl(measurementBaseUrl);
  const endpoint = `${measurementBaseUrl.replace(/\/+$/, '')}/models`;
  const startedAt = now();
  try {
    const headers = authTransport === 'x-codex-lb-api-key'
      ? { 'X-Codex-LB-API-Key': apiKey }
      : { Authorization: `Bearer ${apiKey}` };
    const response = await (options.fetchImpl || globalThis.fetch)(endpoint, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(250, Number(options.timeoutMs || 8_000)))
    });
    const finishedAt = now();
    const actual = safePublicUrl(response.url || endpoint);
    const authRejected = response.status === 401 || response.status === 403;
    const ok = response.ok && !authRejected && actual?.host === measurementTarget?.host;
    const status: CodexLbRoutingTruthStatus = authRejected
      ? 'auth_rejected'
      : response.ok && actual?.host !== measurementTarget?.host
        ? 'endpoint_unreachable'
        : response.ok
          ? 'verified'
          : 'http_error';
    return {
      ...base,
      ok,
      status,
      measured: true,
      fresh: true,
      actual_url: actual?.url || null,
      actual_host: actual?.host || null,
      auth_outcome: authRejected ? 'rejected' : response.ok ? 'accepted' : 'indeterminate',
      http_status: response.status,
      latency_ms: Math.max(0, finishedAt - startedAt),
      blockers: ok
        ? []
        : [authRejected
            ? 'codex_lb_auth_rejected'
            : response.ok
              ? 'codex_lb_actual_host_mismatch'
              : `codex_lb_models_http_${response.status}`]
    };
  } catch {
    const finishedAt = now();
    return {
      ...base,
      ok: false,
      status: 'endpoint_unreachable',
      measured: true,
      fresh: true,
      auth_outcome: 'indeterminate',
      latency_ms: Math.max(0, finishedAt - startedAt),
      blockers: ['codex_lb_endpoint_unreachable']
    };
  }
}

/** Persist only the canonical, secret-free receipt fields using the shared atomic writer. */
export async function writeCodexLbRoutingTruthReceipt(
  truth: CodexLbRoutingTruth,
  options: CodexLbRoutingTruthStampOptions = {}
): Promise<CodexLbRoutingTruth> {
  const receiptPath = options.receiptPath || codexLbRoutingTruthReceiptPath(options.home);
  const canonical = parseReceipt(truth);
  if (!canonical) throw new Error('codex_lb_routing_truth_invalid');
  await writeJsonAtomic(receiptPath, canonical, { mode: 0o600 });
  return canonical;
}

/**
 * Read and freshness-check the same receipt contract used by status/UI and Doctor.
 * A stale or context-mismatched receipt is never accepted as active routing proof.
 */
export async function readCodexLbRoutingTruthReceipt(
  options: CodexLbRoutingTruthStampOptions = {}
): Promise<CodexLbRoutingTruth | null> {
  const receiptPath = options.receiptPath || codexLbRoutingTruthReceiptPath(options.home);
  const parsed = parseReceipt(await readJson(receiptPath, null));
  if (!parsed) return null;
  if (options.expectedMode !== undefined && parsed.mode !== options.expectedMode) return null;
  if (options.expectedSelected !== undefined && parsed.selected !== options.expectedSelected) return null;
  if (options.expectedConfiguredHost !== undefined
    && parsed.configured_host !== options.expectedConfiguredHost) return null;
  if (options.expectedAuthTransport !== undefined
    && parsed.auth_transport !== options.expectedAuthTransport) return null;
  return withFreshness(parsed, options);
}

/** Return only a context-matched, fresh actual measurement from the shared stamp. */
export async function readFreshCodexLbRoutingTruthStamp(
  options: CodexLbRoutingTruthStampOptions = {}
): Promise<CodexLbRoutingTruth | null> {
  const truth = await readCodexLbRoutingTruthReceipt(options);
  return truth?.measured === true && truth.fresh === true ? truth : null;
}

export const writeCodexLbRoutingTruthStamp = writeCodexLbRoutingTruthReceipt;
export const readCodexLbRoutingTruthStamp = readCodexLbRoutingTruthReceipt;

/** Measure and durably publish one receipt. Selected routes fail closed if publishing fails. */
export async function measureAndWriteCodexLbRoutingTruth(
  measureOptions: CodexLbRoutingTruthMeasureOptions,
  receiptOptions: CodexLbRoutingTruthStampOptions = {}
): Promise<CodexLbRoutingTruth> {
  const truth = await measureCodexLbRoutingTruth(measureOptions);
  try {
    return await writeCodexLbRoutingTruthReceipt(truth, receiptOptions);
  } catch {
    if (!truth.selected) return truth;
    return {
      ...truth,
      ok: false,
      status: 'receipt_write_failed',
      observed_status: truth.status as Exclude<CodexLbRoutingTruthStatus, 'stale' | 'receipt_write_failed'>,
      blockers: uniqueStrings([...truth.blockers, 'codex_lb_routing_truth_receipt_write_failed'])
    };
  }
}

export function codexLbRoutingTruthIsActive(truth: CodexLbRoutingTruth | null | undefined): boolean {
  return truth?.selected === true
    && truth.measured === true
    && truth.fresh === true
    && truth.ok === true
    && truth.status === 'verified';
}

function withFreshness(
  truth: CodexLbRoutingTruth,
  options: CodexLbRoutingTruthStampOptions
): CodexLbRoutingTruth {
  const nowMs = (options.now || Date.now)();
  const measuredMs = Date.parse(truth.measured_at);
  const staleAfterMs = Math.max(1_000, Number(options.staleAfterMs || CODEX_LB_ROUTING_TRUTH_STALE_AFTER_MS));
  const ageMs = Number.isFinite(measuredMs) ? Math.max(0, nowMs - measuredMs) : Number.POSITIVE_INFINITY;
  const fresh = truth.measured && Number.isFinite(ageMs) && ageMs <= staleAfterMs;
  if (fresh || !truth.selected) {
    return { ...truth, fresh, stale_after_ms: staleAfterMs, age_ms: Number.isFinite(ageMs) ? ageMs : null };
  }
  return {
    ...truth,
    ok: false,
    status: 'stale',
    observed_status: truth.status as Exclude<CodexLbRoutingTruthStatus, 'stale' | 'receipt_write_failed'>,
    fresh: false,
    stale_after_ms: staleAfterMs,
    age_ms: Number.isFinite(ageMs) ? ageMs : null,
    blockers: uniqueStrings([...truth.blockers, 'codex_lb_routing_truth_stale'])
  };
}

function parseReceipt(value: unknown): CodexLbRoutingTruth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.schema !== CODEX_LB_ROUTING_TRUTH_SCHEMA) return null;
  const status = String(input.status || '') as CodexLbRoutingTruthStatus;
  const statuses: CodexLbRoutingTruthStatus[] = [
    'verified', 'selected_unmeasured', 'ready_unselected', 'missing_base_url', 'missing_api_key',
    'transport_blocked', 'endpoint_unreachable', 'auth_rejected', 'http_error', 'stale',
    'receipt_write_failed'
  ];
  const authTransport = String(input.auth_transport || '') as CodexLbRoutingTruthAuthTransport;
  const mode = String(input.mode || 'cli-provider') as CodexLbRoutingTruthMode;
  const authOutcome = String(input.auth_outcome || '') as CodexLbRoutingTruth['auth_outcome'];
  const measuredAt = stringOrNull(input.measured_at) || stringOrNull(input.checked_at);
  if (!statuses.includes(status)
    || !['bridge', 'cli-provider'].includes(mode)
    || !['authorization-bearer', 'x-codex-lb-api-key'].includes(authTransport)
    || !['accepted', 'rejected', 'not_attempted', 'indeterminate'].includes(authOutcome)
    || !measuredAt
    || !Array.isArray(input.blockers)) return null;
  return {
    schema: CODEX_LB_ROUTING_TRUTH_SCHEMA,
    ok: input.ok === true,
    status,
    ...(typeof input.observed_status === 'string'
      ? { observed_status: input.observed_status as Exclude<CodexLbRoutingTruthStatus, 'stale' | 'receipt_write_failed'> }
      : {}),
    mode,
    selected: input.selected === true,
    measured: input.measured === true,
    fresh: input.fresh === true,
    stale_after_ms: finiteNumberOrNull(input.stale_after_ms) || CODEX_LB_ROUTING_TRUTH_STALE_AFTER_MS,
    age_ms: finiteNumberOrNull(input.age_ms),
    configured_base_url: safeReceiptUrl(input.configured_base_url),
    configured_host: stringOrNull(input.configured_host),
    actual_url: safeReceiptUrl(input.actual_url),
    actual_host: stringOrNull(input.actual_host),
    measurement_path: input.measurement_path === 'bridge-loopback'
      ? 'bridge-loopback'
      : 'direct',
    auth_transport: authTransport,
    auth_outcome: authOutcome,
    http_status: finiteNumberOrNull(input.http_status),
    measured_at: measuredAt,
    checked_at: measuredAt,
    latency_ms: finiteNumberOrNull(input.latency_ms),
    blockers: uniqueStrings(input.blockers.map(String))
  };
}

function safeReceiptUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return safePublicUrl(input)?.url || null;
}

function stringOrNull(input: unknown): string | null {
  return typeof input === 'string' && input ? input : null;
}

function finiteNumberOrNull(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safePublicUrl(input: string): { url: string; host: string } | null {
  try {
    const parsed = new URL(input);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return {
      url: parsed.toString().replace(/\/$/, ''),
      host: parsed.host
    };
  } catch {
    return null;
  }
}

function isHttpLoopbackUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1');
  } catch {
    return false;
  }
}
