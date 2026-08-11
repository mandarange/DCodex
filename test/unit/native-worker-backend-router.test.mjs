import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runNativeCliWorker } from '../../dist/core/agents/native-cli-worker.js';
import { resolveWorkerModelRouting } from '../../dist/core/agents/native-worker-backend-router.js';

test('Naruto worker preserves the selected OpenRouter main model instead of forcing GPT', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-router-openrouter-home-'));
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "openrouter"',
    'model = "anthropic/claude-sonnet-4.5"',
    ''
  ].join('\n'));
  const routing = await resolveWorkerModelRouting({
    agent: {
      id: 'agent-openrouter',
      role: 'implementation_specialist',
      naruto_role: 'implementation_specialist',
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'high'
    },
    slice: { id: 'task-openrouter', role: 'implementation', description: 'implement provider routing' },
    intake: { route: '$Naruto' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, { lbHealth: { ok: true }, env: { CODEX_HOME: codexHome } });

  assert.deepEqual(routing.blockers, []);
  assert.equal(routing.choice.model, 'anthropic/claude-sonnet-4.5');
  assert.equal(routing.choice.reasoning, 'high');
});

test('owner role-model preference overrides the main provider model without changing it globally', async () => {
  const routing = await resolveWorkerModelRouting({
    agent: {
      id: 'agent-role-override',
      role: 'protocol_reviewer',
      naruto_role: 'protocol_reviewer',
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'max',
      routed_model: 'google/gemini-2.5-pro',
      routed_model_reasoning_effort: 'high',
      routed_model_policy: 'user_role_model_preference'
    },
    slice: { id: 'task-role-override', role: 'review', description: 'review protocol compatibility' },
    intake: { route: '$Naruto', main_model: 'anthropic/claude-sonnet-4.5' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, { lbHealth: { ok: true }, env: {} });

  assert.deepEqual(routing.blockers, []);
  assert.equal(routing.choice.model, 'google/gemini-2.5-pro');
  assert.equal(routing.choice.reasoning, 'high');
});

test('native worker honors the active main model sealed into the prepared agent plan', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-router-sealed-main-home-'));
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "openai"',
    'model = "gpt-5.6-sol"',
    ''
  ].join('\n'));
  const routing = await resolveWorkerModelRouting({
    agent: {
      id: 'agent-sealed-main',
      role: 'implementation_specialist',
      naruto_role: 'implementation_specialist',
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'high',
      routed_model: 'moonshotai/kimi-k3',
      routed_model_reasoning_effort: 'high',
      routed_model_policy: 'active_main_model'
    },
    slice: { id: 'task-sealed-main', role: 'implementation', description: 'implement provider routing' },
    intake: { route: '$Naruto' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, { lbHealth: { ok: true }, env: { CODEX_HOME: codexHome } });

  assert.deepEqual(routing.blockers, []);
  assert.equal(routing.choice.model, 'moonshotai/kimi-k3');
  assert.equal(routing.choice.reasoning, 'high');
});

test('native worker backend router launches process child and marks generated patch source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-router-test-'));
  const old = snapshotEnv();
  process.env.SKS_DISABLE_ROUTE_RECURSION = '1';
  process.env.SKS_AGENT_WORKER = '1';
  try {
    const result = await runNativeCliWorker({
      intakeJson: {
        mission_id: 'M-router-test',
        backend: 'process',
        agent_root: root,
        agent: { id: 'agent-router', session_id: 'session-router', slot_id: 'slot-001', generation_index: 1, persona_id: 'executor' },
        slice: { id: 'task-router', write_paths: ['owned.txt'], description: 'process child route' },
        worker_artifact_dir: 'sessions/slot-001/gen-1/worker',
        result_path: 'sessions/slot-001/gen-1/worker/worker-result.json',
        heartbeat_path: 'sessions/slot-001/gen-1/worker/worker-heartbeat.jsonl',
        patch_envelope_path: 'sessions/slot-001/gen-1/worker/worker-patch-envelope.json',
        fast_mode: true,
        service_tier: 'fast'
      }
    });
    assert.equal(result.status, 'done');
    assert.equal(result.backend_router_report.selected_backend, 'process');
    assert.equal(result.patch_envelopes[0].source, 'process_generated');
    assert.equal(typeof result.backend_router_report.child_process_ids[0], 'number');
  } finally {
    restoreEnv(old);
  }
});

function snapshotEnv() {
  return {
    SKS_DISABLE_ROUTE_RECURSION: process.env.SKS_DISABLE_ROUTE_RECURSION,
    SKS_AGENT_WORKER: process.env.SKS_AGENT_WORKER
  };
}

function restoreEnv(old) {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
