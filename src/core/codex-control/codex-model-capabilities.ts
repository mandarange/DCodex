import path from 'node:path'
import { writeJsonAtomic } from '../fsx.js'
import {
  collectCodexModelMetadata,
  normalizeAdvertisedEfforts,
  type CodexModelMetadata
} from './codex-model-metadata.js'

export interface CodexModelEffortCapability {
  model: string
  advertised_efforts: string[]
  default_effort: string
  order_source: 'model-advertised' | 'sks-fallback'
  metadata_source?: CodexModelMetadata['source'] | null
  metadata_blockers?: string[]
}

export const SKS_FALLBACK_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh']

export function codexModelEffortCapability(input: { model?: string | null; advertisedEfforts?: string[] | null; defaultEffort?: string | null; metadata?: CodexModelMetadata | null } = {}): CodexModelEffortCapability {
  const advertised = normalizeAdvertisedEfforts(input.metadata?.advertised_efforts || input.advertisedEfforts)
  const order = advertised.length ? advertised : SKS_FALLBACK_EFFORT_ORDER
  const requestedDefault = input.metadata?.default_effort || input.defaultEffort
  const defaultEffort = effortSupportedByOrder(String(requestedDefault || ''), order)
    || (order.includes('medium') ? 'medium' : order[0] || 'medium')
  return {
    model: String(input.metadata?.model || input.model || process.env.SKS_CODEX_MODEL || process.env.CODEX_MODEL || ''),
    advertised_efforts: advertised,
    default_effort: defaultEffort,
    order_source: advertised.length ? 'model-advertised' : 'sks-fallback',
    metadata_source: input.metadata?.source || null,
    metadata_blockers: input.metadata?.blockers || []
  }
}

export async function resolveCodexModelEffortCapability(input: { model?: string | null } = {}): Promise<CodexModelEffortCapability> {
  const metadata = await collectCodexModelMetadata({ model: input.model || null })
  return codexModelEffortCapability({ metadata })
}

export async function writeCodexModelEffortCapabilityArtifact(root: string, input: { missionId: string; model?: string | null }): Promise<{ capability: CodexModelEffortCapability; artifact: string }> {
  const capability = await resolveCodexModelEffortCapability({ model: input.model || null })
  const artifact = path.join(root, '.sneakoscope', 'missions', input.missionId, 'codex-model-effort-capability.json')
  await writeJsonAtomic(artifact, {
    schema: 'sks.codex-model-effort-capability-artifact.v1',
    generated_at: new Date().toISOString(),
    ...capability
  })
  return { capability, artifact }
}

export function nextAdvertisedEffort(current: string, capability: CodexModelEffortCapability = codexModelEffortCapability()) {
  const order = capability.advertised_efforts.length ? capability.advertised_efforts : SKS_FALLBACK_EFFORT_ORDER
  const supportedCurrent = effortSupportedByOrder(current, order)
  if (!supportedCurrent) return capability.default_effort
  if (supportedCurrent !== current) return supportedCurrent
  const index = order.indexOf(supportedCurrent)
  return order[Math.min(order.length - 1, index + 1)] || current || capability.default_effort
}

export function modelEffortAtLeast(target: string, capability: CodexModelEffortCapability = codexModelEffortCapability()) {
  const order = capability.advertised_efforts.length ? capability.advertised_efforts : SKS_FALLBACK_EFFORT_ORDER
  const supportedTarget = effortSupportedByOrder(target, order)
  if (supportedTarget) return supportedTarget
  if (target === 'recovery') return order.includes('high') ? 'high' : order[order.length - 1]
  if (target === 'forensic_vision') return order.includes('xhigh') ? 'xhigh' : order[order.length - 1]
  return capability.default_effort
}

function effortSupportedByOrder(effort: string, order: string[]): string | null {
  if (order.includes(effort)) return effort
  return (effort === 'none' || effort === 'minimal') && order.includes('low') ? 'low' : null
}
