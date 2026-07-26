// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importDist } from '../gate-lib.js';

export async function buildFixtureProof({ workers, required }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-real-codex-proof-'));
  const dirs = [];
  const base = Date.now();
  for (let index = 0; index < workers; index += 1) {
    const dir = path.join('sessions', `slot-${String(index + 1).padStart(3, '0')}`, 'gen-1', 'worker');
    dirs.push(dir);
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'worker-backend-router-report.json'), JSON.stringify({
      schema: 'sks.native-worker-backend-router.v1',
      ok: true,
      selected_backend: 'codex-sdk',
      worker_process_id: 3000 + index,
      child_process_ids: [],
      sdk_thread_id: `sdk-thread-${index}`,
      stream_event_count: 4,
      structured_output_valid: true,
      patch_envelope_count: 1,
      model_authored_patch_envelopes: true,
      fixture_patch_envelopes: false,
      proof_level: 'model_authored',
      fast_mode: true,
      service_tier: 'fast',
      blockers: []
    }, null, 2));
    await fs.writeFile(path.join(root, dir, 'codex-control-proof.json'), JSON.stringify({
      schema: 'sks.codex-control-proof.v1',
      ok: true,
      backend: 'codex-sdk',
      sdk_thread_id: `sdk-thread-${index}`,
      sdk_run_id: `sdk-run-${index}`,
      stream_event_count: 4,
      structured_output_valid: true,
      output_schema_id: 'sks.agent-worker-result.v1',
      fast_mode: true,
      service_tier: 'fast'
    }, null, 2));
    await fs.writeFile(path.join(root, dir, 'codex-worker-output-truth.json'), JSON.stringify({ ok: true, patch_envelope_count: 1 }, null, 2));
  }
  await fs.writeFile(path.join(root, 'native-cli-worker-runtime.json'), JSON.stringify({
    schema: 'sks.native-cli-worker-runtime.v2',
    requested_agents: workers,
    target_active_slots: workers,
    process_ids: dirs.map((_, index) => 3000 + index),
    worker_artifact_dirs: dirs
  }, null, 2));
  const mod = await importDist('core/agents/real-codex-parallel-proof.js');
  return mod.writeRealCodexParallelProof(root, { requestedWorkers: workers, required });
}
