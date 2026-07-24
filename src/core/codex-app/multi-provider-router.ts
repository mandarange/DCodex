import os from 'node:os';
import { exists, nowIso, readText } from '../fsx.js';
import {
  ensureTrailingNewline,
  normalizeCodexFastModeUiConfig,
  safeWriteCodexConfigToml,
  upsertTopLevelTomlString,
  upsertTomlTable
} from '../codex-runtime/codex-desktop-config-policy.js';
import { unselectCodexLbProvider } from '../../cli/install-helpers.js';
import { restartCodexApp, type CodexAppRestartResult } from './codex-app-restart.js';
import {
  codexUserConfigPath,
  defaultOpenCodexCatalogPath,
  normalizeCodexModelId,
  readCodexModelCatalogFile,
  readTopLevelTomlString,
  type CodexModelCatalogReadResult
} from './codex-model-catalog.js';
import {
  hasTomlKey,
  hasTomlTablePrefix,
  hasUnexpectedTomlKeys,
  isLoopbackHostname,
  isSksManagedCatalogPath,
  probeRouterModels,
  resolveCatalogPath,
  routerBlocked,
  tomlBoolean,
  tomlString,
  tomlTableBody,
  uniqueStrings
} from './multi-provider-router-support.js';
import {
  classifyCodexDesktopRouting,
  OPENCODEX_DESIGN_B_FORCE_HINT,
  opencodexDesignBBlocksRouterActivation
} from './codex-desktop-routing-ownership.js';
import {
  desktopPickerStatusFromCache,
  invalidateCodexModelsCache
} from './codex-models-cache.js';

export const MULTI_PROVIDER_ROUTER_ID = 'sks-router' as const;
export const MULTI_PROVIDER_ROUTER_NAME = 'SKS Multi-Provider Router' as const;
export const MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL = 'http://127.0.0.1:10100/v1' as const;
const MULTI_PROVIDER_ROUTER_TIMEOUT_MS = 5_000;

export interface MultiProviderRouterStatus {
  readonly schema: 'sks.codex-app-multi-provider-router-status.v1';
  readonly ok: boolean;
  readonly status: 'configured' | 'not_configured' | 'blocked';
  readonly provider: typeof MULTI_PROVIDER_ROUTER_ID;
  readonly provider_name: typeof MULTI_PROVIDER_ROUTER_NAME;
  readonly selected_provider: string | null;
  readonly selected: boolean;
  readonly provider_present: boolean;
  readonly provider_contract_ok: boolean;
  readonly base_url: string;
  readonly base_url_loopback: boolean;
  readonly catalog_path: string;
  readonly catalog_configured: boolean;
  readonly catalog: CodexModelCatalogReadResult;
  readonly models: readonly string[];
  readonly model_count: number;
  readonly models_truncated: boolean;
  readonly active_model: string | null;
  readonly active_model_present: boolean;
  readonly runtime_verified: false;
  readonly config_path: string;
  readonly routing_ownership: ReturnType<typeof classifyCodexDesktopRouting>;
  readonly desktop_picker: {
    readonly catalog_ok: boolean;
    readonly models_cache_invalidated: boolean;
    readonly restart_recommended: boolean;
  };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export function normalizeMultiProviderRouterBaseUrl(value: unknown): {
  readonly ok: boolean;
  readonly value: string | null;
  readonly blocker: string | null;
} {
  const raw = String(value || '').trim() || MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, value: null, blocker: 'multi_provider_router_base_url_invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, value: null, blocker: 'multi_provider_router_base_url_protocol_unsupported' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, value: null, blocker: 'multi_provider_router_base_url_contains_credentials_or_query' };
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return { ok: false, value: null, blocker: 'multi_provider_router_requires_loopback' };
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (!normalizedPath || normalizedPath === '') parsed.pathname = '/v1';
  else if (normalizedPath === '/') parsed.pathname = '/v1';
  else if (normalizedPath !== '/v1') {
    return { ok: false, value: null, blocker: 'multi_provider_router_base_url_must_end_in_v1' };
  } else {
    parsed.pathname = '/v1';
  }
  return { ok: true, value: parsed.toString().replace(/\/$/, ''), blocker: null };
}

export async function multiProviderRouterStatus(input: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly baseUrl?: string;
  readonly catalogPath?: string;
} = {}): Promise<MultiProviderRouterStatus> {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const configPath = input.configPath || codexUserConfigPath({ home, env });
  const config = await readText(configPath, '');
  const providerBody = tomlTableBody(config, `model_providers.${MULTI_PROVIDER_ROUTER_ID}`);
  const providerPresent = Boolean(providerBody);
  const providerName = tomlString(providerBody, 'name');
  const configuredBaseUrl = tomlString(providerBody, 'base_url');
  const baseUrlResult = normalizeMultiProviderRouterBaseUrl(
    input.baseUrl || configuredBaseUrl || MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL
  );
  const baseUrl = baseUrlResult.value || String(input.baseUrl || configuredBaseUrl || MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL);
  const configuredCatalogPath = readTopLevelTomlString(config, 'model_catalog_json');
  const catalogPath = resolveCatalogPath(
    input.catalogPath || configuredCatalogPath || defaultOpenCodexCatalogPath({ home, env }),
    { home, env, configPath }
  );
  const catalog = await readCodexModelCatalogFile({
    filePath: catalogPath,
    configured: Boolean(configuredCatalogPath)
  });
  const selectedProvider = readTopLevelTomlString(config, 'model_provider');
  const selected = selectedProvider === MULTI_PROVIDER_ROUTER_ID;
  const activeModel = selected ? readTopLevelTomlString(config, 'model') : null;
  const activeModelPresent = Boolean(activeModel && catalog.models.some((entry) => entry.model === activeModel));
  const providerContractOk = providerPresent
    && providerName === MULTI_PROVIDER_ROUTER_NAME
    && baseUrlResult.ok
    && configuredBaseUrl === baseUrl
    && tomlString(providerBody, 'wire_api') === 'responses'
    && tomlBoolean(providerBody, 'requires_openai_auth') === false
    && !hasTomlKey(providerBody, 'env_key')
    && !hasTomlKey(providerBody, 'experimental_bearer_token')
    && !hasTomlKey(providerBody, 'http_headers')
    && !hasTomlKey(providerBody, 'env_http_headers')
    && !hasUnexpectedTomlKeys(providerBody, ['name', 'base_url', 'wire_api', 'requires_openai_auth'])
    && !hasTomlTablePrefix(config, `model_providers.${MULTI_PROVIDER_ROUTER_ID}.`);
  const blockers = uniqueStrings([
    ...(providerPresent ? [] : ['multi_provider_router_provider_missing']),
    ...(providerPresent && !providerContractOk ? ['multi_provider_router_provider_contract_drift'] : []),
    ...(baseUrlResult.blocker ? [baseUrlResult.blocker] : []),
    ...catalog.blockers,
    ...(selected && !activeModel ? ['multi_provider_router_active_model_missing'] : []),
    ...(selected && activeModel && !activeModelPresent ? ['multi_provider_router_active_model_not_in_catalog'] : [])
  ]);
  const ready = providerContractOk && catalog.ok && (!selected || activeModelPresent);
  const ownership = classifyCodexDesktopRouting(config, { home, env, configPath });
  return {
    schema: 'sks.codex-app-multi-provider-router-status.v1',
    ok: ready,
    status: !providerPresent
      ? 'not_configured'
      : ready
        ? 'configured'
        : 'blocked',
    provider: MULTI_PROVIDER_ROUTER_ID,
    provider_name: MULTI_PROVIDER_ROUTER_NAME,
    selected_provider: selectedProvider,
    selected,
    provider_present: providerPresent,
    provider_contract_ok: providerContractOk,
    base_url: baseUrl,
    base_url_loopback: baseUrlResult.ok,
    catalog_path: catalogPath,
    catalog_configured: Boolean(configuredCatalogPath),
    catalog,
    models: catalog.models.map((entry) => entry.model),
    model_count: catalog.model_count,
    models_truncated: catalog.truncated,
    active_model: activeModel,
    active_model_present: activeModelPresent,
    runtime_verified: false,
    config_path: configPath,
    routing_ownership: ownership,
    desktop_picker: desktopPickerStatusFromCache({
      catalogOk: catalog.ok,
      cache: null,
      restartAppRequested: false
    }),
    blockers,
    warnings: uniqueStrings([
      ...catalog.warnings,
      ...ownership.warnings,
      ...(selected
        && activeModel
        && activeModelPresent
        && catalog.models.find((entry) => entry.model === activeModel)?.multi_agent_version !== 'v2'
        ? ['multi_provider_router_active_model_multi_agent_v2_missing']
        : [])
    ])
  };
}

export async function testMultiProviderRouter(input: {
  readonly baseUrl?: string;
  readonly catalogPath?: string;
  readonly model?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}) {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const baseUrlResult = normalizeMultiProviderRouterBaseUrl(input.baseUrl);
  if (!baseUrlResult.ok || !baseUrlResult.value) {
    return routerBlocked('sks.codex-app-multi-provider-router-test.v1', baseUrlResult.blocker || 'multi_provider_router_base_url_invalid');
  }
  const catalogPath = resolveCatalogPath(
    input.catalogPath || defaultOpenCodexCatalogPath({ home, env }),
    { home, env }
  );
  const catalog = await readCodexModelCatalogFile({ filePath: catalogPath, configured: true });
  if (!catalog.ok) {
    return {
      ...routerBlocked('sks.codex-app-multi-provider-router-test.v1', ...catalog.blockers),
      base_url: baseUrlResult.value,
      catalog_path: catalogPath,
      catalog
    };
  }
  const model = input.model ? normalizeCodexModelId(input.model) : null;
  if (input.model && !model) {
    return routerBlocked('sks.codex-app-multi-provider-router-test.v1', 'multi_provider_router_model_invalid');
  }
  if (model && !catalog.models.some((entry) => entry.model === model)) {
    return {
      ...routerBlocked('sks.codex-app-multi-provider-router-test.v1', 'multi_provider_router_model_not_in_catalog'),
      base_url: baseUrlResult.value,
      catalog_path: catalogPath,
      model
    };
  }
  const probe = await probeRouterModels({
    baseUrl: baseUrlResult.value,
    fetchImpl: input.fetchImpl || fetch,
    timeoutMs: input.timeoutMs || MULTI_PROVIDER_ROUTER_TIMEOUT_MS
  });
  const liveModelPresent = !model || probe.models.includes(model);
  const blockers = uniqueStrings([
    ...probe.blockers,
    ...(liveModelPresent ? [] : ['multi_provider_router_model_not_live'])
  ]);
  return {
    schema: 'sks.codex-app-multi-provider-router-test.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'connected' : 'blocked',
    base_url: baseUrlResult.value,
    catalog_path: catalogPath,
    model,
    catalog_model_count: catalog.model_count,
    live_model_count: probe.models.length,
    live_model_present: liveModelPresent,
    probe,
    blockers,
    warnings: catalog.warnings
  };
}

export async function useMultiProviderRouter(input: {
  readonly model: string;
  readonly baseUrl?: string;
  readonly catalogPath?: string;
  readonly replaceCatalog?: boolean;
  readonly forceRoutingOverride?: boolean;
  readonly restartApp?: boolean;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly restartImpl?: (input: { enabled: boolean }) => Promise<CodexAppRestartResult>;
}) {
  const env = input.env || process.env;
  const home = input.home || env.HOME || os.homedir();
  const configPath = input.configPath || codexUserConfigPath({ home, env });
  const model = normalizeCodexModelId(input.model);
  if (!model) return routerBlocked('sks.codex-app-use-multi-provider-router.v1', 'multi_provider_router_model_invalid');
  const baseUrlResult = normalizeMultiProviderRouterBaseUrl(input.baseUrl);
  if (!baseUrlResult.ok || !baseUrlResult.value) {
    return routerBlocked('sks.codex-app-use-multi-provider-router.v1', baseUrlResult.blocker || 'multi_provider_router_base_url_invalid');
  }
  const catalogPath = resolveCatalogPath(
    input.catalogPath || defaultOpenCodexCatalogPath({ home, env }),
    { home, env, configPath }
  );
  const catalog = await readCodexModelCatalogFile({ filePath: catalogPath, configured: true });
  if (!catalog.ok) {
    return {
      ...routerBlocked('sks.codex-app-use-multi-provider-router.v1', ...catalog.blockers),
      model,
      base_url: baseUrlResult.value,
      catalog_path: catalogPath,
      catalog
    };
  }
  if (!catalog.models.some((entry) => entry.model === model)) {
    return {
      ...routerBlocked('sks.codex-app-use-multi-provider-router.v1', 'multi_provider_router_model_not_in_catalog'),
      model,
      base_url: baseUrlResult.value,
      catalog_path: catalogPath
    };
  }
  const probe = await testMultiProviderRouter({
    baseUrl: baseUrlResult.value,
    catalogPath,
    model,
    home,
    env,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  });
  if (!probe.ok) {
    return {
      schema: 'sks.codex-app-use-multi-provider-router.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'probe_blocked',
      model,
      base_url: baseUrlResult.value,
      catalog_path: catalogPath,
      probe,
      blockers: probe.blockers,
      warnings: probe.warnings || []
    };
  }

  const configExistedBefore = await exists(configPath);
  const current = await readText(configPath, '');
  const ownership = classifyCodexDesktopRouting(current, { home, env, configPath });
  const designBBlocker = opencodexDesignBBlocksRouterActivation(ownership, {
    forceRoutingOverride: input.forceRoutingOverride === true
  });
  if (designBBlocker) {
    return {
      ...routerBlocked('sks.codex-app-use-multi-provider-router.v1', designBBlocker),
      model,
      base_url: baseUrlResult.value,
      catalog_path: catalogPath,
      routing_ownership: ownership,
      hint: OPENCODEX_DESIGN_B_FORCE_HINT
    };
  }

  // Clear any managed codex-lb selection and its shared-OpenAI routing pin so a
  // later `codex-lb use-oauth` cannot misread leftover managed state and clobber
  // the router selection.
  const unselect = await unselectCodexLbProvider({
    home,
    configPath,
    allowActiveSharedAuthTransition: true
  }).catch((err: any) => ({ ok: false, status: 'failed', provider_error: err?.message || String(err) }));

  const providerBody = tomlTableBody(current, `model_providers.${MULTI_PROVIDER_ROUTER_ID}`);
  const existingProviderName = tomlString(providerBody, 'name');
  if (providerBody && existingProviderName !== MULTI_PROVIDER_ROUTER_NAME) {
    return routerBlocked('sks.codex-app-use-multi-provider-router.v1', 'multi_provider_router_provider_id_conflict');
  }
  const providerContractConflict = (providerBody || hasTomlTablePrefix(
    current,
    `model_providers.${MULTI_PROVIDER_ROUTER_ID}.`
  )) && (
    hasUnexpectedTomlKeys(providerBody, ['name', 'base_url', 'wire_api', 'requires_openai_auth'])
    || hasTomlTablePrefix(current, `model_providers.${MULTI_PROVIDER_ROUTER_ID}.`)
  );
  if (providerContractConflict) {
    return routerBlocked(
      'sks.codex-app-use-multi-provider-router.v1',
      'multi_provider_router_existing_provider_contract_conflict'
    );
  }
  const configuredCatalogPath = readTopLevelTomlString(current, 'model_catalog_json');
  const configuredCatalogResolved = configuredCatalogPath
    ? resolveCatalogPath(configuredCatalogPath, { home, env, configPath })
    : null;
  const catalogConflict = configuredCatalogPath
    && configuredCatalogResolved !== catalogPath
    && !isSksManagedCatalogPath(configuredCatalogResolved, { home, env })
    && input.replaceCatalog !== true;
  if (catalogConflict) {
    return {
      ...routerBlocked('sks.codex-app-use-multi-provider-router.v1', 'multi_provider_router_user_catalog_conflict'),
      configured_catalog_path: configuredCatalogPath,
      requested_catalog_path: catalogPath,
      hint: 'Re-run with --replace-catalog only if replacing the current user model catalog is intentional.'
    };
  }

  const providerBlock = [
    `[model_providers.${MULTI_PROVIDER_ROUTER_ID}]`,
    `name = ${JSON.stringify(MULTI_PROVIDER_ROUTER_NAME)}`,
    `base_url = ${JSON.stringify(baseUrlResult.value)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false'
  ].join('\n');
  let next = upsertTomlTable(current, `model_providers.${MULTI_PROVIDER_ROUTER_ID}`, providerBlock);
  next = upsertTopLevelTomlString(next, 'model_catalog_json', catalogPath);
  next = upsertTopLevelTomlString(next, 'model_provider', MULTI_PROVIDER_ROUTER_ID);
  next = upsertTopLevelTomlString(next, 'model', model);
  // Desktop gates its global feature UI on the [features] table; ensure it on
  // every provider switch, not just install/codex-lb setup.
  next = normalizeCodexFastModeUiConfig(next);
  next = ensureTrailingNewline(next);
  const write = await safeWriteCodexConfigToml(configPath, current, next, 'multi-provider-router-use', {
    verifyUnchangedBeforeWrite: true,
    expectedBeforeExists: configExistedBefore
  });
  if (!write.ok) {
    return {
      ...routerBlocked(
        'sks.codex-app-use-multi-provider-router.v1',
        String(write.status || 'multi_provider_router_config_write_blocked')
      ),
      model,
      base_url: baseUrlResult.value,
      catalog_path: catalogPath,
      write
    };
  }

  const restart = await (input.restartImpl || restartCodexApp)({ enabled: Boolean(input.restartApp) });
  const cache = await invalidateCodexModelsCache({ home, env, catalogPath });
  const status = await multiProviderRouterStatus({ home, env, configPath });
  const configApplied = status.selected
    && status.provider_contract_ok
    && status.catalog.ok
    && status.active_model === model
    && status.active_model_present;
  const restartRequired = Boolean(input.restartApp);
  const restartCompleted = !restartRequired || (restart.ok && restart.skipped !== true);
  const operationOk = configApplied && restartCompleted;
  const desktopPicker = desktopPickerStatusFromCache({
    catalogOk: catalog.ok && configApplied,
    cache,
    restartAppRequested: Boolean(input.restartApp)
  });
  return {
    schema: 'sks.codex-app-use-multi-provider-router.v1',
    generated_at: nowIso(),
    ok: operationOk,
    status: !configApplied
      ? 'configuration_incomplete'
      : restartCompleted
        ? restartRequired ? 'configured_restarted' : 'configured'
        : 'configured_restart_blocked',
    provider: MULTI_PROVIDER_ROUTER_ID,
    model,
    base_url: baseUrlResult.value,
    catalog_path: catalogPath,
    config_path: configPath,
    probe,
    write,
    unselect,
    restart_app: restart,
    restart_ok: restart.ok && restart.skipped !== true,
    restart_completed: restartCompleted,
    restart_skipped: restart.skipped === true,
    config_applied: configApplied,
    runtime_verified: false,
    models_cache: cache,
    desktop_picker: desktopPicker,
    routing_ownership: ownership,
    router: {
      ...status,
      desktop_picker: desktopPicker
    },
    blockers: uniqueStrings([
      ...(configApplied ? [] : ['multi_provider_router_configuration_incomplete']),
      ...(restartCompleted ? [] : (restart.blockers || ['multi_provider_router_restart_blocked']))
    ]),
    warnings: uniqueStrings([
      ...catalog.warnings,
      ...ownership.warnings,
      ...cache.warnings,
      ...((unselect as any)?.ok === false
        ? [`codex_lb_unselect:${(unselect as any).provider_error || (unselect as any).status}`]
        : []),
      ...(catalog.models.find((entry) => entry.model === model)?.multi_agent_version === 'v2'
        ? []
        : ['multi_provider_router_model_multi_agent_v2_missing']),
      ...(desktopPicker.models_cache_invalidated ? [] : ['multi_provider_router_models_cache_not_invalidated']),
      'multi_provider_router_runtime_not_verified',
      'desktop_picker_restart_recommended_after_catalog_change'
    ])
  };
}
