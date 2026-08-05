import { testOpenRouterConnection } from '../../providers/openrouter/openrouter-account.js';
import type { BridgeProviderId, DesktopBridgeCommandResult } from '../bridge-contracts.js';
import { codexLbEnvPath, codexLbMetadataPath, loadCodexLbEnv, readCodexLbModelCatalog } from '../codex-lb-env.js';
import {
  configureProviderCredential,
  recordProviderCredentialValidation,
  removeProviderCredential
} from '../provider-credentials.js';
import {
  configureBridgeProviderProfile,
  resolveBridgeProviderRegistry,
  setBridgeProviderEnabled,
  type BridgeProviderAuthTransport
} from '../provider-registry.js';
import {
  commandResult,
  controllerEnv,
  controllerPaths,
  nowIso,
  persistRuntimeSettings,
  providerCode,
  resolveRawCredentials,
  stringArray,
  timeoutMs
} from './shared.js';
import { desktopBridgeStatusV3, loadCore } from './status.js';
import type { ControllerPaths, DesktopBridgeControllerRequestV3, DesktopBridgeControllerV3Options } from './types.js';

export async function configureProvider(
  request: Extract<DesktopBridgeControllerRequestV3, { operation: 'provider.configure' }>,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
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
  if (core.activeCatalog.ok && core.policy) await persistRuntimeSettings({ ...core, registry }, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult('provider.configure', true, status, { configuration: configured }, [], options);
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
    ? await validateCodexLbCredential(paths, options, registry.profiles['codex-lb'].endpoint.auth_transport)
    : await testOpenRouterConnection({
      env: controllerEnv(options),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: timeoutMs(options)
    });
  const ok = result.ok === true;
  const blockers = stringArray((result as Record<string, unknown>).blockers);
  await recordProviderCredentialValidation({
    provider_id: providerId,
    credential,
    state: ok ? 'ready' : validationFailureState(blockers),
    checked_at: nowIso(options),
    blockers,
    warnings: stringArray((result as Record<string, unknown>).warnings),
    home: paths.home,
    validationPath: paths.validationPath
  });
  const status = await desktopBridgeStatusV3(options);
  return commandResult(
    'provider.validate',
    true,
    status,
    { provider_id: providerId, validated: ok, validation: publicValidationResult(result) },
    [],
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
  await setBridgeProviderEnabled({ provider_id: providerId, enabled, home: paths.home });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) await persistRuntimeSettings(core, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult(operation, true, status, { provider_id: providerId, enabled }, [], options);
}

export async function removeCredential(
  providerId: BridgeProviderId,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const removal = await removeProviderCredential({
    provider_id: providerId,
    confirmed: true,
    home: paths.home,
    codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
    codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home)
  });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) await persistRuntimeSettings(core, options);
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
  paths: ControllerPaths,
  options: DesktopBridgeControllerV3Options,
  authTransport: BridgeProviderAuthTransport
): Promise<Record<string, unknown>> {
  const loaded = await loadCodexLbEnv({
    home: paths.home,
    envPath: options.envPath || codexLbEnvPath(paths.home),
    metadataPath: options.metadataPath || codexLbMetadataPath(paths.home),
    processEnv: controllerEnv(options)
  });
  const result = await readCodexLbModelCatalog({
    loadedEnv: loaded,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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
