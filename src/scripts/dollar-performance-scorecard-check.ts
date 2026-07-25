#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

export const CRITICAL_DOLLAR_COMMANDS = new Set([
  '$sks-naruto',
  '$sks-super-search',
  '$sks-seo-geo-optimizer',
  '$sks-db',
  '$sks-mad-sks',
  '$sks-commit-and-push'
])

export const DOLLAR_SMOKE_MAX_AGE_MS = 60 * 60 * 1000

if (isMainModule()) await main()

export async function main() {
  const [{ DOLLAR_COMMANDS_LITE }, routes] = await Promise.all([
    importDist('core/routes/dollar-manifest-lite.js'),
    importDist('core/routes.js')
  ])

  const routePrompt = routes.routePrompt
  const rows = []
  for (const entry of DOLLAR_COMMANDS_LITE) {
    const routePromptSmoke = measureRoutePromptSmoke(entry, routePrompt)
    rows.push(scoreDollarEntry(entry, routePromptSmoke, commandRouteSmokeFor(entry, routePromptSmoke.routed)))
  }

  const average = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length)
  const blockers = [
    ...rows.filter((row) => row.critical && row.score === 0).map((row) => `${row.command}:critical_smoke_missing_or_failed`),
    ...rows.filter((row) => row.p95_ms > 20).map((row) => `${row.command}:route_prompt_p95_exceeded`),
    ...(average >= 94 ? [] : [`average_below_94:${average.toFixed(2)}`])
  ]
  const report = {
    schema: 'sks.dollar-performance-scorecard.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    average_score: Number(average.toFixed(2)),
    dollar_command_count: rows.length,
    rows,
    blockers
  }
  const out = path.join(root, '.sneakoscope', 'reports', 'dollar-performance-scorecard.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

  assertGate(report.ok, 'dollar performance scorecard failed', report)
  emitGate('dollar:performance-scorecard', { average_score: report.average_score, dollar_command_count: rows.length, report: '.sneakoscope/reports/dollar-performance-scorecard.json' })
}

export function scoreDollarEntry(entry, routePromptSmoke, commandSmoke, options = {}) {
  const now = options.now ? new Date(options.now) : new Date()
  const p95 = routePromptSmoke?.p95_ms ?? Infinity
  const metadataComplete = Boolean(entry.command && entry.route && entry.description)
  const routed = routePromptSmoke?.routed || null
  const stopGateOrExempt = Boolean(routed?.stopGate || routed?.coverageExemptReason || entry.command === '$sks-help' || entry.command === '$sks-answer')
  const routePromptOk = classifyDollarSmoke(routePromptSmoke, now) === 'pass'
  const commandSmokeOk = classifyDollarSmoke(commandSmoke, now) === 'pass'
  const metadataSynced = isDollarMetadataSynced(entry, routed, commandSmoke)
  const lifecycleReasoned = !((routed?.hidden === true || routed?.deprecated === true) && !routed?.hiddenReason && !routed?.deprecationReason && !routed?.deprecationMessage)
  const critical = CRITICAL_DOLLAR_COMMANDS.has(entry.command)
  if (critical && (!routePromptOk || !commandSmokeOk || !metadataSynced || !lifecycleReasoned)) {
    return {
      command: entry.command,
      route: entry.route,
      critical,
      p95_ms: Number.isFinite(p95) ? Number(p95.toFixed(3)) : null,
      score: 0,
      route_prompt_smoke: classifyDollarSmoke(routePromptSmoke, now),
      command_route_smoke: classifyDollarSmoke(commandSmoke, now),
      command_evidence_tier: criticalDollarEvidenceTier(commandSmoke),
      metadata_synced: metadataSynced,
      lifecycle_reasoned: lifecycleReasoned,
      routed_id: routed?.id || null,
      stop_gate: routed?.stopGate || null
    }
  }
  const cliSmokeOrPrompt = Boolean(commandSmokeOk)
  const highRiskPolicy = !critical || !/\b(?:MAD|DB|Computer|CU|Commit|Push|Release)\b/i.test(entry.command) || Boolean(routed?.requiredSkills || routed?.lifecycle)
  const score =
    (routePromptOk && p95 <= 20 ? 20 : 0) +
    (metadataComplete ? 20 : 0) +
    (stopGateOrExempt ? 20 : 0) +
    (cliSmokeOrPrompt ? 20 : 0) +
    (highRiskPolicy && metadataSynced && lifecycleReasoned ? 20 : 0)
  const cappedScore = critical ? Math.min(score, criticalDollarEvidenceMaxScore(commandSmoke)) : score
  return {
    command: entry.command,
    route: entry.route,
    critical,
    p95_ms: Number.isFinite(p95) ? Number(p95.toFixed(3)) : null,
    score: cappedScore,
    route_prompt_smoke: classifyDollarSmoke(routePromptSmoke, now),
    command_route_smoke: classifyDollarSmoke(commandSmoke, now),
    command_evidence_tier: criticalDollarEvidenceTier(commandSmoke),
    metadata_synced: metadataSynced,
    lifecycle_reasoned: lifecycleReasoned,
    routed_id: routed?.id || null,
    stop_gate: routed?.stopGate || null
  }
}

export function measureRoutePromptSmoke(entry, routePrompt) {
  const timings = []
  let routed = null
  for (let i = 0; i < 25; i++) {
    const started = performance.now()
    routed = routePrompt(`${entry.command} scorecard smoke`)
    timings.push(performance.now() - started)
  }
  timings.sort((a, b) => a - b)
  const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)] || 0
  return {
    kind: 'route_prompt',
    ok: Boolean(routed?.id),
    generated_at: new Date().toISOString(),
    p95_ms: p95,
    routed
  }
}

export function commandRouteSmokeFor(entry, routed = null) {
  const reportSmoke = reportBackedDollarSmoke(entry, routed)
  if (reportSmoke) return reportSmoke
  const cliEntrypoint = routed?.cliEntrypoint || ''
  const hasActualCli = /^sks\s+/i.test(cliEntrypoint)
  const synced = isDollarMetadataSynced(entry, routed, null)
  if (!CRITICAL_DOLLAR_COMMANDS.has(entry.command) && routed?.id && synced) {
    return {
      kind: 'route_prompt_metadata',
      ok: true,
      generated_at: new Date().toISOString(),
      command: entry.command,
      route: entry.route,
      routed_id: routed.id,
      metadata_synced: synced
    }
  }
  return {
    kind: hasActualCli ? 'cli_entrypoint_metadata' : 'metadata',
    ok: false,
    generated_at: new Date().toISOString(),
    command: entry.command,
    route: entry.route,
    cli_entrypoint: cliEntrypoint || null,
    metadata_synced: synced
  }
}

export function reportBackedDollarSmoke(entry, routed = null) {
  const synced = isDollarMetadataSynced(entry, routed, null)
  const now = new Date().toISOString()
  if (entry.command === '$sks-naruto') {
    const real = readReport('naruto-real-write-e2e.json')
    if (real?.ok === true) return smoke('read_only', true, now, synced, { report: 'naruto-real-write-e2e.json' })
    const hermetic = readReport('naruto-write-e2e.json')
    if (hermetic?.ok === true) return smoke('fixture', true, now, synced, { report: 'naruto-write-e2e.json' })
  }
  if (entry.command === '$sks-super-search') {
    const offline = readReport('super-search-offline-contract.json')
    const local = readReport('super-search-local-http-smoke.json')
    if (offline?.ok === true || local?.ok === true) return smoke('read_only', true, now, synced, { report: offline?.ok === true ? 'super-search-offline-contract.json' : 'super-search-local-http-smoke.json' })
  }
  if (entry.command === '$sks-seo-geo-optimizer') {
    const metadata = readReport('seo-metadata-sync.json')
    const truth = readReport('seo-marketing-truthfulness.json')
    if (metadata?.ok === true && truth?.ok === true) return smoke('read_only', true, now, synced, { report: 'seo-metadata-sync.json+seo-marketing-truthfulness.json' })
  }
  const highRisk = highRiskSmokeForDollar(entry.command)
  if (highRisk) return { ...highRisk, metadata_synced: synced }
  return null
}

function highRiskSmokeForDollar(command) {
  const report = readReport('high-risk-contracts.json')
  const target = {
    '$sks-db': '$DB',
    '$sks-mad-sks': 'mad-sks',
    '$sks-commit-and-push': 'commit-and-push'
  }[command]
  if (!target || !Array.isArray(report?.cli_negative_smokes)) return null
  const row = report.cli_negative_smokes.find((item) => item?.target === target)
  if (!row) return null
  return {
    kind: 'blocked_negative',
    ok: false,
    blocked: row.blocked === true,
    generated_at: report.generated_at || new Date().toISOString(),
    command,
    evidence: row
  }
}

function smoke(kind, ok, generatedAt, metadataSynced, extra = {}) {
  return { kind, ok, generated_at: generatedAt, metadata_synced: metadataSynced, ...extra }
}

function readReport(fileName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.sneakoscope', 'reports', fileName), 'utf8'))
  } catch {
    return null
  }
}

export function isDollarMetadataSynced(entry, routed, commandSmoke = null) {
  if (commandSmoke?.metadata_synced === false) return false
  if (!routed) return Boolean(entry.command && entry.route)
  const publicCommands = [routed.command, ...(routed.dollarAliases || [])].map(publicDollarCommand)
  const commandSynced = publicCommands.includes(String(entry.command || '').toLowerCase())
  const routeSynced = !entry.route || !routed.route || entry.route === routed.route
  return Boolean(commandSynced && routeSynced)
}

function publicDollarCommand(value) {
  const name = String(value || '').trim().replace(/^\$/, '').toLowerCase()
  if (!name || name === 'sks' || name.startsWith('sks-')) return `$${name || 'sks'}`
  return `$sks-${name}`
}

export function criticalDollarEvidenceTier(smoke) {
  if (!smoke) return 'metadata'
  if (smoke.kind === 'fixture') return 'fixture'
  if (smoke.kind === 'blocked_negative') return 'blocked_negative'
  if (smoke.kind === 'dry_run') return 'dry_run'
  if (smoke.kind === 'read_only' || smoke.kind === 'cli_read_only') return 'read_only'
  return 'metadata'
}

export function criticalDollarEvidenceMaxScore(smoke) {
  const tier = criticalDollarEvidenceTier(smoke)
  if (tier === 'metadata') return 0
  if (tier === 'fixture') return 70
  if (tier === 'blocked_negative') return 90
  return 100
}

export function classifyDollarSmoke(smoke, now = new Date()) {
  if (!smoke) return 'missing'
  if (isDollarSmokeStale(smoke, now)) return 'stale'
  if (smoke.kind === 'blocked_negative') return smoke.blocked === true && smoke.ok !== true ? 'pass' : 'failed'
  return smoke.ok === true ? 'pass' : 'failed'
}

export function isDollarSmokeStale(smoke, now = new Date()) {
  if (!smoke.generated_at) return false
  const generated = new Date(smoke.generated_at).getTime()
  return !Number.isFinite(generated) || now.getTime() - generated > DOLLAR_SMOKE_MAX_AGE_MS
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
}
