import path from 'node:path'
import { writeJsonAtomic } from '../fsx.js'

export const AGENT_RECURSION_GUARD_REPORT_SCHEMA = 'sks.agent-recursion-guard.v1'
export const NON_RECURSIVE_PIPELINE_REPORT_SCHEMA = 'sks.non-recursive-pipeline-report.v1'
export const NON_RECURSIVE_PIPELINE_PERFORMANCE_BUDGET_MS = 1500

export const AGENT_RECURSIVE_COMMAND_DENYLIST = Object.freeze([
  'sks naruto run',
  'sks research run',
  'sks autoresearch run',
  'sks qa-loop',
  'sks goal',
  '$Naruto',
  '$Work',
  '$Research',
  '$AutoResearch',
  '$QA-LOOP',
  '$Goal',
  'node dist/bin/sks.js naruto',
  'node dist/bin/sks.js research run'
])

export const AGENT_WORKER_ENV_GUARD_TOKENS = Object.freeze([
  'AGENT_WORKER_PIPELINE',
  'SKS_AGENT_WORKER',
  'SKS_PIPELINE_MODE',
  'SKS_DISABLE_ROUTE_RECURSION',
  'SKS_AGENT_SESSION_ID',
  'SKS_AGENT_ID',
  'SKS_AGENT_ALLOWED_COMMANDS_FILE'
])

const COMMAND_DENYLIST = AGENT_RECURSIVE_COMMAND_DENYLIST.filter((entry) => !entry.startsWith('$'))
const ROUTE_DENYLIST = AGENT_RECURSIVE_COMMAND_DENYLIST.filter((entry) => entry.startsWith('$'))

const DENY_PATTERNS = AGENT_RECURSIVE_COMMAND_DENYLIST.map((entry) =>
  entry.startsWith('$')
    ? new RegExp('(^|\\s)\\' + entry + '(\\s|$)', 'i')
    : new RegExp('(^|\\s)' + escapeRe(entry).replace(/\\ /g, '\\s+') + '(\\s|$)', 'i')
)

const SECRET_PATTERNS = [
  { id: 'openai_api_key', pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g },
  { id: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g },
  { id: 'jwt_like_token', pattern: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g }
]

const WORKER_MISSION_CREATION_PATTERNS = [
  { id: 'createMission', pattern: /\bcreateMission\s*\(/g },
  { id: 'missionDir', pattern: /\bmissionDir\s*\(/g }
]

const CURRENT_JSON_WRITE_PATTERNS = [
  { id: 'setCurrent', pattern: /\bsetCurrent\s*\(/g },
  { id: 'stateFile', pattern: /\bstateFile\s*\(/g },
  { id: 'current_json_path', pattern: /\.sneakoscope\/state\/current\.json/g }
]

export const NON_RECURSIVE_PIPELINE_SCAN_CONTRACT = Object.freeze({
  schema: NON_RECURSIVE_PIPELINE_REPORT_SCHEMA,
  local_only: true,
  scan_groups: [
    'env guard',
    'command denylist',
    'route denylist',
    'worker mission creation block',
    'current.json write block',
    'top-level command block',
    'stdout transcript scan',
    'stderr transcript scan',
    'agent result scan',
    'wrongness record'
  ],
  artifacts: ['non-recursive-pipeline-report.json', 'non-recursive-pipeline-report.md'],
  performance_budget_ms: NON_RECURSIVE_PIPELINE_PERFORMANCE_BUDGET_MS
})

export type NonRecursivePipelineChannel = 'source' | 'docs' | 'env' | 'stdout' | 'stderr' | 'agent_result'

export interface NonRecursivePipelineScanInput {
  path: string
  text: string
  channel?: NonRecursivePipelineChannel
}

export function scanAgentTextForRecursion(text: unknown) {
  const body = String(text || '')
  const violations = AGENT_RECURSIVE_COMMAND_DENYLIST.filter((entry, index) => DENY_PATTERNS[index]?.test(body))
  return {
    ok: violations.length === 0,
    violations,
    warning: violations.length ? 'agent_worker_recursion_attempt_blocked' : null
  }
}

export function assertNoAgentRecursion(text: unknown) {
  const result = scanAgentTextForRecursion(text)
  if (!result.ok) throw new Error('Agent recursion blocked: ' + result.violations.join(', '))
  return result
}

export function scanNonRecursivePipelinePolicy(
  records: NonRecursivePipelineScanInput[],
  opts: { performanceBudgetMs?: number } = {}
) {
  const started = Date.now()
  const performanceBudgetMs = opts.performanceBudgetMs || NON_RECURSIVE_PIPELINE_PERFORMANCE_BUDGET_MS
  const violations: any[] = []
  const scannedRecords: Array<{ path: string; channel: NonRecursivePipelineChannel; bytes: number }> = []
  const redactionSamples: string[] = []
  const envCorpus: string[] = []
  const guardCorpus: string[] = []
  const workerCorpus: string[] = []
  const channelCoverage = {
    stdout: false,
    stderr: false,
    agent_result: false
  }

  for (const record of records) {
    const rel = normalizePath(record.path)
    const text = String(record.text || '')
    const channel = record.channel || classifyNonRecursivePipelinePath(rel)
    scannedRecords.push({ path: rel, channel, bytes: Buffer.byteLength(text, 'utf8') })
    redactionSamples.push(...collectSecretRedactionSamples(text))

    if (channel === 'env' || rel.includes('agent-worker-pipeline')) envCorpus.push(text)
    if (rel.includes('agent-recursion-guard')) guardCorpus.push(text)
    if (isWorkerExecutionSurface(rel, channel)) {
      workerCorpus.push(text)
      scanWorkerExecutionSurface({ rel, text, channel, violations })
    }
    if (channel === 'stdout') channelCoverage.stdout = true
    if (channel === 'stderr') channelCoverage.stderr = true
    if (channel === 'agent_result') channelCoverage.agent_result = true
  }

  const envText = envCorpus.join('\n')
  for (const token of AGENT_WORKER_ENV_GUARD_TOKENS) {
    if (!envText.includes(token)) {
      violations.push(nonRecursivePipelineViolation({
        file: 'src/core/agents/agent-worker-pipeline.ts',
        channel: 'env',
        group: 'env guard',
        rule_id: `missing_env_guard:${token}`,
        snippet: token,
        index: null
      }))
    }
  }

  const guardText = guardCorpus.join('\n')
  for (const token of COMMAND_DENYLIST) {
    if (!guardText.includes(token)) {
      violations.push(nonRecursivePipelineViolation({
        file: 'src/core/agents/agent-recursion-guard.ts',
        channel: 'source',
        group: 'command denylist',
        rule_id: `missing_command_denylist:${token}`,
        snippet: token,
        index: null
      }))
    }
  }
  for (const token of ROUTE_DENYLIST) {
    if (!guardText.includes(token)) {
      violations.push(nonRecursivePipelineViolation({
        file: 'src/core/agents/agent-recursion-guard.ts',
        channel: 'source',
        group: 'route denylist',
        rule_id: `missing_route_denylist:${token}`,
        snippet: token,
        index: null
      }))
    }
  }

  const elapsedMs = Date.now() - started
  const ok = violations.length === 0
  const secretRedactionOk = violations.every((row) => !containsSecret(row.snippet))
  const groupsWithViolations = new Set(violations.map((row) => row.group))

  return {
    schema: NON_RECURSIVE_PIPELINE_REPORT_SCHEMA,
    ok,
    generated_at: new Date().toISOString(),
    local_only: true,
    secret_redaction_ok: secretRedactionOk,
    performance_budget_ms: performanceBudgetMs,
    elapsed_ms: elapsedMs,
    performance_ok: elapsedMs <= performanceBudgetMs,
    scan_contract: NON_RECURSIVE_PIPELINE_SCAN_CONTRACT,
    env_policy: {
      schema: 'sks.agent-worker-env-policy.v1',
      required_tokens: [...AGENT_WORKER_ENV_GUARD_TOKENS],
      present: AGENT_WORKER_ENV_GUARD_TOKENS.filter((token) => envText.includes(token)),
      missing: AGENT_WORKER_ENV_GUARD_TOKENS.filter((token) => !envText.includes(token))
    },
    denylist: {
      schema: 'sks.agent-worker-recursion-denylist.v1',
      commands: [...COMMAND_DENYLIST],
      routes: [...ROUTE_DENYLIST]
    },
    scanned_records: scannedRecords,
    channel_coverage: channelCoverage,
    worker_surface_records: workerCorpus.length,
    violations,
    redaction_samples: [...new Set(redactionSamples)].slice(0, 20),
    wrongness_records: violations.map((row) => ({
      schema: 'sks.non-recursive-pipeline-wrongness.v1',
      kind: 'agent_recursive_pipeline_attempt',
      file: row.file,
      channel: row.channel,
      group: row.group,
      rule_id: row.rule_id,
      next_action: row.next_action
    })),
    proof: {
      schema: 'sks.non-recursive-pipeline-proof.v1',
      ok,
      env_guard_configured: !groupsWithViolations.has('env guard'),
      command_denylist_enforced: !groupsWithViolations.has('command denylist'),
      route_denylist_enforced: !groupsWithViolations.has('route denylist'),
      worker_mission_creation_blocked: !groupsWithViolations.has('worker mission creation block'),
      current_json_write_blocked: !groupsWithViolations.has('current.json write block'),
      top_level_command_blocked: !groupsWithViolations.has('top-level command block'),
      stdout_transcript_scan: channelCoverage.stdout && !groupsWithViolations.has('stdout transcript scan'),
      stderr_transcript_scan: channelCoverage.stderr && !groupsWithViolations.has('stderr transcript scan'),
      agent_result_scan: channelCoverage.agent_result && !groupsWithViolations.has('agent result scan'),
      wrongness_records_written: violations.length === 0 || violations.length === violations.map((row) => row.rule_id).length
    },
    trust_report: {
      schema: 'sks.non-recursive-pipeline-trust.v1',
      ok,
      trust: ok ? 'high' : 'blocked',
      evidence_count: scannedRecords.length,
      local_only: true
    },
    evidence_router: {
      schema: 'sks.non-recursive-pipeline-evidence-router.v1',
      records: scannedRecords.map((row) => ({ file: row.path, channel: row.channel, source: 'local_scan', redacted: true })),
      blocked_records: violations.length
    },
    next_action: ok
      ? 'keep agent workers non-recursive and continue writing proof through the parent orchestrator'
      : 'remove nested route launches or state writes from worker surfaces before accepting agent proof'
  }
}

export function nonRecursivePipelineMarkdown(report: any) {
  const proof = report.proof || {}
  const lines = [
    '# Non-Recursive Agent Pipeline Report',
    '',
    `Status: ${report.ok ? 'passed' : 'blocked'}`,
    `Generated: ${report.generated_at}`,
    `Local only: ${report.local_only ? 'yes' : 'no'}`,
    `Records scanned: ${report.scanned_records?.length || 0}`,
    `Performance: ${report.elapsed_ms}ms / ${report.performance_budget_ms}ms`,
    '',
    '## Proof',
    '',
    `- env_guard_configured: ${Boolean(proof.env_guard_configured)}`,
    `- command_denylist_enforced: ${Boolean(proof.command_denylist_enforced)}`,
    `- route_denylist_enforced: ${Boolean(proof.route_denylist_enforced)}`,
    `- worker_mission_creation_blocked: ${Boolean(proof.worker_mission_creation_blocked)}`,
    `- current_json_write_blocked: ${Boolean(proof.current_json_write_blocked)}`,
    `- top_level_command_blocked: ${Boolean(proof.top_level_command_blocked)}`,
    `- stdout_transcript_scan: ${Boolean(proof.stdout_transcript_scan)}`,
    `- stderr_transcript_scan: ${Boolean(proof.stderr_transcript_scan)}`,
    `- agent_result_scan: ${Boolean(proof.agent_result_scan)}`,
    `- wrongness_records_written: ${Boolean(proof.wrongness_records_written)}`,
    '',
    '## Violations',
    ''
  ]
  if (!report.violations?.length) lines.push('- none')
  for (const violation of report.violations || []) lines.push(`- ${violation.file}: ${violation.group}/${violation.rule_id} -> ${violation.next_action}`)
  return `${lines.join('\n')}\n`
}

export async function writeAgentRecursionGuardReport(dir: string, input: unknown) {
  const result = scanAgentTextForRecursion(input)
  const report = {
    schema: AGENT_RECURSION_GUARD_REPORT_SCHEMA,
    ok: result.ok,
    violations: result.violations,
    blocks_proof: !result.ok
  }
  await writeJsonAtomic(path.join(dir, 'agent-recursion-guard.json'), report)
  return report
}

function scanWorkerExecutionSurface(input: {
  rel: string
  text: string
  channel: NonRecursivePipelineChannel
  violations: any[]
}) {
  const transcriptGroup = transcriptGroupForChannel(input.channel)
  scanPatterns(input.text, commandRules(COMMAND_DENYLIST), (rule, match) => {
    input.violations.push(nonRecursivePipelineViolation({
      file: input.rel,
      channel: input.channel,
      group: transcriptGroup || 'command denylist',
      rule_id: rule.id,
      snippet: match[0] || rule.id,
      index: match.index ?? null
    }))
    input.violations.push(nonRecursivePipelineViolation({
      file: input.rel,
      channel: input.channel,
      group: 'top-level command block',
      rule_id: rule.id,
      snippet: match[0] || rule.id,
      index: match.index ?? null
    }))
  })
  scanPatterns(input.text, commandRules(ROUTE_DENYLIST), (rule, match) => {
    input.violations.push(nonRecursivePipelineViolation({
      file: input.rel,
      channel: input.channel,
      group: transcriptGroup || 'route denylist',
      rule_id: rule.id,
      snippet: match[0] || rule.id,
      index: match.index ?? null
    }))
  })
  scanPatterns(input.text, WORKER_MISSION_CREATION_PATTERNS, (rule, match) => {
    input.violations.push(nonRecursivePipelineViolation({
      file: input.rel,
      channel: input.channel,
      group: 'worker mission creation block',
      rule_id: rule.id,
      snippet: match[0] || rule.id,
      index: match.index ?? null
    }))
  })
  scanPatterns(input.text, CURRENT_JSON_WRITE_PATTERNS, (rule, match) => {
    input.violations.push(nonRecursivePipelineViolation({
      file: input.rel,
      channel: input.channel,
      group: 'current.json write block',
      rule_id: rule.id,
      snippet: match[0] || rule.id,
      index: match.index ?? null
    }))
  })
}

function scanPatterns(
  text: string,
  rules: Array<{ id: string; pattern: RegExp }>,
  onMatch: (rule: { id: string; pattern: RegExp }, match: RegExpMatchArray) => void
) {
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
    const pattern = new RegExp(rule.pattern.source, flags)
    for (const match of text.matchAll(pattern)) onMatch(rule, match)
  }
}

function commandRules(entries: readonly string[]) {
  return entries.map((entry) => ({
    id: entry,
    pattern: entry.startsWith('$')
      ? new RegExp('(^|\\s)\\' + entry + '(\\s|$)', 'gi')
      : new RegExp('(^|\\s)' + escapeRe(entry).replace(/\\ /g, '\\s+') + '(\\s|$)', 'gi')
  }))
}

function nonRecursivePipelineViolation(input: any) {
  return {
    schema: 'sks.non-recursive-pipeline-violation.v1',
    file: input.file,
    channel: input.channel,
    group: input.group,
    rule_id: input.rule_id,
    index: input.index,
    snippet: redactPolicyText(input.snippet),
    next_action: nextActionForNonRecursiveRule(input.group, input.rule_id)
  }
}

function nextActionForNonRecursiveRule(group: string, ruleId: string) {
  if (group === 'env guard') return 'restore SKS_AGENT_WORKER and SKS_DISABLE_ROUTE_RECURSION in agentWorkerEnv'
  if (group === 'worker mission creation block') return 'move mission creation to the parent orchestrator and keep workers route-local'
  if (group === 'current.json write block') return 'remove global current.json writes from worker code and record state in agent ledgers'
  if (group === 'top-level command block') return `replace ${ruleId} with parent-owned orchestration or a read-only local check`
  if (group.endsWith('transcript scan') || group === 'agent result scan') return 'block the worker result and convert the finding into an agent wrongness record'
  if (group === 'route denylist') return 'remove nested SKS dollar-route launch from the worker prompt or result'
  return 'remove nested SKS route command from worker execution surfaces'
}

function transcriptGroupForChannel(channel: NonRecursivePipelineChannel) {
  if (channel === 'stdout') return 'stdout transcript scan'
  if (channel === 'stderr') return 'stderr transcript scan'
  if (channel === 'agent_result') return 'agent result scan'
  return null
}

function isWorkerExecutionSurface(rel: string, channel: NonRecursivePipelineChannel) {
  if (channel === 'stdout' || channel === 'stderr' || channel === 'agent_result') return true
  return /(?:^|\/)agent-worker-pipeline\.(?:ts|mjs|js)$/.test(rel) || /(?:^|\/)agent-runner-(?:process|ollama)\.(?:ts|mjs|js)$/.test(rel)
}

function classifyNonRecursivePipelinePath(file: string): NonRecursivePipelineChannel {
  const normalized = normalizePath(file)
  if (normalized.endsWith('.json')) return 'agent_result'
  if (normalized.includes('/docs/') || normalized.startsWith('docs/')) return 'docs'
  return 'source'
}

function redactPolicyText(text: unknown) {
  let out = String(text || '')
  for (const rule of SECRET_PATTERNS) out = out.replace(rule.pattern, `[REDACTED:${rule.id}]`)
  return out
}

function collectSecretRedactionSamples(text: string) {
  const samples: string[] = []
  for (const rule of SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0
    const matches = [...String(text || '').matchAll(rule.pattern)]
    for (const match of matches) samples.push(redactPolicyText(match[0]))
  }
  return samples
}

function containsSecret(text: unknown) {
  return SECRET_PATTERNS.some((rule) => {
    rule.pattern.lastIndex = 0
    return rule.pattern.test(String(text || ''))
  })
}

function normalizePath(file: string) {
  return String(file || '').replace(/\\/g, '/')
}

function escapeRe(value: string) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}
