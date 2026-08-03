import { AGENT_RESULT_SCHEMA, AGENT_WORKER_PIPELINE } from './agent-schema.js'
import type { AgentRunnerResult } from './agent-schema.js'
import { normalizeAgentPatchEnvelope, validateAgentPatchEnvelope } from './agent-patch-schema.js'
import { scanAgentTextForRecursion } from './agent-recursion-guard.js'
import { validateAgentResultSchema, validateAndNormalizeAgentFollowUps } from './agent-output-validator.js'
import { isRecord } from '../json/records.js'

export function agentWorkerEnv(agent: any, allowedCommandsFile: string) {
  return {
    SKS_AGENT_WORKER: '1',
    SKS_PIPELINE_MODE: 'agent-worker',
    SKS_DISABLE_ROUTE_RECURSION: '1',
    SKS_AGENT_SESSION_ID: agent.session_id,
    SKS_AGENT_ID: agent.id,
    SKS_AGENT_SLOT_ID: agent.slot_id || agent.worker_slot_id || agent.id,
    SKS_AGENT_SESSION_GENERATION_ID: agent.session_generation_id || agent.session_id,
    SKS_AGENT_ALLOWED_COMMANDS_FILE: allowedCommandsFile,
    SKS_FAST_MODE: agent.fast_mode === false ? '0' : '1',
    SKS_SERVICE_TIER: agent.service_tier || 'fast'
  }
}

export function validateAgentWorkerResult(result: any): AgentRunnerResult {
  const guard = scanAgentTextForRecursion(JSON.stringify(result || {}))
  const followUps = validateAndNormalizeAgentFollowUps(result?.follow_up_work_items, result?.session_id)
  const patchEnvelopeValidation = normalizePatchEnvelopes(result?.patch_envelopes)
  const normalized: AgentRunnerResult = {
    schema: AGENT_RESULT_SCHEMA,
    mission_id: String(result?.mission_id || ''),
    agent_id: String(result?.agent_id || 'unknown'),
    session_id: String(result?.session_id || 'unknown'),
    persona_id: String(result?.persona_id || result?.agent_id || 'unknown'),
    task_slice_id: String(result?.task_slice_id || 'unknown'),
    ...(result?.work_item_kind === undefined ? {} : { work_item_kind: String(result.work_item_kind) }),
    status: guard.ok ? (result?.status === undefined ? 'done' : String(result.status) as AgentRunnerResult['status']) : 'blocked',
    backend: result?.backend || 'fake',
    summary: String(result?.summary || ''),
    findings: Array.isArray(result?.findings) ? result.findings : [],
    proposed_changes: Array.isArray(result?.proposed_changes) ? result.proposed_changes : [],
    changed_files: Array.isArray(result?.changed_files) ? result.changed_files : [],
    lease_compliance: normalizeLeaseCompliance(result?.lease_compliance),
    artifacts: Array.isArray(result?.artifacts) ? result.artifacts : [],
    blockers: [...(Array.isArray(result?.blockers) ? result.blockers : []), ...guard.violations.map((v) => 'recursion:' + v)],
    confidence: String(result?.confidence || 'medium'),
    handoff_notes: String(result?.handoff_notes || ''),
    unverified: Array.isArray(result?.unverified) ? result.unverified : [],
    writes: Array.isArray(result?.writes) ? result.writes : [],
    ...(patchEnvelopeValidation.envelopes.length ? { patch_envelopes: patchEnvelopeValidation.envelopes } : {}),
    ...(Array.isArray(result?.patch_queue_refs) ? { patch_queue_refs: result.patch_queue_refs.map(String) } : {}),
    ...(Array.isArray(result?.applied_patch_refs) ? { applied_patch_refs: result.applied_patch_refs.map(String) } : {}),
    ...(Array.isArray(result?.rollback_refs) ? { rollback_refs: result.rollback_refs.map(String) } : {}),
    ...(result?.backend_router_report === undefined ? {} : { backend_router_report: result.backend_router_report }),
    ...(result?.codex_child_report === undefined ? {} : { codex_child_report: result.codex_child_report }),
    ...(result?.process_child_report === undefined ? {} : { process_child_report: result.process_child_report }),
    ...(result?.codex_sdk_thread === undefined ? {} : { codex_sdk_thread: result.codex_sdk_thread }),
    ...(result?.model_authored_patch_envelopes === undefined ? {} : { model_authored_patch_envelopes: Boolean(result.model_authored_patch_envelopes) }),
    ...(result?.fixture_patch_envelopes === undefined ? {} : { fixture_patch_envelopes: Boolean(result.fixture_patch_envelopes) }),
    ...(result?.no_patch_reason === undefined ? {} : { no_patch_reason: result.no_patch_reason }),
    ...(result?.machine_feedback === undefined ? {} : { machine_feedback: result.machine_feedback }),
    ...(isRecord(result?.regression_proof) ? { regression_proof: result.regression_proof } : {}),
    ...(isRecord(result?.repair_hypothesis) ? { repair_hypothesis: result.repair_hypothesis } : {}),
    ...(isRecord(result?.tournament) ? { tournament: result.tournament } : {}),
    ...(result?.source_intelligence_refs === undefined ? {} : { source_intelligence_refs: result.source_intelligence_refs }),
    ...(result?.goal_mode_ref === undefined ? {} : { goal_mode_ref: result.goal_mode_ref }),
    ...(result?.follow_up_work_items === undefined ? {} : { follow_up_work_items: followUps.accepted }),
    ...(result?.naruto_runtime === undefined ? {} : { naruto_runtime: result.naruto_runtime }),
    ...(result?.control_plane_result === undefined ? {} : { control_plane_result: result.control_plane_result }),
    recursion_guard: { ok: guard.ok, violations: guard.violations },
    verification: normalizeVerification(result?.verification)
  }
  if (followUps.blockers.length) {
    normalized.status = 'blocked'
    normalized.blockers.push(...followUps.blockers.map((issue) => 'schema_invalid:' + issue))
  }
  if (patchEnvelopeValidation.blockers.length) {
    normalized.status = 'blocked'
    normalized.blockers.push(...patchEnvelopeValidation.blockers.map((issue) => 'patch_envelope_invalid:' + issue))
    normalized.verification = { status: 'failed', checks: [...normalized.verification.checks, 'agent-patch-envelope-schema'] }
  }
  const protocolBlockers = qualityProtocolBlockers(normalized);
  if (protocolBlockers.length) {
    normalized.status = 'blocked';
    normalized.blockers.push(...protocolBlockers);
    normalized.verification = { status: 'failed', checks: [...normalized.verification.checks, 'agent-worker-quality-protocol'] };
  }
  const readOnlyOrNoopWithoutPatch = acceptsNoPatchReadOnlyOrNoop(result?.no_patch_reason)
  if (patchEnvelopeValidation.envelopes.length === 0 && (normalized.writes.length > 0 || (!readOnlyOrNoopWithoutPatch && normalized.changed_files.length > 0))) {
    normalized.status = 'blocked'
    normalized.blockers.push('no_patch_generated')
    normalized.verification = { status: 'failed', checks: [...normalized.verification.checks, 'agent-patch-envelope-required-for-write'] }
  }
  const schemaValidation = validateAgentResultSchema(normalized)
  if (!schemaValidation.ok) {
    normalized.status = 'blocked'
    normalized.blockers.push(...schemaValidation.issues.map((issue) => 'schema_invalid:' + issue))
    normalized.verification = { status: 'failed', checks: [...normalized.verification.checks, 'agent-result-schema'] }
  }
  return normalized
}

function qualityProtocolBlockers(result: AgentRunnerResult): string[] {
  const writesPatch = result.writes.length > 0 || result.changed_files.length > 0 || Boolean(result.patch_envelopes?.length);
  if (!writesPatch) return [];
  const kind = String(result.work_item_kind || result.naruto_runtime?.work_item_kind || '').toLowerCase();
  const text = [kind, result.task_slice_id].join(' ').toLowerCase();
  const repair = result.repair_hypothesis || result.patch_envelopes?.find((envelope) => envelope.repair_hypothesis)?.repair_hypothesis || null;
  const blockers: string[] = [];
  if (!validWriteVerification(result.verification)) blockers.push('verification_evidence_missing');
  if ((kind === 'conflict_resolution' || /\b(repair|conflict|rebase|rollback)\b|수리|충돌/.test(text)) && !repair) blockers.push('repair_without_hypothesis');
  return blockers;
}

function validWriteVerification(verification: AgentRunnerResult['verification']): boolean {
  const status = String(verification?.status || '').trim().toLowerCase();
  const checks = Array.isArray(verification?.checks)
    ? verification.checks.map((check) => String(check || '').trim()).filter(Boolean)
    : [];
  if (status === 'passed') return checks.length > 0;
  return status === 'not_applicable' && Boolean(String(verification?.reason || '').trim());
}

export function agentWorkerPipelineContract() {
  return {
    schema: 'sks.agent-worker-pipeline.v1',
    pipeline_id: AGENT_WORKER_PIPELINE,
    creates_mission: false,
    route_classifier_allowed: false,
    writes_global_current_json: false,
    route_finalizer_allowed: false,
    writes_only_agent_session_and_central_ledger: true,
    patch_envelope_result_fields: {
      result_field: 'patch_envelopes',
      required_for_write_tasks: true,
      envelope_schema: 'sks.agent-patch-envelope.v1',
      metadata: ['agent_id', 'session_id', 'slot_id', 'generation_index', 'lease_id_or_lease_proof'],
      optional_hints: ['rationale', 'verification_hint', 'rollback_hint', 'cochange_acknowledged_reason', 'regression_proof', 'repair_hypothesis']
    }
  }
}

function normalizePatchEnvelopes(value: any) {
  const envelopes = Array.isArray(value) ? value.map((raw) => ({
    ...normalizeAgentPatchEnvelope(raw),
    ...(raw?.mission_id === undefined ? {} : { mission_id: String(raw.mission_id) }),
    ...(raw?.route === undefined ? {} : { route: String(raw.route) }),
    ...(raw?.session_id === undefined ? {} : { session_id: String(raw.session_id) }),
    ...(raw?.slot_id === undefined ? {} : { slot_id: String(raw.slot_id) }),
    ...(raw?.generation_index === undefined ? {} : { generation_index: Number(raw.generation_index) }),
    ...(raw?.task_slice_id === undefined ? {} : { task_slice_id: String(raw.task_slice_id) }),
    ...(raw?.verification_hint === undefined ? {} : { verification_hint: raw.verification_hint }),
    ...(raw?.rollback_hint === undefined ? {} : { rollback_hint: raw.rollback_hint }),
    ...(raw?.cochange_acknowledged === undefined ? {} : { cochange_acknowledged: Boolean(raw.cochange_acknowledged) }),
    ...(raw?.cochange_acknowledged_reason === undefined ? {} : { cochange_acknowledged_reason: String(raw.cochange_acknowledged_reason) }),
    ...(isRecord(raw?.regression_proof) ? { regression_proof: raw.regression_proof } : {}),
    ...(isRecord(raw?.repair_hypothesis) ? { repair_hypothesis: raw.repair_hypothesis } : {}),
    ...(isRecord(raw?.tournament) ? { tournament: raw.tournament } : {})
  })) : []
  const blockers = envelopes.flatMap((envelope, index) => {
    const validation = validateAgentPatchEnvelope(envelope)
    const leaseOk = Boolean(envelope.lease_id || envelope.lease_proof?.lease_id)
    return [
      ...(validation.ok ? [] : validation.violations),
      ...(leaseOk ? [] : ['lease_id_or_proof_missing'])
    ].map((violation) => `${index}:${violation}`)
  })
  return { envelopes, blockers }
}

function normalizeLeaseCompliance(value: any) {
  return {
    ok: value?.ok !== false,
    violations: Array.isArray(value?.violations) ? value.violations : []
  }
}

function normalizeVerification(value: any) {
  return {
    status: String(value?.status || 'not_run'),
    checks: Array.isArray(value?.checks) ? value.checks : [],
    ...(String(value?.reason || '').trim() ? { reason: String(value.reason).trim() } : {})
  }
}

function acceptsNoPatchReadOnlyOrNoop(value: any) {
  if (!value || typeof value !== 'object') return false
  return value.ok === true
    && value.read_only_or_noop_evidence === true
    && String(value.reason || '') === 'read_only_or_no_write_paths'
}
