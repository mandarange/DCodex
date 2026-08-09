/**
 * Single inventory of SKS authority domains.
 *
 * Architecture Map `ssot-analysis` and `ssot-guard` both read from here.
 * Domain strings MUST NOT be duplicated into architecture-map policy.
 */

export type SsotAuthorityKind = 'file' | 'manifest' | 'runtime_owner' | 'generated_projection';

export interface SsotAuthorityDomain {
  readonly id: string;
  readonly title: string;
  readonly authorityKind: SsotAuthorityKind;
  readonly canonicalSources: readonly string[];
  readonly allowedWriters: readonly string[];
  readonly allowedReaders: readonly string[];
  readonly derivedArtifacts: readonly string[];
  readonly protected: boolean;
  readonly description: string;
  /** Human-readable authority statement used by the ssot-guard report shape. */
  readonly authority: string;
  readonly rule: string;
}

export const SKS_SSOT_AUTHORITY_INVENTORY: readonly SsotAuthorityDomain[] = Object.freeze([
  Object.freeze({
    id: 'route_contract',
    title: 'Route contract',
    authorityKind: 'runtime_owner' as const,
    canonicalSources: Object.freeze([
      'decision-contract.json, route prompt, and pipeline-plan.json'
    ]),
    allowedWriters: Object.freeze(['pipeline plan writer', 'request intake']),
    allowedReaders: Object.freeze(['naruto', 'workers', 'stop gate']),
    derivedArtifacts: Object.freeze([
      'subagent-plan.json',
      'subagent-events.jsonl',
      'worker inboxes'
    ]),
    protected: true,
    description:
      'The sealed user objective, constraints, non-goals, and acceptance criteria define what code may be created.',
    authority:
      'The sealed user objective, constraints, non-goals, and acceptance criteria define what code may be created.',
    rule: 'Do not implement behavior outside the sealed route contract; block with evidence if the requested path cannot be honored.'
  }),
  Object.freeze({
    id: 'triwiki_context',
    title: 'TriWiki context pack',
    authorityKind: 'file' as const,
    canonicalSources: Object.freeze(['.sneakoscope/wiki/context-pack.json']),
    allowedWriters: Object.freeze(['sks wiki pack', 'sks align run', 'triwiki refresh']),
    allowedReaders: Object.freeze(['pipeline stages', 'naruto parent', 'honest mode']),
    derivedArtifacts: Object.freeze([
      'subagent-parent-summary.json',
      'subagent-evidence.json',
      'reflection.md'
    ]),
    protected: true,
    description:
      'TriWiki is the bounded mission context SSOT and must be refreshed or packed, then validated before risky handoffs and final claims.',
    authority:
      'TriWiki is the bounded mission context SSOT and must be refreshed or packed, then validated before risky handoffs and final claims.',
    rule: 'Use the latest coordinate+voxel overlay pack; coordinate-only legacy packs are invalid for pipeline decisions.'
  }),
  Object.freeze({
    id: 'runtime_source',
    title: 'TypeScript runtime source',
    authorityKind: 'file' as const,
    canonicalSources: Object.freeze(['src/**/*.ts']),
    allowedWriters: Object.freeze(['implementation workers under sealed route']),
    allowedReaders: Object.freeze(['build', 'tests', 'release gates']),
    derivedArtifacts: Object.freeze(['dist/**', 'dist/bin/sks.js']),
    protected: true,
    description: 'TypeScript source is the runtime SSOT.',
    authority: 'TypeScript source is the runtime SSOT.',
    rule: 'Edit source, rebuild derived output, and rely on runtime:ts-source-of-truth plus runtime:dist-parity.'
  }),
  Object.freeze({
    id: 'generated_outputs',
    title: 'Generated outputs',
    authorityKind: 'generated_projection' as const,
    canonicalSources: Object.freeze([
      'source generators, build scripts, and schema definitions'
    ]),
    allowedWriters: Object.freeze(['generators', 'build scripts']),
    allowedReaders: Object.freeze(['release', 'doctor', 'install']),
    derivedArtifacts: Object.freeze([
      'release-gates.v2.json',
      'infra-harness-gates.json',
      '.sneakoscope/reports/**',
      'dist/build-manifest.json'
    ]),
    protected: true,
    description: 'Generated files are derived from their generator or schema owner.',
    authority: 'Generated files are derived from their generator or schema owner.',
    rule: 'Regenerate derived artifacts instead of hand-editing them as independent truth.'
  }),
  Object.freeze({
    id: 'stack_current_docs',
    title: 'Stack current docs',
    authorityKind: 'file' as const,
    canonicalSources: Object.freeze(['.sneakoscope/memory/q2_facts/stack-current-docs.md']),
    allowedWriters: Object.freeze(['Context7 hydration', 'docs refresh']),
    allowedReaders: Object.freeze(['implementation', 'research']),
    derivedArtifacts: Object.freeze(['implementation notes', 'route evidence']),
    protected: false,
    description:
      'Current vendor or Context7 docs override model-memory defaults when stack versions or APIs change.',
    authority:
      'Current vendor or Context7 docs override model-memory defaults when stack versions or APIs change.',
    rule: 'Fetch and record current docs before relying on external package, SDK, API, MCP, or generated-doc behavior that may have changed.'
  }),
  Object.freeze({
    id: 'release_gate_manifest',
    title: 'Release gate manifest',
    authorityKind: 'manifest' as const,
    canonicalSources: Object.freeze([
      'src/core/release/gate-manifest.ts and src/scripts/release-parallel-check.ts'
    ]),
    allowedWriters: Object.freeze(['release maintainers via source edit']),
    allowedReaders: Object.freeze(['release DAG', 'publish preflight']),
    derivedArtifacts: Object.freeze([
      '.sneakoscope/reports/release-gate-plan.json',
      '.sneakoscope/reports/gate-policy-audit.json'
    ]),
    protected: true,
    description: 'Release gate selection and publish-required status live in the manifest plus the release DAG.',
    authority: 'Release gate selection and publish-required status live in the manifest plus the release DAG.',
    rule: 'Publish-blocking guard gates must appear in the DAG, manifest, and package scripts.'
  })
]);

export function canonicalSsotAuthorityInventory(): readonly SsotAuthorityDomain[] {
  return SKS_SSOT_AUTHORITY_INVENTORY;
}

/** Shape consumed by legacy ssot-guard report fields. */
export function inventoryAsSsotGuardSources(): ReadonlyArray<{
  id: string;
  source: string;
  authority: string;
  derived: string[];
  rule: string;
}> {
  return SKS_SSOT_AUTHORITY_INVENTORY.map((domain) => ({
    id: domain.id,
    source: domain.canonicalSources.join(', '),
    authority: domain.authority,
    derived: [...domain.derivedArtifacts],
    rule: domain.rule
  }));
}
