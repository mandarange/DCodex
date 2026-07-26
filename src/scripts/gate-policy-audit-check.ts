#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { COMMANDS } from '../cli/command-registry.js'

const root = process.cwd()
const release = JSON.parse(fs.readFileSync(path.join(root, 'release-gates.v2.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const gates = release.gates || []
const releaseGates = gates.filter((gate) => (gate.preset || []).includes('release'))
const blockers: string[] = []
const splitReviewBudget = 1200
const splitReviewFiles = [
  'src/core/research.ts',
  'src/core/ppt.ts',
  'src/core/init.ts',
  'src/core/hooks-runtime.ts',
  'src/core/recallpulse.ts'
]
const policyCallsiteAllowlist = new Map([
  ['codex_config_write|src/cli/install-helpers-codex-lb-selftest-chain.ts|runCodexLbLaunchChainSelftest|writeTextAtomic', 'isolated launch-chain selftest config'],
  ['codex_config_write|src/cli/install-helpers-codex-lb-selftest.ts|selftestCodexLb|writeTextAtomic', 'isolated Codex LB selftest config'],
  ['mkdtemp|src/core/codex-control/codex-sdk-env-policy.ts|prepareNativeCodexAuthBridge|mkdtemp', 'identity-checked 0700 OAuth bridge root with explicit cleanup proof'],
  ['mkdtemp|src/core/mcp-config/codex-cli-adapter.ts|CodexMcpCliAdapter|mkdtemp', 'isolated official CLI transform HOME'],
  ['mkdtemp|src/core/perf/release-latency-slo.ts|runReleaseLatencySlo|mkdtemp', 'run-local latency fixture root'],
  ['mkdtemp|src/core/release/npm-stage-tarball-verifier.ts|verifyNpmStageTarball|mkdtempSync', 'private stage-review transaction root'],
  ['mkdtemp|src/core/release/release-pack-content-scanner.ts|scanTarballTextContents|mkdtempSync', 'finally-cleaned tar scan root'],
  ['mkdtemp|src/core/release/release-pack-tarball.ts|tarUnpackedBytes|mkdtempSync', 'finally-cleaned tar inventory root'],
  // Gate libraries used to be named `*-check-lib.ts` and were skipped by the
  // filename filter below; the rename to `*-gate-lib.ts` dropped that magic word
  // and exposed their fixture roots. They are gate infrastructure, not product
  // code: each creates an OS-temp root for one gate run and nothing outside it.
  ['mkdtemp|src/scripts/codex-native-gate-lib.ts|tempRoot|mkdtemp', 'per-gate isolated OS-temp fixture root'],
  ['mkdtemp|src/scripts/runtime-domain-gate-lib.ts|tempRoot|mkdtemp', 'per-gate isolated OS-temp fixture root'],
  ['mkdtemp|src/scripts/typed-routing-gate-lib.ts|tempRoot|mkdtemp', 'per-gate isolated OS-temp fixture root']
])
const policyCallsiteAllowlistHits = new Set<string>()
const splitReviewLineCounts = splitReviewFiles.map((file) => ({
  file,
  lines: lineCount(path.join(root, file))
}))
const directCodexConfigWrites = scanDirectCodexConfigWrites()
const commandGateContract = scanCommandGateContract()
const directMkdtempCalls = scanDirectMkdtempCalls()
const rustTempdirCalls = scanRustTempdirCalls()
const unusedPolicyCallsiteAllowlist = [...policyCallsiteAllowlist.keys()].filter((key) => !policyCallsiteAllowlistHits.has(key))

if (releaseGates.length > 200) blockers.push(`release_preset_gate_budget_exceeded:${releaseGates.length}`)
if (gates.length > 200) blockers.push(`release_manifest_gate_budget_exceeded:${gates.length}`)
if (Object.keys(pkg.scripts || {}).length > 100) blockers.push(`package_script_budget_exceeded:${Object.keys(pkg.scripts || {}).length}`)
if (releaseGates.some((gate) => String(gate.id || '').startsWith('zellij:'))) blockers.push('zellij_gate_in_release_preset')
if (fs.existsSync(path.join(root, 'src/core/pipeline-runtime.ts'))) blockers.push('pipeline_runtime_duplicate_facade_present')
if (gitTracked('*sks-backup*').length) blockers.push('tracked_sks_backup_files_present')
if (directCodexConfigWrites.length) blockers.push(`direct_codex_config_write_callsite:${directCodexConfigWrites[0].file}:${directCodexConfigWrites[0].line}`)
if (!commandGateContract.ok) blockers.push(`command_gate_contract:${commandGateContract.issues[0]}`)
if (directMkdtempCalls.length) blockers.push(`direct_mkdtemp_callsite:${directMkdtempCalls[0].file}:${directMkdtempCalls[0].line}`)
if (rustTempdirCalls.length) blockers.push(`rust_tempdir_without_raii:${rustTempdirCalls[0].file}:${rustTempdirCalls[0].line}`)
if (unusedPolicyCallsiteAllowlist.length) blockers.push(`unused_policy_callsite_allowlist:${unusedPolicyCallsiteAllowlist[0]}`)
for (const row of splitReviewLineCounts) {
  if (row.lines > splitReviewBudget) blockers.push(`split_review_budget_exceeded:${row.file}:${row.lines}`)
}

const result = {
  schema: 'sks.gate-policy-audit.v1',
  ok: blockers.length === 0,
  release_gate_count: releaseGates.length,
  manifest_gate_count: gates.length,
  package_script_count: Object.keys(pkg.scripts || {}).length,
  split_review_budget_lines: splitReviewBudget,
  split_review_line_counts: splitReviewLineCounts,
  direct_codex_config_write_callsite_count: directCodexConfigWrites.length,
  direct_codex_config_write_callsites: directCodexConfigWrites.slice(0, 20),
  command_gate_contract: commandGateContract,
  direct_mkdtemp_callsite_count: directMkdtempCalls.length,
  direct_mkdtemp_callsites: directMkdtempCalls.slice(0, 20),
  policy_callsite_allowlist: { used: policyCallsiteAllowlistHits.size, unused: unusedPolicyCallsiteAllowlist },
  rust_tempdir_raii: { ok: rustTempdirCalls.length === 0, direct_tempdir_callsites: rustTempdirCalls.slice(0, 20) },
  blockers
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)

function gitTracked(pattern: string): string[] {
  try {
    const out = spawnSync('git', ['ls-files', pattern], { cwd: root, encoding: 'utf8' })
    return String(out.stdout || '').split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

function scanCommandGateContract() {
  const issues: string[] = []
  for (const [name, entry] of Object.entries(COMMANDS)) {
    if (entry.readonly === true && entry.skipMigrationGate !== true) issues.push(`${name}:readonly_without_skipMigrationGate`)
    if (entry.diagnostic === true && entry.allowedDuringActiveRoute !== true) issues.push(`${name}:diagnostic_without_active_route_allow`)
    if (entry.ownsGates === true && entry.mutatesRouteState !== true) issues.push(`${name}:ownsGates_without_mutatesRouteState`)
    if (entry.mutatesRouteState === true && (!Array.isArray(entry.ownedGateFiles) || entry.ownedGateFiles.length === 0)) issues.push(`${name}:route_mutator_without_owned_gate_files`)
    if (entry.allowedDuringActiveRoute === true && !entry.activeRoutePolicy) issues.push(`${name}:missing_active_route_policy`)
  }
  for (const required of ['help', 'version', 'commands', 'status', 'root', 'stop-gate', 'route', 'doctor']) {
    const entry = (COMMANDS as Record<string, any>)[required]
    if (!entry?.skipMigrationGate) issues.push(`${required}:missing_skipMigrationGate`)
  }
  for (const routeStarter of ['naruto', 'dfix', 'loop', 'qa-loop', 'research', 'autoresearch', 'mad-sks', 'ppt', 'image-ux-review', 'computer-use']) {
    const entry = (COMMANDS as Record<string, any>)[routeStarter]
    if (entry?.mutatesRouteState !== true) issues.push(`${routeStarter}:missing_route_state_mutator_contract`)
  }
  const goal = (COMMANDS as Record<string, any>).goal
  if (!goal) issues.push('goal:missing_native_goal_command_contract')
  if (goal?.mutatesRouteState === true || goal?.ownsGates === true || (goal?.ownedGateFiles?.length ?? 0) > 0) {
    issues.push('goal:native_goal_command_must_be_stateless')
  }
  for (const migrationBypass of ['check', 'gates', 'task', 'release', 'triwiki', 'daemon', 'pipeline', 'wiki', 'stop-gate']) {
    const entry = (COMMANDS as Record<string, any>)[migrationBypass]
    if (entry?.skipMigrationGate !== true) issues.push(`${migrationBypass}:missing_skip_migration_gate_contract`)
  }
  return { ok: issues.length === 0, issues }
}

function scanDirectMkdtempCalls() {
  const files = [
    ...walk(path.join(root, 'src', 'core')),
    ...walk(path.join(root, 'src', 'cli')),
    ...walk(path.join(root, 'src', 'commands')),
    ...walk(path.join(root, 'src', 'scripts'))
  ].filter((file) => file.endsWith('.ts'))
  const out: Array<{ file: string; line: number; text: string }> = []
  for (const file of files) {
    const rel = path.relative(root, file)
    if (rel === 'src/core/fsx.ts') continue
    if (/(?:__tests__|fixture|fixtures|bench|blackbox|check|probe|smoke|selftest|feature-commands|feature-probes)/i.test(rel)) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    let currentSymbol = 'module'
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || ''
      currentSymbol = policySymbolFromLine(line) || currentSymbol
      const match = line.match(/\b(mkdtemp(?:Sync)?)\s*\(/)
      if (match && !allowPolicyCallsite('mkdtemp', rel, currentSymbol, match[1]!)) out.push({ file: rel, line: index + 1, text: line.trim().slice(0, 220) })
    }
  }
  return out
}

function scanRustTempdirCalls() {
  const crateRoot = path.join(root, 'crates')
  const files = walk(crateRoot).filter((file) => file.endsWith('.rs'))
  const out: Array<{ file: string; line: number; text: string }> = []
  for (const file of files) {
    const rel = path.relative(root, file)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || ''
      if (/\b(?:std::env::temp_dir|tempfile::tempdir|TempDir::new|mktemp)\b/.test(line)) {
        out.push({ file: rel, line: index + 1, text: line.trim().slice(0, 220) })
      }
    }
  }
  return out
}

function lineCount(file: string): number {
  if (!fs.existsSync(file)) return 0
  const text = fs.readFileSync(file, 'utf8')
  if (!text) return 0
  return text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0)
}

function scanDirectCodexConfigWrites() {
  const files = [
    ...walk(path.join(root, 'src', 'core')),
    ...walk(path.join(root, 'src', 'cli')),
    ...walk(path.join(root, 'src', 'commands'))
  ].filter((file) => file.endsWith('.ts'))
  const out: Array<{ file: string; line: number; text: string }> = []
  for (const file of files) {
    const rel = path.relative(root, file)
    if (rel === 'src/core/codex/codex-config-guard.ts') continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    let currentSymbol = 'module'
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || ''
      currentSymbol = policySymbolFromLine(line) || currentSymbol
      if (!/\bwriteTextAtomic\s*\(/.test(line)) continue
      if (!/(?:config\.toml|configPath|candidate\.path|config\.path|userConfigPath|codexHomeConfigPath)/.test(line)) continue
      if (allowPolicyCallsite('codex_config_write', rel, currentSymbol, 'writeTextAtomic')) continue
      out.push({ file: rel, line: index + 1, text: line.trim().slice(0, 220) })
    }
  }
  return out
}

function allowPolicyCallsite(kind: string, file: string, symbol: string, token: string): boolean {
  const key = `${kind}|${file}|${symbol}|${token}`
  if (!policyCallsiteAllowlist.has(key)) return false
  policyCallsiteAllowlistHits.add(key)
  return true
}

function policySymbolFromLine(line: string): string | null {
  return line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/)?.[1]
    || line.match(/class\s+([A-Za-z0-9_$]+)/)?.[1]
    || null
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(file))
    else out.push(file)
  }
  return out
}
