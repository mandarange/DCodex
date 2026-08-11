#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'
import {
  evaluateHighRiskCliSmokeResult,
  evaluateHighRiskFixtures,
  HIGH_RISK_CONTRACT_REPORT_SCHEMA,
  highRiskCliNegativeSmokeSpecs,
  highRiskNegativeFixtures
} from '../core/security/high-risk-contracts.js'

const runtimeHelpers = fs.readFileSync(`${root}/src/core/super-search/runtime-helpers.ts`, 'utf8')
assertGate(runtimeHelpers.includes('evaluateUrlFetchPolicy'), 'Super-Search fetch must use a URL fetch policy preflight')
assertGate(runtimeHelpers.includes('direct_url_fetch_ssrf_blocked'), 'Super-Search fetch must report SSRF blocks')
assertGate(runtimeHelpers.includes('127') && runtimeHelpers.includes('192') && runtimeHelpers.includes('169'), 'SSRF policy must cover local/private IPv4 ranges')
assertGate(runtimeHelpers.includes("lower === '::1'") && runtimeHelpers.includes("lower.startsWith('fc')") && runtimeHelpers.includes("lower.startsWith('fe80:')"), 'SSRF policy must cover local/private IPv6 ranges')

const { runSuperSearch } = await importDist('core/super-search/index.js')
const missionDir = await fs.promises.mkdtemp('/tmp/sks-high-risk-super-search-')
const blocked = await runSuperSearch({
  missionDir,
  query: 'http://127.0.0.1:1/docs',
  mode: 'url_acquisition',
  env: {}
})
assertGate(blocked.ok === false, 'Super-Search fetch must fail closed for private/local URLs by default', blocked)
assertGate(blocked.blockers.some((entry) => String(entry).includes('direct_url_fetch_ssrf_blocked')), 'blocked fetch must include SSRF blocker', blocked.blockers)

const negativeFixtures = highRiskNegativeFixtures()
const negativeResults = evaluateHighRiskFixtures(negativeFixtures)
for (const target of new Set(negativeFixtures.map((fixture) => fixture.target))) {
  const targetResults = negativeResults.filter((result) => result.target === target)
  assertGate(targetResults.some((result) => result.blocked === true), `missing high-risk negative fixture coverage: ${target}`, targetResults)
}
assertGate(
  negativeResults.every((result) => result.ok !== true && result.status === 'blocked_expected' && result.blocked === true),
  'high-risk negative checks must block without ok:true',
  negativeResults
)

const cliSmokeSpecs = highRiskCliNegativeSmokeSpecs()
const cliNegativeSmokes = []
for (const spec of cliSmokeSpecs) {
  const run = await runCliNegativeSmoke(spec)
  cliNegativeSmokes.push(evaluateHighRiskCliSmokeResult(spec, run))
}
const reportBlockers = []
for (const target of new Set(cliSmokeSpecs.map((spec) => spec.target))) {
  const targetResults = cliNegativeSmokes.filter((result) => result.target === target)
  if (!targetResults.some((result) => result.blocked === true)) reportBlockers.push(`missing_cli_negative_smoke:${target}`)
}
for (const result of cliNegativeSmokes) {
  if (result.blocked !== true || result.blockers.length === 0) reportBlockers.push(`cli_negative_smoke_not_blocked:${result.target}`)
}

const report = {
  schema: HIGH_RISK_CONTRACT_REPORT_SCHEMA,
  ok: reportBlockers.length === 0,
  generated_at: new Date().toISOString(),
  super_search_ssrf_default_block: true,
  static_preflight: true,
  static_fixtures: negativeResults,
  cli_negative_smokes: cliNegativeSmokes,
  blockers: reportBlockers
}
const out = path.join(root, '.sneakoscope', 'reports', 'high-risk-contracts.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

assertGate(
  report.ok,
  'high-risk CLI negative smokes must reach a real blocking/no-mutation condition',
  { blockers: reportBlockers, cli_negative_smokes: cliNegativeSmokes, report: '.sneakoscope/reports/high-risk-contracts.json' }
)

emitGate('security:high-risk-contracts', {
  super_search_ssrf_default_block: true,
  static_preflight: true,
  static_fixture_count: negativeResults.length,
  cli_negative_smoke_count: cliNegativeSmokes.length,
  report: '.sneakoscope/reports/high-risk-contracts.json'
})

async function runCliNegativeSmoke(spec: any) {
  assertGate(fs.existsSync(path.join(root, 'dist', 'bin', 'sks.js')), 'dist/bin/sks.js missing for high-risk CLI negative smokes', { hint: 'run npm run build first' })
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sks-high-risk-cli-'))
  const cwd = path.join(tempRoot, 'workspace')
  const home = path.join(tempRoot, 'home')
  await fs.promises.mkdir(cwd, { recursive: true })
  await fs.promises.mkdir(home, { recursive: true })
  await fs.promises.mkdir(path.join(cwd, '.sneakoscope'), { recursive: true })
  await prepareSmokeWorkspace(spec, cwd, home)
  const before = await smokeBefore(spec, cwd, home)
  const result = await runNodeSks(spec.argv.slice(1), {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      SKS_GLOBAL_ROOT: path.join(tempRoot, 'global-sks'),
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
      SKS_DISABLE_UPDATE_CHECK: '1',
      SKS_UPDATE_QUIET: '1'
    }
  })
  const after = await smokeAfter(spec, cwd, home)
  if (spec.target === 'doctor --fix' && before.userConfigText === after.userConfigText) {
    result.diagnostics = { doctor_config: doctorConfigCompare(before.userConfigText, after.userConfigText) }
    result.stdout = `${result.stdout}\nuser_owned_file_without_sks_marker user_config_unchanged ${doctorConfigCompareLine(before.userConfigText, after.userConfigText)}`
  } else if (spec.target === 'doctor --fix') {
    result.diagnostics = { doctor_config: doctorConfigCompare(before.userConfigText, after.userConfigText) }
    result.stdout = `${result.stdout}\ndoctor_touched_user_owned_file_without_sks_marker ${doctorConfigCompareLine(before.userConfigText, after.userConfigText)} after_excerpt=${JSON.stringify(String(after.userConfigText || '').slice(0, 200))}`
  }
  return result
}

async function prepareSmokeWorkspace(spec: any, cwd: string, home: string) {
  if (spec.target === 'commit-and-push') {
    await runProcess('git', ['init', '-q'], { cwd })
    await runProcess('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd })
    await runProcess('git', ['config', 'user.name', 'SKS Smoke'], { cwd })
    await fs.promises.writeFile(path.join(cwd, 'smoke.txt'), 'smoke\n')
  }
  if (spec.target === 'doctor --fix') {
    await fs.promises.mkdir(path.join(cwd, '.codex'), { recursive: true })
    await fs.promises.writeFile(path.join(cwd, '.codex', 'config.toml'), 'user_config = true\n')
    await fs.promises.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.promises.writeFile(path.join(home, '.codex', 'config.toml'), 'user_home_config = true\n')
  }
}

async function smokeBefore(spec: any, cwd: string, _home: string) {
  if (spec.target !== 'doctor --fix') return {}
  return { userConfigText: await fs.promises.readFile(path.join(cwd, '.codex', 'config.toml'), 'utf8') }
}

async function smokeAfter(spec: any, cwd: string, _home: string) {
  if (spec.target !== 'doctor --fix') return {}
  return { userConfigText: await fs.promises.readFile(path.join(cwd, '.codex', 'config.toml'), 'utf8').catch(() => '') }
}

function runNodeSks(args: string[], opts: any) {
  return runProcess(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), ...args], opts)
}

function runProcess(command: string, args: string[], opts: any = {}) {
  return new Promise<any>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const maxBytes = 128 * 1024
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, opts.timeoutMs || 45_000)
    child.stdout.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk, maxBytes)
    })
    child.stderr.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk, maxBytes)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exit_code: code, stdout, stderr, timed_out: timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exit_code: 1, stdout, stderr: `${stderr}\n${err.message}`, timed_out: timedOut })
    })
  })
}

function boundedAppend(current: string, chunk: Buffer, maxBytes: number) {
  const next = current + chunk.toString('utf8')
  return Buffer.byteLength(next) > maxBytes ? next.slice(-maxBytes) : next
}

function doctorConfigCompareLine(before: any, after: any) {
  const compare = doctorConfigCompare(before, after)
  return `before_len=${compare.before_len} after_len=${compare.after_len} before_sha=${compare.before_sha} after_sha=${compare.after_sha}`
}

function doctorConfigCompare(before: any, after: any) {
  const beforeText = String(before || '')
  const afterText = String(after || '')
  return {
    unchanged: beforeText === afterText,
    before_len: Buffer.byteLength(beforeText),
    after_len: Buffer.byteLength(afterText),
    before_sha: sha(beforeText),
    after_sha: sha(afterText),
    after_excerpt: afterText.slice(0, 200)
  }
}

function sha(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}
