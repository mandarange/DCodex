import { affectedGlobsFor } from './gate-affected-globs.js'

export const GATE_MANIFEST_SCHEMA = 'sks.release-gate-manifest.v1'

export type GateTier = 'P0' | 'P1' | 'P2'
export type GateCost = 'hermetic' | 'real' | 'heavy'

export interface GateManifestEntry {
  id: string
  tier: GateTier
  cost: GateCost
  affected_by: string[]
  always_on_release: boolean
  required_for_publish: boolean
  can_run_incremental: boolean
  safe_subgate?: string | undefined
}

export const FORBIDDEN_RECURSIVE_GATES = new Set<string>([
  'release:check',
  'release:check:parallel',
  'release:check:dynamic',
  'release:check:dynamic:execute',
  'release:real-check',
  'release:publish',
  'publish:npm',
  'prepublishOnly'
])

// Gates that always run on a release check regardless of which files changed.
export const ALWAYS_ON_GATES = new Set<string>([
  'release:metadata-current',
  'release:version-truth',
  'install-surface:ssot',
  'architecture:guard',
  'safety:mutation-callsite-coverage',
  'side-effect:runtime-report',
  'publish:packlist-performance',
  'publish:runtime-script-closure',
  'migration:upgrade-safety',
  'release:proof-truth',
  'release:latency-slo',
  'release:dynamic-performance',
  'release:provenance',
  'changelog:check'
])

// Gates that must never be skipped when planning for publish.
export const REQUIRED_FOR_PUBLISH = new Set<string>([
  'release:metadata-current',
  'release:version-truth',
  'install-surface:ssot',
  'architecture:guard',
  'safety:mutation-callsite-coverage',
  'side-effect:runtime-report',
  'release:proof-truth',
  'release:latency-slo',
  'release:provenance',
  'codex:current:dependency-graph',
  'codex:current:binary-identity',
  'codex:current:policy',
  'codex:current:app-server-v2',
  'codex:current:thread-store',
  'codex:current:capability',
  'publish:packlist-performance',
  'publish:runtime-script-closure',
  'migration:upgrade-safety',
  'package:published-contract',
  'runtime:installed-smoke',
  'schema:check',
  'secret:preservation',
  'typecheck'
])

const P0_PREFIXES = ['architecture:', 'safety:', 'side-effect:', 'runtime:', 'release:', 'migration:', 'publish:', 'package:']

function tierFor(id: string): GateTier {
  if (P0_PREFIXES.some((p) => id.startsWith(p))) return 'P0'
  return 'P1'
}

function costFor(id: string): GateCost {
  if (id.includes(':require-real') || id.includes(':actual') || id.startsWith('agent:real-codex') || id.includes('real-session')) {
    return 'real'
  }
  return 'hermetic'
}

export { affectedGlobsFor } from './gate-affected-globs.js'

export function buildGateEntry(id: string): GateManifestEntry {
  return {
    id,
    tier: tierFor(id),
    cost: costFor(id),
    affected_by: affectedGlobsFor(id),
    always_on_release: ALWAYS_ON_GATES.has(id),
    required_for_publish: REQUIRED_FOR_PUBLISH.has(id),
    can_run_incremental: costFor(id) === 'hermetic'
  }
}

export function buildGateManifest(gateIds: string[]): { schema: string; gates: GateManifestEntry[] } {
  const seen = new Set<string>()
  const gates: GateManifestEntry[] = []
  for (const id of gateIds) {
    if (seen.has(id)) continue
    seen.add(id)
    gates.push(buildGateEntry(id))
  }
  gates.sort((a, b) => a.id.localeCompare(b.id))
  return { schema: GATE_MANIFEST_SCHEMA, gates }
}

/** Parity between the manifest and the actual release-gate set. */
export function validateManifestParity(manifestGateIds: string[], releaseGateIds: string[]): { ok: boolean; missing_from_manifest: string[]; missing_from_release: string[] } {
  const manifest = new Set(manifestGateIds)
  const release = new Set(releaseGateIds)
  const missingFromManifest = [...release].filter((id) => !manifest.has(id))
  const missingFromRelease = [...manifest].filter((id) => !release.has(id))
  return { ok: missingFromManifest.length === 0 && missingFromRelease.length === 0, missing_from_manifest: missingFromManifest, missing_from_release: missingFromRelease }
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLE_STAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLE_STAR__/g, '.*') +
      '$'
  )
}

export function gateMatchesChange(entry: GateManifestEntry, changedFiles: string[]): boolean {
  if (entry.always_on_release) return true
  const regexes = entry.affected_by.map(globToRegExp)
  return changedFiles.some((file) => regexes.some((re) => re.test(file)))
}

/** Select which gates to run given changed files. Always-on gates are always selected. */
export function selectGates(gates: GateManifestEntry[], changedFiles: string[], opts: { publish?: boolean } = {}): { selected: GateManifestEntry[]; skipped: Array<{ id: string; reason: string }> } {
  const selected: GateManifestEntry[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const entry of gates) {
    if (opts.publish && entry.required_for_publish) {
      selected.push(entry)
      continue
    }
    if (gateMatchesChange(entry, changedFiles)) selected.push(entry)
    else skipped.push({ id: entry.id, reason: entry.always_on_release ? 'always_on' : 'no_affected_files_changed' })
  }
  return { selected, skipped }
}
