#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, runFakeCodexSdkTaskFixture } from './lib/codex-sdk-gate-lib.js';
import fsp from 'node:fs/promises';
import path from 'node:path';

const requireReal = process.env.SKS_CODEX_SDK_REQUIRE_REAL === '1'
  || process.env.SKS_REQUIRE_CODEX_SDK === '1'
  || process.argv.includes('--require-real');
if (!requireReal) {
  const fixture = await runFakeCodexSdkTaskFixture('real-smoke-fixture');
  assertGate(fixture.result.ok === true, 'fixture SDK smoke must pass', fixture.result);
  emitGate('codex-sdk:real-smoke', { status: 'integration_optional', fixture_thread_id: fixture.result.sdkThreadId });
} else {
  const mod = await importDist('core/codex-control/codex-control-plane.js');
  const schema = await importDist('core/codex-control/schemas/agent-worker-result.schema.js');
  const mutationLedgerRoot = '.sneakoscope/reports/codex-sdk-real-smoke';
  const result = await mod.runCodexTask({
    route: '$Naruto',
    missionId: 'M-codex-sdk-real-smoke',
    workItemId: 'real-smoke',
    slotId: 'slot-real',
    generationIndex: 1,
    sessionId: 'real-smoke-session',
    cwd: process.cwd(),
    prompt: [
      'Read-only real Codex SDK smoke. Do not edit files.',
      'Return only JSON matching sks.agent-worker-result.v1.',
      'Use status "done", a short summary, findings as string array, changed_files as [], patch_envelopes as [], verification as { "status": "passed", "checks": ["real-codex-sdk-smoke"] }, rollback_notes as [], and blockers as [].'
    ].join('\n'),
    inputFiles: [],
    inputImages: [],
    outputSchemaId: schema.CODEX_AGENT_WORKER_RESULT_SCHEMA_ID,
    outputSchema: schema.codexAgentWorkerResultSchema,
    sandboxPolicy: 'read-only',
    requestedScopeContract: { id: 'real-smoke', read_only: true, allowed_paths: [], write_paths: [] },
    mutationLedgerRoot
  });
  assertGate(result.ok === true, 'real Codex SDK smoke failed', result);
  const proof = JSON.parse(await fsp.readFile(path.join(mutationLedgerRoot, 'codex-control-proof.json'), 'utf8'));
  assertGate(result.backend === 'codex-sdk', 'real smoke must use the official Codex SDK backend', result);
  assertGate(
    result.desktop_bridge_launch_guard?.ok === true
      && result.desktop_bridge_launch_guard?.status === 'allowed'
      && result.desktop_bridge_launch_guard?.selected_provider === 'openai',
    'real smoke must stay on native OpenAI without selecting Desktop Bridge',
    result
  );
  assertGate(proof?.config?.model_provider === 'openai', 'real smoke must bind proof to the native OpenAI provider', proof);
  assertGate(proof?.config?.forced_login_method === 'chatgpt', 'real smoke must require ChatGPT authentication', proof);
  assertGate(proof?.runtime_identity?.trusted === true && proof?.runtime_identity?.trust_basis, 'real smoke must bind proof to a trusted official Codex runtime', proof);
  assertGate(proof?.env?.native_codex_only === true && proof?.env?.codex_lb_env_injected === false, 'real smoke must use native Codex authentication without ambient proxy injection', proof);
  assertGate(proof?.env?.native_codex_auth_bridge?.status === 'ready', 'real smoke must use the native auth-only bridge', proof);
  assertGate(proof?.env?.native_codex_auth_bridge?.cleanup_required === false && proof?.env?.native_codex_auth_bridge?.cleanup_status === 'cleaned', 'real smoke must clean its private native auth copy before proof completion', proof);
  emitGate('codex-sdk:real-smoke', {
    status: 'proven',
    provider: proof.config.model_provider,
    native_codex_only: proof.env.native_codex_only,
    sdk_thread_id: result.sdkThreadId,
    stream_event_count: result.streamEventCount
  });
}
