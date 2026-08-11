import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import type { CodexTaskInput, CodexTaskResult } from './codex-control-plane.js'
import { redactCodexSdkConfig } from './codex-sdk-config-policy.js'

export const CODEX_CONTROL_PROOF_SCHEMA = 'sks.codex-control-proof.v1'

export async function writeCodexControlProof(root: string, input: {
  task: CodexTaskInput
  result: CodexTaskResult & Record<string, unknown>
  capability?: Record<string, unknown> | null
  sandbox?: Record<string, unknown> | null
  envProof?: Record<string, unknown> | null
  config?: Record<string, unknown> | null
  reliabilityShield?: Record<string, unknown> | null
  routerDecision?: Record<string, unknown> | null
  translatedEvents?: unknown[]
}) {
  const proof = {
    schema: CODEX_CONTROL_PROOF_SCHEMA,
    generated_at: nowIso(),
    ok: input.result.ok === true,
    backend: input.result.backend,
    backend_family: input.result.backend_family,
    route: input.task.route,
    mission_id: input.task.missionId,
    work_item_id: input.task.workItemId || null,
    slot_id: input.task.slotId || null,
    generation_index: input.task.generationIndex ?? null,
    session_id: input.task.sessionId || null,
    sdk_thread_id: input.result.sdkThreadId,
    sdk_run_id: input.result.sdkRunId,
    runtime_identity: input.result.runtimeIdentity || null,
    stream_event_count: input.result.streamEventCount,
    structured_output_valid: input.result.structuredOutputValid,
    output_schema_id: input.task.outputSchemaId,
    worker_result_path: input.result.workerResultPath,
    patch_envelope_path: input.result.patchEnvelopePath || null,
    python_sdk_proof_path: input.result.pythonSdkProofPath || null,
    sandbox: input.sandbox || null,
    env: input.envProof || null,
    config: input.config ? redactCodexSdkConfig(input.config) : null,
    reliability_shield: input.reliabilityShield || null,
    ultra_router: input.routerDecision || null,
    capability: input.capability || null,
    translated_event_count: input.translatedEvents?.length || 0,
    blockers: input.result.blockers || []
  }
  const proofPath = path.join(root, 'codex-control-proof.json')
  await writeJsonAtomic(proofPath, proof)
  return { proof, proofPath }
}
