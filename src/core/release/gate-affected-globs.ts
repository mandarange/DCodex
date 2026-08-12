/**
 * Gate id -> the source globs whose change should select that gate.
 *
 * Split out of `gate-manifest.ts` because this table grows every time a gate
 * gains a consumer, and the manifest builder around it does not: keeping them in
 * one file made every glob addition a change to the file that also owns tier,
 * cost and publish policy.
 *
 * The table is a floor, never a filter. `selectGates` may only ever choose *more*
 * gates than the previous revision of this file chose, so an entry is added when
 * a consumer appears and is not removed when one is deleted — a glob that names a
 * file which no longer exists simply matches nothing, whereas a removed glob is a
 * gate that silently stops running for a change it used to cover.
 */

/** Heuristic mapping from a gate id to the source globs that affect it. */
export function affectedGlobsFor(id: string): string[] {
  const prefix = id.split(':')[0]
  switch (prefix) {
    case 'architecture-map':
      return [
        'src/core/triwiki/context-graph/architecture/**',
        'src/core/triwiki/context-graph/projections/mermaid/**',
        'src/core/triwiki/context-graph/store/architecture-map-store.ts',
        'src/scripts/architecture-map-check.ts',
        'config/architecture-map-policy.v1.json',
        'package.json'
      ]
    case 'architecture':
      return ['src/core/safety/ssot-guard.ts', 'src/core/pipeline-internals/runtime-core.ts', 'src/core/pipeline-internals/runtime-gates.ts', 'src/core/commands/naruto-command.ts', 'src/scripts/release-parallel-check.ts', 'src/scripts/architecture-guard-check.ts', 'docs/architecture-ts-rust-boundary.md', 'package.json']
    case 'core-skill':
      return ['src/core/skills/**', 'schemas/skills/**', 'src/scripts/core-skill-*.ts']
    case 'safety':
      return ['src/core/safety/**', 'src/scripts/side-effect-zero-gate-check.ts', 'src/scripts/mutation-callsite-coverage-check.ts', 'safety-mutation-allowlist.json']
    case 'side-effect':
      return ['src/core/safety/**', 'src/scripts/side-effect-runtime-report-check.ts', '.sneakoscope/missions/**/mutation-ledger.jsonl', '.sneakoscope/mutation-ledger.jsonl']
    case 'migration':
      return ['src/core/migration/**', 'src/core/codex/**', 'src/core/init.ts', 'src/cli/install-helpers.ts', 'src/scripts/current-upgrade-matrix-check.ts']
    case 'publish':
      return ['package.json', '.npmignore', 'src/scripts/packlist-performance-check.ts', 'src/scripts/npm-publish-performance-check.ts', 'dist/**']
    case 'postinstall':
      return [
        'src/cli/install-helpers.ts',
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
        'schemas/codex-*.json',
        'package.json',
        'package-lock.json',
        'src/core/codex-app.ts',
        'src/core/codex-lb-circuit.ts',
        `src/scripts/${prefix}-*.ts`
      ]
    // The v2 gates measure the same engine from the other side — bytes, corrupt
    // input, crash recovery — so they share the v1 gates' affected set rather
    // than carrying a narrower copy of it. A separate list would drift, and the
    // drift would show up as a v2 gate that stops running for a change the v1
    // gates still cover.
    case 'context-graph-v2':
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
        'src/core/triwiki/triwiki-cleanup.ts',
        'src/core/naruto/context-graph-advisor.ts',
        'src/core/naruto/context-graph-advisor-scope.ts',
        'src/core/verification/context-graph-affected.ts',
        'src/core/align/code-navigation-align.ts',
        // The publish seam align runs before it builds its pack. Listed
        // explicitly because the entry above is an exact path: extracting the
        // seam into its own file would otherwise have taken it out of the
        // graph's affected set without any gate noticing.
        'src/core/align/align-context-index.ts',
        'src/core/commands/wiki-command.ts',
        'src/core/commands/triwiki-graph-command.ts',
        'config/context-graph-benchmark.json',
        'schemas/triwiki/context-graph.schema.json',
        'src/scripts/context-graph-check.ts',
        'src/scripts/context-graph-v2-check.ts',
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
