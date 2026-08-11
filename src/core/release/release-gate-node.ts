export const RELEASE_GATE_NODE_SCHEMA = 'sks.release-gates.v2'

export const RELEASE_GATE_RESOURCE_CLASSES = [
  'cpu-light',
  'cpu-heavy',
  'io-light',
  'io-heavy',
  'git',
  'git-worktree',
  'browser-real',
  'secret-sensitive',
  'remote-model-real',
  'python',
  'network',
  'global-config',
  'publish',
  'fs-read',
  'fs-write',
  'timing-sensitive'
] as const

export type ReleaseGateResourceClass = typeof RELEASE_GATE_RESOURCE_CLASSES[number]
export type ReleaseGateSideEffect = 'hermetic' | 'real-env'

export interface ReleaseGateNode {
  id: string
  command: string
  deps: string[]
  resource: ReleaseGateResourceClass[]
  side_effect: ReleaseGateSideEffect
  timeout_ms: number
  output_contract: 'sks.gate-result.v2'
  cache: {
    enabled: boolean
    inputs: string[]
  }
  isolation: {
    home: 'temp' | 'inherit'
    codex_home: 'temp' | 'inherit'
    report_dir: 'per-gate'
  }
  preset: string[]
}

export interface ReleaseGateManifestV2 {
  schema: typeof RELEASE_GATE_NODE_SCHEMA
  gates: ReleaseGateNode[]
}

export function validateReleaseGateManifest(input: any): { ok: boolean; manifest?: ReleaseGateManifestV2; errors: string[] } {
  const errors: string[] = []
  if (input?.schema !== RELEASE_GATE_NODE_SCHEMA) errors.push('schema_mismatch')
  if (!Array.isArray(input?.gates)) errors.push('gates_missing')
  const ids = new Set<string>()
  const resources = new Set<string>(RELEASE_GATE_RESOURCE_CLASSES)
  for (const gate of Array.isArray(input?.gates) ? input.gates : []) {
    if (!gate?.id) errors.push('gate_id_missing')
    if (gate?.id && ids.has(gate.id)) errors.push(`gate_duplicate:${gate.id}`)
    if (gate?.id) ids.add(gate.id)
    if (!gate?.command) errors.push(`gate_command_missing:${gate?.id || 'unknown'}`)
    if (!Array.isArray(gate?.deps)) errors.push(`gate_deps_missing:${gate?.id || 'unknown'}`)
    if (!Array.isArray(gate?.resource) || !gate.resource.length) errors.push(`gate_resource_missing:${gate?.id || 'unknown'}`)
    for (const resource of Array.isArray(gate?.resource) ? gate.resource : []) {
      if (!resources.has(resource)) errors.push(`gate_unknown_resource:${gate?.id || 'unknown'}:${resource}`)
    }
    if (gate?.side_effect !== 'hermetic' && gate?.side_effect !== 'real-env') errors.push(`gate_side_effect_invalid:${gate?.id || 'unknown'}`)
    if (!Number.isFinite(Number(gate?.timeout_ms)) || Number(gate.timeout_ms) <= 0) errors.push(`gate_timeout_missing:${gate?.id || 'unknown'}`)
    if (gate?.output_contract !== 'sks.gate-result.v2') errors.push(`gate_output_contract_invalid:${gate?.id || 'unknown'}`)
    if (!gate?.cache || typeof gate.cache.enabled !== 'boolean' || !Array.isArray(gate.cache.inputs)) errors.push(`gate_cache_missing:${gate?.id || 'unknown'}`)
    if (!gate?.isolation || gate.isolation.report_dir !== 'per-gate') errors.push(`gate_isolation_missing:${gate?.id || 'unknown'}`)
    if (!Array.isArray(gate?.preset)) errors.push(`gate_preset_missing:${gate?.id || 'unknown'}`)
  }
  for (const gate of Array.isArray(input?.gates) ? input.gates : []) {
    for (const dep of Array.isArray(gate?.deps) ? gate.deps : []) {
      if (!ids.has(dep)) errors.push(`gate_unknown_dep:${gate.id}:${dep}`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: input as ReleaseGateManifestV2, errors }
}
