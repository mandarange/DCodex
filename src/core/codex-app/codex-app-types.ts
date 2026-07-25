import { isRecord } from '../json/records.js';

export { isRecord };
export interface ProbeBlockers {
  blockers: string[]
  warnings?: string[]
}

export interface CodexAppFeatureHealth {
  ok: boolean
  status: 'ok' | 'degraded' | 'unknown' | 'missing' | 'blocked'
  evidence: string[]
  blockers: string[]
  warnings: string[]
}

export type CodexHookApprovalState =
  | 'approved'
  | 'pending_review'
  | 'modified_requires_reapproval'
  | 'unknown'
  | 'not_installed'

export type CodexHookApprovalSource =
  | 'codex-doctor-json'
  | 'plugin-inventory'
  | 'hook-actual-state'
  | 'startup-review-cache'
  | 'config'

export interface CodexHookApprovalSourceCheck {
  source: CodexHookApprovalSource
  ok: boolean
  evidence: string[]
  blockers: string[]
}

export interface CodexHookApprovalProbe {
  schema: 'sks.codex-hook-approval-probe.v1'
  generated_at: string
  ok: boolean
  detectable: boolean
  approval_state: CodexHookApprovalState
  sources_checked: CodexHookApprovalSourceCheck[]
  blockers: string[]
  warnings: string[]
}

export interface CodexAgentTypeProbe {
  schema: 'sks.codex-agent-type-probe.v1'
  generated_at: string
  ok: boolean
  supported: boolean
  source: 'codex-tool-schema' | 'codex-doctor-json' | 'codex-help' | 'env' | 'fixture' | 'unknown'
  spawn_tool_name: 'spawn_agent' | 'unknown'
  schema_path: string | null
  evidence: string[]
  blockers: string[]
  warnings: string[]
}

export interface CodexAgentRolePayload {
  strategy: 'agent_type' | 'message-role'
  agent_type?: string
  message_role_prefix?: string
  probe_artifact_path?: string | null
}

export interface CodexAppHarnessMatrix {
  schema: 'sks.codex-app-harness-matrix.v1'
  generated_at: string
  ok: boolean
  codex_cli: { available: boolean; version: string | null }
  app_features: {
    plugin_json: boolean
    marketplace_add: boolean
    marketplace_upgrade: boolean
    startup_review_detectable: boolean
    hook_approval_state_detectable: boolean
    hook_approval_state: CodexHookApprovalState
    skill_picker_ready: boolean
    agent_type_supported: boolean
    mcp_inventory_ready: boolean
    app_handoff_ready: boolean
    image_path_exposure_ready: boolean
  }
  sks_integrations: {
    dollar_skills_synced: boolean
    agent_roles_synced: boolean
    hooks_synced: boolean
    init_deep_available: boolean
    loop_mesh_app_profile_available: boolean
  }
  probes: {
    hook_approval: CodexHookApprovalProbe
    agent_type: CodexAgentTypeProbe
  }
  blockers: string[]
  warnings: string[]
}

export type CodexAppExecutionProfileMode =
  | 'codex-app-native'
  | 'codex-cli-headless'
  | 'sks-loop-headless'
  | 'degraded-no-app'

export interface CodexAppExecutionProfile {
  schema: 'sks.codex-app-execution-profile.v1'
  generated_at: string
  ok: boolean
  mode: CodexAppExecutionProfileMode
  agent_role_strategy: 'agent_type' | 'message-role'
  hooks_assumed_running: false
  hooks_approval_required: boolean
  hook_approval_state: CodexHookApprovalState
  app_handoff_ready: boolean
  image_path_exposure_ready: boolean
  plugin_mcp_inventory_ready: boolean
  loop_mesh_app_profile_available: boolean
  artifact_path: string
  matrix_artifact_path: string
  agent_type_probe_artifact_path: string
  hook_approval_probe_artifact_path: string
  blockers: string[]
  warnings: string[]
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []
}

export function isCodexAppHarnessMatrix(value: unknown): value is CodexAppHarnessMatrix {
  if (!isRecord(value)) return false
  if (value.schema !== 'sks.codex-app-harness-matrix.v1') return false
  const app = value.app_features
  const sks = value.sks_integrations
  return isRecord(app)
    && isRecord(sks)
    && typeof value.ok === 'boolean'
    && isRecord(value.codex_cli)
    && Array.isArray(value.blockers)
    && Array.isArray(value.warnings)
}
