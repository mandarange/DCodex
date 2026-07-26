#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-fallback-'))
const missionId = 'M-zellij-stacked-fallback'
const sessionName = 'sks-stacked-fallback-fixture'
process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
process.env.SKS_ZELLIJ_FAKE_ROOT = tmp
process.env.SKS_ZELLIJ_FAKE_DELAY_MS = '10'
process.env.SKS_ZELLIJ_FAKE_VERSION = '0.42.2'
process.env.SKS_ZELLIJ_WORKER_STACKED = '1'

const { openWorkerPane } = await importDist('core/zellij/zellij-worker-pane-manager.js')
const records = []
for (let slot = 1; slot <= 3; slot += 1) records.push(await openWorkerPane(workerInput(slot)))
const calls = await readJsonl(path.join(tmp, '.sneakoscope', 'fake-zellij-calls.jsonl'))
const stackedCalls = calls.filter((row) => row.args.includes('--stacked'))

assertGate(records.every((row) => row.ok === true), 'fallback integration workers must still run', records)
assertGate(stackedCalls.length === 0, 'Zellij <0.43 fallback path must not call --stacked', stackedCalls)
assertGate(records.slice(1).every((row) => row.worker_stacked_requested === true), 'second+ workers must record stacked intent', records)
assertGate(records.slice(1).every((row) => row.worker_stacked_applied === false), 'fallback workers must record stacked_applied=false', records)
assertGate(records.slice(1).every((row) => row.worker_stacked_fallback_mode === 'down-split-stack-emulation'), 'fallback mode must be down-split-stack-emulation', records)
emitGate('zellij:stacked-fallback-integration', { workers: records.length, stacked_calls: stackedCalls.length })

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
    workerCommand: 'node -e "setTimeout(()=>{}, 100)"',
    providerContext: providerContext(),
    serviceTier: 'fast',
    backend: 'codex-sdk',
    statusLabel: 'running',
    rightColumnMode: 'spawn-on-first-worker',
    visiblePaneCap: 3,
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

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line))
}
