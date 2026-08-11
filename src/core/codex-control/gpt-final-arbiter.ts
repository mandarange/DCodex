import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { validateJsonSchemaRecursive } from '../json-schema-validator.js'
import { evaluateGptFinalGate } from './gpt-final-gate.js'
import { runCodexTask } from './codex-control-plane.js'
import { GPT_FINAL_ARBITER_INPUT_SCHEMA, GPT_FINAL_ARBITER_RESULT_SCHEMA_ID, gptFinalArbiterResultSchema, normalizeGptFinalArbiterResult } from './gpt-final-review-schema.js'
import { compressGptFinalContext } from './gpt-final-context-compressor.js'
import type { GptFinalArbiterInput } from './gpt-final-proof-pack.js'
import { leanEngineeringCompactText } from '../lean-engineering-policy.js'

export const GPT_FINAL_ARBITER_RUN_SCHEMA = 'sks.gpt-final-arbiter-run.v1'

export async function runGptFinalArbiter(input: GptFinalArbiterInput, opts: {
  cwd?: string
  mutationLedgerRoot?: string
  forceUnavailable?: boolean
  writeArtifact?: boolean
} = {}) {
  const started = Date.now()
  const cwd = path.resolve(opts.cwd || process.cwd())
  const root = path.resolve(opts.mutationLedgerRoot || path.join(cwd, '.sneakoscope', 'tmp', 'gpt-final-arbiter', safeName(input.mission_id || 'mission')))
  const compressed = compressGptFinalContext(input)
  if (opts.forceUnavailable || process.env.SKS_GPT_FINAL_ARBITER_UNAVAILABLE === '1') {
    return finalize(root, input, compressed, blockedResult('gpt_final_arbiter_unavailable', 'GPT final arbiter backend is unavailable.'), started, opts)
  }
  let codexTask: any = null
  let parsed: any = null
  try {
    codexTask = await runCodexTask({
      route: String(input.route || '$Pipeline'),
      tier: 'orchestrator',
      missionId: String(input.mission_id || ''),
      workItemId: 'gpt-final-arbiter',
      slotId: 'gpt-final-arbiter',
      generationIndex: 1,
      sessionId: `gpt-final-${safeName(input.mission_id || 'mission')}`,
      cwd,
      prompt: buildArbiterPrompt(input, compressed),
      inputFiles: [],
      inputImages: [],
      outputSchemaId: GPT_FINAL_ARBITER_RESULT_SCHEMA_ID,
      outputSchema: gptFinalArbiterResultSchema as Record<string, unknown>,
      sandboxPolicy: 'read-only',
      requestedScopeContract: {
        id: `gpt-final:${input.mission_id || 'mission'}`,
        route: String(input.route || '$Pipeline'),
        read_only: true,
        allowed_paths: [],
        write_paths: [],
        user_confirmed_full_access: false,
        mad_sks_authorized: process.env.SKS_MAD_SKS_ACTIVE === '1'
      },
      mutationLedgerRoot: root,
      reliabilityPolicy: {
        maxEmptyResultRetries: 1,
        timeoutClass: 'standard'
      }
    })
    parsed = parseFinalResponse(codexTask.finalResponse)
  } catch (error: unknown) {
    return finalize(root, input, compressed, blockedResult('gpt_final_arbiter_unavailable', error instanceof Error ? error.message : String(error)), started, opts)
  }
  const normalized = normalizeGptFinalArbiterResult(parsed)
  const validation = validateJsonSchemaRecursive(normalized, gptFinalArbiterResultSchema as Record<string, unknown>)
  const taskBlockers = Array.isArray(codexTask?.blockers) ? codexTask.blockers.map(String) : []
  const result = {
    ...normalized,
    blockers: [
      ...normalized.blockers,
      ...(codexTask?.ok === true ? [] : ['gpt_final_arbiter_unavailable']),
      ...taskBlockers,
      ...(validation.ok ? [] : ['gpt_final_result_schema_invalid', ...validation.issues.map((issue) => `schema:${issue}`)])
    ]
  }
  return finalize(root, input, compressed, result, started, opts, codexTask)
}

function finalize(root: string, input: GptFinalArbiterInput, compressed: ReturnType<typeof compressGptFinalContext>, result: ReturnType<typeof normalizeGptFinalArbiterResult>, started: number, opts: { writeArtifact?: boolean }, codexTask?: any) {
  const latencyMs = Math.max(0, Date.now() - started)
  const gate = evaluateGptFinalGate({
    required: true,
    gptFinalStatus: result.status,
    gptFinalAvailable: !result.blockers.includes('gpt_final_arbiter_unavailable')
  })
  const artifact = {
    schema: GPT_FINAL_ARBITER_RUN_SCHEMA,
    generated_at: nowIso(),
    ok: gate.ok && result.blockers.length === 0,
    input_schema: input.schema || GPT_FINAL_ARBITER_INPUT_SCHEMA,
    route: input.route,
    mission_id: input.mission_id,
    backend: codexTask ? 'codex-sdk' : 'unavailable',
    backend_family: codexTask ? 'remote-gpt' : 'none',
    candidate_outputs_count: Array.isArray(input.candidate_outputs) ? input.candidate_outputs.length : 0,
    proof_pack: compressed.proof_pack,
    latency_budget: {
      ...compressed.latency_budget,
      latency_ms: latencyMs
    },
    result,
    final_gate: gate,
    codex_task: codexTask ? {
      ok: codexTask.ok === true,
      sdk_thread_id: codexTask.sdkThreadId || null,
      sdk_run_id: codexTask.sdkRunId || null,
      stream_event_count: codexTask.streamEventCount || 0,
      structured_output_valid: codexTask.structuredOutputValid === true,
      worker_result_path: codexTask.workerResultPath || null,
      blockers: codexTask.blockers || []
    } : null,
    blockers: [
      ...result.blockers,
      ...gate.blockers,
      ...compressed.blockers
    ]
  }
  artifact.ok = artifact.blockers.length === 0 && (result.status === 'approved' || result.status === 'modified')
  if (opts.writeArtifact !== false) return writeArtifact(root, artifact)
  return artifact
}

async function writeArtifact(root: string, artifact: any) {
  await writeJsonAtomic(path.join(root, 'gpt-final-arbiter.json'), artifact)
  return artifact
}

function blockedResult(blocker: string, summary: string) {
  return normalizeGptFinalArbiterResult({
    status: 'needs_more_work',
    summary,
    blockers: [blocker],
    confidence: 'low',
    required_followup_work: [{ blocker }]
  })
}

function parseFinalResponse(value: unknown) {
  if (typeof value !== 'string') return value || {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function buildArbiterPrompt(input: GptFinalArbiterInput, compressed: ReturnType<typeof compressGptFinalContext>) {
  return [
    'You are the GPT Final Arbiter for an SKS pipeline run.',
    'Candidate outputs are drafts only. Review the proof pack, candidate diff, patch envelopes, verification results, side effects, mutation ledger, and rollback plan.',
    leanEngineeringCompactText(),
    'Judge the candidate against that directive and the recorded evidence. Reject fabricated substitutes, unsupported complexity, or unsafe changes. Return only the requested structured JSON schema.',
    JSON.stringify({
      route: input.route,
      mission_id: input.mission_id,
      proof_pack: compressed.proof_pack
    })
  ].join('\n')
}

function safeName(value: unknown) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80)
}
