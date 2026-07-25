#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root as repoRoot } from './gate-lib.js';

const mod = await importDist('core/agents/native-cli-worker.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-worker-router-'));
const old = snapshotEnv();
process.env.SKS_DISABLE_ROUTE_RECURSION = '1';
process.env.SKS_AGENT_WORKER = '1';
process.env.SKS_FAST_MODE = '1';
process.env.SKS_SERVICE_TIER = 'fast';
try {
  const result = await mod.runNativeCliWorker({
    intakeJson: {
      mission_id: 'M-router-check',
      parent_mission_id: 'M-router-check',
      route: '$Naruto',
      backend: 'process',
      agent_root: root,
      agent: { id: 'router-agent', session_id: 'router-session', slot_id: 'slot-001', generation_index: 1, persona_id: 'executor' },
      slice: { id: 'router-task', write_paths: ['router-output.txt'], description: 'exercise real process child backend' },
      worker_artifact_dir: 'sessions/slot-001/gen-1/worker',
      result_path: 'sessions/slot-001/gen-1/worker/worker-result.json',
      heartbeat_path: 'sessions/slot-001/gen-1/worker/worker-heartbeat.jsonl',
      patch_envelope_path: 'sessions/slot-001/gen-1/worker/worker-patch-envelope.json',
      fast_mode: true,
      service_tier: 'fast'
    }
  });
  const workerDir = path.join(root, 'sessions', 'slot-001', 'gen-1', 'worker');
  const router = JSON.parse(await fs.readFile(path.join(workerDir, 'worker-backend-router-report.json'), 'utf8'));
  const patch = JSON.parse(await fs.readFile(path.join(workerDir, 'worker-patch-envelope.json'), 'utf8'));
  assertGate(result.status === 'done', 'process backend worker result must be done', result);
  assertGate(router.selected_backend === 'process', 'router selected backend mismatch', router);
  assertGate(router.child_process_ids.length === 1, 'router must record child process id', router);
  assertGate(patch.envelopes[0].source === 'process_generated', 'process backend patch envelope source missing', patch);
  assertGate(result.backend_router_report?.proof_level === 'process_child_proven', 'router proof level must show process child', result.backend_router_report);
  await fs.mkdir(path.join(repoRoot, '.sneakoscope', 'reports'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.sneakoscope', 'reports', 'agent-worker-backend-router.json'), `${JSON.stringify({ ok: true, router, patch_source: patch.envelopes[0].source }, null, 2)}\n`);
  emitGate('agent:worker-backend-router', { backend: router.selected_backend, child_process_ids: router.child_process_ids.length, patch_source: patch.envelopes[0].source });
} finally {
  restoreEnv(old);
}

function snapshotEnv() {
  return {
    SKS_DISABLE_ROUTE_RECURSION: process.env.SKS_DISABLE_ROUTE_RECURSION,
    SKS_AGENT_WORKER: process.env.SKS_AGENT_WORKER,
    SKS_FAST_MODE: process.env.SKS_FAST_MODE,
    SKS_SERVICE_TIER: process.env.SKS_SERVICE_TIER
  };
}

function restoreEnv(old) {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
