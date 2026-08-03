import type { NarutoWorkGraph } from '../naruto/naruto-work-item.js'
import {
  DEFAULT_NARUTO_MAX_THREADS,
  HARD_NARUTO_MAX_THREADS
} from '../subagents/thread-budget.js'

export {
  DEFAULT_NARUTO_MAX_THREADS,
  DEFAULT_NARUTO_REQUESTED_SUBAGENTS,
  HARD_NARUTO_MAX_THREADS
} from '../subagents/thread-budget.js'

export const AGENT_KERNEL_SCHEMA = 'sks.native-agent-kernel.v1'
export const AGENT_RESULT_SCHEMA = 'sks.agent-result.v1'
export const AGENT_LEDGER_EVENT_SCHEMA = 'sks.agent-ledger-event.v1'
export const AGENT_PROOF_EVIDENCE_SCHEMA = 'sks.agent-proof-evidence.v1'
export const AGENT_WORKER_PIPELINE = 'AGENT_WORKER_PIPELINE'
export const AGENT_ORCHESTRATOR_PIPELINE = 'AGENT_ORCHESTRATOR_PIPELINE'
export const DEFAULT_AGENT_COUNT = 5
export const AGENT_COUNT = DEFAULT_AGENT_COUNT
export const OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID = 'official_subagent_execution'
export const MAX_AGENT_COUNT = 20
/**
 * Default concurrent Naruto child budget. Must track DEFAULT_NARUTO_MAX_THREADS —
 * never the GPT-5.6 four-profile matrix count (profiles ≠ agents).
 */
export const DEFAULT_AGENT_CONCURRENCY = DEFAULT_NARUTO_MAX_THREADS
/** Hard concurrency ceiling shared with the Naruto capacity ledger. */
export const HARD_AGENT_CONCURRENCY = HARD_NARUTO_MAX_THREADS
export const AGENT_BACKENDS = ['fake', 'process', 'codex-sdk', 'ollama', 'local-llm'] as const

export type AgentBackend = typeof AGENT_BACKENDS[number]
export type AgentExecutionBackend = 'codex-sdk' | 'python-codex-sdk' | 'local-llm' | 'fake'
export type AgentWorkerPlacement = 'process'
export type AgentServiceTier = 'fast' | 'standard'
export type AgentStatus = 'pending' | 'running' | 'closed' | 'blocked' | 'failed'
export type AgentRole = 'architect' | 'implementer' | 'verifier' | 'safety' | 'integrator' | 'research' | 'documentation' | 'schema' | 'release' | 'ux' | 'db'

export type { AgentFollowUpWorkItem } from './agent-follow-up-work-items.js'
export type { AgentPatchEnvelope } from './agent-patch-schema.js'

export interface AgentPersona {
  id: string
  stable_id: string
  role: AgentRole
  naruto_role?: string
  work_kind?: string
  write_allowed?: boolean
  temperament: string
  risk_focus: string
  allowed_tools: string[]
  denied_tools: string[]
  read_only: boolean
  write_policy: string
  output_expectations: string[]
  output_schema_reminder: string
  central_ledger_communication_rule: string
  recursion_ban: string
  expected_artifacts: string[]
  lease_policy: string
  communication_style: string
  completion_criteria: string[]
  failure_criteria: string[]
  handoff_rules: string[]
  confidence_calibration: string
  verification_plan: string[]
  wrongness_triggers: string[]
  mock_behavior: string
  real_behavior: string
  docs_example: string
  prompt: string
}

export interface AgentRosterEntry {
  id: string
  session_id: string
  persona_id: string
  role: AgentRole
  naruto_role?: string
  work_kind?: string
  write_allowed?: boolean
  index: number
  write_policy: string
  status: AgentStatus
  model?: string
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  model_reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  model_tier?: string
  model_profile?: string
  model_selection_reason?: string
  reasoning_profile?: string
  service_tier?: AgentServiceTier
  fast_mode?: boolean
  reasoning_reason?: string
  dynamic_effort_policy?: {
    escalation_triggers: string[]
    downshift_triggers: string[]
  }
}

export interface AgentRunOptions {
  root?: string
  missionId?: string | null
  sessionKey?: string | null
  prompt?: string
  promptExplicit?: boolean
  route?: string
  agents?: number
  requestedSubagents?: number
  maxThreads?: number
  subagentWorkflow?: boolean
  concurrency?: number
  targetActiveSlots?: number
  desiredWorkItemCount?: number
  minimumWorkItems?: number
  maxQueueExpansion?: number
  routeCommand?: string
  routeBlackboxKind?: string
  refillDelayMs?: number
  roster?: unknown
  backend?: AgentBackend | string
  workerPlacement?: AgentWorkerPlacement | string
  backendExplicit?: boolean
  json?: boolean
  mock?: boolean
  readonly?: boolean
  real?: boolean
  profile?: string | null
  workspaceWrite?: boolean
  writeMode?: 'proof-safe' | 'parallel' | 'serial' | 'off'
  applyPatches?: boolean
  dryRunPatches?: boolean
  maxWriteAgents?: number
  fastMode?: boolean
  serviceTier?: AgentServiceTier
  env?: NodeJS.ProcessEnv
  noFast?: boolean
  ollamaEnabled?: boolean
  noOllama?: boolean
  ollamaModel?: string | null
  ollamaBaseUrl?: string | null
  worktree?: {
    id: string
    path: string
    branch?: string
    main_repo_root?: string | null
  } | null
  maxAgentCount?: number
  narutoWorkGraph?: NarutoWorkGraph | null
  narutoAllocationPolicy?: unknown
  narutoRebalancePolicy?: unknown
  gitWorktreePolicy?: {
    mode: 'git-worktree' | 'patch-envelope-only'
    required?: boolean
    main_repo_root?: string | null
    worktree_root?: string | null
    fallback_reason?: string | null
  } | null
}

export interface AgentTaskSlice {
  id: string
  owner_agent_id: string
  role: AgentRole | string
  domain: string
  title?: string
  dependencies?: string[]
  priority?: number
  required_persona_category?: string
  lease_requirements?: unknown[]
  generated_by?: string
  route_domain?: string
  work_item_kind?: string
  max_attempts?: number
  target_paths: string[]
  readonly_paths: string[]
  write_paths: string[]
  description: string
  tournament_group_id?: string | null
  tournament_candidate_index?: number | null
  tournament_candidate_count?: number | null
  approach_directive?: string | null
  strategy_refs?: Record<string, unknown> | null
  micro_win_id?: string | null
  verification_node_id?: string | null
  rollback_node_id?: string | null
  dopamine_weight?: number
  appshot_required?: boolean
}

export interface AgentLease {
  id: string
  agent_id: string
  session_id?: string
  kind: 'write' | 'read'
  path: string
  domain?: string
  status: 'active' | 'released' | 'conflicted'
  strategy_task_id?: string
  micro_win_id?: string
  owner_agent?: string
  owner_persona?: string
  write_paths?: string[]
  protected_path_check?: { ok: boolean; blockers: string[] }
  conflict_prediction_id?: string | null
  verification_node_id?: string | null
  rollback_node_id?: string | null
  tournament_group_id?: string | null
  strategy_artifact?: string
}

export interface AgentRunnerResult {
  schema: typeof AGENT_RESULT_SCHEMA
  mission_id: string
  agent_id: string
  session_id: string
  persona_id: string
  task_slice_id: string
  work_item_kind?: string
  status: 'done' | 'blocked' | 'failed'
  backend: AgentBackend
  summary: string
  findings: string[]
  proposed_changes: string[]
  changed_files: string[]
  lease_compliance: { ok: boolean; violations: string[] }
  artifacts: string[]
  blockers: string[]
  confidence: string
  handoff_notes: string
  unverified: string[]
  writes: string[]
  patch_envelopes?: import('./agent-patch-schema.js').AgentPatchEnvelope[]
  patch_queue_refs?: string[]
  applied_patch_refs?: string[]
  rollback_refs?: string[]
  backend_router_report?: Record<string, unknown>
  codex_child_report?: Record<string, unknown>
  codex_sdk_thread?: Record<string, unknown>
  process_child_report?: Record<string, unknown>
  model_authored_patch_envelopes?: boolean
  fixture_patch_envelopes?: boolean
  no_patch_reason?: Record<string, unknown>
  machine_feedback?: Record<string, unknown>
  regression_proof?: Record<string, unknown>
  repair_hypothesis?: Record<string, unknown>
  tournament?: Record<string, unknown>
  source_intelligence_refs?: Record<string, unknown> | null
  goal_mode_ref?: Record<string, unknown> | null
  follow_up_work_items?: import('./agent-follow-up-work-items.js').AgentFollowUpWorkItem[]
  recursion_guard: { ok: boolean; violations: string[] }
  verification: { status: string; checks: string[]; reason?: string }
  naruto_runtime?: Record<string, unknown>
  control_plane_result?: Record<string, unknown>
}

export function normalizeAgentBackend(input: unknown): AgentBackend | null {
  const value = String(input || 'codex-sdk')
  return (AGENT_BACKENDS as readonly string[]).includes(value) ? value as AgentBackend : null
}

export function agentSessionId(agentId: string, index = 1): string {
  return agentId + '-session-' + String(index).padStart(2, '0')
}
