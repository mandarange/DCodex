import path from 'node:path';
import os from 'node:os';
import { ensureDir, exists, readText, nowIso } from '../fsx.js';
import { openRouterSecretPaths, resolveOpenRouterApiKey } from '../providers/openrouter/openrouter-secret-store.js';
import {
  OPENROUTER_AUTH_COMMAND,
  OPENROUTER_AUTH_REFRESH_INTERVAL_MS,
  OPENROUTER_AUTH_TIMEOUT_MS,
  openRouterAuthCommandArgs,
  OPENROUTER_PROVIDER_ID,
  normalizeOpenRouterModelId
} from './openrouter-provider.js';
import { installCodexAppGlmProfile } from './glm-profile-installer.js';
import { restartCodexApp } from './codex-app-restart.js';
import type { CodexAppRestartResult } from './codex-app-restart.js';
import {
  codexLbConfigPath,
  ensureGlobalCodexAppGlmProfile,
  unselectCodexLbProvider
} from '../../cli/install-helpers.js';
import {
  ensureTrailingNewline,
  normalizeCodexFastModeUiConfig,
  safeWriteCodexConfigToml,
  upsertTopLevelTomlString
} from '../codex-runtime/codex-desktop-config-policy.js';
import { readTopLevelTomlString, sksOpenRouterCatalogPath } from './codex-model-catalog.js';
import { resolveCatalogPath } from './multi-provider-router-support.js';
import {
  openRouterCatalogBindDecision,
  writeOpenRouterManagedCatalog
} from './openrouter-model-catalog.js';
import {
  classifyCodexDesktopRouting
} from './codex-desktop-routing-ownership.js';
import {
  desktopPickerStatusFromCache,
  invalidateCodexModelsCache,
  type InvalidateCodexModelsCacheResult
} from './codex-models-cache.js';
import {
  assessThreadVisibilityImpact,
  captureDesktopRoutingSnapshot,
  desktopRoutingSnapshotPath,
  readDesktopRoutingSnapshot,
  remapThreadCatalogProvider,
  restoreDesktopRoutingSnapshot,
  writeDesktopRoutingSnapshot
} from './desktop-routing-snapshot.js';
import { escapeRegExp } from '../text/regex.js';

export interface OpenRouterStatus {
  readonly schema: 'sks.codex-app-openrouter-status.v1';
  readonly ok: boolean;
  readonly key_present: boolean;
  readonly key_source: string | null;
  readonly provider_present: boolean;
  readonly provider_env_key_present: boolean;
  readonly provider_auth_present: boolean;
  readonly provider_auth_conflict: boolean;
  readonly provider_auth_valid: boolean;
  readonly selected: boolean;
  readonly model: string | null;
  readonly model_source: 'config' | null;
  readonly model_catalog_path: string;
  readonly model_catalog_bound: boolean;
  readonly config_path: string;
  readonly routing_ownership: ReturnType<typeof classifyCodexDesktopRouting>;
  readonly desktop_picker: {
    readonly catalog_ok: boolean;
    readonly models_cache_invalidated: boolean;
    readonly restart_recommended: boolean;
  };
  readonly thread_visibility: ReturnType<typeof assessThreadVisibilityImpact> | null;
  readonly previous_routing_restore_available: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export async function openRouterStatus(input: {
  readonly root?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
} = {}): Promise<OpenRouterStatus> {
  const home = input.home || process.env.HOME || os.homedir();
  const configPath = input.configPath || codexLbConfigPath(home);
  const config = await readText(configPath, '');
  const env = { ...(input.env || process.env), HOME: home };
  const key = await resolveOpenRouterApiKey({ env });
  const authArgs = openRouterAuthCommandArgs(openRouterSecretPaths(env).keyPath);
  const providerPresent = new RegExp(`\\[model_providers\\.${OPENROUTER_PROVIDER_ID}\\]`).test(config);
  const providerBody = tomlTableBody(config, `model_providers.${OPENROUTER_PROVIDER_ID}`);
  const providerEnvKeyPresent = hasTomlKey(providerBody, 'env_key');
  const authBody = tomlTableBody(config, `model_providers.${OPENROUTER_PROVIDER_ID}.auth`);
  const providerAuthPresent = Boolean(authBody);
  const providerAuthConflict = providerEnvKeyPresent && providerAuthPresent;
  const providerAuthValid = providerAuthPresent
    && !providerAuthConflict
    && hasTomlString(authBody, 'command', OPENROUTER_AUTH_COMMAND)
    && hasTomlStringArray(authBody, 'args', authArgs)
    && hasTomlInteger(authBody, 'timeout_ms', OPENROUTER_AUTH_TIMEOUT_MS)
    && hasTomlInteger(authBody, 'refresh_interval_ms', OPENROUTER_AUTH_REFRESH_INTERVAL_MS);
  const selected = readTopLevelTomlString(config, 'model_provider') === OPENROUTER_PROVIDER_ID;
  const model = readTopLevelTomlString(config, 'model');
  const managedCatalogPath = sksOpenRouterCatalogPath({ home, env });
  const configuredCatalogPath = readTopLevelTomlString(config, 'model_catalog_json');
  const modelCatalogBound = Boolean(configuredCatalogPath
    && resolveCatalogPath(configuredCatalogPath, { home, env, configPath }) === path.resolve(managedCatalogPath));
  const blockers: string[] = [];
  if (!key.key) blockers.push('openrouter_key_missing');
  if (!providerPresent) blockers.push('openrouter_provider_missing');
  if (providerAuthConflict) blockers.push('openrouter_provider_auth_env_key_conflict');
  else if (!providerAuthPresent) blockers.push('openrouter_provider_auth_missing');
  else if (!providerAuthValid) blockers.push('openrouter_provider_auth_invalid');
  if (selected && !model) blockers.push('openrouter_model_missing');
  const ownership = classifyCodexDesktopRouting(config, { home, env, configPath });
  const currentProvider = readTopLevelTomlString(config, 'model_provider');
  const threadVisibility = assessThreadVisibilityImpact({
    home,
    env,
    currentProvider,
    targetProvider: selected ? OPENROUTER_PROVIDER_ID : (currentProvider || 'openai')
  });
  const previousSnapshot = await readDesktopRoutingSnapshot({ home, env });
  // A snapshot that itself points at OpenRouter cannot restore a previous
  // provider; restoring it would be a no-op, so do not advertise it.
  const previousRoutingRestoreAvailable = Boolean(
    previousSnapshot && previousSnapshot.model_provider !== OPENROUTER_PROVIDER_ID
  );
  const warnings = [
    ...(selected && !modelCatalogBound ? ['openrouter_model_catalog_not_bound'] : []),
    ...ownership.warnings,
    ...(selected && threadVisibility.hidden_if_switched > 0
      ? ['desktop_other_provider_threads_hidden_until_restore']
      : []),
    ...(previousRoutingRestoreAvailable ? ['desktop_routing_snapshot_restore_available'] : [])
  ];
  return {
    schema: 'sks.codex-app-openrouter-status.v1',
    ok: blockers.length === 0,
    key_present: Boolean(key.key),
    key_source: key.source || null,
    provider_present: providerPresent,
    provider_env_key_present: providerEnvKeyPresent,
    provider_auth_present: providerAuthPresent,
    provider_auth_conflict: providerAuthConflict,
    provider_auth_valid: providerAuthValid,
    selected,
    model,
    model_source: model ? 'config' : null,
    model_catalog_path: managedCatalogPath,
    model_catalog_bound: modelCatalogBound,
    config_path: configPath,
    routing_ownership: ownership,
    desktop_picker: desktopPickerStatusFromCache({
      catalogOk: modelCatalogBound,
      cache: null,
      restartAppRequested: false
    }),
    thread_visibility: threadVisibility,
    previous_routing_restore_available: previousRoutingRestoreAvailable,
    blockers,
    warnings
  };
}

export async function useOpenRouter(input: {
  readonly root: string;
  readonly model?: string | null;
  readonly restartApp?: boolean;
  readonly preserveThreadSidebar?: boolean;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly restartImpl?: (input: { enabled: boolean }) => Promise<CodexAppRestartResult>;
}): Promise<Record<string, unknown>> {
  const model = normalizeOpenRouterModelId(input.model);
  if (!model) {
    return {
      schema: 'sks.codex-app-use-openrouter.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'blocked',
      mode: 'openrouter',
      blockers: ['openrouter_model_invalid'],
      warnings: [],
      hint: 'Choose a catalog model or pass --model <openrouter-model-id>.'
    };
  }

  const home = input.home || process.env.HOME || os.homedir();
  const configPath = input.configPath || codexLbConfigPath(home);
  const env = { ...(input.env || process.env), HOME: home };
  await ensureDir(path.dirname(configPath));

  const key = await resolveOpenRouterApiKey({ env });
  if (!key.key) {
    return {
      schema: 'sks.codex-app-use-openrouter.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'blocked',
      mode: 'openrouter',
      model,
      blockers: ['openrouter_key_missing'],
      warnings: [],
      hint: 'Save a key first: sks codex-app set-openrouter-key --api-key-stdin'
    };
  }

  const profile = await installCodexAppGlmProfile({
    root: input.root,
    apply: true,
    home,
    env,
    configPath
  });
  const activationProfile = {
    ...profile,
    profile: {
      ...profile.profile,
      model
    }
  };
  if (!profile.ok) {
    return {
      schema: 'sks.codex-app-use-openrouter.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'blocked',
      mode: 'openrouter',
      model,
      profile: activationProfile,
      blockers: profile.blockers,
      warnings: profile.warnings || []
    };
  }

  const configExistedBefore = await exists(configPath);
  const currentBeforeSwitch = await readText(configPath, '');
  const previousProvider = readTopLevelTomlString(currentBeforeSwitch, 'model_provider');
  const threadVisibility = assessThreadVisibilityImpact({
    home,
    env,
    currentProvider: previousProvider,
    targetProvider: OPENROUTER_PROVIDER_ID
  });
  const preserveThreadSidebar = input.preserveThreadSidebar !== false;
  // Snapshot prior routing before any mutation. Sidebar remap runs only after
  // the OpenRouter config write succeeds so a failed activate cannot retag chats.
  // Re-activating while OpenRouter is already selected captures a
  // self-referential snapshot; writing it would clobber the only record of the
  // pre-OpenRouter routing and turn restore-desktop-routing into a no-op, so
  // preserve the existing cross-provider snapshot instead.
  const routingSnapshot = captureDesktopRoutingSnapshot(currentBeforeSwitch, {
    reason: 'use-openrouter'
  });
  let snapshotWrite: { ok: boolean; path: string; error?: string; skipped?: string };
  if (routingSnapshot.model_provider === OPENROUTER_PROVIDER_ID) {
    const existingSnapshot = await readDesktopRoutingSnapshot({ home, env });
    const crossProviderSnapshotPreserved = Boolean(
      existingSnapshot && existingSnapshot.model_provider !== OPENROUTER_PROVIDER_ID
    );
    snapshotWrite = {
      ok: crossProviderSnapshotPreserved,
      path: desktopRoutingSnapshotPath({ home, env }),
      skipped: crossProviderSnapshotPreserved
        ? 'preserved_existing_cross_provider_snapshot'
        : 'self_referential_snapshot_not_written'
    };
  } else {
    snapshotWrite = await writeDesktopRoutingSnapshot(routingSnapshot, { home, env });
  }

  // Prefer OpenRouter as the default provider; drop a selected codex-lb pin when safe.
  const unselect = await unselectCodexLbProvider({
    home,
    configPath,
    processEnv: env
  }).catch((err: any) => ({ ok: false, status: 'failed', provider_error: err?.message || String(err) }));
  if ((unselect as any)?.ok !== true) {
    const sharedAuthActive = (unselect as any)?.reason === 'shared_codex_lb_auth_active';
    return {
      schema: 'sks.codex-app-use-openrouter.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'blocked',
      mode: 'openrouter',
      model,
      profile: activationProfile,
      unselect,
      routing_snapshot: routingSnapshot,
      routing_snapshot_write: snapshotWrite,
      thread_visibility: threadVisibility,
      blockers: [
        sharedAuthActive
          ? 'legacy_codex_lb_desktop_config_requires_migration'
          : String((unselect as any)?.status || 'codex_lb_unselect_failed')
      ],
      warnings: [],
      ...(sharedAuthActive
        ? { guidance: ['Run: sks codex-lb migrate-legacy-desktop --restart-app'] }
        : {})
    };
  }

  // The Desktop app gates per-model feature UI (reasoning picker, list
  // visibility, multi-agent v2 eligibility) on ModelInfo catalog rows, and
  // global feature UI on the [features] table. Without both, third-party
  // provider models fall back to feature-off metadata.
  const modelCatalog = await writeOpenRouterManagedCatalog({ model, home, env });

  const current = await readText(configPath, '');
  const catalogBind = openRouterCatalogBindDecision(current, { home, env, configPath });
  let next = upsertTopLevelTomlString(current, 'model_provider', OPENROUTER_PROVIDER_ID);
  next = upsertTopLevelTomlString(next, 'model', model);
  if (modelCatalog.ok && catalogBind.bindable) {
    next = upsertTopLevelTomlString(next, 'model_catalog_json', modelCatalog.path);
  }
  next = normalizeCodexFastModeUiConfig(next);
  next = ensureTrailingNewline(next);
  const write = await safeWriteCodexConfigToml(configPath, current, next, 'openrouter-use', {
    verifyUnchangedBeforeWrite: true,
    expectedBeforeExists: configExistedBefore
  });
  if (!write.ok) {
    return {
      schema: 'sks.codex-app-use-openrouter.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'blocked',
      mode: 'openrouter',
      model,
      write,
      unselect,
      routing_snapshot: routingSnapshot,
      routing_snapshot_write: snapshotWrite,
      thread_visibility: threadVisibility,
      thread_sidebar_remap: null,
      blockers: [String(write.status || 'openrouter_config_write_blocked')],
      warnings: []
    };
  }

  let threadSidebarRemap: ReturnType<typeof remapThreadCatalogProvider> | null = null;
  let threadSidebarMeta: {
    readonly remapped: boolean
    readonly from_provider: string
    readonly to_provider: string
    readonly thread_ids: readonly string[]
    readonly catalog_db: string
  } | undefined;
  if (
    preserveThreadSidebar
    && previousProvider
    && previousProvider !== OPENROUTER_PROVIDER_ID
  ) {
    threadSidebarRemap = remapThreadCatalogProvider({
      home,
      env,
      fromProvider: previousProvider,
      toProvider: OPENROUTER_PROVIDER_ID
    });
    if (threadSidebarRemap.ok && threadSidebarRemap.remapped > 0) {
      threadSidebarMeta = {
        remapped: true,
        from_provider: previousProvider,
        to_provider: OPENROUTER_PROVIDER_ID,
        thread_ids: threadSidebarRemap.thread_ids,
        catalog_db: threadSidebarRemap.catalog_db
      };
      await writeDesktopRoutingSnapshot(
        captureDesktopRoutingSnapshot(currentBeforeSwitch, {
          reason: 'use-openrouter',
          threadSidebar: threadSidebarMeta
        }),
        { home, env }
      );
    }
  }

  const restart = await (input.restartImpl || restartCodexApp)({ enabled: Boolean(input.restartApp) });
  const cache = (modelCatalog as any)?.models_cache as InvalidateCodexModelsCacheResult | undefined
    || await invalidateCodexModelsCache({
      home,
      env,
      catalogPath: modelCatalog.ok ? modelCatalog.path : null,
      seedMode: 'merge'
    });
  const status = await openRouterStatus({ home, configPath, env });
  const modelCatalogApplied = Boolean(
    modelCatalog.ok
    && (!catalogBind.bindable || status.model_catalog_bound)
  );
  const configApplied = Boolean(
    status.selected
    && status.key_present
    && status.provider_present
    && status.provider_auth_valid
    && status.model === model
    && modelCatalogApplied
  );
  const desktopPicker = desktopPickerStatusFromCache({
    catalogOk: modelCatalogApplied,
    cache,
    restartAppRequested: Boolean(input.restartApp)
  });
  return {
    schema: 'sks.codex-app-use-openrouter.v1',
    generated_at: nowIso(),
    ok: configApplied,
    status: configApplied ? (restart.ok ? 'active' : 'active_restart_blocked') : 'activation_incomplete',
    mode: 'openrouter',
    model,
    profile: activationProfile,
    unselect,
    write,
    restart_app: restart,
    config_applied: configApplied,
    restart_ok: restart.ok,
    openrouter: {
      ...status,
      desktop_picker: desktopPicker
    },
    model_catalog: modelCatalog,
    model_catalog_bind: catalogBind,
    models_cache: cache,
    desktop_picker: desktopPicker,
    routing_ownership: status.routing_ownership,
    routing_snapshot: routingSnapshot,
    routing_snapshot_write: snapshotWrite,
    previous_routing_restore_available: Boolean(snapshotWrite.ok),
    thread_visibility: threadVisibility,
    thread_sidebar_remap: threadSidebarRemap,
    readiness: {
      selected: status.selected,
      key_present: status.key_present,
      provider_present: status.provider_present,
      provider_auth_present: status.provider_auth_present,
      provider_auth_valid: status.provider_auth_valid,
      model: status.model,
      model_catalog_ok: modelCatalog.ok,
      model_catalog_bound: status.model_catalog_bound,
      features_normalized: true,
      config_applied: configApplied,
      restart_ok: restart.ok,
      models_cache_invalidated: desktopPicker.models_cache_invalidated,
      ok: configApplied
    },
    blockers: [
      ...(status.selected ? [] : ['openrouter_not_selected']),
      ...(status.model === model ? [] : ['openrouter_model_not_applied']),
      ...(status.provider_auth_valid ? [] : ['openrouter_provider_auth_not_applied']),
      ...(modelCatalogApplied
        ? []
        : (modelCatalog.blockers.length ? modelCatalog.blockers : ['openrouter_model_catalog_not_applied']))
    ],
    warnings: [
      ...(unselect?.ok === false ? [`codex_lb_unselect:${unselect.provider_error || unselect.status}`] : []),
      ...(restart.ok ? [] : (restart.blockers || ['openrouter_restart_blocked']).map((blocker) => `restart:${blocker}`)),
      ...(profile.warnings || []),
      ...(catalogBind.bindable ? [] : ['openrouter_model_catalog_user_catalog_preserved']),
      ...modelCatalog.warnings,
      ...cache.warnings,
      ...(desktopPicker.models_cache_invalidated ? [] : ['openrouter_models_cache_not_invalidated']),
      ...(threadSidebarRemap && !threadSidebarRemap.ok
        ? [`thread_sidebar_remap_failed:${threadSidebarRemap.error || 'unknown'}`]
        : []),
      ...(threadVisibility.hidden_if_switched > 0 && !(threadSidebarMeta?.remapped)
        ? [`desktop_hides_${threadVisibility.hidden_if_switched}_other_provider_threads`]
        : []),
      ...(snapshotWrite.ok
        ? []
        : [snapshotWrite.skipped
          ? `routing_snapshot_not_written:${snapshotWrite.skipped}`
          : `routing_snapshot_write_failed:${snapshotWrite.error || 'unknown'}`]),
      'desktop_picker_restart_recommended_after_catalog_change',
      'restore_previous_provider_via_sks_codex_app_restore_desktop_routing'
    ],
    hint: snapshotWrite.ok
      ? 'Other-provider Desktop chats stay visible when sidebar remap succeeds; otherwise restore with: sks codex-app restore-desktop-routing --restart-app'
      : 'If Desktop chats disappeared, run: sks codex-app restore-desktop-routing --restart-app'
  };
}

export { restoreDesktopRoutingSnapshot };

export async function ensureOpenRouterProviderInstalled(opts: any = {}) {
  return ensureGlobalCodexAppGlmProfile(opts);
}

function tomlTableBody(text: string, table: string): string {
  const header = `[${table}]`;
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return '';
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[[^\]]+\]\s*$/.test(line || '')) break;
    body.push(line || '');
  }
  return body.join('\n');
}

function hasTomlString(text: string, key: string, value: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*(?:#.*)?$`, 'm').test(text);
}

function hasTomlKey(text: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'm').test(text);
}

function hasTomlStringArray(text: string, key: string, values: readonly string[]): boolean {
  const expected = values.map((value) => JSON.stringify(value)).join(', ');
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[${escapeRegExp(expected)}\\]\\s*(?:#.*)?$`, 'm').test(text);
}

function hasTomlInteger(text: string, key: string, value: number): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*${value}\\s*(?:#.*)?$`, 'm').test(text);
}
