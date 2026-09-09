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
import { isRecord } from '../json/records.js';
import { ASTRA_SUBAGENT_MODEL, SUBAGENT_MODEL_POLICIES } from './model-policy.js';

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

export const SUPPORTED_ROLE_MODEL_PROFILES = Object.freeze(
  Object.values(SUBAGENT_MODEL_POLICIES).map((profile) => Object.freeze({
    provider: 'openai' as const,
    model: profile.model,
    reasoning_effort: profile.modelReasoningEffort,
    source: 'managed-default' as const
  }))
);

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
      // Persisted model choices cannot override the managed child model policy.
      // Reads migrate effective values only and leave the stored document intact.
      const keepEffort = provider === 'openai' && isSupportedRoleModelProfile(model, reasoning);
      roles[role.codex_name] = {
        provider: 'openai',
        model: ASTRA_SUBAGENT_MODEL,
        reasoning_effort: keepEffort ? reasoning : role.model_reasoning_effort,
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
  const preferenceBlockers = Object.entries(read.store.roles).flatMap(([role, preference]) => (
    isSupportedRoleModelProfile(preference.model, preference.reasoning_effort)
      ? []
      : [`role_model_preference_not_managed:${role}`]
  ));
  const allProfiles = dedupeProfiles([
    ...SUPPORTED_ROLE_MODEL_PROFILES
  ]);
  const supportedProfiles = allProfiles.slice(0, ROLE_MODEL_PROFILE_PRESENTATION_LIMIT);
  const roles = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => {
    const override = read.store.roles[role.codex_name] || null;
    const effectiveProvider = 'openai';
    const effectiveModel = ASTRA_SUBAGENT_MODEL;
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
      effective_source: override ? 'role-override' : 'managed-default'
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
      active_main_model_inherited: false,
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
  if (model !== ASTRA_SUBAGENT_MODEL) return mutationBlocked('role_model_astra_required');

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
  if (requestedProvider && requestedProvider !== 'openai') return mutationBlocked('role_model_provider_mismatch');
  const provider = 'openai';
  if (!isSupportedRoleModelProfile(model, reasoning)) {
    return mutationBlocked('role_model_profile_not_managed');
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
