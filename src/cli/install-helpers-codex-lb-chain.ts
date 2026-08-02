import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { ensureDir, packageRoot, readText, writeTextAtomic } from '../core/fsx.js';
import { recordCodexLbHealthEvent } from '../core/codex-lb-circuit.js';
import { codexLbBaseUrlSecurityBlocker } from '../core/codex-lb/codex-lb-env.js';
import type { CapabilityEvidence } from '../core/codex-lb/capability-types.js';
import { probeEvidence } from '../core/codex-lb/probes/probe-evidence.js';
import {
  CODEX_LB_CANONICAL_FAST_SERVICE_TIER,
  codexLbEnvPath,
  parseCodexLbEnvKey,
  redactSecretText
} from './install-helpers-codex-lb-shared.js';

function codexLbResponsesEndpoint(baseUrl: any = '') {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/responses$/i.test(base) ? base : `${base}/responses`;
}

function codexLbChainCheckEnabled(env: any = process.env) {
  return env.SKS_CODEX_LB_CHAIN_CHECK !== '0' && env.SKS_SKIP_CODEX_LB_CHAIN_CHECK !== '1';
}

function codexLbChainCachePath(home: any = process.env.HOME || os.homedir()) {
  return path.join(home, '.codex', 'sks-codex-lb-chain-health.json');
}

function codexLbChainCacheTtlMs(status: any = '', env: any = process.env) {
  const hardFailure = Boolean(status && !['chain_ok', 'previous_response_not_found'].includes(status));
  const key = hardFailure ? 'SKS_CODEX_LB_CHAIN_CHECK_FAILURE_CACHE_TTL_MS' : 'SKS_CODEX_LB_CHAIN_CHECK_CACHE_TTL_MS';
  const fallback = hardFailure ? 30 * 1000 : 5 * 60 * 1000;
  const raw = env[key] ?? env.SKS_CODEX_LB_CHAIN_CHECK_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function codexLbChainCacheEnabled(opts: any = {}, env: any = process.env) {
  if (opts.force || opts.cache === false) return false;
  if (opts.fetch) return false;
  if (env.SKS_CODEX_LB_CHAIN_CHECK_CACHE === '0') return false;
  return true;
}

async function readCodexLbChainCache({ endpoint, home, opts = {}, env = process.env }: any = {}) {
  if (!endpoint || !codexLbChainCacheEnabled(opts, env)) return null;
  const cachePath = opts.cachePath || codexLbChainCachePath(home || env.HOME || os.homedir());
  const text = await readText(cachePath, '');
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.schema !== 'sks.codex-lb-chain-health.v1' || parsed.endpoint !== endpoint || !parsed.result?.status) return null;
    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    const checkedAt = Number(parsed.checked_at_ms || 0);
    const ttlMs = codexLbChainCacheTtlMs(parsed.result.status, env);
    if (!checkedAt || ttlMs <= 0 || now - checkedAt > ttlMs) return null;
    return {
      ...parsed.result,
      endpoint,
      cached: true,
      cache_path: cachePath,
      cache_age_ms: Math.max(0, now - checkedAt)
    };
  } catch {
    return null;
  }
}

async function writeCodexLbChainCache(result: any = {}, { endpoint, home, opts = {}, env = process.env }: any = {}) {
  if (!endpoint || !result.status || !codexLbChainCacheEnabled(opts, env)) return result;
  const cachePath = opts.cachePath || codexLbChainCachePath(home || env.HOME || os.homedir());
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const cacheResult = {
    ok: Boolean(result.ok),
    status: result.status,
    chain_unhealthy: result.chain_unhealthy === true,
    http_status: result.http_status || null,
    error: result.error || null
  };
  try {
    await ensureDir(path.dirname(cachePath));
    await writeTextAtomic(cachePath, `${JSON.stringify({
      schema: 'sks.codex-lb-chain-health.v1',
      endpoint,
      checked_at_ms: now,
      result: cacheResult
    }, null, 2)}\n`);
    await fsp.chmod(cachePath, 0o600).catch(() => {});
  } catch {
    // Cache writes are a launch optimization only; never block codex-lb startup.
  }
  return result;
}

function isPreviousResponseNotFound(payload: any = {}) {
  const error = payload?.error || payload?.response?.error || payload;
  const text = typeof error === 'string'
    ? error
    : [error?.type, error?.code, error?.message, error?.param, JSON.stringify(error || {})].filter(Boolean).join(' ');
  return /previous_response_not_found|previous_response_id.*not found|previous_response_id/i.test(text);
}

function parseCodexLbSseEvents(text: any = '') {
  const events: any[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events;
}

function codexLbResponseId(payload: any = {}) {
  if (typeof payload?.id === 'string' && payload.id) return payload.id;
  if (typeof payload?.response?.id === 'string' && payload.response.id) return payload.response.id;
  if (typeof payload?.data?.id === 'string' && payload.data.id) return payload.data.id;
  if (typeof payload?.data?.response?.id === 'string' && payload.data.response.id) return payload.data.response.id;
  return null;
}

function codexLbResponseError(json: any, events: any = []) {
  if (json?.error) return json;
  for (const event of events) {
    if (event?.error || event?.response?.error || event?.type === 'response.failed' || event?.type === 'error') return event;
  }
  return null;
}

function codexLbServiceTierEvidence(...responses: any[]) {
  const values: any[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    values.push(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const response of responses) {
    visit(response?.json);
    visit(response?.events);
  }
  const firstString = (...keys: string[]) => {
    for (const row of values) {
      for (const key of keys) {
        const value = row?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
      }
    }
    return null;
  };
  const requested = firstString('requestedServiceTier', 'requested_service_tier', 'requested_serviceTier');
  const actual = firstString('actualServiceTier', 'actual_service_tier', 'actual_serviceTier');
  const effective = firstString('serviceTier', 'service_tier');
  return {
    requested_service_tier: requested,
    actual_service_tier: actual,
    effective_service_tier: effective,
    fast_requested: requested === CODEX_LB_CANONICAL_FAST_SERVICE_TIER || effective === CODEX_LB_CANONICAL_FAST_SERVICE_TIER,
    fast_actual: actual === CODEX_LB_CANONICAL_FAST_SERVICE_TIER || effective === CODEX_LB_CANONICAL_FAST_SERVICE_TIER
  };
}

async function fetchCodexLbResponse(fetchImpl: any, endpoint: any, apiKey: any, body: any, timeoutMs: any) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs).unref?.();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const events = json ? [] : parseCodexLbSseEvents(text);
    const responseId = codexLbResponseId(json) || events.map((event: any) => codexLbResponseId(event)).find(Boolean) || null;
    const errorPayload = codexLbResponseError(json, events);
    return { ok: response.ok && !errorPayload, status: response.status, json, text, events, response_id: responseId, error_payload: errorPayload };
  } catch (err: any) {
    return { ok: false, status: 0, json: null, text: err.name === 'AbortError' ? 'request timed out' : err.message, events: [], response_id: null, error_payload: null };
  } finally {
    clearTimeout(timer);
  }
}

const CODEX_LB_CONNECT_TEST_MAX_OUTPUT_TOKENS = 32;
const CODEX_LB_CONNECT_TEST_MAX_RESULT_CHARS = 256;
const CODEX_LB_CONNECT_TEST_MAX_ERROR_CHARS = 512;
const CODEX_LB_CONNECT_TEST_TIMEOUT_MS = 15_000;

function boundedText(value: any, maxChars: number) {
  const text = String(value || '').trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function codexLbCompletedResponse(json: any, events: any[] = []) {
  if (json?.response && typeof json.response === 'object') return json.response;
  if (json?.data?.response && typeof json.data.response === 'object') return json.data.response;
  if (json?.data && typeof json.data === 'object') return json.data;
  if (json && typeof json === 'object') return json;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'response.completed' && event?.response && typeof event.response === 'object') {
      return event.response;
    }
  }
  return null;
}

function codexLbOutputText(response: any, events: any[] = []) {
  const parts: string[] = [];
  for (const output of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }
  if (parts.length === 0) {
    for (const event of events) {
      if (event?.type === 'response.output_text.done' && typeof event.text === 'string' && event.text.trim()) {
        parts.push(event.text.trim());
      }
    }
  }
  return parts.join('\n').trim();
}

function boundedCodexLbUsage(usage: any) {
  const tokenCount = (value: any) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    input_tokens: tokenCount(usage?.input_tokens),
    output_tokens: tokenCount(usage?.output_tokens),
    total_tokens: tokenCount(usage?.total_tokens),
    reasoning_tokens: tokenCount(usage?.output_tokens_details?.reasoning_tokens)
  };
}

function codexLbConnectTestFailure(status: string, extra: any = {}) {
  return {
    schema: 'sks.codex-lb-connect-test.v1',
    ok: false,
    status,
    response_id: null,
    model: extra.model || null,
    latency_ms: extra.latency_ms ?? null,
    usage: extra.usage || null,
    result: null,
    result_truncated: false,
    http_status: extra.http_status ?? null,
    blockers: Array.isArray(extra.blockers) ? extra.blockers : [status],
    ...(extra.error ? { error: extra.error } : {})
  };
}

export async function testCodexLbConnection(status: any = {}, opts: any = {}) {
  const providerSelected = status?.selected === true || status?.provider?.selected === true;
  if (opts.requireSelected === true && !providerSelected) {
    return codexLbConnectTestFailure('provider_unselected', {
      blockers: ['codex_lb_provider_not_selected']
    });
  }
  const credentialBindingBlockers = Array.isArray(opts.credentialBindingBlockers)
    ? opts.credentialBindingBlockers.map((value: any) => boundedText(value, 128)).filter(Boolean)
    : [];
  if (credentialBindingBlockers.length > 0) {
    return codexLbConnectTestFailure('credential_binding_drift', { blockers: credentialBindingBlockers });
  }
  if (status.provider_base_url_matches_credential !== true) {
    return codexLbConnectTestFailure('provider_base_url_mismatch', {
      blockers: ['codex_lb_provider_base_url_mismatch']
    });
  }
  if (status.provider_contract_ok !== true) {
    return codexLbConnectTestFailure('provider_contract_drift', {
      blockers: ['codex_lb_provider_contract_drift']
    });
  }

  const baseUrl = opts.baseUrl || status.base_url;
  const endpoint = codexLbResponsesEndpoint(baseUrl);
  if (!endpoint) return codexLbConnectTestFailure('missing_base_url');
  const transportBlocker = codexLbBaseUrlSecurityBlocker(baseUrl);
  if (transportBlocker) return codexLbConnectTestFailure('transport_blocked', { blockers: [transportBlocker] });

  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const apiKey = opts.apiKey || parseCodexLbEnvKey(await readText(opts.envPath || status.env_path || codexLbEnvPath(home), ''));
  if (!apiKey) return codexLbConnectTestFailure('missing_env_key');
  const model = String(opts.model || env.SKS_CODEX_MODEL || env.CODEX_MODEL || '').trim();
  if (!model) return codexLbConnectTestFailure('model_unselected');
  if (model.length > 128) return codexLbConnectTestFailure('model_invalid');
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return codexLbConnectTestFailure('fetch_unavailable', { model });

  const timeoutMs = Number(opts.timeoutMs || env.SKS_CODEX_LB_CONNECT_TEST_TIMEOUT_MS || CODEX_LB_CONNECT_TEST_TIMEOUT_MS);
  const body = {
    model,
    input: 'Reply OK.',
    store: false,
    reasoning: { effort: 'low' },
    max_output_tokens: CODEX_LB_CONNECT_TEST_MAX_OUTPUT_TOKENS
  };
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now;
  const startedAt = nowMs();
  const fetched = await fetchCodexLbResponse(fetchImpl, endpoint, apiKey, body, timeoutMs);
  const latencyMs = Math.max(0, Math.round(nowMs() - startedAt));
  if (!fetched.ok) {
    const error = redactSecretText(
      fetched.error_payload?.error?.message
        || fetched.error_payload?.response?.error?.message
        || fetched.text
        || 'codex-lb Responses request failed',
      [apiKey]
    );
    return codexLbConnectTestFailure('request_failed', {
      model,
      latency_ms: latencyMs,
      http_status: fetched.status,
      error: boundedText(error, CODEX_LB_CONNECT_TEST_MAX_ERROR_CHARS)
    });
  }

  const response = codexLbCompletedResponse(fetched.json, fetched.events);
  const responseId = boundedText(codexLbResponseId(response), 128);
  const responseModel = boundedText(response?.model || model, 128);
  const usage = boundedCodexLbUsage(response?.usage);
  if (!responseId) {
    return codexLbConnectTestFailure('missing_response_id', {
      model: responseModel,
      latency_ms: latencyMs,
      http_status: fetched.status,
      usage
    });
  }
  if (response?.error) {
    return codexLbConnectTestFailure('response_error', {
      model: responseModel,
      latency_ms: latencyMs,
      http_status: fetched.status,
      usage,
      error: boundedText(redactSecretText(response.error?.message || response.error, [apiKey]), CODEX_LB_CONNECT_TEST_MAX_ERROR_CHARS)
    });
  }
  if (response?.status !== 'completed') {
    return codexLbConnectTestFailure('response_not_completed', {
      model: responseModel,
      latency_ms: latencyMs,
      http_status: fetched.status,
      usage
    });
  }
  const outputText = codexLbOutputText(response, fetched.events);
  if (!outputText) {
    return codexLbConnectTestFailure('empty_result', {
      model: responseModel,
      latency_ms: latencyMs,
      http_status: fetched.status,
      usage
    });
  }
  return {
    schema: 'sks.codex-lb-connect-test.v1',
    ok: true,
    status: 'connected',
    response_id: responseId,
    model: responseModel,
    latency_ms: latencyMs,
    usage,
    result: boundedText(outputText, CODEX_LB_CONNECT_TEST_MAX_RESULT_CHARS),
    result_truncated: outputText.length > CODEX_LB_CONNECT_TEST_MAX_RESULT_CHARS,
    http_status: fetched.status,
    blockers: []
  };
}

export async function checkCodexLbResponseChain(status: any = {}, opts: any = {}) {
  const env = opts.env || process.env;
  if (!codexLbChainCheckEnabled(env) && !opts.force) return { ok: true, status: 'skipped', skipped: true, reason: 'SKS_CODEX_LB_CHAIN_CHECK=0' };
  if (status.provider_base_url_matches_credential === false) {
    return recordCodexLbChainHealth({
      ok: false,
      status: 'provider_base_url_mismatch',
      chain_unhealthy: true,
      blockers: ['codex_lb_provider_base_url_mismatch'],
      error: 'codex_lb_provider_base_url_mismatch'
    }, opts);
  }
  const baseUrl = opts.baseUrl || status.base_url;
  const endpoint = codexLbResponsesEndpoint(baseUrl);
  if (!endpoint) return recordCodexLbChainHealth({ ok: false, status: 'missing_base_url', chain_unhealthy: true }, opts);
  const transportBlocker = codexLbBaseUrlSecurityBlocker(baseUrl);
  if (transportBlocker) {
    return recordCodexLbChainHealth({
      ok: false,
      status: 'transport_blocked',
      chain_unhealthy: true,
      endpoint,
      blockers: [transportBlocker],
      error: transportBlocker
    }, opts);
  }
  const home = opts.home || env.HOME || os.homedir();
  const apiKey = opts.apiKey || parseCodexLbEnvKey(await readText(opts.envPath || status.env_path || codexLbEnvPath(home), ''));
  if (!apiKey) return recordCodexLbChainHealth({ ok: false, status: 'missing_env_key', chain_unhealthy: true }, opts);
  const cached = await readCodexLbChainCache({ endpoint, home, opts, env });
  if (cached) return cached;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: true, status: 'skipped', skipped: true, reason: 'fetch unavailable' };
  const model = String(opts.model || env.SKS_CODEX_MODEL || env.CODEX_MODEL || '').trim();
  if (!model) return { ok: true, status: 'skipped', skipped: true, reason: 'model_unselected_use_explicit_model_or_codex_catalog' };
  const timeoutMs = Number(opts.timeoutMs || env.SKS_CODEX_LB_CHAIN_CHECK_TIMEOUT_MS || 8000);
  const serviceTier = opts.fastMode === true || opts.serviceTier === 'fast' || opts.serviceTier === CODEX_LB_CANONICAL_FAST_SERVICE_TIER
    ? CODEX_LB_CANONICAL_FAST_SERVICE_TIER
    : null;
  const baseBody = {
    model,
    instructions: 'You are running a short SKS codex-lb response-chain health check.',
    input: 'SKS codex-lb response-chain health check. Reply with OK.',
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    stream: true,
    store: true,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    reasoning: { effort: 'low' }
  };
  const first = await fetchCodexLbResponse(fetchImpl, endpoint, apiKey, baseBody, timeoutMs);
  if (!first.ok || !first.response_id) {
    return recordCodexLbChainHealth(await writeCodexLbChainCache({
      ok: false,
      status: first.ok ? 'missing_response_id' : 'first_request_failed',
      chain_unhealthy: true,
      endpoint,
      http_status: first.status,
      requested_service_tier: serviceTier,
      service_tier_evidence: codexLbServiceTierEvidence(first),
      error: redactSecretText(first.error_payload?.error?.message || first.error_payload?.response?.error?.message || first.text || 'codex-lb first Responses request failed', [apiKey])
    }, { endpoint, home, opts, env }), opts);
  }
  const second = await fetchCodexLbResponse(fetchImpl, endpoint, apiKey, { ...baseBody, previous_response_id: first.response_id }, timeoutMs);
  if (second.ok) return recordCodexLbChainHealth(await writeCodexLbChainCache({ ok: true, status: 'chain_ok', endpoint, response_id: first.response_id, chained_response_id: second.response_id || null, http_status: second.status, requested_service_tier: serviceTier, service_tier_evidence: codexLbServiceTierEvidence(first, second) }, { endpoint, home, opts, env }), opts);
  const previousMissing = isPreviousResponseNotFound(second.error_payload || second.json || second.text);
  return recordCodexLbChainHealth(await writeCodexLbChainCache({
    ok: false,
    status: previousMissing ? 'previous_response_not_found' : 'second_request_failed',
    chain_unhealthy: true,
    endpoint,
    response_id: first.response_id,
    http_status: second.status,
    requested_service_tier: serviceTier,
    service_tier_evidence: codexLbServiceTierEvidence(first, second),
    error: redactSecretText(second.error_payload?.error?.message || second.error_payload?.response?.error?.message || second.text || 'codex-lb chained Responses request failed', [apiKey])
  }, { endpoint, home, opts, env }), opts);
}

export async function runCodexLbTextResponsesProbe(
  status: any = {},
  opts: any = {}
): Promise<CapabilityEvidence> {
  const result = await checkCodexLbResponseChain(status, opts);
  return codexLbResponseChainCapabilityEvidence(result, {
    checkedAt: typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString()
  });
}

export function codexLbResponseChainCapabilityEvidence(
  result: any = {},
  opts: { checkedAt?: string } = {}
): CapabilityEvidence {
  const checkedAt = opts.checkedAt || new Date().toISOString();
  if (result?.skipped === true || result?.status === 'skipped') {
    return probeEvidence({
      skipped: true,
      source: 'config',
      evidence: {
        probe: 'text_responses',
        status: result?.status || 'skipped',
        reason: result?.reason || null
      }
    }, checkedAt);
  }
  const verified = result?.ok === true && result?.status === 'chain_ok';
  const blockers = verified
    ? []
    : [
        ...(Array.isArray(result?.blockers) ? result.blockers : []),
        `text_responses_${String(result?.status || 'probe_failed')}`
      ];
  return probeEvidence({
    attempted: true,
    verified,
    source: 'transport',
    blockers,
    evidence: {
      probe: 'text_responses',
      status: result?.status || null,
      cached: result?.cached === true,
      http_status: result?.http_status || null,
      response_chain_completed: verified,
      service_tier: result?.service_tier_evidence || null
    }
  }, checkedAt);
}

async function recordCodexLbChainHealth(result: any, opts: any = {}) {
  if (!result || result.skipped || opts.recordCircuit === false) return result;
  await recordCodexLbHealthEvent(opts.root || packageRoot(), result).catch(() => null);
  return result;
}
