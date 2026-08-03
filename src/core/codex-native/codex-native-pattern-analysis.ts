import path from 'node:path'
import { createHash } from 'node:crypto'
import { nowIso, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import { analyzeCodexNativeReferenceSource, renderCodexNativeReferenceMarkdown, type CodexNativeReferenceEvidenceReport } from './codex-native-reference-source.js'

export interface CodexNativePatternAnalysis {
  schema: 'sks.codex-native-pattern-analysis.v1'
  generated_at: string
  source_kind: 'external-reference-source'
  source_ref: string
  source_sha: string | null
  source_url_hash?: string | null
  cache_report_path?: string | null
  patterns: Array<{
    id: string
    title: string
    adoption: 'adopt' | 'adapt' | 'reject' | 'watch'
    confidence: 'low' | 'medium' | 'high'
    evidence_hashes: string[]
    sks_target_modules: string[]
    implementation_notes: string[]
  }>
  blockers: string[]
  warnings: string[]
}

const PATTERN_ROWS: Array<Omit<CodexNativePatternAnalysis['patterns'][number], 'confidence' | 'evidence_hashes'>> = [
  row('plugin-lifecycle-state-separation', 'Plugin install and approval are separate states', 'adopt', ['src/core/codex-native/codex-native-feature-broker.ts'], ['Do not count installed tools as approved evidence.']),
  row('hook-approval-gating', 'Hook approval gates counted evidence', 'adopt', ['src/core/codex-app/codex-hook-lifecycle.ts'], ['Unknown or pending hook approval does not count as proof.']),
  row('skill-picker-route-bridge', 'SKS route skills bridge command picker usage', 'adapt', ['src/core/codex-app/codex-skill-sync.ts'], ['Managed skills expose route purpose, command, proof path, and failure recovery.']),
  row('native-agent-role-probe', 'Native agent role payload is probed before use', 'adopt', ['src/core/codex-app/codex-agent-type-probe.ts'], ['Use agent_type only when the probe supports it.']),
  row('message-role-fallback', 'Message-role fallback is explicit', 'adopt', ['src/core/codex-native/codex-native-invocation-router.ts'], ['Fallback remains valid but must be recorded in proof.']),
  row('directory-local-memory', 'Directory-local memory is guidance', 'adapt', ['src/core/codex-app/codex-init-deep.ts', 'src/core/loops/loop-planner.ts'], ['Memory hints never widen owner scope.']),
  row('plan-work-proof-separation', 'Plan, work, and proof stay separate', 'adopt', ['src/core/loops', 'src/core/naruto'], ['Route artifacts separate planning, execution, and verification.']),
  row('continuation-enforcer', 'Continuation is stateful and bounded', 'adapt', ['src/core/loops/loop-continuation-enforcer.ts'], ['Use runtime proof when hook approval is not approved.']),
  row('doctor-harness-matrix', 'Doctor merges readiness into one story', 'adopt', ['src/commands/doctor.ts'], ['Doctor should show Codex Native, Loop, QA, and Research together.']),
  row('mcp-tool-candidate-inventory', 'MCP plugin servers are candidates', 'adapt', ['src/core/mcp/mcp-plugin-inventory.ts'], ['Candidate-only inventory prevents accidental destructive auto-enable.']),
  row('non-clobber-managed-assets', 'Managed assets avoid clobbering user files', 'adopt', ['src/core/codex-app/codex-skill-sync.ts', 'src/core/codex-app/codex-agent-role-sync.ts'], ['Skip unmarked user assets and include checksums for managed content.'])
]

export async function buildCodexNativePatternAnalysis(input: {
  root: string
  evidence?: CodexNativeReferenceEvidenceReport | null
  sourceDir?: string | null
}): Promise<CodexNativePatternAnalysis> {
  const root = path.resolve(input.root)
  const evidence = input.evidence || await analyzeCodexNativeReferenceSource({ root, sourceDir: input.sourceDir || null, writeReport: true }).catch(() => null)
  const evidenceByPattern = new Map<string, string[]>()
  const confidenceByPattern = new Map<string, CodexNativePatternAnalysis['patterns'][number]['confidence']>()
  for (const item of evidence?.evidence || []) {
    const list = evidenceByPattern.get(item.pattern_id) || []
    list.push(item.snippet_hash)
    evidenceByPattern.set(item.pattern_id, list)
    confidenceByPattern.set(item.pattern_id, strongerConfidence(confidenceByPattern.get(item.pattern_id), item.confidence))
  }
  return {
    schema: 'sks.codex-native-pattern-analysis.v1',
    generated_at: nowIso(),
    source_kind: 'external-reference-source',
    source_ref: evidence?.source_ref || neutralSourceRef(input.sourceDir || '.sneakoscope/cache/codex-native-reference'),
    source_sha: evidence?.source_sha || null,
    source_url_hash: evidence?.source_url_hash || null,
    cache_report_path: evidence?.cache_report_path || null,
    patterns: PATTERN_ROWS.map((pattern) => {
      const hashes = evidenceByPattern.get(pattern.id) || []
      return {
        ...pattern,
        confidence: confidenceByPattern.get(pattern.id) || (hashes.length ? 'medium' as const : evidence ? 'low' as const : 'low' as const),
        evidence_hashes: hashes
      }
    }),
    blockers: evidence?.blockers || ['source_snapshot_missing'],
    warnings: evidence?.warnings || ['reference_evidence_unavailable']
  }
}

function neutralSourceRef(value: string): string {
  return `source:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function strongerConfidence(
  current: CodexNativePatternAnalysis['patterns'][number]['confidence'] | undefined,
  next: CodexNativePatternAnalysis['patterns'][number]['confidence']
): CodexNativePatternAnalysis['patterns'][number]['confidence'] {
  const rank = { low: 0, medium: 1, high: 2 } as const
  return current && rank[current] >= rank[next] ? current : next
}

export async function writeCodexNativePatternAnalysis(root: string, input: { sourceDir?: string | null } = {}): Promise<CodexNativePatternAnalysis> {
  const evidence = await analyzeCodexNativeReferenceSource({ root, sourceDir: input.sourceDir || null, writeReport: true }).catch(() => null)
  const report = await buildCodexNativePatternAnalysis({ root, evidence, sourceDir: input.sourceDir || null })
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-native-pattern-analysis.json'), report)
  if (evidence) await writeTextAtomic(path.join(root, 'docs', 'codex-native-patterns.md'), renderCodexNativeReferenceMarkdown(evidence)).catch(() => undefined)
  return report
}

function row(
  id: string,
  title: string,
  adoption: CodexNativePatternAnalysis['patterns'][number]['adoption'],
  sks_target_modules: string[],
  implementation_notes: string[]
): Omit<CodexNativePatternAnalysis['patterns'][number], 'confidence' | 'evidence_hashes'> {
  return { id, title, adoption, sks_target_modules, implementation_notes }
}
