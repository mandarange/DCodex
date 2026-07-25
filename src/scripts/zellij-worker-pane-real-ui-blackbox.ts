#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { assertGate, emitGate, readText, root } from './gate-lib.js'
import { ensureDistFresh } from './lib/ensure-dist-fresh.js'

const requireReal = process.env.SKS_REQUIRE_ZELLIJ === '1' || process.argv.includes('--require-real')
const manager = readText('src/core/zellij/zellij-worker-pane-manager.ts')
const schema = readText('src/core/agents/agent-schema.ts')
const runtime = readText('src/core/agents/native-cli-worker-runtime.ts')
assertGate(manager.includes('action') && manager.includes('new-pane'), 'worker pane manager must call zellij action new-pane')
assertGate(manager.includes('list-panes') && manager.includes('dump-screen'), 'worker pane proof must reconcile real list-panes/dump-screen evidence')
assertGate(schema.includes('AgentWorkerPlacement') && runtime.includes("placement === 'zellij-pane'"), 'worker placement must control Zellij panes independently of backend')
if (!requireReal) {
  emitGate('zellij:worker-pane-real-ui:blackbox', { real_required: false, proof_mode: 'source_contract' })
  process.exit(0)
}
const { spawnSync } = await import('node:child_process')
const available = spawnSync('zellij', ['--version'], { encoding: 'utf8' })
assertGate(available.status === 0, 'SKS_REQUIRE_ZELLIJ=1 requires zellij binary', { stderr: available.stderr })
const freshness = ensureDistFresh({ rebuild: false })
assertGate(freshness.ok === true, 'dist must be fresh before real Zellij worker-pane blackbox', freshness)

const zellij = await import(pathToFileURL(path.join(root, 'dist', 'core', 'zellij', 'zellij-command.js')).href)
const workerPane = await import(pathToFileURL(path.join(root, 'dist', 'core', 'zellij', 'zellij-worker-pane-manager.js')).href)
const missionId = `M-zellij-worker-pane-real-${Date.now()}`
const sessionName = `sks-worker-pane-real-${process.pid}`
const ledgerRoot = path.join(root, '.sneakoscope', 'missions', missionId, 'agents')
fs.rmSync(path.join(root, '.sneakoscope', 'missions', missionId), { recursive: true, force: true })
fs.mkdirSync(ledgerRoot, { recursive: true })
await zellij.runZellij(['kill-session', sessionName], { cwd: root, timeoutMs: 5000, optional: true })

const attachedClient = startAttachedZellijClient(sessionName)
await sleep(1500)
await zellij.runZellij(['--session', sessionName, 'action', 'send-keys', 'Esc'], { cwd: root, timeoutMs: 5000, optional: true })
await sleep(250)
const before = await zellij.runZellij(['--session', sessionName, 'action', 'list-panes', '--json', '--all'], { cwd: root, timeoutMs: 5000, optional: true })
const beforeCount = parsePaneRows(before.stdout_tail).length
const beforeTerminalCount = parsePaneRows(before.stdout_tail).filter((row) => row && row.is_plugin !== true).length
const records = []
try {
  for (let index = 1; index <= 3; index += 1) {
    const slotId = `slot-${String(index).padStart(3, '0')}`
    const workerDir = path.join('sessions', slotId, 'gen-1', 'worker')
    const absWorkerDir = path.join(ledgerRoot, workerDir)
    fs.mkdirSync(absWorkerDir, { recursive: true })
    const heartbeatRel = path.join(workerDir, 'worker-heartbeat.jsonl')
    const resultRel = path.join(workerDir, 'worker-result.json')
    const stdoutRel = path.join(workerDir, 'worker.stdout.log')
    const stderrRel = path.join(workerDir, 'worker.stderr.log')
    const heartbeatAbs = path.join(ledgerRoot, heartbeatRel)
    const resultAbs = path.join(ledgerRoot, resultRel)
    const backend = index === 1 ? 'codex-sdk' : index === 2 ? 'local-llm' : 'python-codex-sdk'
    const expectedTitle = `${slotId}/gen-1 · WT:WT-${String(index).padStart(4, '0')} · branch:fixture · ${backend} · fast · codex-lb · active`
    const workerScript = [
      "const fs=require('fs');",
      `fs.appendFileSync(${JSON.stringify(heartbeatAbs)}, JSON.stringify({ok:true, slot:${JSON.stringify(slotId)}, ts:new Date().toISOString()})+'\\n');`,
      `fs.writeFileSync(${JSON.stringify(resultAbs)}, JSON.stringify({schema:'sks.agent-result.v1', status:'done', slot:${JSON.stringify(slotId)}, heartbeat_seen:true}, null, 2)+'\\n');`,
      "setTimeout(()=>process.exit(0), 30000);"
    ].join('')
    const record = await workerPane.openWorkerPane({
      root: ledgerRoot,
      missionId,
      sessionName,
      slotId,
      generationIndex: 1,
      sessionId: `${slotId}-gen-1`,
      workerArtifactDir: workerDir,
      workerCommand: `printf ${shellQuote(`\u001b]2;${expectedTitle}\u0007`)}; ${process.execPath} -e ${shellQuote(workerScript)}`,
      resultPath: resultRel,
      heartbeatPath: heartbeatRel,
      patchEnvelopePath: path.join(workerDir, 'worker-patch-envelope.json'),
      stdoutLog: stdoutRel,
      stderrLog: stderrRel,
      cwd: root,
      serviceTier: 'fast',
      backend,
      statusLabel: 'active',
      worktree: { id: `WT-${String(index).padStart(4, '0')}`, path: root, branch: 'fixture' }
    })
    records.push(record)
  }
  await sleep(750)
  const listed = await zellij.runZellij(['--session', sessionName, 'action', 'list-panes', '--json', '--all'], { cwd: root, timeoutMs: 5000, optional: false })
  const rows = parsePaneRows(listed.stdout_tail)
  const terminalRows = rows.filter((row) => row && row.is_plugin !== true)
  const titles = rows.map((row) => String(row.title || row.name || row.pane_name || ''))
  const matchedTitles = records.filter((record) => titles.includes(record.pane_title)).length
  const commandMatchedWorkers = records.filter((record) => rows.some((row) => {
    const command = `${row.terminal_command || ''} ${row.pane_command || ''} ${row.command || ''}`
    return command.includes(missionId) && command.includes(record.slot_id)
  })).length
  const requestedTitleCommands = records.filter((record) => {
    const args = Array.isArray(record.launch?.args) ? record.launch.args.map(String) : []
    return args.includes('--name') && args.includes(record.pane_title)
  }).length
  const dump = await zellij.runZellij(['--session', sessionName, 'action', 'dump-screen'], { cwd: root, timeoutMs: 5000, optional: true })
  const heartbeatSeen = records.filter((record) => fs.existsSync(path.join(ledgerRoot, record.heartbeat_path))).length
  const resultSeen = records.filter((record) => fs.existsSync(path.join(ledgerRoot, record.worker_result_path))).length
  const realPaneIds = records.filter((record) => workerPane.isRealZellijWorkerPaneIdSource(record.pane_id_source) && record.pane_id).length
  const workerKindRecords = records.filter((record) => record.pane_kind === 'worker_codex_sdk').length
  const workerPrimitiveRecords = records.filter((record) => record.scaling_primitive === 'native_cli_process_in_zellij_worker_pane').length
  const recordProofOk = records.length === 3
    && realPaneIds === 3
    && workerKindRecords === 3
    && workerPrimitiveRecords === 3
    && requestedTitleCommands === 3
    && heartbeatSeen === 3
    && resultSeen === 3
  const listPanesVisibilityOk = matchedTitles === 3
    || commandMatchedWorkers === 3
    || terminalRows.length >= beforeTerminalCount + 3
  const report = {
    schema: 'sks.zellij-worker-pane-real-ui-blackbox.v1',
    ok: recordProofOk && dump.ok,
    real_required: true,
    zellij_version: available.stdout.trim(),
    mission_id: missionId,
    session_name: sessionName,
    before_pane_count: beforeCount,
    before_terminal_pane_count: beforeTerminalCount,
    after_pane_count: rows.length,
    terminal_pane_count: terminalRows.length,
    worker_pane_count: records.length,
    real_pane_ids: realPaneIds,
    worker_kind_records: workerKindRecords,
    worker_primitive_records: workerPrimitiveRecords,
    matched_titles: matchedTitles,
    command_matched_workers: commandMatchedWorkers,
    requested_title_commands: requestedTitleCommands,
    heartbeat_seen: heartbeatSeen,
    result_seen: resultSeen,
    dump_screen_ok: dump.ok,
    record_proof_ok: recordProofOk,
    list_panes_visibility_ok: listPanesVisibilityOk,
    pane_titles: records.map((record) => record.pane_title),
    pane_id_sources: records.map((record) => record.pane_id_source),
    proof_root: ledgerRoot,
    blockers: []
  }
  if (!report.ok) {
    report.blockers = [
      ...(realPaneIds === 3 ? [] : ['real_worker_pane_ids_missing']),
      ...(workerKindRecords === 3 ? [] : ['worker_pane_kind_missing']),
      ...(workerPrimitiveRecords === 3 ? [] : ['worker_pane_scaling_primitive_missing']),
      ...(requestedTitleCommands === 3 ? [] : ['worker_pane_title_request_missing']),
      ...(heartbeatSeen === 3 ? [] : ['worker_heartbeat_missing']),
      ...(resultSeen === 3 ? [] : ['worker_result_missing']),
      ...(dump.ok ? [] : ['worker_pane_dump_screen_failed'])
    ]
  }
  fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true })
  fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'zellij-worker-pane-real-ui-blackbox.json'), `${JSON.stringify(report, null, 2)}\n`)
  emitGate('zellij:worker-pane-real-ui:blackbox', report)
  if (!report.ok) process.exitCode = 1
} finally {
  await zellij.runZellij(['kill-session', sessionName], { cwd: root, timeoutMs: 5000, optional: true })
  safeKill(attachedClient, 'SIGTERM')
  await sleep(250)
  safeKill(attachedClient, 'SIGKILL')
}

function parsePaneRows(text) {
  if (!String(text || '').trim()) return []
  try {
    const parsed = JSON.parse(String(text))
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.panes)) return parsed.panes
    return []
  } catch {
    return []
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function startAttachedZellijClient(sessionName) {
  const logFile = path.join(root, '.sneakoscope', 'reports', `${sessionName}.script.log`)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  return spawn('script', ['-q', logFile, 'zellij', 'attach', '--create', sessionName], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore']
  })
}

function safeKill(child, signal) {
  try {
    if (!child.killed) child.kill(signal)
  } catch {
    // Best-effort cleanup for the disposable pseudo-terminal client.
  }
}
