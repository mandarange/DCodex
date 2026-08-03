import os from 'node:os';
import path from 'node:path';
import { loadCodexLbEnv, parseShellEnvValue } from '../codex-lb/codex-lb-env.js';
import {
  CODEX_LB_ROUTING_TRUTH_RECEIPT,
  codexLbRoutingTruthIsActive,
  readCodexLbRoutingTruthReceipt
} from '../codex-lb/routing-truth.js';
import { nowIso, readText, runProcess, which } from '../fsx.js';
import { redactSecrets, redactString } from '../secret-redaction.js';
import { evaluateImagegenAuthReadiness } from './imagegen-auth-readiness.js';
import { escapeRegExp } from '../text/regex.js';

export async function detectImagegenCapability(opts: any = {}) {
  const codexBin = opts.codexBin || await which('codex').catch(() => null);
  const codexApp = await detectCodexAppImagegen(codexBin, opts);
  const env = opts.env || process.env;
  const openaiApiKeyPresent = Boolean(opts.apiKey || env.OPENAI_API_KEY);
  const codexLb = await detectCodexLbImagegenAuth(opts, env);
  const codexAppBuiltInAvailable = codexApp.available === true;
  const authReadiness = await evaluateImagegenAuthReadiness({
    codexHome: opts.codexHome,
    env,
    codexAppBuiltInAvailable,
    authJsonText: opts.authJsonText
  }).catch(() => null);
  const apiFallbackAvailable = openaiApiKeyPresent;
  const fakeAdapterEnabled = opts.fake === true || env.SKS_TEST_FAKE_IMAGEGEN === '1';
  const fakeAdapterAcceptedForRoute = fakeAdapterEnabled && (
    opts.mockContext === true
    || opts.testContext === true
    || env.NODE_ENV === 'test'
    || env.SKS_SELFTEST_MOCK === '1'
    || env.SKS_MOCK === '1'
  );
  const realGenerationAvailable = codexAppBuiltInAvailable;
  const routeGenerationAvailable = codexAppBuiltInAvailable || fakeAdapterAcceptedForRoute;
  const coreReady = codexAppBuiltInAvailable;
  const coreBlockers = coreReady ? [] : ['codex_app_builtin_imagegen_capability_missing'];
  const routeGenerationBlockers = routeGenerationAvailable ? [] : ['imagegen_capability_missing'];
  return {
    schema: 'sks.imagegen-capability.v1',
    ok: true,
    created_at: nowIso(),
    model: 'gpt-image-2',
    core_feature: true,
    core_ready: coreReady,
    real_generation_available: realGenerationAvailable,
    codex_app_builtin_output_required: true,
    real_output_verified_by_capability_check: false,
    capability_detection_is_not_output_proof: true,
    preferred_surface: 'Codex App $imagegen',
    fallback_surface: 'Explicit OpenAI Images API gpt-image-2 fallback (non-Codex evidence)',
    api_fallback_satisfies_codex_app_evidence: false,
    full_verification_requires_real_generation: true,
    codex_app: {
      ...codexApp,
      official_surface: '$imagegen',
      generated_output_required_for_full_verification: true
    },
    codex_lb: {
      ...codexLb,
      satisfies_codex_app_builtin_evidence: false,
      accepted_for_core_readiness: false
    },
    openai_images_api: {
      available: apiFallbackAvailable,
      auth_source: openaiApiKeyPresent ? 'OPENAI_API_KEY' : null,
      codex_lb_proxy: codexLb.available ? {
        base_url: codexLb.base_url,
        env_key: codexLb.env_key,
        satisfies_codex_app_builtin_evidence: false,
        accepted_for_core_readiness: false
      } : null,
      endpoints: {
        images_edits_supported: apiFallbackAvailable,
        images_generations_supported: apiFallbackAvailable,
        responses_image_generation_supported: apiFallbackAvailable
      },
      blocker: apiFallbackAvailable ? null : 'openai_api_key_missing',
      official_codex_app_substitute: false,
      requires_explicit_api_fallback: true
    },
    fake_adapter: {
      available: fakeAdapterEnabled,
      accepted_for_route_readiness: fakeAdapterAcceptedForRoute,
      env: 'SKS_TEST_FAKE_IMAGEGEN=1',
      source: 'mock_like_fixture',
      real_generation_claim_allowed: false
    },
    supports_reference_image: codexAppBuiltInAvailable || fakeAdapterAcceptedForRoute,
    gpt_image_2_input_fidelity_automatic: true,
    input_fidelity_must_be_omitted: true,
    supported_workflows: {
      ux_review_callouts: codexAppBuiltInAvailable || fakeAdapterAcceptedForRoute,
      ppt_slide_callouts: codexAppBuiltInAvailable || fakeAdapterAcceptedForRoute,
      structured_extraction_required_after_generation: true,
      full_verification_requires_codex_app_output: true
    },
    auth_readiness: authReadiness,
    core_blockers: coreBlockers,
    route_generation_blockers: routeGenerationBlockers,
    blockers: [...coreBlockers, ...routeGenerationBlockers]
  };
}

async function detectCodexLbImagegenAuth(opts: any = {}, env: any = process.env) {
  const home = opts.home || env.HOME || process.env.HOME || os.homedir();
  const codexHome = opts.codexHome || env.CODEX_HOME || path.join(home, '.codex');
  const configPath = opts.configPath || path.join(codexHome, 'config.toml');
  const configText = typeof opts.configText === 'string'
    ? opts.configText
    : await readText(configPath, '').catch(() => '');
  const block = tomlTableBlock(configText, 'model_providers.codex-lb');
  const selected = opts.codexLbSelected === true || topLevelTomlString(configText, 'model_provider') === 'codex-lb';
  const providerConfigured = Boolean(block);
  const requiresOpenAiAuth = tomlBoolean(block, 'requires_openai_auth');
  const bearerEnvKey = tomlString(block, 'env_key');
  const gatewayHeaderEnvKey = tomlEnvHttpHeader(block, 'X-Codex-LB-API-Key');
  const envKey = gatewayHeaderEnvKey || bearerEnvKey;
  // CLI provider contract: Codex resolves the gateway key from the environment
  // into the dedicated gateway header. It must not also install env_key Bearer
  // auth, which would send the same secret through two authentication channels.
  const cliContract = providerConfigured
    && tomlString(block, 'name') === 'codex-lb'
    && tomlString(block, 'wire_api') === 'responses'
    && gatewayHeaderEnvKey === 'CODEX_LB_API_KEY'
    && !bearerEnvKey
    && requiresOpenAiAuth === false;
  const baseUrl = tomlString(block, 'base_url') || String(env.CODEX_LB_BASE_URL || '').trim();
  const envPath = opts.codexLbEnvPath || path.join(codexHome, 'sks-codex-lb.env');
  // Resolve through the fingerprint-bound loader rather than re-reading
  // process.env here: a stale exported key otherwise reports as present and
  // usable while the proxy rejects it. Callers may still inject a key or an
  // env-file body directly for hermetic checks.
  const injectedEnvText = typeof opts.codexLbEnvText === 'string' ? opts.codexLbEnvText : null;
  const keyFromInjectedFile = injectedEnvText !== null && envKey ? parseShellEnvValue(injectedEnvText, envKey) : '';
  const loaded = injectedEnvText === null
    ? await loadCodexLbEnv({
        home,
        processEnv: {},
        envPath,
        metadataPath: path.join(codexHome, 'sks-codex-lb.json')
      }).catch(() => null)
    : null;
  const apiKeyPresent = Boolean(opts.codexLbApiKey || keyFromInjectedFile || loaded?.secret_api_key);
  const apiKeySource = opts.codexLbApiKey
    ? 'option'
    : keyFromInjectedFile ? 'env-file' : loaded?.api_key?.source || null;
  const blocker = codexLbAuthBlocker({
    selected,
    providerConfigured,
    requiresOpenAiAuth,
    envKey,
    baseUrl,
    apiKeyPresent,
    cliContract
  });
  const routingTruthReceiptPath = opts.codexLbRoutingTruthReceiptPath
    || path.join(codexHome, CODEX_LB_ROUTING_TRUTH_RECEIPT);
  const routingTruth = await readCodexLbRoutingTruthReceipt({
    receiptPath: routingTruthReceiptPath
  }).catch(() => null);
  const configuredHost = publicUrlHost(baseUrl);
  const routingAuthTransport = cliContract
    ? 'x-codex-lb-api-key'
    : 'authorization-bearer';
  const routingTruthContextMatches = routingTruth?.selected === selected
    && routingTruth?.configured_host === configuredHost
    && routingTruth?.auth_transport === routingAuthTransport;
  const routingActive = routingTruthContextMatches
    && codexLbRoutingTruthIsActive(routingTruth);
  return {
    available: blocker === null,
    selected,
    cli_contract: cliContract,
    provider_configured: providerConfigured,
    requires_openai_auth: requiresOpenAiAuth,
    openai_auth_disabled: requiresOpenAiAuth === false,
    env_key: envKey || null,
    base_url: baseUrl || null,
    env_path: envPath,
    api_key: {
      present: apiKeyPresent,
      source: apiKeySource,
      redacted: true
    },
    routing_active: routingActive,
    routing_truth: routingTruth,
    routing_truth_receipt_path: routingTruthReceiptPath,
    routing_blocker: codexLbRoutingBlocker({
      selected,
      configuredHost,
      routingTruth,
      expectedAuthTransport: routingAuthTransport,
      routingTruthContextMatches,
      routingActive
    }),
    blocker
  };
}

function codexLbRoutingBlocker(state: {
  selected: boolean;
  configuredHost: string | null;
  routingTruth: any;
  expectedAuthTransport: 'authorization-bearer' | 'x-codex-lb-api-key';
  routingTruthContextMatches: boolean;
  routingActive: boolean;
}): string | null {
  if (!state.selected) return 'codex_lb_not_selected';
  if (!state.routingTruth) return 'codex_lb_routing_truth_receipt_missing';
  if (state.routingTruth.selected !== true) return 'codex_lb_routing_truth_selection_mismatch';
  if (state.routingTruth.configured_host !== state.configuredHost) return 'codex_lb_routing_truth_host_mismatch';
  if (state.routingTruth.auth_transport !== state.expectedAuthTransport) return 'codex_lb_routing_truth_auth_transport_mismatch';
  if (!state.routingTruthContextMatches || !state.routingActive) {
    return state.routingTruth.blockers?.[0] || 'codex_lb_routing_truth_unverified';
  }
  return null;
}

function codexLbAuthBlocker(state: any) {
  if (!state.selected && !state.cliContract) return 'codex_lb_not_selected';
  if (!state.providerConfigured) return 'codex_lb_provider_missing';
  if (state.cliContract) {
    if (!state.apiKeyPresent) return 'codex_lb_api_key_missing';
    if (!state.baseUrl) return 'codex_lb_base_url_missing';
    return null;
  }
  if (state.requiresOpenAiAuth !== true) {
    return state.requiresOpenAiAuth === false ? 'codex_lb_legacy_openai_auth_disabled' : 'codex_lb_requires_openai_auth_missing';
  }
  if (state.envKey !== 'CODEX_LB_API_KEY') return 'codex_lb_env_key_missing_or_unsupported';
  if (!state.baseUrl) return 'codex_lb_base_url_missing';
  if (!state.apiKeyPresent) return 'codex_lb_api_key_missing';
  return null;
}

async function detectCodexAppImagegen(codexBin: string | null, opts: any = {}) {
  if (opts.codexAppAvailable === true || process.env.SKS_CODEX_APP_IMAGEGEN_AVAILABLE === '1') {
    return { available: true, detector: 'env_or_option', blocker: null, raw: null };
  }
  if (!codexBin) return { available: false, detector: 'codex_binary_missing', blocker: 'codex_binary_missing', raw: null };
  // Codex 0.144 exposes `features list` as a stable text table and rejects
  // `--json`. Read the supported surface once; still accept JSON output if a
  // future CLI returns it from the plain command.
  const featureRun = await runProcess(codexBin, ['features', 'list'], {
    timeoutMs: opts.timeoutMs || 5000,
    maxOutputBytes: 64 * 1024
  }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }));
  let parsed: any = null;
  try {
    const candidate = JSON.parse(featureRun.stdout || 'null');
    parsed = hasCodexFeatureSignal(candidate) ? candidate : null;
  } catch {}
  if (featureRun.code !== 0) {
    return {
      available: false,
      detector: 'codex_features_list',
      blocker: 'codex_app_imagegen_not_detected',
      raw: redactString(String(featureRun.stderr || featureRun.stdout || '').slice(0, 2000))
    };
  }
  const rawText = String(featureRun.stdout || featureRun.stderr || '');
  const available = codexFeatureEnabled(parsed, rawText);
  return {
    available,
    detector: 'codex_features_list',
    blocker: available ? null : 'codex_app_imagegen_not_detected',
    raw: parsed ? redactSecrets(parsed) : redactString(rawText.slice(0, 2000))
  };
}

function hasCodexFeatureSignal(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function codexFeatureEnabled(parsed: any, rawText: string): boolean {
  const parsedValue = parsedFeatureEnabled(parsed);
  if (parsedValue !== null) return parsedValue;
  const plainValue = plainFeatureEnabled(rawText);
  if (plainValue !== null) return plainValue;
  const haystack = JSON.stringify(parsed || rawText || '');
  return /image[_-]?generation|imagegen|\$imagegen/i.test(haystack)
    && !/false|disabled|missing/i.test(String(parsed?.image_generation ?? parsed?.features?.image_generation ?? ''));
}

function parsedFeatureEnabled(parsed: any): boolean | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const direct = boolish(parsed.image_generation ?? parsed.imageGeneration ?? parsed.imagegen);
  if (direct !== null) return direct;
  const featureMap = parsed.features && typeof parsed.features === 'object' && !Array.isArray(parsed.features)
    ? boolish(parsed.features.image_generation ?? parsed.features.imageGeneration ?? parsed.features.imagegen)
    : null;
  if (featureMap !== null) return featureMap;
  const featureLists = [
    Array.isArray(parsed) ? parsed : null,
    Array.isArray(parsed.features) ? parsed.features : null
  ].filter(Boolean);
  for (const list of featureLists) {
    for (const item of list as any[]) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name ?? item.key ?? item.id ?? item.feature ?? '');
      if (!/^image[_-]?generation$|^imagegen$/i.test(name)) continue;
      const value = boolish(item.enabled ?? item.value ?? item.available ?? item.status);
      if (value !== null) return value;
    }
  }
  return null;
}

function plainFeatureEnabled(rawText: string): boolean | null {
  for (const line of rawText.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/).filter(Boolean);
    if (columns.length < 2) continue;
    if (!/^image[_-]?generation$|^imagegen$/i.test(columns[0] || '')) continue;
    return boolish(columns[columns.length - 1]);
  }
  return null;
}

function boolish(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return null;
  if (/^(true|enabled|available|on|yes)$/i.test(value.trim())) return true;
  if (/^(false|disabled|missing|off|no)$/i.test(value.trim())) return false;
  return null;
}

function publicUrlHost(value: unknown): string | null {
  try {
    return typeof value === 'string' && value ? new URL(value).host : null;
  } catch {
    return null;
  }
}

function topLevelTomlString(text: any = '', key: any = '') {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return tomlString(topLevel, key);
}

function tomlTableBlock(text: any = '', table: any = '') {
  const re = new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`);
  return String(text || '').match(re)?.[2] || '';
}

function tomlString(text: any = '', key: any = '') {
  const re = new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?(?=\\n|$)`);
  return String(text || '').match(re)?.[2] || '';
}

function tomlEnvHttpHeader(text: any = '', header: any = '') {
  const inline = String(text || '').match(/(?:^|\n)\s*env_http_headers\s*=\s*\{([^}]*)\}/)?.[1] || '';
  return inline.match(new RegExp(`"${escapeRegExp(header)}"\\s*=\\s*"([^"]+)"`))?.[1] || '';
}

function tomlBoolean(text: any = '', key: any = '') {
  const re = new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?(?=\\n|$)`, 'i');
  const raw = String(text || '').match(re)?.[2];
  if (!raw) return null;
  return raw.toLowerCase() === 'true';
}
