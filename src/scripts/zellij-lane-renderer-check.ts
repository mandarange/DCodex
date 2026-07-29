#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDistFresh, root } from './lib/ensure-dist-fresh.js';
const freshness = ensureDistFresh({ rebuild: true });
if (!freshness.ok) fail('dist_not_fresh', { freshness });
const mod = await import(pathToFileURL(path.join(root, 'dist', 'core', 'zellij', 'zellij-lane-renderer.js')).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-lane-'));
await fs.writeFile(path.join(tmp, 'agent-scheduler-state.json'), `${JSON.stringify({ target_active_slots: 1, active_slot_count: 1, pending_count: 2, completed_count: 3 }, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'native-cli-worker-runtime.json'), `${JSON.stringify({
  schema: 'sks.native-cli-worker-runtime.v2',
  records: [{
    slot_id: 'slot-001',
    generation_index: 1,
    status: 'running',
    stdout_log: 'sessions/slot-001/gen-1/worker/worker.stdout.log',
    stderr_log: 'sessions/slot-001/gen-1/worker/worker.stderr.log',
    heartbeat_path: 'sessions/slot-001/gen-1/worker/worker-heartbeat.jsonl',
    result_path: 'sessions/slot-001/gen-1/worker/worker-result.json',
    worker_intake: 'sessions/slot-001/gen-1/worker/worker-intake.json',
    worker_artifact_dir: 'sessions/slot-001/gen-1/worker'
  }]
}, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'agent-patch-queue.json'), `${JSON.stringify({ queue: [{ slot_id: 'slot-001', target_file: 'src/core/example.ts' }] }, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'agent-proof-evidence.json'), `${JSON.stringify({ ok: false, blockers: ['fixture_blocker_visible'] }, null, 2)}\n`);
await fs.mkdir(path.join(tmp, 'lanes', 'slot-001'), { recursive: true });
await fs.mkdir(path.join(tmp, 'sessions', 'slot-001', 'gen-1', 'worker'), { recursive: true });
await fs.writeFile(path.join(tmp, 'sessions', 'slot-001', 'gen-1', 'worker', 'worker.stdout.log'), 'worker boot\nnative worker says hello\n');
await fs.writeFile(path.join(tmp, 'sessions', 'slot-001', 'gen-1', 'worker', 'worker.stderr.log'), 'worker stderr tail visible\n');
await fs.writeFile(path.join(tmp, 'sessions', 'slot-001', 'gen-1', 'worker', 'worker-heartbeat.jsonl'), `${JSON.stringify({ event: 'started', ts: '2026-06-02T00:00:00.000Z', slot_id: 'slot-001' })}\n`);
await fs.writeFile(path.join(tmp, 'sessions', 'slot-001', 'gen-1', 'worker', 'worker-result.json'), `${JSON.stringify({ status: 'done', summary: 'live worker connected', blockers: [] }, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'sessions', 'slot-001', 'gen-1', 'worker', 'worker-intake.json'), `${JSON.stringify({ slot_id: 'slot-001', generation_index: 1, slice: { target_file: 'src/core/example.ts' } }, null, 2)}\n`);
await fs.writeFile(path.join(tmp, 'lanes', 'slot-001', 'command-inbox.jsonl'), `${JSON.stringify({ schema: 'sks.zellij-lane-command.v1', id: 'cmd-fixture', kind: 'operator_text', payload: { text: 'hello' } })}\n`);
const frame = await mod.renderZellijLaneFrame({ missionId: 'M-lane', slot: 'slot-001', ledgerRoot: tmp, once: true, color: false });
const ackText = await fs.readFile(path.join(tmp, 'lanes', 'slot-001', 'command-ack.jsonl'), 'utf8');
const fastProject = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-fast-on-'));
const fastProjectLedger = path.join(fastProject, '.sneakoscope', 'missions', 'M-fast-on', 'agents');
await fs.mkdir(path.join(fastProject, '.sneakoscope', 'state'), { recursive: true });
await fs.mkdir(fastProjectLedger, { recursive: true });
await fs.writeFile(path.join(fastProject, '.sneakoscope', 'state', 'fast-mode.json'), `${JSON.stringify({
  schema: 'sks.fast-mode-preference.v1',
  updated_at: '2026-06-01T00:00:00.000Z',
  mode: 'fast',
  fast_mode: true,
  service_tier: 'fast',
  codex_desktop_service_tier: 'priority',
  source: 'zellij-lane-renderer-check'
}, null, 2)}\n`);
const fastFrame = await mod.renderZellijLaneFrame({ missionId: 'M-fast-on', slot: 'slot-001', ledgerRoot: fastProjectLedger, once: true, color: false });
const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-fast-off-'));
const projectLedger = path.join(project, '.sneakoscope', 'missions', 'M-fast-off', 'agents');
await fs.mkdir(path.join(project, '.sneakoscope', 'state'), { recursive: true });
await fs.mkdir(projectLedger, { recursive: true });
await fs.writeFile(path.join(project, '.sneakoscope', 'state', 'fast-mode.json'), `${JSON.stringify({
  schema: 'sks.fast-mode-preference.v1',
  updated_at: '2026-06-01T00:00:00.000Z',
  mode: 'standard',
  fast_mode: false,
  service_tier: 'standard',
  codex_desktop_service_tier: 'default',
  source: 'zellij-lane-renderer-check'
}, null, 2)}\n`);
const offFrame = await mod.renderZellijLaneFrame({ missionId: 'M-fast-off', slot: 'slot-001', ledgerRoot: projectLedger, once: true, color: false });
// No preference file in this bare fixture: the fast-by-default policy
// (default_fast_mode: true) resolves to `on · service_tier=fast`; an explicit
// preference file is what flips a project to standard.
const required = ['SKS Lane', 'Mission', 'Mode', 'Fast', 'on · service_tier=fast', 'Workers', 'slot-001 gen-1 running', 'Codex child', 'live running · result done', 'Current', 'Queue', 'Safety', 'Blockers', 'Reports', 'Keys:', 'src/core/example.ts', 'fixture_blocker_visible', 'live worker:', 'native worker says hello', 'worker stderr tail visible'];
const fastRequired = ['Fast', 'on · service_tier=fast'];
const offRequired = ['Fast', 'off · service_tier=standard'];
const commandBusOk = frame.report.command_bus?.mode === 'jsonl_nonblocking' && frame.report.command_bus?.newly_acked_count === 1 && ackText.includes('cmd-fixture');
const ok = required.every((item) => frame.frame.includes(item)) && fastRequired.every((item) => fastFrame.frame.includes(item)) && offRequired.every((item) => offFrame.frame.includes(item)) && frame.report.stdout_only === true && commandBusOk;
const report = { schema: 'sks.zellij-lane-renderer-check.v1', ok, frame: frame.report, fast_on_frame: fastFrame.report, fast_off_frame: offFrame.report, command_bus_ok: commandBusOk };
await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
await fs.writeFile(path.join(root, '.sneakoscope', 'reports', 'zellij-lane-renderer.json'), `${JSON.stringify(report, null, 2)}\n`);
emit(report);
function emit(report) { console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
function fail(blocker, detail) { emit({ schema: 'sks.zellij-lane-renderer-check.v1', ok: false, blockers: [blocker], detail }); process.exit(1); }
