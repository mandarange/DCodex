#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { runProcess } = await importDist('core/fsx.js')

const scenarios = [
  { name: 'no-state', prompt: 'hello', budget_p95_ms: 230 },
  { name: 'active-route', prompt: 'continue current route', budget_p95_ms: 230, state: { mission_id: 'M-active', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', phase: 'EXECUTE', implementation_allowed: true } },
  { name: 'stale-code-pack-note', prompt: 'status?', budget_p95_ms: 230, files: { '.sneakoscope/wiki/code-pack.json': JSON.stringify({ generated_at: '2000-01-01T00:00:00.000Z' }) } },
  { name: 'no-question-queue', prompt: 'can I interrupt?', budget_p95_ms: 230, state: { mission_id: 'M-noq', mode: 'RESEARCH', phase: 'RESEARCH_RUNNING_NO_QUESTIONS' } },
  { name: 'clarification-awaiting', prompt: 'here is the answer', budget_p95_ms: 230, state: { mission_id: 'M-clarify', mode: 'NARUTO', phase: 'CLARIFICATION_AWAITING_ANSWERS', stop_gate: 'clarification-gate', ambiguity_gate_required: true, clarification_required: true, implementation_allowed: false } },
  { name: 'super-search-prompt', prompt: '$Super-Search run "npm release notes"', budget_p95_ms: 420 },
  { name: 'question-shaped-work-request', prompt: 'Can you fix the failing tests?', budget_p95_ms: 420 }
]

const warmups = Number(process.env.SKS_HOOK_LATENCY_WARMUPS || 2)
const runs = Number(process.env.SKS_HOOK_LATENCY_RUNS || 15)
const report = await runHookScenarios()
const out = path.join(root, '.sneakoscope', 'reports', 'hook-latency-quantum.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
assertGate(report.ok, 'hook_latency_quantum_failed', report)
emitGate('hook:latency-quantum', { scenarios: report.scenarios.length, report: '.sneakoscope/reports/hook-latency-quantum.json' })

async function runHookScenarios() {
  const scenarioResults = []
  const blockers = []
  for (const scenario of scenarios) {
    const result = await runOne(scenario)
    scenarioResults.push(result)
    if (result.failures.length) blockers.push(`${scenario.name}:process_failed`)
    if (result.p95_ms > result.budget_p95_ms) blockers.push(`${scenario.name}:p95_budget_exceeded`)
  }
  return {
    schema: 'sks.hook-latency-quantum.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    warmup_runs: warmups,
    measure_runs: runs,
    scenarios: scenarioResults,
    blockers
  }
}

async function runOne(scenario) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `sks-hook-${scenario.name}-`))
  try {
    seedRoot(tmp, scenario)
    const durations = []
    const failures = []
    for (let i = 0; i < warmups + runs; i++) {
      const phase = i < warmups ? 'warmup' : 'measure'
      const measured = await timed(tmp, scenario, phase === 'measure' ? i - warmups + 1 : i + 1, phase)
      if (phase === 'measure') durations.push(measured.duration_ms)
      if (measured.code !== 0) failures.push(measured)
    }
    durations.sort((a, b) => a - b)
    const p95 = percentile(durations, 0.95)
    const p50 = percentile(durations, 0.5)
    return {
      name: scenario.name,
      runs,
      p50_ms: p50,
      p95_ms: p95,
      budget_p95_ms: scenario.budget_p95_ms,
      ok: failures.length === 0 && p95 <= scenario.budget_p95_ms,
      failures
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function timed(tmp, scenario, run, phase) {
  const started = performance.now()
  const payload = JSON.stringify({ prompt: scenario.prompt, cwd: tmp, conversation_id: `quantum-${scenario.name}` })
  const res = await runProcess(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), 'hook', 'user-prompt-submit'], {
    cwd: tmp,
    input: payload,
    timeoutMs: 10000,
    maxOutputBytes: 64 * 1024,
    env: { SKS_DISABLE_NETWORK: '1', SKS_PERF_MEASURE: '1', SKS_DISABLE_UPDATE_CHECK: '1' }
  })
  return {
    run,
    phase,
    code: res.code,
    duration_ms: Math.round(performance.now() - started),
    stderr_tail: String(res.stderr || '').slice(-4000)
  }
}

function seedRoot(tmp, scenario) {
  fs.mkdirSync(path.join(tmp, '.sneakoscope', 'state', 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(tmp, '.sneakoscope', 'missions'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"hook-latency-fixture","type":"module"}\n')
  if (scenario.state) {
    const state = { ...scenario.state, _session_key: 'quantum', updated_at: new Date().toISOString() }
    fs.writeFileSync(path.join(tmp, '.sneakoscope', 'state', 'current.json'), `${JSON.stringify(state, null, 2)}\n`)
    const missionId = String(scenario.state.mission_id || '')
    if (missionId) {
      const dir = path.join(tmp, '.sneakoscope', 'missions', missionId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'mission.json'), `${JSON.stringify({ id: missionId, mode: scenario.state.mode || 'NARUTO', created_at: new Date().toISOString() }, null, 2)}\n`)
    }
  }
  for (const [rel, text] of Object.entries(scenario.files || {})) {
    const file = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${text}\n`)
  }
}

function percentile(values, pct) {
  if (!values.length) return 0
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * pct) - 1))
  return values[index] || 0
}
