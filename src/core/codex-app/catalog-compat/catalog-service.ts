import fsp from 'node:fs/promises';
import path from 'node:path';
import { stableArchitectureHash, type CatalogSnapshot, type CredentialReadiness, type FeatureCompatibility, type ProviderMode, type SessionPin } from '../../architecture-hardening/contracts/contracts.js';
import { writeJsonAtomic } from '../../fsx.js';

export type CatalogRefreshTrigger = 'startup' | 'settings-applied' | 'manual' | 'background';

export interface CatalogCompatibilityState {
  readonly schema: 'sks.catalog-compatibility-state.v1';
  readonly last_good: CatalogSnapshot | null;
  readonly changed: boolean;
  readonly last_checked_at: string;
  readonly failure_reason: string | null;
  readonly cache_invalidation_required: boolean;
  readonly restart_required: boolean;
  readonly trigger: CatalogRefreshTrigger;
}

export interface NativeCatalogPort {
  readNativeCatalog(): Promise<readonly string[]>;
  validateModels(mode: ProviderMode, models: readonly string[]): Promise<readonly string[]>;
}

export class CatalogCompatibilityService {
  readonly statePath: string;

  constructor(statePath: string) {
    this.statePath = path.resolve(statePath);
  }

  async refresh(input: {
    trigger: CatalogRefreshTrigger;
    mode: ProviderMode;
    credential: CredentialReadiness;
    port: NativeCatalogPort;
    pinnedSessions?: readonly SessionPin[];
    now?: Date;
  }): Promise<CatalogCompatibilityState> {
    const previous = await this.read();
    const checkedAt = (input.now || new Date()).toISOString();
    try {
      if (input.credential.status !== 'ready') throw new Error(`catalog_credential_${input.credential.status}`);
      const nativeModels = [...new Set(await input.port.readNativeCatalog())].filter(Boolean).sort();
      const modeCandidates = nativeModels.filter((model) => (input.mode === 'openrouter') === model.includes('/'));
      const candidateSet = new Set(modeCandidates);
      const validated = [...new Set(await input.port.validateModels(input.mode, modeCandidates))];
      if (validated.some((model) => !candidateSet.has(model))) throw new Error('catalog_validation_returned_unknown_model');
      const filtered = validated.sort();
      const snapshot: CatalogSnapshot = {
        schema: 'sks.catalog-snapshot.v1',
        version: stableArchitectureHash({ mode: input.mode, models: filtered }),
        models: filtered,
        checked_at: checkedAt
      };
      const changed = previous.last_good?.version !== snapshot.version;
      const state: CatalogCompatibilityState = {
        schema: 'sks.catalog-compatibility-state.v1', last_good: snapshot, changed,
        last_checked_at: checkedAt, failure_reason: null,
        cache_invalidation_required: changed, restart_required: changed && (input.pinnedSessions?.length || 0) > 0,
        trigger: input.trigger
      };
      await this.write(state);
      return state;
    } catch (error) {
      const state: CatalogCompatibilityState = {
        schema: 'sks.catalog-compatibility-state.v1', last_good: previous.last_good, changed: false,
        last_checked_at: checkedAt, failure_reason: safeReason(error), cache_invalidation_required: false,
        restart_required: false, trigger: input.trigger
      };
      await this.write(state);
      return state;
    }
  }

  async read(): Promise<CatalogCompatibilityState> {
    try {
      const value = JSON.parse(await fsp.readFile(this.statePath, 'utf8')) as CatalogCompatibilityState;
      if (value.schema !== 'sks.catalog-compatibility-state.v1') throw new Error('catalog_state_invalid');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as Error).message !== 'catalog_state_invalid') throw error;
      return {
        schema: 'sks.catalog-compatibility-state.v1', last_good: null, changed: false,
        last_checked_at: new Date(0).toISOString(), failure_reason: null,
        cache_invalidation_required: false, restart_required: false, trigger: 'startup'
      };
    }
  }

  private async write(state: CatalogCompatibilityState): Promise<void> {
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.statePath, state, { mode: 0o600 });
  }
}

export function computeFeatureCompatibility(input: {
  feature: string;
  directProxySupported: boolean;
  protocolVerified: boolean;
  oauthConnected: boolean;
  oauthAllowed: boolean;
}): FeatureCompatibility {
  if (input.directProxySupported) return feature(input.feature, 'direct-proxy', false, null);
  if (!input.protocolVerified) return feature(input.feature, 'unavailable', false, 'feature_protocol_unverified');
  if (!input.oauthAllowed) return feature(input.feature, 'unavailable', true, 'feature_oauth_permission_required');
  if (!input.oauthConnected) return feature(input.feature, 'unavailable', true, 'feature_oauth_connection_required');
  return feature(input.feature, 'oauth-auxiliary', true, null);
}

export function scheduleCatalogBackgroundRefresh(
  refresh: () => Promise<void>,
  intervalMs: number,
  schedule: typeof setInterval = setInterval,
  onFailure?: (reason: string) => void
): { stop(): void; lastFailure(): string | null } {
  if (intervalMs < 60_000) throw new Error('catalog_background_interval_too_short');
  let failure: string | null = null;
  const timer = schedule(() => {
    void refresh().catch((error: unknown) => {
      failure = safeReason(error);
      onFailure?.(failure);
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    lastFailure: () => failure
  };
}

function feature(name: string, route: FeatureCompatibility['route'], oauth: boolean, reason: string | null): FeatureCompatibility {
  return { schema: 'sks.feature-compatibility.v1', feature: name, route, oauth_required: oauth, reason_code: reason };
}

function safeReason(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{2,99}$/.test(value) ? value : 'catalog_refresh_failed';
}
