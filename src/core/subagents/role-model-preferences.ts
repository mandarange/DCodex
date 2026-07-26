import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeTextAtomic } from '../fsx.js';
import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  managedOfficialSubagentRoleByName
} from '../managed-assets/managed-assets-manifest.js';
import {
  inferProviderFromModel,
  normalizeCodexModelId,
  normalizeCodexReasoningEffort,
  readConfiguredCodexModelRoutingContext
} from '../codex-app/codex-model-catalog.js';
import { childInheritsActiveMainModel } from '../provider/model-router.js';
import { isRecord } from '../json/records.js';

export const ROLE_MODEL_PREFERENCES_SCHEMA = 'sks.role-model-preferences.v2' as const;
const LEGACY_ROLE_MODEL_PREFERENCES_SCHEMA = 'sks.role-model-preferences.v1';
const ROLE_MODEL_PROFILE_PRESENTATION_LIMIT = 1_000;

export type SupportedRoleModel = string;
export type SupportedRoleReasoningEffort = string;

export interface RoleModelPreference {
  readonly provider: string;
  readonly model: SupportedRoleModel;
  readonly reasoning_effort: SupportedRoleReasoningEffort;
  readonly updated_at: string;
}

export interface RoleModelPreferenceStore {
  readonly schema: typeof ROLE_MODEL_PREFERENCES_SCHEMA;
  readonly version: 2;
  readonly updated_at: string;
  readonly roles: Readonly<Record<string, RoleModelPreference>>;
}

export const SUPPORTED_ROLE_MODEL_PROFILES = Object.freeze([
  Object.freeze({ provider: 'openai', model: 'gpt-5.6-luna', reasoning_effort: 'max', source: 'managed-default' }),
  Object.freeze({ provider: 'openai', model: 'gpt-5.6-terra', reasoning_effort: 'medium', source: 'managed-default' }),
  Object.freeze({ provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'high', source: 'managed-default' }),
  Object.freeze({ provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'max', source: 'managed-default' })
] as const);

export function roleModelPreferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  const sksHome = path.resolve(env.SKS_HOME || path.join(env.HOME || os.homedir(), '.sneakoscope'));
  return path.join(sksHome, 'preferences', 'role-models.json');
}

export async function readRoleModelPreferences(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly filePath?: string;
} = {}): Promise<{ store: RoleModelPreferenceStore; path: string; blockers: string[] }> {
  const filePath = input.filePath || roleModelPreferencesPath(input.env || process.env);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, any>;
    const legacy = parsed.schema === LEGACY_ROLE_MODEL_PREFERENCES_SCHEMA && parsed.version === 1;
    const current = parsed.schema === ROLE_MODEL_PREFERENCES_SCHEMA && parsed.version === 2;
    if ((!legacy && !current) || !isRecord(parsed.roles)) {
      return { store: emptyStore(), path: filePath, blockers: ['role_model_preferences_invalid_schema'] };
    }
    const roles: Record<string, RoleModelPreference> = {};
    const blockers: string[] = [];
    for (const [rawRole, rawPreference] of Object.entries(parsed.roles)) {
      const role = managedOfficialSubagentRoleByName(rawRole);
      if (!role || !isRecord(rawPreference)) {
        blockers.push(`role_model_preference_invalid_role:${rawRole}`);
        continue;
      }
      const model = normalizeCodexModelId(rawPreference.model);
      const reasoning = normalizeCodexReasoningEffort(rawPreference.reasoning_effort);
      const provider = normalizeRoleProvider(rawPreference.provider)
        || (model ? inferProviderFromModel(model) : null);
      if (!model || !reasoning || !provider) {
        blockers.push(`role_model_preference_invalid_profile:${role.codex_name}`);
        continue;
      }
      roles[role.codex_name] = {
        provider,
        model,
        reasoning_effort: reasoning,
        updated_at: String(rawPreference.updated_at || parsed.updated_at || '')
      };
    }
    return {
      store: {
        schema: ROLE_MODEL_PREFERENCES_SCHEMA,
        version: 2,
        updated_at: String(parsed.updated_at || ''),
        roles
      },
      path: filePath,
      blockers
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { store: emptyStore(), path: filePath, blockers: [] };
    return { store: emptyStore(), path: filePath, blockers: ['role_model_preferences_unreadable'] };
  }
}

export async function roleModelPreferencesStatus(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly filePath?: string;
  readonly home?: string;
  readonly configPath?: string;
} = {}) {
  const env = input.env || process.env;
  const read = await readRoleModelPreferences(input);
  const routing = await readConfiguredCodexModelRoutingContext({
    env,
    ...(input.home ? { home: input.home } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {})
  });
  const catalog = routing.catalog;
  const routerSelected = routing.selected_provider === 'sks-router';
  const activeMainModel = routing.selected_provider && routing.selected_model
    ? {
        provider: routing.selected_provider,
        model: routing.selected_model
      }
    : null;
  const preferenceBlockers = Object.entries(read.store.roles).flatMap(([role, preference]) => {
    const routed = preference.provider !== 'openai' || preference.model.includes('/');
    if (!routed) {
      return isSupportedRoleModelProfile(preference.model, preference.reasoning_effort)
        ? []
        : [`role_model_preference_not_managed:${role}`];
    }
    if (!routerSelected) return [`role_model_router_not_selected:${role}`];
    const entry = catalog.models.find((model) => model.model === preference.model);
    if (!catalog.ok || !entry) return [`role_model_preference_not_in_active_catalog:${role}`];
    if (!entry.reasoning_efforts.includes(preference.reasoning_effort)) {
      return [`role_model_preference_reasoning_not_in_active_catalog:${role}`];
    }
    return entry.multi_agent_version === 'v2'
      ? []
      : [`role_model_preference_multi_agent_v2_required:${role}`];
  });
  const catalogProfiles = (routerSelected ? catalog.models : [])
    .filter((entry) => entry.multi_agent_version === 'v2')
    .flatMap((entry) => (
    entry.reasoning_efforts.map((reasoning) => ({
      provider: entry.provider,
      model: entry.model,
      reasoning_effort: reasoning,
      source: 'codex-model-catalog'
    }))
    ));
  const allProfiles = dedupeProfiles([
    ...SUPPORTED_ROLE_MODEL_PROFILES,
    ...catalogProfiles
  ]);
  const supportedProfiles = allProfiles.slice(0, ROLE_MODEL_PROFILE_PRESENTATION_LIMIT);
  const roles = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => {
    const override = read.store.roles[role.codex_name] || null;
    const inheritActiveMain = childInheritsActiveMainModel(activeMainModel?.model);
    const effectiveProvider = override?.provider
      || (inheritActiveMain ? activeMainModel?.provider : null)
      || inferProviderFromModel(role.model);
    const effectiveModel = override?.model
      || (inheritActiveMain ? activeMainModel?.model : null)
      || role.model;
    const effectiveReasoning = override?.reasoning_effort || role.model_reasoning_effort;
    return {
      role: role.codex_name,
      description: role.description,
      default_provider: inferProviderFromModel(role.model),
      default_model: role.model,
      default_reasoning_effort: role.model_reasoning_effort,
      override,
      effective_provider: effectiveProvider,
      effective_model: effectiveModel,
      effective_reasoning_effort: effectiveReasoning,
      effective_source: override
        ? 'role-override'
        : inheritActiveMain
          ? 'selected-main-model'
          : 'managed-default'
    };
  });
  return {
    schema: 'sks.role-model-preferences-status.v2',
    ok: read.blockers.length === 0 && preferenceBlockers.length === 0,
    path: read.path,
    owner_only: true,
    supported_profiles: supportedProfiles,
    supported_profile_count: allProfiles.length,
    supported_profiles_truncated: allProfiles.length > supportedProfiles.length,
    routing: {
      selected_provider: routing.selected_provider,
      selected_model: routing.selected_model,
      active_main_model_inherited: childInheritsActiveMainModel(activeMainModel?.model),
      router_selected: routerSelected,
      runtime_verified: false
    },
    catalog: {
      configured: catalog.configured,
      ok: catalog.ok,
      path: catalog.path,
      model_count: catalog.model_count,
      total_model_count: catalog.total_model_count,
      truncated: catalog.truncated,
      blockers: catalog.blockers
    },
    roles,
    // Store-level blockers mean the preference file itself could not be used, so
    // every save/reset below fails closed; preference blockers are recoverable
    // states a save or reset can clear. Consumers (Center) must keep the
    // controls usable for the second kind and only lock them for the first.
    store_readable: read.blockers.length === 0,
    store_blockers: [...read.blockers],
    preference_blockers: [...preferenceBlockers],
    blockers: [...read.blockers, ...preferenceBlockers],
    warnings: [
      ...catalog.warnings,
      ...(catalog.configured && !catalog.ok
        ? catalog.blockers.map((blocker) => `role_model_catalog:${blocker}`)
        : []),
      ...(catalog.configured && catalog.ok && !routerSelected
        ? ['role_model_router_not_selected']
        : []),
      ...(allProfiles.length > supportedProfiles.length
        ? [`role_model_supported_profiles_truncated:${allProfiles.length}:${supportedProfiles.length}`]
        : [])
    ]
  };
}

export async function setRoleModelPreference(input: {
  readonly role: string;
  readonly provider?: string;
  readonly model: string;
  readonly reasoning: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly filePath?: string;
  readonly home?: string;
  readonly configPath?: string;
  readonly now?: () => string;
}) {
  const role = managedOfficialSubagentRoleByName(String(input.role || '').trim());
  if (!role) return mutationBlocked('role_model_role_invalid');
  const model = normalizeCodexModelId(input.model);
  const reasoning = normalizeCodexReasoningEffort(input.reasoning);
  if (!model || !reasoning) return mutationBlocked('role_model_profile_invalid');

  const env = input.env || process.env;
  const routing = await readConfiguredCodexModelRoutingContext({
    env,
    ...(input.home ? { home: input.home } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {})
  });
  const catalog = routing.catalog;
  const catalogEntry = catalog.models.find((entry) => entry.model === model) || null;
  const requestedProvider = normalizeRoleProvider(input.provider);
  if (input.provider && !requestedProvider) return mutationBlocked('role_model_provider_invalid');
  if (requestedProvider && catalogEntry && requestedProvider !== catalogEntry.provider) {
    return mutationBlocked('role_model_provider_mismatch');
  }
  const provider = requestedProvider || catalogEntry?.provider || inferProviderFromModel(model);
  const routedModel = provider !== 'openai' || model.includes('/');
  const managedProfile = SUPPORTED_ROLE_MODEL_PROFILES.some((profile) => (
    profile.provider === provider
    && profile.model === model
    && profile.reasoning_effort === reasoning
  ));
  if (!routedModel && !managedProfile) {
    return mutationBlocked('role_model_profile_not_managed');
  }
  if (routedModel && routing.selected_provider !== 'sks-router') {
    return mutationBlocked('role_model_router_not_selected');
  }
  if (routedModel && !catalog.ok) {
    return mutationBlocked('role_model_catalog_required_for_routed_model', ...catalog.blockers);
  }
  if (routedModel && !catalogEntry) {
    return mutationBlocked('role_model_not_in_active_catalog');
  }
  if (catalogEntry && !catalogEntry.reasoning_efforts.includes(reasoning)) {
    return mutationBlocked('role_model_reasoning_not_in_catalog');
  }
  if (routedModel && catalogEntry?.multi_agent_version !== 'v2') {
    return mutationBlocked('role_model_multi_agent_v2_required');
  }

  const read = await readRoleModelPreferences(input);
  if (read.blockers.length) return mutationBlocked(...read.blockers);
  const timestamp = (input.now || (() => new Date().toISOString()))();
  const store: RoleModelPreferenceStore = {
    schema: ROLE_MODEL_PREFERENCES_SCHEMA,
    version: 2,
    updated_at: timestamp,
    roles: {
      ...read.store.roles,
      [role.codex_name]: {
        provider,
        model,
        reasoning_effort: reasoning,
        updated_at: timestamp
      }
    }
  };
  await writeOwnerOnlyStore(read.path, store);
  return {
    schema: 'sks.role-model-preference-mutation.v2',
    ok: true,
    status: 'set',
    role: role.codex_name,
    provider,
    model,
    reasoning_effort: reasoning,
    catalog_verified: Boolean(catalogEntry),
    catalog_path: catalog.path,
    selected_model_provider: routing.selected_provider,
    multi_agent_version: catalogEntry?.multi_agent_version || null,
    runtime_verified: false,
    path: read.path,
    blockers: [],
    warnings: catalog.warnings
  };
}

export async function resetRoleModelPreference(input: {
  readonly role: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly filePath?: string;
  readonly now?: () => string;
}) {
  const role = managedOfficialSubagentRoleByName(String(input.role || '').trim());
  if (!role) return mutationBlocked('role_model_role_invalid');
  const read = await readRoleModelPreferences(input);
  if (read.blockers.length) return mutationBlocked(...read.blockers);
  const roles = { ...read.store.roles };
  delete roles[role.codex_name];
  const store: RoleModelPreferenceStore = {
    schema: ROLE_MODEL_PREFERENCES_SCHEMA,
    version: 2,
    updated_at: (input.now || (() => new Date().toISOString()))(),
    roles
  };
  await writeOwnerOnlyStore(read.path, store);
  return {
    schema: 'sks.role-model-preference-mutation.v2',
    ok: true,
    status: 'reset',
    role: role.codex_name,
    path: read.path,
    blockers: [],
    warnings: []
  };
}

export function isSupportedRoleModelProfile(
  model: unknown,
  reasoning: unknown
): boolean {
  const normalizedModel = normalizeCodexModelId(model);
  const normalizedReasoning = normalizeCodexReasoningEffort(reasoning);
  return SUPPORTED_ROLE_MODEL_PROFILES.some((profile) => (
    profile.model === normalizedModel
    && profile.reasoning_effort === normalizedReasoning
  ));
}

async function writeOwnerOnlyStore(filePath: string, store: RoleModelPreferenceStore): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await writeTextAtomic(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function emptyStore(): RoleModelPreferenceStore {
  return { schema: ROLE_MODEL_PREFERENCES_SCHEMA, version: 2, updated_at: '', roles: {} };
}

function mutationBlocked(...blockers: string[]) {
  return {
    schema: 'sks.role-model-preference-mutation.v2',
    ok: false,
    status: 'blocked',
    blockers: [...new Set(blockers.filter(Boolean))],
    warnings: []
  };
}

function normalizeRoleProvider(value: unknown): string | null {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider || provider.length > 80) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(provider) ? provider : null;
}

function dedupeProfiles<T extends {
  readonly provider: string;
  readonly model: string;
  readonly reasoning_effort: string;
}>(profiles: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const profile of profiles) {
    const key = `${profile.model}\u0000${profile.reasoning_effort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(profile);
  }
  return out;
}
