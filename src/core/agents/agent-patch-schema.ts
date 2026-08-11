export const AGENT_PATCH_SCHEMA = 'sks.agent-patch-envelope.v1'

export type AgentPatchOperationKind = 'replace' | 'write' | 'unified_diff' | 'git_apply_patch'

export interface AgentPatchOperation {
  op: AgentPatchOperationKind
  path: string
  search?: string
  replace?: string
  content?: string
  diff?: string
}

export interface AgentPatchEnvelope {
  schema: typeof AGENT_PATCH_SCHEMA
  source?: 'fixture' | 'model_authored' | 'process_generated' | 'git-worktree-diff'
  mission_id?: string
  route?: string
  agent_id: string
  session_id: string
  slot_id: string
  generation_index: number
  task_slice_id?: string
  native_cli_worker_session_id?: string
  native_cli_process_id?: number
  worker_process_id?: number
  backend_child_process_id?: number
  backend_sdk_thread_id?: string
  fast_mode?: boolean
  service_tier?: 'fast' | 'standard'
  lease_id?: string
  allowed_paths?: string[]
  strategy_task_id?: string
  micro_win_id?: string
  verification_node_id?: string
  rollback_node_id?: string
  lease_proof?: {
    lease_id?: string
    owner_agent?: string
    owner_persona?: string
    allowed_paths?: string[]
    strategy_task_id?: string
    micro_win_id?: string
    protected_path_check?: 'passed' | 'blocked' | 'not_checked'
    conflict_prediction_id?: string
    verification_node_id?: string
    rollback_node_id?: string
  }
  git_worktree?: {
    main_repo_root: string
    worktree_path: string
    branch: string | null
    base_head: string | null
    worktree_head: string | null
    changed_files: string[]
    diff_bytes: number
    checkpoint?: {
      schema?: string
      mode_applied?: string
      commit_hash?: string | null
      changed_files?: string[]
      blockers?: string[]
    } | null
  }
  operations: AgentPatchOperation[]
  rationale?: string
  verification_hint?: AgentPatchHint
  rollback_hint?: AgentPatchHint
  cochange_acknowledged?: boolean
  cochange_acknowledged_reason?: string
  regression_proof?: {
    test_file?: string
    failed_before?: boolean
    passed_after?: boolean
    output_digest?: string
  }
  repair_hypothesis?: Record<string, unknown>
  tournament?: Record<string, unknown>
}

type AgentPatchLeaseProof = NonNullable<AgentPatchEnvelope['lease_proof']>

export interface AgentPatchHint {
  command?: string
  node_id?: string
  artifact?: string
  notes?: string
}

export function normalizeAgentPatchEnvelope(input: any): AgentPatchEnvelope {
  const generationIndex = Number(input?.generation_index ?? input?.generationIndex)
  const source = normalizeEnvelopeSource(input?.source)
  return {
    schema: AGENT_PATCH_SCHEMA,
    ...(source ? { source } : {}),
    ...(input?.mission_id ? { mission_id: String(input.mission_id) } : {}),
    ...(input?.route ? { route: String(input.route) } : {}),
    agent_id: String(input?.agent_id || input?.agentId || 'unknown-agent'),
    session_id: String(input?.session_id || input?.sessionId || ''),
    slot_id: String(input?.slot_id || input?.slotId || ''),
    generation_index: Number.isFinite(generationIndex) ? Math.floor(generationIndex) : -1,
    ...(input?.task_slice_id ? { task_slice_id: String(input.task_slice_id) } : {}),
    ...(input?.native_cli_worker_session_id ? { native_cli_worker_session_id: String(input.native_cli_worker_session_id) } : {}),
    ...(hasFiniteNumber(input?.native_cli_process_id) ? { native_cli_process_id: Number(input.native_cli_process_id) } : {}),
    ...(hasFiniteNumber(input?.worker_process_id) ? { worker_process_id: Number(input.worker_process_id) } : {}),
    ...(hasFiniteNumber(input?.backend_child_process_id) ? { backend_child_process_id: Number(input.backend_child_process_id) } : {}),
    ...(input?.backend_sdk_thread_id ? { backend_sdk_thread_id: String(input.backend_sdk_thread_id) } : {}),
    ...(input?.fast_mode === undefined ? {} : { fast_mode: Boolean(input.fast_mode) }),
    ...(input?.service_tier === 'fast' || input?.service_tier === 'standard' ? { service_tier: input.service_tier } : {}),
    ...(input?.lease_id ? { lease_id: String(input.lease_id) } : {}),
    ...(Array.isArray(input?.allowed_paths) ? { allowed_paths: input.allowed_paths.map(String) } : {}),
    ...(input?.strategy_task_id === undefined ? {} : { strategy_task_id: String(input.strategy_task_id) }),
    ...(input?.micro_win_id === undefined ? {} : { micro_win_id: String(input.micro_win_id) }),
    ...(input?.verification_node_id === undefined ? {} : { verification_node_id: String(input.verification_node_id) }),
    ...(input?.rollback_node_id === undefined ? {} : { rollback_node_id: String(input.rollback_node_id) }),
    ...(input?.lease_proof ? { lease_proof: normalizeLeaseProof(input.lease_proof) } : {}),
    ...(input?.git_worktree ? { git_worktree: normalizeGitWorktreeMetadata(input.git_worktree) } : {}),
    ...(input?.rationale ? { rationale: String(input.rationale) } : {}),
    ...(input?.verification_hint ? { verification_hint: normalizeHint(input.verification_hint) } : {}),
    ...(input?.rollback_hint ? { rollback_hint: normalizeHint(input.rollback_hint) } : {}),
    ...(input?.cochange_acknowledged === undefined ? {} : { cochange_acknowledged: Boolean(input.cochange_acknowledged) }),
    ...(input?.cochange_acknowledged_reason === undefined ? {} : { cochange_acknowledged_reason: String(input.cochange_acknowledged_reason) }),
    ...(input?.regression_proof ? { regression_proof: normalizeRegressionProof(input.regression_proof) } : {}),
    ...(input?.repair_hypothesis && typeof input.repair_hypothesis === 'object' ? { repair_hypothesis: input.repair_hypothesis } : {}),
    ...(input?.tournament && typeof input.tournament === 'object' ? { tournament: input.tournament } : {}),
    operations: Array.isArray(input?.operations) ? input.operations.map(normalizeOperation) : []
  }
}

export function validateAgentPatchEnvelope(envelope: AgentPatchEnvelope): { ok: boolean; violations: string[] } {
  const violations: string[] = []
  if (envelope.schema !== AGENT_PATCH_SCHEMA) violations.push('schema_mismatch')
  if (!envelope.agent_id) violations.push('agent_id_missing')
  if (!envelope.session_id) violations.push('session_id_missing')
  if (!envelope.slot_id) violations.push('slot_id_missing')
  if (!Number.isInteger(envelope.generation_index) || envelope.generation_index < 0) violations.push('generation_index_missing')
  if (!envelope.lease_id && !envelope.lease_proof?.lease_id) violations.push('lease_id_missing')
  if (!envelope.operations.length) violations.push('operations_missing')
  if (envelope.source && !['fixture', 'model_authored', 'process_generated', 'git-worktree-diff'].includes(envelope.source)) violations.push('source_invalid')
  if (envelope.source === 'model_authored' && !hasFiniteNumber(envelope.backend_child_process_id) && !envelope.backend_sdk_thread_id) violations.push('model_authored_backend_proof_missing')
  if (envelope.source === 'fixture' && envelope.backend_child_process_id !== undefined) violations.push('fixture_backend_child_process_id_present')
  if (envelope.source === 'git-worktree-diff' && !envelope.git_worktree?.worktree_path) violations.push('git_worktree_metadata_missing')
  for (const operation of envelope.operations) {
    if (!operation.path || operation.path.includes('\0') || operation.path.startsWith('/') || operation.path.split(/[\\/]/).includes('..')) {
      violations.push(`invalid_path:${operation.path || 'missing'}`)
    }
    if (operation.op === 'replace' && typeof operation.search !== 'string') violations.push(`replace_search_missing:${operation.path}`)
    if (operation.op === 'write' && typeof operation.content !== 'string') violations.push(`write_content_missing:${operation.path}`)
    if (operation.op === 'unified_diff' && typeof operation.diff !== 'string') violations.push(`unified_diff_missing:${operation.path}`)
    if (operation.op === 'git_apply_patch' && typeof operation.diff !== 'string') violations.push(`git_apply_patch_missing:${operation.path}`)
    const allowedPaths = envelope.allowed_paths?.length ? envelope.allowed_paths : envelope.lease_proof?.allowed_paths
    if (operation.op !== 'git_apply_patch' && allowedPaths?.length && !pathAllowedByLease(operation.path, allowedPaths)) {
      violations.push(`lease_path_not_allowed:${operation.path}`)
    }
  }
  return { ok: violations.length === 0, violations }
}

function normalizeEnvelopeSource(value: any): AgentPatchEnvelope['source'] | null {
  const text = String(value || '')
  return text === 'fixture' || text === 'model_authored' || text === 'process_generated' || text === 'git-worktree-diff' ? text : null
}

function hasFiniteNumber(value: any): boolean {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function normalizeOperation(input: any): AgentPatchOperation {
  const op = input?.op === 'write' ? 'write' : input?.op === 'git_apply_patch' ? 'git_apply_patch' : input?.op === 'unified_diff' || input?.op === 'patch' ? 'unified_diff' : 'replace'
  return {
    op,
    path: String(input?.path || ''),
    ...(input?.search === undefined ? {} : { search: String(input.search) }),
    ...(input?.replace === undefined ? {} : { replace: String(input.replace) }),
    ...(input?.content === undefined ? {} : { content: String(input.content) }),
    ...(input?.diff === undefined ? {} : { diff: String(input.diff) })
  }
}

function normalizeLeaseProof(input: any): AgentPatchLeaseProof {
  return {
    ...(input?.lease_id === undefined ? {} : { lease_id: String(input.lease_id) }),
    ...(input?.owner_agent === undefined ? {} : { owner_agent: String(input.owner_agent) }),
    ...(input?.owner_persona === undefined ? {} : { owner_persona: String(input.owner_persona) }),
    ...(Array.isArray(input?.allowed_paths) ? { allowed_paths: input.allowed_paths.map(String) } : {}),
    ...(input?.strategy_task_id === undefined ? {} : { strategy_task_id: String(input.strategy_task_id) }),
    ...(input?.micro_win_id === undefined ? {} : { micro_win_id: String(input.micro_win_id) }),
    ...(input?.protected_path_check === undefined ? {} : { protected_path_check: normalizeProtectedPathCheck(input.protected_path_check) }),
    ...(input?.conflict_prediction_id === undefined ? {} : { conflict_prediction_id: String(input.conflict_prediction_id) }),
    ...(input?.verification_node_id === undefined ? {} : { verification_node_id: String(input.verification_node_id) }),
    ...(input?.rollback_node_id === undefined ? {} : { rollback_node_id: String(input.rollback_node_id) })
  }
}

function normalizeGitWorktreeMetadata(input: any): NonNullable<AgentPatchEnvelope['git_worktree']> {
  return {
    main_repo_root: String(input?.main_repo_root || ''),
    worktree_path: String(input?.worktree_path || ''),
    branch: input?.branch == null ? null : String(input.branch),
    base_head: input?.base_head == null ? null : String(input.base_head),
    worktree_head: input?.worktree_head == null ? null : String(input.worktree_head),
    changed_files: Array.isArray(input?.changed_files) ? input.changed_files.map(String) : [],
    diff_bytes: Number(input?.diff_bytes || 0),
    checkpoint: input?.checkpoint ? {
      ...(input.checkpoint.schema === undefined ? {} : { schema: String(input.checkpoint.schema) }),
      ...(input.checkpoint.mode_applied === undefined ? {} : { mode_applied: String(input.checkpoint.mode_applied) }),
      commit_hash: input.checkpoint.commit_hash == null ? null : String(input.checkpoint.commit_hash),
      changed_files: Array.isArray(input.checkpoint.changed_files) ? input.checkpoint.changed_files.map(String) : [],
      blockers: Array.isArray(input.checkpoint.blockers) ? input.checkpoint.blockers.map(String) : []
    } : null
  }
}

function normalizeHint(input: any): AgentPatchHint {
  return {
    ...(input?.command === undefined ? {} : { command: String(input.command) }),
    ...(input?.node_id === undefined ? {} : { node_id: String(input.node_id) }),
    ...(input?.artifact === undefined ? {} : { artifact: String(input.artifact) }),
    ...(input?.notes === undefined ? {} : { notes: String(input.notes) })
  }
}

function normalizeRegressionProof(input: any): NonNullable<AgentPatchEnvelope['regression_proof']> {
  return {
    ...(input?.test_file === undefined ? {} : { test_file: String(input.test_file) }),
    ...(input?.failed_before === undefined ? {} : { failed_before: Boolean(input.failed_before) }),
    ...(input?.passed_after === undefined ? {} : { passed_after: Boolean(input.passed_after) }),
    ...(input?.output_digest === undefined ? {} : { output_digest: String(input.output_digest) })
  }
}

function pathAllowedByLease(operationPath: string, allowedPaths: string[]): boolean {
  const rel = normalizePatchPath(operationPath)
  return allowedPaths.map(normalizePatchPath).some((allowed) => rel === allowed || rel.startsWith(`${allowed}/`))
}

function normalizePatchPath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').split('/').filter((part) => part && part !== '.').join('/')
}

function normalizeProtectedPathCheck(value: any): 'passed' | 'blocked' | 'not_checked' {
  const text = String(value || '')
  return text === 'passed' || text === 'blocked' || text === 'not_checked' ? text : 'not_checked'
}
