#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-open-worker-pane-'))
const missionId = 'M-zellij-open-worker-pane'
const sessionName = 'sks-open-worker-pane-fixture'
const workers = 32
const visible = 8
const workerSleepMs = 3000
const events = []
const pids = new Set()
let active = 0
let maxActive = 0
const started = Date.now()

process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
process.env.SKS_ZELLIJ_FAKE_ROOT = tmp
process.env.SKS_ZELLIJ_FAKE_DELAY_MS = '300'
process.env.SKS_ZELLIJ_FAKE_VERSION = '0.43.1'
process.env.SKS_ZELLIJ_WORKER_STACKED = '1'

const { openWorkerPane } = await importDist('core/zellij/zellij-worker-pane-manager.js')
const runs = Array.from({ length: workers }, (_, index) => runWorker(index + 1))
const records = await Promise.all(runs)
const wall = Date.now() - started
const visibleRecords = records.filter(Boolean)
const calls = await readJsonl(path.join(tmp, '.sneakoscope', 'fake-zellij-calls.jsonl'))
const metrics = await readJsonl(path.join(tmp, '.sneakoscope', 'missions', missionId, 'zellij', 'pane-creation-lock-events.jsonl'))
const anchorCalls = calls.filter((row) => row.args.includes('--name') && row.args.includes('SLOTS'))
const stackedCalls = calls.filter((row) => row.args.includes('--stacked'))
const stackPaneCalls = calls.filter((row) => row.args.includes('stack-panes'))
const workerArtifacts = await Promise.all(visibleRecords.map((record) => readJson(path.join(tmp, record.worker_artifact_dir, 'zellij-worker-pane.json'))))
const stackedWorkerArtifacts = workerArtifacts.filter((row) => row.worker_stacked_requested === true)
const lastPaneCreated = Math.max(...events.filter((event) => event.type === 'zellij_pane_created').map((event) => event.at))
const firstSpawn = Math.min(...events.filter((event) => event.type === 'worker_process_spawned').map((event) => event.at))

assertGate(visibleRecords.length === visible, 'visible openWorkerPane records missing', { visibleRecords: visibleRecords.length })
assertGate(workerArtifacts.every((row) => row?.schema === 'sks.zellij-worker-pane.v1'), 'openWorkerPane must write zellij-worker-pane.json artifacts', workerArtifacts)
assertGate(anchorCalls.length === 1, 'exactly one SLOTS anchor must be created', { anchorCalls })
assertGate(new Set(anchorCalls.map((row) => JSON.stringify(row.args))).size === 1, 'SLOTS anchor must not be created N side-by-side times', { anchorCalls })
assertGate(metrics.length >= visible, 'pane lock metrics must cover visible panes', { metrics: metrics.length })
assertGate(firstSpawn <= lastPaneCreated, 'worker processes must spawn before all pane creation finishes', { firstSpawn, lastPaneCreated })
assertGate(maxActive >= workers, 'worker process execution must not be serialized by pane lock', { maxActive })
assertGate(pids.size >= workers, 'unique worker process PIDs must reach requested worker count', { pids: pids.size })
assertGate(wall < 9000, 'openWorkerPane integration wall time must stay below 9s', { wall })
assertGate(stackedCalls.length >= visible - 1, 'second+ visible workers must request native stacked panes on fake zellij >=0.43', { stackedCalls: stackedCalls.length })
assertGate(stackPaneCalls.length >= visible - 1, 'second+ visible workers must reconcile native stacked panes with stack-panes', { stackPaneCalls: stackPaneCalls.length })
assertGate(stackedWorkerArtifacts.length >= visible - 1, 'second+ visible worker artifacts must record stacked requested', workerArtifacts)
assertGate(stackedWorkerArtifacts.every((row) => row.worker_stacked_applied === true), 'second+ visible worker artifacts must record stacked applied', workerArtifacts)

emitGate('zellij:pane-lock-open-worker-integration', {
  wall_ms: wall,
  max_active_workers: maxActive,
  unique_pids: pids.size,
  visible_panes: visibleRecords.length,
  stacked_calls: stackedCalls.length,
  stack_panes_calls: stackPaneCalls.length,
  pane_lock_metrics: metrics.length
})

async function runWorker(slot) {
  const child = spawn(process.execPath, ['-e', `setTimeout(()=>process.exit(0), ${workerSleepMs})`], { stdio: 'ignore' })
  active += 1
  maxActive = Math.max(maxActive, active)
  if (child.pid) pids.add(child.pid)
  events.push({ type: 'worker_process_spawned', slot, at: Date.now() - started, pid: child.pid || null })
  const paneTask = slot <= visible
    ? openWorkerPane(workerInput(slot)).then((record) => {
        events.push({ type: 'zellij_pane_created', slot, at: Date.now() - started, pane_id: record.pane_id })
        return record
      })
    : Promise.resolve(null)
  const [, record] = await Promise.all([
    new Promise((resolve) => child.on('close', resolve)),
    paneTask
  ])
  active -= 1
  return record
}

function workerInput(slot) {
  const slotId = `slot-${String(slot).padStart(3, '0')}`
  const workerDir = path.join('sessions', slotId, 'gen-1', 'worker')
  return {
    root: tmp,
    cwd: tmp,
    projectRoot: tmp,
    missionId,
    sessionName,
    slotId,
    generationIndex: 1,
    sessionId: `${slotId}-gen-1`,
    workerArtifactDir: workerDir,
    resultPath: path.join(workerDir, 'worker-result.json'),
    heartbeatPath: path.join(workerDir, 'worker-heartbeat.jsonl'),
    patchEnvelopePath: path.join(workerDir, 'worker-patch-envelope.json'),
    stdoutLog: path.join(workerDir, 'worker.stdout.log'),
    stderrLog: path.join(workerDir, 'worker.stderr.log'),
    workerCommand: `node -e "setTimeout(()=>{}, ${workerSleepMs})"`,
    providerContext: providerContext(),
    serviceTier: 'fast',
    backend: 'codex-sdk',
    statusLabel: 'running',
    rightColumnMode: 'spawn-on-first-worker',
    visiblePaneCap: visible,
    uiMode: 'compact-slots'
  }
}

function providerContext() {
  return {
    schema: 'sks.provider-context.v1',
    generated_at: new Date().toISOString(),
    provider: 'codex-lb',
    auth_mode: 'codex_lb_key',
    route: '$Naruto',
    service_tier: 'fast',
    source: 'fixture',
    confidence: 'high',
    conflict: false,
    warnings: [],
    signals: {
      openai_api_key_present: false,
      codex_lb_key_present: true,
      codex_lb_explicit: true,
      codex_app_auth_present: false,
      model_provider: 'codex-lb'
    }
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line))
}
