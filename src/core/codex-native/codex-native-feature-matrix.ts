export type CodexNativeFeatureStatus = 'available' | 'unavailable' | 'unknown' | 'blocked' | 'fallback'

export type CodexNativeFeatureSource =
  | 'actual-probe'
  | 'codex-doctor'
  | 'plugin-inventory'
  | 'config'
  | 'fixture'
  | 'fallback'
  | 'not-applicable'

export interface CodexNativeFeatureState {
  ok: boolean
  status: CodexNativeFeatureStatus
  source: CodexNativeFeatureSource
  artifact_path: string | null
  evidence: string[]
  blockers: string[]
  warnings: string[]
}

export interface CodexNativeInvocationDefaults {
  loop_worker_role_strategy: 'agent_type' | 'message-role'
  multi_agent_mode: 'none' | 'explicitRequestOnly' | 'proactive'
  rollout_budget_strategy: 'codex-current-shared' | 'sks-local-only'
  qa_visual_review_strategy: 'app-handoff' | 'headless-artifact' | 'blocked'
  research_source_strategy: 'indexed-web-search' | 'mcp-plugin-candidates' | 'web-sources' | 'local-files'
  image_followup_strategy: 'model-visible-path' | 'artifact-path' | 'blocked'
  hook_evidence_policy: 'approved-only' | 'unknown-do-not-count' | 'not-installed'
  skill_bridge_strategy: 'sks-managed-skills' | 'cli-only'
  current_time_source: 'codex-currentTime-read' | 'external-clock'
  overload_retry_policy: 'codex-current-retryable' | 'generic'
}

export interface CodexNativeFeatureMatrix {
  schema: 'sks.codex-native-feature-matrix.v1'
  generated_at: string
  ok: boolean
  codex_cli: {
    available: boolean
    version: string | null
    bin: string | null
  }
  features: {
    plugin_json: CodexNativeFeatureState
    plugin_marketplace: CodexNativeFeatureState
    hook_approval: CodexNativeFeatureState
    skill_picker: CodexNativeFeatureState
    skill_sync: CodexNativeFeatureState
    agent_roles: CodexNativeFeatureState
    agent_type: CodexNativeFeatureState
    mcp_inventory: CodexNativeFeatureState
    app_handoff: CodexNativeFeatureState
    image_path_exposure: CodexNativeFeatureState
    code_mode_web_search: CodexNativeFeatureState
    codex_current: CodexNativeFeatureState
    multi_agent_mode: CodexNativeFeatureState
    rollout_budget: CodexNativeFeatureState
    indexed_web_search: CodexNativeFeatureState
    current_time_read: CodexNativeFeatureState
    terminal_subagent_error: CodexNativeFeatureState
    exec_mcp_reconnect: CodexNativeFeatureState
    plugin_catalog_refresh: CodexNativeFeatureState
    native_thread_list_search: CodexNativeFeatureState
    remote_native_environment: CodexNativeFeatureState
    app_server_overload: CodexNativeFeatureState
    codex_current_feature: CodexNativeFeatureState
    usage_views: CodexNativeFeatureState
    goal_attachment_preservation: CodexNativeFeatureState
    session_delete: CodexNativeFeatureState
    import_command: CodexNativeFeatureState
    unified_mentions: CodexNativeFeatureState
    bedrock_managed_auth: CodexNativeFeatureState
    sqlite_auto_recovery: CodexNativeFeatureState
    mcp_reliability: CodexNativeFeatureState
    non_tty_interrupt: CodexNativeFeatureState
    large_repo_responsiveness: CodexNativeFeatureState
    slash_command_bridge: CodexNativeFeatureState
    project_memory: CodexNativeFeatureState
  }
  probes: Record<string, unknown>
  invocation_defaults: CodexNativeInvocationDefaults
  blockers: string[]
  warnings: string[]
}

export function codexNativeFeatureState(input: {
  ok: boolean
  source: CodexNativeFeatureSource
  artifact_path?: string | null
  evidence?: string[]
  blockers?: string[]
  warnings?: string[]
  unavailableStatus?: Extract<CodexNativeFeatureStatus, 'unavailable' | 'unknown' | 'blocked' | 'fallback'>
}): CodexNativeFeatureState {
  const blockers = uniq(input.blockers || [])
  return {
    ok: input.ok && blockers.length === 0,
    status: input.ok && blockers.length === 0 ? 'available' : input.unavailableStatus || (blockers.length ? 'blocked' : 'unavailable'),
    source: input.source,
    artifact_path: input.artifact_path ?? null,
    evidence: uniq(input.evidence || []),
    blockers,
    warnings: uniq(input.warnings || [])
  }
}

export function computeCodexNativeInvocationDefaults(matrix: Pick<CodexNativeFeatureMatrix, 'features'>): CodexNativeInvocationDefaults {
  const features = matrix.features
  const hookStatus = features.hook_approval.status
  const multiAgentOk = features.multi_agent_mode?.ok === true
  const rolloutBudgetOk = features.rollout_budget?.ok === true
  const indexedSearchOk = features.indexed_web_search?.ok === true
  const currentTimeOk = features.current_time_read?.ok === true
  const overloadOk = features.app_server_overload?.ok === true
  return {
    loop_worker_role_strategy: features.agent_type.ok ? 'agent_type' : 'message-role',
    multi_agent_mode: multiAgentOk && features.agent_type.ok ? 'proactive' : multiAgentOk ? 'explicitRequestOnly' : 'none',
    rollout_budget_strategy: rolloutBudgetOk ? 'codex-current-shared' : 'sks-local-only',
    qa_visual_review_strategy: features.app_handoff.ok ? 'app-handoff' : 'headless-artifact',
    research_source_strategy: indexedSearchOk ? 'indexed-web-search' : features.mcp_inventory.ok ? 'mcp-plugin-candidates' : features.code_mode_web_search.ok ? 'web-sources' : 'local-files',
    image_followup_strategy: features.image_path_exposure.ok ? 'model-visible-path' : 'artifact-path',
    hook_evidence_policy: hookStatus === 'available' ? 'approved-only' : hookStatus === 'unavailable' ? 'not-installed' : 'unknown-do-not-count',
    skill_bridge_strategy: features.skill_sync.ok || features.skill_picker.ok ? 'sks-managed-skills' : 'cli-only',
    current_time_source: currentTimeOk ? 'codex-currentTime-read' : 'external-clock',
    overload_retry_policy: overloadOk ? 'codex-current-retryable' : 'generic'
  }
}

export function matrixFeatureOk(matrix: CodexNativeFeatureMatrix, key: keyof CodexNativeFeatureMatrix['features']): boolean {
  return matrix.features[key].ok
}

export function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}
