#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/agents/native-cli-worker.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-sdk-router-'));
const old = snapshotEnv();
process.env.NODE_ENV = 'test';
process.env.SKS_CODEX_SDK_FAKE = '1';
process.env.SKS_CODEX_LB_AUTOBYPASS = '1';
process.env.SKS_DISABLE_ROUTE_RECURSION = '1';
process.env.SKS_AGENT_WORKER = '1';
process.env.SKS_FAST_MODE = '1';
process.env.SKS_SERVICE_TIER = 'fast';
try {
  const result = await mod.runNativeCliWorker({
    intakeJson: {
      mission_id: 'M-codex-sdk-router',
      parent_mission_id: 'M-codex-sdk-router',
      route: '$Naruto',
      backend: 'codex-sdk',
      naruto_model_catalog: {
        ok: true,
        models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
        model_efforts: {
          'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
          'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
          'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        },
        blockers: []
      },
      agent_root: root,
      agent: { id: 'sdk-router-agent', session_id: 'sdk-router-session', slot_id: 'slot-001', generation_index: 1, persona_id: 'executor' },
      slice: { id: 'sdk-router-task', write_paths: [], description: 'exercise Codex SDK backend router' },
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
  const proof = JSON.parse(await fs.readFile(path.join(workerDir, 'codex-control-proof.json'), 'utf8'));
  assertGate(result.status === 'done', 'Codex SDK worker result must be done', result);
  assertGate(router.selected_backend === 'codex-sdk', 'router selected backend mismatch', router);
  assertGate(router.sdk_thread_id, 'router must record sdk_thread_id', router);
  assertGate(router.stream_event_count >= 1, 'router must record SDK event stream count', router);
  assertGate(proof.output_schema_id === 'sks.agent-worker-result.v1', 'proof output schema mismatch', proof);
  emitGate('codex-sdk:backend-router', { backend: router.selected_backend, stream_event_count: router.stream_event_count });
} finally {
  restoreEnv(old);
}

function snapshotEnv() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    SKS_CODEX_SDK_FAKE: process.env.SKS_CODEX_SDK_FAKE,
    SKS_CODEX_LB_AUTOBYPASS: process.env.SKS_CODEX_LB_AUTOBYPASS,
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
