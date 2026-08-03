import { validateJsonSchemaRecursive } from '../json-schema-validator.js'
import { normalizeAgentFollowUpWorkItems } from './agent-follow-up-work-items.js'

export const AGENT_RESULT_RUNTIME_SCHEMA = {
  type: 'object',
  required: [
    'schema',
    'mission_id',
    'agent_id',
    'session_id',
    'persona_id',
    'task_slice_id',
    'status',
    'backend',
    'summary',
    'findings',
    'proposed_changes',
    'changed_files',
    'lease_compliance',
    'recursion_guard',
    'verification',
    'blockers',
    'confidence',
    'handoff_notes',
    'artifacts',
    'unverified',
    'writes'
  ],
  properties: {
    schema: { const: 'sks.agent-result.v1' },
    mission_id: { type: 'string' },
    agent_id: { type: 'string', minLength: 1 },
    session_id: { type: 'string', minLength: 1 },
    persona_id: { type: 'string' },
    task_slice_id: { type: 'string' },
    work_item_kind: { type: 'string' },
    status: { enum: ['done', 'blocked', 'failed'] },
    backend: { enum: ['fake', 'process', 'codex-sdk', 'python-codex-sdk', 'ollama', 'local-llm'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    proposed_changes: { type: 'array', items: { type: 'string' } },
    changed_files: { type: 'array', items: { type: 'string' } },
    lease_compliance: {
      type: 'object',
      required: ['ok', 'violations'],
      properties: {
        ok: { type: 'boolean' },
        violations: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    },
    recursion_guard: {
      type: 'object',
      required: ['ok', 'violations'],
      properties: {
        ok: { type: 'boolean' },
        violations: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    },
    verification: {
      type: 'object',
      required: ['status', 'checks'],
      properties: {
        status: { type: 'string' },
        checks: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', minLength: 1 }
      },
      additionalProperties: false
    },
    blockers: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string' },
    handoff_notes: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
    writes: { type: 'array', items: { type: 'string' } },
    patch_envelopes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['schema', 'agent_id', 'session_id', 'slot_id', 'generation_index', 'operations'],
        properties: {
          schema: { const: 'sks.agent-patch-envelope.v1' },
          source: { enum: ['fixture', 'model_authored', 'process_generated', 'git-worktree-diff'] },
          mission_id: { type: 'string' },
          route: { type: 'string' },
          agent_id: { type: 'string', minLength: 1 },
          session_id: { type: 'string', minLength: 1 },
          slot_id: { type: 'string', minLength: 1 },
          generation_index: { type: 'integer', minimum: 0 },
          task_slice_id: { type: 'string' },
          native_cli_worker_session_id: { type: 'string' },
          native_cli_process_id: { type: 'number' },
          worker_process_id: { type: 'number' },
          backend_child_process_id: { type: 'number' },
          backend_sdk_thread_id: { type: 'string' },
          backend_ollama_request_id: { type: 'string' },
          fast_mode: { type: 'boolean' },
          service_tier: { enum: ['fast', 'standard'] },
          lease_id: { type: 'string' },
          allowed_paths: { type: 'array', items: { type: 'string' } },
          strategy_task_id: { type: 'string' },
          micro_win_id: { type: 'string' },
          verification_node_id: { type: 'string' },
          rollback_node_id: { type: 'string' },
          lease_proof: {
            type: 'object',
            properties: {
              lease_id: { type: 'string' },
              owner_agent: { type: 'string' },
              owner_persona: { type: 'string' },
              allowed_paths: { type: 'array', items: { type: 'string' } },
              strategy_task_id: { type: 'string' },
              micro_win_id: { type: 'string' },
              protected_path_check: { enum: ['passed', 'blocked', 'not_checked'] },
              conflict_prediction_id: { type: 'string' },
              verification_node_id: { type: 'string' },
              rollback_node_id: { type: 'string' }
            },
            additionalProperties: false
          },
          operations: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['op', 'path'],
              properties: {
                op: { enum: ['replace', 'write', 'unified_diff', 'git_apply_patch'] },
                path: { type: 'string', minLength: 1 },
                search: { type: 'string' },
                replace: { type: 'string' },
                content: { type: 'string' },
                diff: { type: 'string' }
              },
              additionalProperties: false
            }
          },
          rationale: { type: 'string' },
          verification_hint: { type: 'object', additionalProperties: { type: 'string' } },
          rollback_hint: { type: 'object', additionalProperties: { type: 'string' } },
          cochange_acknowledged: { type: 'boolean' },
          cochange_acknowledged_reason: { type: 'string' },
          regression_proof: { type: 'object', additionalProperties: true },
          repair_hypothesis: { type: 'object', additionalProperties: true },
          tournament: { type: 'object', additionalProperties: true },
          git_worktree: { type: 'object', additionalProperties: true }
        },
        additionalProperties: false
      }
    },
    patch_queue_refs: { type: 'array', items: { type: 'string' } },
    applied_patch_refs: { type: 'array', items: { type: 'string' } },
    rollback_refs: { type: 'array', items: { type: 'string' } },
    backend_router_report: { type: 'object', additionalProperties: true },
    codex_child_report: { type: 'object', additionalProperties: true },
    codex_sdk_thread: { type: 'object', additionalProperties: true },
    process_child_report: { type: 'object', additionalProperties: true },
    model_authored_patch_envelopes: { type: 'boolean' },
    fixture_patch_envelopes: { type: 'boolean' },
    no_patch_reason: { type: 'object', additionalProperties: true },
    machine_feedback: { type: 'object', additionalProperties: true },
    regression_proof: { type: 'object', additionalProperties: true },
    repair_hypothesis: { type: 'object', additionalProperties: true },
    tournament: { type: 'object', additionalProperties: true },
    follow_up_work_items: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'title',
          'description',
          'required_persona_category',
          'priority',
          'dependencies',
          'lease_requirements',
          'max_attempts',
          'reason'
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          required_persona_category: { type: 'string', minLength: 1 },
          priority: { type: 'integer', minimum: 0 },
          dependencies: { type: 'array', items: { type: 'string' } },
          lease_requirements: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'path'],
              properties: {
                kind: { type: 'string' },
                path: { type: 'string' }
              },
              additionalProperties: false
            }
          },
          max_attempts: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 1 },
          source_agent_session_id: { type: 'string' }
        },
        additionalProperties: false
      }
    },
    source_intelligence_refs: {
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' }
      ]
    },
    goal_mode_ref: {
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' }
      ]
    },
    worker_scout_evidence: {
      type: 'object',
      required: ['schema', 'ok', 'agent_id', 'artifact_path', 'central_proof_ssot'],
      properties: {
        schema: { const: 'sks.worker-scout-evidence.v1' },
        ok: { type: 'boolean' },
        agent_id: { type: 'string' },
        artifact_path: { type: 'string' },
        central_proof_ssot: { type: 'boolean' },
        blockers: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: true
    }
  },
  additionalProperties: false
} as const

export function validateAgentResultSchema(result: unknown) {
  const validation = validateJsonSchemaRecursive(result, AGENT_RESULT_RUNTIME_SCHEMA as any)
  return {
    schema: 'sks.agent-output-schema-validation.v1',
    ok: validation.ok,
    issues: validation.issues
  }
}

export function validateAndNormalizeAgentFollowUps(rawItems: unknown, originSessionId?: string | null) {
  return normalizeAgentFollowUpWorkItems(rawItems, originSessionId === undefined ? {} : { originSessionId })
}
