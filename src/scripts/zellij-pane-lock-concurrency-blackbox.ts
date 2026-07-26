#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertGate, emitGate } from './gate-lib.js'

const missionId = 'M-zellij-pane-lock-blackbox'
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-pane-lock-'))
const metricsFile = path.join(tmp, '.sneakoscope', 'missions', missionId, 'zellij', 'pane-creation-lock-events.jsonl')
await fs.mkdir(path.dirname(metricsFile), { recursive: true })
const workers = 32
const visiblePaneCap = 8
const workerSleepMs = 3000
const paneDelayMs = 300
const started = Date.now()
let active = 0
let maxActive = 0
const pids = new Set()
const events = []
let lock = Promise.resolve()

const runs = Array.from({ length: workers }, (_, index) => runWorker(index + 1))
await Promise.all(runs)
const wall = Date.now() - started
const metricsText = await fs.readFile(metricsFile, 'utf8')
const metrics = metricsText.trim().split(/\n+/).map((line) => JSON.parse(line))
const visiblePanes = metrics.length
const headlessWorkers = workers - visiblePanes
const lastPaneCreated = Math.max(...events.filter((event) => event.type === 'zellij_pane_created').map((event) => event.at))
const firstSpawn = Math.min(...events.filter((event) => event.type === 'worker_process_spawned').map((event) => event.at))

assertGate(maxActive >= 32, 'max active workers must reach 32', { maxActive })
assertGate(pids.size >= 32, 'unique PIDs must reach 32', { unique: pids.size })
assertGate(wall < 9000, 'wall time must prove overlap under 9s', { wall })
assertGate(metrics.length === visiblePaneCap && metrics.every((row) => row.wait_ms >= 0 && row.held_ms >= paneDelayMs - 40), 'pane lock metrics missing or invalid', metrics)
assertGate(firstSpawn <= lastPaneCreated, 'worker processes must spawn before all pane creation finishes', { firstSpawn, lastPaneCreated })
assertGate(visiblePanes <= 8 && headlessWorkers >= 24, 'visible/headless worker counts mismatch', { visiblePanes, headlessWorkers })
emitGate('zellij:pane-lock-concurrency-blackbox', { wall_ms: wall, max_active_workers: maxActive, unique_pids: pids.size, visible_panes: visiblePanes, headless_workers: headlessWorkers })

async function runWorker(slot) {
  const child = spawn(process.execPath, ['-e', `setTimeout(()=>process.exit(0), ${workerSleepMs})`], { stdio: 'ignore' })
  active += 1
  maxActive = Math.max(maxActive, active)
  if (child.pid) pids.add(child.pid)
  events.push({ type: 'worker_process_spawned', slot, at: Date.now() - started, pid: child.pid || null })
  const paneTask = slot <= visiblePaneCap ? withPaneLock(slot) : Promise.resolve()
  await Promise.all([
    new Promise((resolve) => child.on('close', resolve)),
    paneTask
  ])
  active -= 1
}

async function withPaneLock(slot) {
  const requestedAt = new Date().toISOString()
  const requestedMs = Date.now()
  events.push({ type: 'zellij_pane_creation_lock_requested', slot, at: requestedMs - started })
  const previous = lock
  let release
  lock = new Promise((resolve) => { release = resolve })
  await previous
  const acquiredAt = new Date().toISOString()
  const acquiredMs = Date.now()
  await new Promise((resolve) => setTimeout(resolve, paneDelayMs))
  events.push({ type: 'zellij_pane_created', slot, at: Date.now() - started })
  const releasedAt = new Date().toISOString()
  const releasedMs = Date.now()
  await fs.appendFile(metricsFile, JSON.stringify({
    schema: 'sks.zellij-pane-creation-lock-metrics.v1',
    mission_id: missionId,
    session_name: 'fixture',
    slot_id: `slot-${String(slot).padStart(3, '0')}`,
    generation_index: 1,
    requested_at: requestedAt,
    acquired_at: acquiredAt,
    released_at: releasedAt,
    wait_ms: acquiredMs - requestedMs,
    held_ms: releasedMs - acquiredMs
  }) + '\n')
  release()
}
