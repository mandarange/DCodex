import { testOpenRouterConnection } from '../../providers/openrouter/openrouter-account.js';
import { openRouterSecretPaths } from '../../providers/openrouter/openrouter-secret-store.js';
import type { BridgeProviderId, DesktopBridgeCommandResult } from '../bridge-contracts.js';
import { codexLbEnvPath, codexLbMetadataPath, readCodexLbModelCatalog, type CodexLbEnvLoadResult } from '../codex-lb-env.js';
import {
  configureProviderCredential,
  recordProviderCredentialValidation,
  removeProviderCredential
} from '../provider-credentials.js';
import type { ResolvedProviderCredential } from '../provider-credentials.js';
import {
  configureBridgeProviderProfile,
  resolveBridgeProviderRegistry,
  setBridgeProviderEnabled,
  type BridgeProviderAuthTransport
} from '../provider-registry.js';
import {
  commandResult,
  activeProviderIds,
  controllerEnv,
  controllerPaths,
  nowIso,
  persistRuntimeSettings,
  providerCode,
  quiesceRunningBridge,
  resolveRawCredentials,
  stringArray,
  timeoutMs
} from './shared.js';
import { desktopBridgeStatusV3, loadCore } from './status.js';
import type { DesktopBridgeControllerRequestV3, DesktopBridgeControllerV3Options } from './types.js';

export async function configureProvider(
  request: Extract<DesktopBridgeControllerRequestV3, { operation: 'provider.configure' }>,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const restartDeferred = await quiesceRunningBridge(await loadCore(options), options);
  const configured = await configureProviderCredential({
    provider_id: request.provider_id,
    api_key: request.api_key,
    ...(request.host ? { host: request.host } : {}),
    home: paths.home,
    processEnv: controllerEnv(options),
    codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
    codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home)
  });
  const rawCredentials = await resolveRawCredentials(options, paths);
  const endpoint = request.provider_id === 'codex-lb'
    ? rawCredentials['codex-lb'].endpoint_url
    : 'https://openrouter.ai/api/v1';
  if (!endpoint) throw new Error(`${providerCode(request.provider_id)}_endpoint_missing`);
  const registry = await configureBridgeProviderProfile({
    provider_id: request.provider_id,
    endpoint_url: endpoint,
    enabled: true,
    home: paths.home,
    credentials: rawCredentials
  });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) {
    await persistRuntimeSettings({ ...core, registry }, options, { restartService: false });
  }
  const status = await desktopBridgeStatusV3(options);
  const blockers = restartDeferred ? ['desktop_bridge_restart_deferred_until_provider_validation'] : [];
  return commandResult('provider.configure', true, status, {
    configuration: configured,
    restart_deferred: restartDeferred,
    recovery_action: restartDeferred ? `bridge provider validate ${request.provider_id}` : null,
  }, blockers, options);
}

export async function validateProvider(
  providerId: BridgeProviderId,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const credentials = await resolveRawCredentials(options, paths);
  const credential = credentials[providerId];
  if (!credential.secret || !credential.fingerprint || !credential.endpoint_url) {
    const status = await desktopBridgeStatusV3(options);
    return commandResult(
      'provider.validate',
      true,
      status,
      { provider_id: providerId, validated: false },
      [`${providerCode(providerId)}_credential_missing`],
      options
    );
  }
  const registry = await resolveBridgeProviderRegistry({ home: paths.home, credentials });
  const result = providerId === 'codex-lb'
    ? await validateCodexLbCredential(credential, options, registry.profiles['codex-lb'].endpoint.auth_transport)
    : await testOpenRouterConnection({
      apiKey: credential.secret,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: timeoutMs(options)
    });
  const ok = result.ok === true;
  const blockers = stringArray((result as Record<string, unknown>).blockers);
  if (!ok && blockers.length === 0) blockers.push(`${providerCode(providerId)}_validation_failed`);
  await recordProviderCredentialValidation({
    provider_id: providerId,
    credential,
    state: ok ? 'ready' : validationFailureState(blockers),
    checked_at: nowIso(options),
    blockers,
    warnings: stringArray((result as Record<string, unknown>).warnings),
    home: paths.home,
    validationPath: paths.validationPath,
    resolveCurrentCredential: async () => (await resolveRawCredentials(options, paths))[providerId],
  });
  if (ok) {
    const current = await loadCore(options);
    if (current.activeCatalog.ok && current.policy) {
      await persistRuntimeSettings(current, options, {
        restartService: current.service.installed || current.service.running,
        failClosedRestart: true,
      });
    }
  }
  const status = await desktopBridgeStatusV3(options);
  return commandResult(
    'provider.validate',
    true,
    status,
    { provider_id: providerId, validated: ok, validation: publicValidationResult(result) },
    ok ? [] : blockers,
    options
  );
}

export async function setProviderState(
  providerId: BridgeProviderId,
  enabled: boolean,
  operation: 'provider.enable' | 'provider.disable',
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const restartService = enabled
    ? null
    : await quiesceRunningBridge(await loadCore(options), options);
  const credentials = await resolveRawCredentials(options, paths);
  await setBridgeProviderEnabled({
    provider_id: providerId,
    enabled,
    home: paths.home,
    credentials
  });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) {
    if (enabled) await persistRuntimeSettings(core, options);
    else {
      await persistRuntimeSettings(core, options, {
        restartService: Boolean(restartService) && activeProviderIds(core).length > 0,
        failClosedRestart: true
      });
    }
  }
  const status = await desktopBridgeStatusV3(options);
  return commandResult(operation, true, status, { provider_id: providerId, enabled }, [], options);
}

export async function removeCredential(
  providerId: BridgeProviderId,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const before = await loadCore(options);
  const restartService = await quiesceRunningBridge(before, options);
  const removal = await removeProviderCredential({
    provider_id: providerId,
    confirmed: true,
    home: paths.home,
    codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
    codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home),
    openRouterPaths: openRouterSecretPaths(controllerEnv(options))
  });
  if (removal.blockers.length > 0) {
    const status = await desktopBridgeStatusV3(options);
    return commandResult(
      'provider.remove-credential',
      false,
      status,
      { removal },
      removal.blockers,
      options
    );
  }
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) {
    await persistRuntimeSettings(core, options, {
      restartService: restartService && activeProviderIds(core).length > 0,
      failClosedRestart: true
    });
  }
  const status = await desktopBridgeStatusV3(options);
  return commandResult(
    'provider.remove-credential',
    removal.blockers.length === 0,
    status,
    { removal },
    removal.blockers,
    options
  );
}

async function validateCodexLbCredential(
  credential: ResolvedProviderCredential,
  options: DesktopBridgeControllerV3Options,
  authTransport: BridgeProviderAuthTransport
): Promise<Record<string, unknown>> {
  if (!credential.secret || !credential.endpoint_url || !credential.fingerprint) {
    throw new Error('codex_lb_credential_validation_binding_missing');
  }
  const loaded: CodexLbEnvLoadResult = {
    schema: 'sks.codex-lb-env.v1', configured: true, missing: [], source: 'env-file',
    source_priority: ['env-file'], base_url: credential.endpoint_url,
    api_key: { present: true, usable: true, source: 'env-file', redacted: true, fingerprint: credential.fingerprint },
    secret_api_key: credential.secret,
    credential_binding: {
      checked: true, present: true, valid: true, status: 'matched', metadata_path: '[validation-snapshot]',
      api_key_matches: true, base_url_matches: true, blockers: [],
    },
    env_paths: [], keychain: { checked: false, available: false, status: 'not_used' },
  };
  const result = await readCodexLbModelCatalog({
    loadedEnv: loaded,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.codexLbLookup ? { lookup: options.codexLbLookup } : {}),
    timeoutMs: timeoutMs(options),
    gatewayAuthTransport: authTransport === 'x-codex-lb-api-key'
      ? 'x-codex-lb-api-key' : 'authorization-bearer'
  });
  return {
    schema: 'sks.codex-lb-provider-validation.v1',
    ok: result.ok,
    authenticated: result.ok,
    model_count: result.models.length,
    http_status: result.http_status,
    blockers: result.blockers,
    warnings: []
  };
}

function publicValidationResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).filter(([key]) =>
    !/(?:api.?key|secret|token|authorization|cookie|headers?|env)/i.test(key)));
}

function validationFailureState(blockers: readonly string[]): 'rejected' | 'unavailable' {
  return blockers.some((blocker) => /(?:401|403|auth|rejected|invalid_key|unauthorized)/i.test(blocker))
    ? 'rejected' : 'unavailable';
}
