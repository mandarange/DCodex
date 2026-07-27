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
  'release:metadata',
  'release:readiness',
  'release:gate-existence-audit',
  'architecture:guard',
  'runtime:dist-parity',
  'runtime:ts-source-of-truth',
  'runtime:no-src-mjs',
  'runtime:terminal-current',
  'runtime:ts-rust-boundary',
  'safety:side-effect-zero',
  'safety:mutation-callsite-coverage',
  'side-effect:runtime-report',
  'core-skill:no-inference-optimizer',
  'core-skill:heldout-validation',
  'core-skill:deployment-snapshot',
  'core-skill:legacy-promotion-api-audit',
  'postinstall:safe-side-effects',
  'publish:packlist-performance',
  'publish:runtime-script-closure',
  'legacy:gate-inventory',
  'legacy:gate-purge',
  'legacy:strong-inventory',
  'migration:upgrade-safety',
  'release:proof-truth',
  'release:latency-slo',
  'release:dynamic-performance',
  'release:provenance',
  'changelog:check'
])

// Gates that must never be skipped when planning for publish.
export const REQUIRED_FOR_PUBLISH = new Set<string>([
  'release:metadata',
  'architecture:guard',
  'runtime:dist-parity',
  'runtime:ts-rust-boundary',
  'safety:side-effect-zero',
  'safety:mutation-callsite-coverage',
  'side-effect:runtime-report',
  'release:proof-truth',
  'release:latency-slo',
  'release:provenance',
  'codex:0144:manifest',
  'codex:0144:binary-identity',
  'codex:0144:policy',
  'codex:0144:app-server-v2',
  'codex:0144:thread-store',
  'codex:0144:capability',
  'publish:packlist-performance',
  'publish:runtime-script-closure',
  'postinstall:safe-side-effects',
  'legacy:gate-inventory',
  'legacy:gate-purge',
  'legacy:strong-inventory',
  'migration:upgrade-safety',
  'core-skill:card-schema',
  'core-skill:patch',
  'core-skill:heldout-validation',
  'core-skill:deployment-snapshot',
  'core-skill:no-inference-optimizer',
  'core-skill:rollout-scoring',
  'zellij:launch-command-truth',
  'zellij:ui-design'
])

const P0_PREFIXES = ['architecture:', 'core-skill:', 'safety:', 'side-effect:', 'runtime:', 'release:', 'legacy:', 'migration:', 'publish:', 'postinstall:', 'zellij:']

function tierFor(id: string): GateTier {
  if (P0_PREFIXES.some((p) => id.startsWith(p))) return 'P0'
  return 'P1'
}

function costFor(id: string): GateCost {
  if (id.includes(':require-real') || id.includes(':actual') || id.startsWith('agent:real-codex') || id.includes('real-session') || id === 'zellij:pane-proof' || id === 'zellij:screen-proof') {
    return 'real'
  }
  return 'hermetic'
}

/** Heuristic mapping from a gate id to the source globs that affect it. */
export function affectedGlobsFor(id: string): string[] {
  const prefix = id.split(':')[0]
  switch (prefix) {
    case 'architecture':
      return ['src/core/safety/ssot-guard.ts', 'src/core/pipeline-internals/runtime-core.ts', 'src/core/pipeline-internals/runtime-gates.ts', 'src/core/commands/naruto-command.ts', 'src/scripts/release-parallel-check.ts', 'src/scripts/architecture-guard-check.ts', 'docs/architecture-ts-rust-boundary.md', 'package.json']
    case 'core-skill':
      return ['src/core/skills/**', 'schemas/skills/**', 'src/scripts/core-skill-*.ts']
    case 'zellij':
      return ['src/core/zellij/**', 'src/scripts/zellij-*.ts', 'templates/zellij/**', 'src/core/agents/zellij-lane-supervisor.ts']
    case 'safety':
      return ['src/core/safety/**', 'src/scripts/side-effect-zero-gate-check.ts', 'src/scripts/mutation-callsite-coverage-check.ts', 'safety-mutation-allowlist.json']
    case 'side-effect':
      return ['src/core/safety/**', 'src/scripts/side-effect-runtime-report-check.ts', '.sneakoscope/missions/**/mutation-ledger.jsonl', '.sneakoscope/mutation-ledger.jsonl']
    case 'legacy':
    case 'migration':
      return ['src/core/migration/**', 'src/core/codex/**', 'src/core/init.ts', 'src/cli/install-helpers.ts', 'src/scripts/current-upgrade-matrix-check.ts']
    case 'publish':
      return ['package.json', '.npmignore', 'src/scripts/packlist-performance-check.ts', 'src/scripts/npm-publish-performance-check.ts', 'dist/**']
    case 'postinstall':
      return [
        'src/cli/install-helpers.ts',
        'src/cli/install-helpers-codex-lb-selftest.ts',
        'src/cli/install-helpers-install-support.ts',
        'src/core/init.ts',
        'src/core/install/installed-package-smoke.ts',
        'src/core/routes/design-policy.ts',
        'src/scripts/installed-package-smoke-check.ts',
        'src/scripts/postinstall-safe-side-effects-check.ts',
        'test/blackbox/postinstall-safe-side-effects-packed.test.mjs',
        'test/unit/postinstall-command.test.mjs',
        'test/unit/publish-workflow-safety.test.mjs'
      ]
    case 'runtime':
      return ['src/**', 'src/scripts/runtime-*.ts', 'src/scripts/build-dist.ts', 'src/scripts/clean-dist.ts', 'package.json']
    case 'agent':
    case 'research':
    case 'qa':
    case 'naruto':
      return ['src/core/agents/**', 'src/core/commands/**', `src/scripts/${prefix}-*.ts`]
    case 'codex':
    case 'codex-app':
    case 'codex-lb':
      return [
        'src/core/codex/**',
        'src/core/codex-control/**',
        'src/core/codex-compat/**',
        'src/core/codex-runtime/**',
        'src/core/codex-app-server/**',
        'src/core/codex-policy/**',
        'src/commands/codex.ts',
        'src/cli/install-helpers.ts',
        'config/codex-releases/**',
        'schemas/codex-*.json',
        'package.json',
        'package-lock.json',
        'src/core/codex-app.ts',
        'src/core/codex-lb-circuit.ts',
        `src/scripts/${prefix}-*.ts`
      ]
    case 'context-graph':
      // The default `src/scripts/<prefix>-*.ts` glob would only fire when the
      // check script itself moved, so editing the graph engine would skip the
      // gates that prove it. These are the graph's own sources plus the
      // consumers whose behaviour the gates assert, not all of `src/**`.
      return [
        'src/core/triwiki/context-graph/**',
        'src/core/search/context.ts',
        'src/core/search/context-graph-seeds.ts',
        'src/core/subagents/triwiki-attention.ts',
        'src/core/triwiki/code-pack.ts',
        'src/core/naruto/context-graph-advisor.ts',
        'src/core/naruto/context-graph-advisor-scope.ts',
        'src/core/verification/context-graph-affected.ts',
        'src/core/commands/wiki-command.ts',
        'src/core/commands/triwiki-graph-command.ts',
        'config/context-graph-benchmark.json',
        'schemas/triwiki/context-graph.schema.json',
        'src/scripts/context-graph-check.ts',
        'package.json'
      ]
    case 'latest-version':
      // The guidance scan reads every user-facing surface, so its affected set
      // is genuinely wide; narrowing it would let a pinned version slip in
      // through a file the gate still reads.
      return ['README.md', 'docs/**', 'src/**', 'native/**', 'src/scripts/latest-version-guidance-check.ts', 'package.json']
    case 'release':
      return ['src/core/release/**', 'src/scripts/release-parallel-check.ts', 'src/scripts/release-*.ts', 'package.json']
    default:
      return [`src/scripts/${prefix}-*.ts`, `src/scripts/${id.replace(/:/g, '-')}-*.ts`]
  }
}

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
