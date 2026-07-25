import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { nowIso, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import { ensureCodexNativeReferenceSnapshot, type CodexNativeReferenceCacheReport } from './codex-native-reference-cache.js'
import { messageOf } from '../errors/message.js'

export interface CodexNativeReferenceEvidenceRow {
  pattern_id: string
  file: string
  line_range: [number, number] | null
  snippet_hash: string
  claim_id: string
  confidence: 'low' | 'medium' | 'high'
}

export interface CodexNativeReferenceEvidenceReport {
  schema: 'sks.codex-native-reference-evidence.v1'
  generated_at: string
  source_kind: 'external-reference-source'
  source_ref: string
  source_sha: string | null
  source_url_hash: string | null
  cache_report_path: string | null
  cache: CodexNativeReferenceCacheReport | null
  evidence: CodexNativeReferenceEvidenceRow[]
  blockers: string[]
  warnings: string[]
}

const PATTERNS: Array<{ id: string; claim: string; re: RegExp }> = [
  { id: 'no-global-optional-tooling', claim: 'optional tooling avoids mandatory global install', re: /\bnpx\b|no[- ]global|global install/i },
  { id: 'plugin-lifecycle-state-separation', claim: 'plugin install state is separated from approval/readiness', re: /\bplugin\b.+\b(install|enable|marketplace|lifecycle)\b/i },
  { id: 'hook-approval-gating', claim: 'hook approval is a separate counted evidence gate', re: /\bhook\b.+\b(approval|approve|review|trusted|trust)\b/i },
  { id: 'skill-picker-route-bridge', claim: 'route skills are exposed through command picker style bridges', re: /\b(skill|command picker|slash command|\$[A-Za-z-]+)\b/i },
  { id: 'native-agent-role-probe', claim: 'native agent role support is probed before use', re: /\bagent_type\b|agent role|spawn_agent/i },
  { id: 'message-role-fallback', claim: 'message-role fallback is used when native role payload is unavailable', re: /message[- ]role|fallback/i },
  { id: 'directory-local-memory', claim: 'directory-local memory is injected as context', re: /AGENTS\.md|directory[- ]local|project memory/i },
  { id: 'plan-work-proof-separation', claim: 'planning, work, and proof are separated', re: /\b(plan|work|proof)\b/i },
  { id: 'continuation-enforcer', claim: 'continuation is enforced through loop state', re: /continuation|resume|stop hook/i },
  { id: 'doctor-harness-matrix', claim: 'doctor merges feature probes into one readiness matrix', re: /doctor|health|matrix|readiness/i },
  { id: 'mcp-tool-candidate-inventory', claim: 'MCP tools are candidates until approved', re: /\bMCP\b|tool candidate|server candidate/i },
  { id: 'non-clobber-managed-assets', claim: 'managed assets preserve user-authored content', re: /non[- ]clobber|managed|preserve user|checksum/i }
]

export async function analyzeCodexNativeReferenceSource(input: {
  root: string
  sourceDir?: string | null
  sourceRef?: string
  writeReport?: boolean
}): Promise<CodexNativeReferenceEvidenceReport> {
  const root = path.resolve(input.root)
  const cacheInput = input.sourceRef ? { root, ref: input.sourceRef } : { root }
  const cache = input.sourceDir
    ? null
    : await ensureCodexNativeReferenceSnapshot(cacheInput).catch((err: unknown) => ({
      schema: 'sks.codex-native-reference-cache.v1' as const,
      generated_at: nowIso(),
      ok: false,
      cache_dir: '.sneakoscope/cache/codex-native-reference',
      source_url_hash: null,
      source_ref: input.sourceRef || 'HEAD',
      source_sha: null,
      refreshed: false,
      offline: true,
      blockers: [messageOf(err)],
      warnings: ['reference_cache_exception']
    }))
  const sourceDir = input.sourceDir
    ? path.resolve(input.sourceDir)
    : path.join(root, cache?.cache_dir || '.sneakoscope/cache/codex-native-reference')
  const confidence: CodexNativeReferenceEvidenceRow['confidence'] = input.sourceDir ? 'high' : cache?.ok ? cache.refreshed ? 'high' : 'medium' : 'low'
  const files = await listTextFiles(sourceDir)
  const evidence: CodexNativeReferenceEvidenceRow[] = []
  const blockers: string[] = []
  for (const file of files) {
    const rel = path.relative(sourceDir, file).split(path.sep).join('/')
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (text) evidence.push(...extractCodexNativeEvidence(rel, text).map((row) => ({ ...row, confidence })))
  }
  if (!files.length || !evidence.length) blockers.push('source_snapshot_missing')
  const report: CodexNativeReferenceEvidenceReport = {
    schema: 'sks.codex-native-reference-evidence.v1',
    generated_at: nowIso(),
    source_kind: 'external-reference-source',
    source_ref: neutralSourceRef(input, cache, sourceDir),
    source_sha: cache?.source_sha || await gitSha(sourceDir),
    source_url_hash: cache?.source_url_hash || null,
    cache_report_path: cache ? '.sneakoscope/reports/codex-native-reference-cache.json' : null,
    cache,
    evidence,
    blockers: [...new Set([...blockers, ...(cache?.blockers || [])])],
    warnings: [...new Set([...(cache?.warnings || []), ...(blockers.length ? ['reference_evidence_incomplete'] : [])])]
  }
  if (input.writeReport !== false) {
    await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-native-reference-evidence.json'), report).catch(() => undefined)
    await writeTextAtomic(path.join(root, 'docs', 'codex-native-patterns.md'), renderCodexNativeReferenceMarkdown(report)).catch(() => undefined)
  }
  return report
}

export function extractCodexNativeEvidence(file: string, text: string): CodexNativeReferenceEvidenceRow[] {
  const lines = text.split(/\r?\n/)
  const rows: CodexNativeReferenceEvidenceRow[] = []
  for (const pattern of PATTERNS) {
    const index = lines.findIndex((line) => pattern.re.test(line))
    if (index < 0) continue
    const snippet = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join('\n').slice(0, 500)
    rows.push({
      pattern_id: pattern.id,
      file,
      line_range: [index + 1, index + 1],
      snippet_hash: createHash('sha256').update(snippet).digest('hex'),
      claim_id: pattern.claim,
      confidence: 'high'
    })
  }
  return rows
}

export function renderCodexNativeReferenceMarkdown(report: CodexNativeReferenceEvidenceReport): string {
  const rows = report.evidence.map((row) => `| ${row.pattern_id} | ${row.file} | ${row.line_range?.join('-') || '-'} | ${row.snippet_hash.slice(0, 16)} | ${row.confidence} |`).join('\n')
  return [
    '# SKS Codex Native Patterns',
    '',
    'This document records reference-derived Codex-native patterns in SKS-owned vocabulary. It stores line anchors and snippet hashes only.',
    '',
    `Generated at: \`${report.generated_at}\``,
    `Source kind: \`${report.source_kind}\``,
    `Source URL hash: \`${report.source_url_hash || 'none'}\``,
    `Source SHA: \`${report.source_sha || 'none'}\``,
    '',
    '| Pattern | File | Lines | Snippet Hash | Confidence |',
    '|---|---|---:|---|---|',
    rows || '| none | - | - | - | low |',
    ''
  ].join('\n')
}

function neutralSourceRef(input: { sourceDir?: string | null; sourceRef?: string }, cache: CodexNativeReferenceCacheReport | null, sourceDir: string): string {
  if (cache) return `cache:${createHash('sha256').update(`${cache.cache_dir}:${cache.source_ref}:${cache.source_sha || ''}`).digest('hex').slice(0, 16)}`
  if (input.sourceRef) return `explicit:${createHash('sha256').update(input.sourceRef).digest('hex').slice(0, 16)}`
  return `explicit-source-dir:${createHash('sha256').update(sourceDir).digest('hex').slice(0, 16)}`
}

async function listTextFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  await walk(dir, out, 500)
  return out
}

async function walk(dir: string, out: string[], maxFiles: number): Promise<void> {
  if (out.length >= maxFiles) return
  const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const row of rows) {
    if (out.length >= maxFiles) return
    const full = path.join(dir, row.name)
    if (row.isDirectory()) {
      if (['.git', 'node_modules', 'dist'].includes(row.name)) continue
      await walk(full, out, maxFiles)
    } else if (row.isFile() && /\.(md|txt|json|toml|ya?ml|js|ts|mjs|cjs)$/i.test(row.name)) {
      out.push(full)
    }
  }
}

async function gitSha(sourceDir: string): Promise<string | null> {
  const head = await fs.readFile(path.join(sourceDir, '.git', 'HEAD'), 'utf8').catch(() => '')
  const ref = head.match(/^ref:\s*(.+)$/m)?.[1]
  if (ref) return (await fs.readFile(path.join(sourceDir, '.git', ref), 'utf8').catch(() => '')).trim() || null
  return /^[0-9a-f]{40}$/i.test(head.trim()) ? head.trim() : null
}
