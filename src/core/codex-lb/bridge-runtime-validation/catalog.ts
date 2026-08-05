import type { BridgeProviderId } from '../bridge-contracts.js';
import {
  CATALOG_STATES,
  PROVIDERS,
  enumValue,
  exact,
  integer,
  literal,
  nullableInteger,
  nullableIso,
  nullableString,
  object,
  stringArray
} from './shared.js';

export function validateCombinedCatalog(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'state', 'generation', 'digest', 'model_count', 'route_count',
    'conflict_count', 'checked_at', 'providers', 'blockers', 'warnings',
    'recovery_action'
  ], issues);
  literal(row.schema, 'sks.combined-catalog-sync.v1', `${path}.schema`, issues);
  enumValue(row.state, CATALOG_STATES, `${path}.state`, issues);
  nullableString(row.generation, `${path}.generation`, issues);
  nullableString(row.digest, `${path}.digest`, issues);
  nullableInteger(row.model_count, `${path}.model_count`, issues);
  nullableInteger(row.route_count, `${path}.route_count`, issues);
  integer(row.conflict_count, `${path}.conflict_count`, issues, 0);
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  const providers = object(row.providers, `${path}.providers`, issues);
  if (providers) {
    exact(providers, `${path}.providers`, [...PROVIDERS], issues);
    validateCatalogState(providers['codex-lb'], 'codex-lb', `${path}.providers.codex-lb`, issues);
    validateCatalogState(providers.openrouter, 'openrouter', `${path}.providers.openrouter`, issues);
  }
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  nullableString(row.recovery_action, `${path}.recovery_action`, issues);
}

export function validateCatalogState(
  value: unknown,
  provider: BridgeProviderId,
  path: string,
  issues: string[]
): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'provider_id', 'state', 'source', 'generation', 'digest',
    'model_count', 'checked_at', 'expires_at', 'blockers', 'warnings',
    'recovery_action'
  ], issues);
  literal(row.schema, 'sks.catalog-sync-state.v2', `${path}.schema`, issues);
  literal(row.provider_id, provider, `${path}.provider_id`, issues);
  enumValue(row.state, CATALOG_STATES, `${path}.state`, issues);
  if (row.source !== null) {
    literal(row.source, provider === 'codex-lb' ? 'gateway' : 'openrouter', `${path}.source`, issues);
  }
  nullableString(row.generation, `${path}.generation`, issues);
  nullableString(row.digest, `${path}.digest`, issues);
  nullableInteger(row.model_count, `${path}.model_count`, issues);
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  nullableIso(row.expires_at, `${path}.expires_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  nullableString(row.recovery_action, `${path}.recovery_action`, issues);
}
