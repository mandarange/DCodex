import type { CapabilityProbeContextV3 } from '../capability-types.js'
import type { CapabilityProbeResultV3, CatalogSyncState } from '../bridge-contracts.js'
import { capabilityProbeResultV3, uniqueStrings } from './probe-evidence.js'

export interface CatalogProbeInputV3 extends CapabilityProbeContextV3 {
  catalog: CatalogSyncState
}

/** Map a provider-owned catalog lifecycle without treating files as live proof. */
export function runCatalogProbeV3(input: CatalogProbeInputV3): CapabilityProbeResultV3 {
  const state = input.catalog.state === 'verified'
    ? 'verified'
    : input.catalog.state === 'degraded'
      ? 'degraded'
      : input.catalog.state === 'failed'
        ? 'blocked'
        : input.catalog.state === 'stale'
          ? 'stale'
          : input.catalog.state === 'syncing'
            ? 'running'
            : 'not_attempted'
  const rootCause = state === 'blocked'
    ? uniqueStrings(input.catalog.blockers)[0] || 'catalog_sync_failed'
    : null
  return capabilityProbeResultV3({
    ...input,
    capability: 'catalog_sync',
    scope: `provider:${input.catalog.provider_id}`,
    stage: state === 'verified' ? 'complete' : 'catalog_sync',
    state,
    terminal: state === 'blocked',
    rootCause,
    blockers: input.catalog.blockers,
    warnings: input.catalog.warnings,
    retryable: state === 'blocked' || state === 'stale',
    recoveryAction: input.catalog.recovery_action,
    source: 'transport',
    evidence: {
      lifecycle_schema: input.catalog.schema,
      source: input.catalog.source,
      generation: input.catalog.generation,
      digest: input.catalog.digest,
      model_count: input.catalog.model_count,
      expires_at: input.catalog.expires_at
    }
  })
}
