import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { flag } from '../../cli/args.js'
import { printJson } from '../../cli/output.js'
import { projectRoot } from '../fsx.js'
import { GATE_RESULT_CONTRACT, evaluateGateProcessOutput } from './gate-result-contract.js'

const CHECK_SCHEMA = 'sks.check.v1'

export async function checkCommand(args: string[] = []): Promise<unknown> {
  const root = await projectRoot()
  const tier = readArg(args, '--tier', positionalTier(args) || 'confidence')
  const sla = readArg(args, '--sla', '5m')
  const changedSince = readArg(args, '--changed-since', 'auto')
  const json = flag(args, '--json')
  const planOnly = flag(args, '--plan')
  const triwiki = !flag(args, '--no-triwiki')

  const plan = buildCheckPlan({ tier, sla, changedSince, triwiki })
  if (planOnly) {
    const result = { schema: CHECK_SCHEMA, ok: true, mode: 'plan', ...plan }
    if (json) return printJson(result)
    printPlan(result)
    return result
  }

  const steps: Array<{ name: string; ok: boolean; status: number | null; stderr_tail: string; reason?: string; contract?: string; gate_result?: any }> = []
  let proofBankSummary: any | null = null
  for (const step of plan.steps) {
    const result = spawnSync(step.command, step.args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      shell: false,
      env: { ...process.env, CI: process.env.CI || 'true' }
    })
    const stdout = String(result.stdout || '')
    let ok = result.status === 0
    let reason: string | undefined
    let contract: string | undefined
    let gateResult: any | null = null
    if (step.name === 'proof-bank-summary') {
      proofBankSummary = parseJsonObject(stdout)
      if (!proofBankSummary) {
        ok = false
        reason = 'invalid_json_output'
      }
    }
    if (step.output_contract === GATE_RESULT_CONTRACT) {
      const gateEval = evaluateGateProcessOutput({ status: result.status, stdout })
      ok = gateEval.ok
      reason = gateEval.reason
      contract = gateEval.contract
      gateResult = gateEval.gate_result
    }
    steps.push({
      name: step.name,
      ok,
      status: result.status,
      stderr_tail: tail(String(result.stderr || '')),
      ...(reason ? { reason } : {}),
      ...(contract ? { contract } : {}),
      ...(gateResult ? { gate_result: gateResult } : {})
    })
    if (!json) {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
    }
    if (!ok) {
      const failed = { schema: CHECK_SCHEMA, ok: false, mode: 'run', ...plan, steps, completion_certificate: latestCertificate(root) || proofBankSummary?.completion_certificate || null, release_speed_summary: proofBankSummary }
      if (json) return printJson(failed)
      process.exitCode = result.status || 1
      return failed
    }
  }

  const result = { schema: CHECK_SCHEMA, ok: true, mode: 'run', ...plan, steps, completion_certificate: latestCertificate(root) || proofBankSummary?.completion_certificate || null, release_speed_summary: proofBankSummary }
  if (json) return printJson(result)
  if (result.completion_certificate) {
    console.log(`SKS check certificate: ${result.completion_certificate.confidence} sla_met=${result.completion_certificate.sla_met}`)
  }
  return result
}

function buildCheckPlan(input: { tier: string; sla: string; changedSince: string; triwiki: boolean }) {
  const tier = normalizeTier(input.tier)
  const buildScript = tier === 'release' ? 'build:clean' : 'build:incremental'
  const steps: Array<{ name: string; command: string; args: string[]; output_contract?: string }> = []
  if (tier === 'instant') {
    steps.push({ name: 'proof-bank-summary', command: process.execPath, args: ['dist/scripts/release-speed-summary.js'] })
  } else if (tier === 'real-check') {
    steps.push({ name: 'real-check', command: process.execPath, args: ['dist/scripts/release-real-check.js'] })
  } else {
    steps.push({ name: buildScript, command: 'npm', args: ['run', buildScript, '--silent'] })
    steps.push({ name: `release:${tier}`, command: process.execPath, args: dagArgs(tier, input.changedSince, input.sla), output_contract: GATE_RESULT_CONTRACT })
  }
  return {
    tier,
    sla: input.sla,
    triwiki: input.triwiki,
    changed_since: input.changedSince,
    build_once: tier === 'release' ? 'clean' : tier === 'real-check' || tier === 'instant' ? 'not_applicable' : 'incremental',
    steps
  }
}

function dagArgs(tier: string, changedSince: string, sla: string): string[] {
  if (tier === 'release') return ['dist/scripts/release-gate-dag-runner.js', '--preset', 'release', '--full']
  const preset = tier === 'instant' ? 'fast' : tier === 'affected' || tier === 'confidence' ? 'affected' : tier
  return ['dist/scripts/release-gate-dag-runner.js', '--preset', preset, '--changed-since', changedSince, '--sla', sla]
}

function latestCertificate(root: string): any | null {
  const direct = path.join(root, '.sneakoscope', 'reports', 'completion-certificate.json')
  if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8'))
  const base = path.join(root, '.sneakoscope', 'reports', 'release-gates')
  if (!fs.existsSync(base)) return null
  const latest = fs.readdirSync(base)
    .map((name) => path.join(base, name, 'completion-certificate.json'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  return latest ? JSON.parse(fs.readFileSync(latest, 'utf8')) : null
}

function normalizeTier(value: string): string {
  const tier = String(value || '').trim().toLowerCase()
  if (['instant', 'affected', 'confidence', 'release', 'real-check'].includes(tier)) return tier
  return 'confidence'
}

function positionalTier(args: string[]): string | null {
  const first = args.find((arg) => !arg.startsWith('-'))
  return first || null
}

function readArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : fallback
}

function tail(value: string, limit = 1200): string {
  return value.length > limit ? value.slice(-limit) : value
}

function parseJsonObject(value: string): any | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function printPlan(result: any): void {
  console.log(`SKS check plan: tier=${result.tier} sla=${result.sla} build=${result.build_once}`)
  for (const step of result.steps) console.log(`- ${step.name}: ${[step.command, ...step.args].join(' ')}`)
}
