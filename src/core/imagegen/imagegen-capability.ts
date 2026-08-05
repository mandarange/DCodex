import { desktopBridgeStatusV3 } from '../codex-lb/desktop-controller-v3.js';
import { nowIso, runProcess, which } from '../fsx.js';
import { redactSecrets, redactString } from '../secret-redaction.js';
import { evaluateImagegenAuthReadiness } from './imagegen-auth-readiness.js';

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
  const status = opts.desktopBridgeStatus || await (opts.desktopBridgeStatusImpl || desktopBridgeStatusV3)({
    home: opts.home || env.HOME,
    env
  }).catch(() => null);
  const provider = status?.providers?.['codex-lb'] || null;
  const policy = status?.routing?.policy || null;
  const modelRoutes = Object.values(policy?.model_routes || {}) as any[];
  const selected = provider?.enabled === true && (
    policy?.default_provider_id === 'codex-lb'
    || modelRoutes.some((route) => route?.provider_id === 'codex-lb')
  );
  const credentialReady = provider?.credential?.state === 'ready';
  const endpointConfigured = provider?.endpoint?.configured === true;
  const capabilityEvidence = provider?.capabilities?.capabilities?.image_generation || null;
  const capabilityReady = capabilityEvidence?.state === 'verified';
  const blocker = !status
    ? 'desktop_bridge_status_unavailable'
    : !provider
      ? 'codex_lb_provider_status_missing'
      : !provider.enabled
        ? 'codex_lb_provider_disabled'
        : !credentialReady
          ? provider.credential?.blockers?.[0] || `codex_lb_credential_${provider.credential?.state || 'unknown'}`
          : !endpointConfigured
            ? 'codex_lb_endpoint_missing'
            : !selected
              ? 'codex_lb_route_inactive'
              : !capabilityReady
                ? capabilityEvidence?.blockers?.[0] || `codex_lb_imagegen_capability_${capabilityEvidence?.state || 'unverified'}`
                : null;
  return {
    available: blocker === null,
    selected,
    cli_contract: provider?.endpoint?.auth_transport === 'authorization-bearer',
    provider_configured: Boolean(provider),
    requires_openai_auth: null,
    openai_auth_disabled: null,
    env_key: null,
    base_url: provider?.endpoint?.origin_redacted || null,
    env_path: null,
    api_key: {
      present: credentialReady,
      source: provider?.credential?.source || null,
      redacted: true
    },
    routing_active: selected,
    routing_blocker: selected ? null : 'codex_lb_route_inactive',
    capability_evidence: capabilityEvidence,
    provider_capability_summary: provider?.capabilities || null,
    bridge_status_checked_at: status?.checked_at || null,
    blocker
  };
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
