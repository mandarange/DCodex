import type { AgentPersona } from './agent-schema.js'
import { codexModelEffortCapability, type CodexModelEffortCapability } from '../codex-control/codex-model-capabilities.js'
import { managedOfficialSubagentRoleByName } from '../managed-assets/managed-assets-manifest.js'
import { ASTRA_SUBAGENT_MODEL, decideSubagentModel, subagentModelProfile } from '../subagents/model-policy.js'

export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type AgentModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type AgentWorkerModelTier = string

export interface AgentEffortDecision {
  schema: 'sks.agent-effort-decision.v1'
  policy_version: 1
  agent_id: string
  role: string
  model: string
  reasoning_effort: AgentReasoningEffort
  model_reasoning_effort: AgentModelReasoningEffort
  model_tier: AgentWorkerModelTier
  model_profile: string
  model_selection_reason: string
  reasoning_profile: string
  service_tier: 'fast'
  reason: string
  dynamic: true
  escalation_triggers: string[]
  downshift_triggers: string[]
  model_effort_capability?: CodexModelEffortCapability
}

export function decideAgentEffort(input: { persona?: Partial<AgentPersona>; prompt?: string; agentId?: string; readonly?: boolean } = {}): AgentEffortDecision {
  return decideOfficialSubagentModel(input)
}

// Official Codex subagents use one of four fixed profiles: Astra Low for tiny
// mechanical work, Astra High for ordinary implementation, Astra Max for
// judgment, and Astra Medium for long-context or Codex-tool execution.
export function decideOfficialSubagentModel(input: { persona?: Partial<AgentPersona>; prompt?: string; agentId?: string; readonly?: boolean } = {}): AgentEffortDecision {
  const persona = input.persona || {}
  const prompt = String(input.prompt || '')
  const role = String(persona.role || '')
  const agentId = String(input.agentId || persona.id || 'subagent')
  const routingRole = [agentId, persona.naruto_role, persona.work_kind, role].filter(Boolean).join(' ')
  const managedRole = managedOfficialSubagentRoleByName(agentId)
    || managedOfficialSubagentRoleByName(String(persona.naruto_role || ''))
    || managedOfficialSubagentRoleByName(role)
  // Installed custom-agent roles already seal Astra Low/Astra High/Max/Medium.
  // Prefer that catalog contract over re-scoring the parent goal text, which
  // otherwise collapses almost every child onto Astra Max.
  if (managedRole) {
    const profile = subagentModelProfile(managedRole.model_policy)
    const effort: AgentReasoningEffort = profile.modelReasoningEffort
    const modelCapability = codexModelEffortCapability({
      model: profile.model,
      advertisedEfforts: [effort],
      defaultEffort: effort
    })
    return {
      schema: 'sks.agent-effort-decision.v1',
      policy_version: 1,
      agent_id: agentId,
      role,
      model: profile.model,
      reasoning_effort: effort,
      model_reasoning_effort: effort,
      model_tier: `${profile.model}-${effort}`,
      model_profile: `sks-official-subagent-${safeProfileSegment(profile.model)}-${effort}-fast`,
      model_selection_reason: profile.policy,
      model_effort_capability: modelCapability,
      reasoning_profile: reasoningProfileName(effort),
      service_tier: 'fast',
      reason: `managed_role:${managedRole.codex_name}:${profile.policy}`,
      dynamic: true,
      escalation_triggers: [
        'focused review, debugging, planning, integration, security, database, research, release, or unresolved ambiguity selects Astra Max',
        'incidental judgment vocabulary does not override a clearly classified implementation or context/tools slice',
        'requested model/effort profile unavailable blocks instead of silently falling back'
      ],
      downshift_triggers: [
        'ordinary UI, logic, backend, or native implementation selects Astra High',
        'long-context, Browser/Chrome, Computer Use, image-generation, or large search selects Astra Medium',
        'tiny short-context mechanical search/typing/rename work selects Astra Low'
      ]
    }
  }
  const promptIsDocsExploration = /\b(?:read|scan|explore|compare|summarize|review)\b[^\n]{0,64}\b(?:docs?|documentation|manual|notes?|references?)\b/i.test(prompt)
  const promptIsFocusedJudgment = !promptIsDocsExploration
    && /^(?:\s*)(?:review|audit|debug(?:ger|ging)?|diagnos|investigat|plan|assess)\b|\b(?:security|database|release|production|high[- ]?risk)\b[^\n]{0,48}\b(?:review|audit|decision|plan|assessment)\b/i.test(prompt)
  const taskClass = promptIsFocusedJudgment
    || /(?:debugger|expert|_reviewer|research_synthesizer)/i.test(routingRole)
    ? 'judgment' as const
    : /(?:implementation_specialist|ui_implementer|native_app_specialist)/i.test(routingRole)
    ? 'implementation' as const
    : /(?:explorer|docs_maintainer|long_context_analyst|computer_use_operator|browser_use_operator|image_generation_operator)/i.test(routingRole)
      ? 'context_tools' as const
      : /\bworker\b/i.test(routingRole)
        ? 'mechanical' as const
        : undefined
  const routed = decideSubagentModel({
    title: routingRole,
    description: [prompt, persona.risk_focus, persona.write_policy].filter(Boolean).join(' '),
    role,
    expectedOutput: (persona.output_expectations || []).join(' '),
    ...(taskClass ? { taskClass } : {})
  })
  const effort: AgentReasoningEffort = routed.modelReasoningEffort
  const modelCapability = codexModelEffortCapability({
    model: routed.model,
    advertisedEfforts: [effort],
    defaultEffort: effort
  })
  return {
    schema: 'sks.agent-effort-decision.v1',
    policy_version: 1,
    agent_id: agentId,
    role,
    model: routed.model,
    reasoning_effort: effort,
    model_reasoning_effort: effort,
    model_tier: `${routed.model}-${effort}`,
    model_profile: `sks-official-subagent-${safeProfileSegment(routed.model)}-${effort}-fast`,
    model_selection_reason: routed.reason,
    model_effort_capability: modelCapability,
    reasoning_profile: reasoningProfileName(effort),
    service_tier: 'fast',
    reason: routed.reason,
    dynamic: true,
    escalation_triggers: [
      'focused review, debugging, planning, integration, security, database, research, release, or unresolved ambiguity selects Astra Max',
      'incidental judgment vocabulary does not override a clearly classified implementation or context/tools slice',
      'requested model/effort profile unavailable blocks instead of silently falling back'
    ],
    downshift_triggers: [
      'ordinary UI, logic, backend, or native implementation selects Astra High',
      'long-context, Browser/Chrome, Computer Use, or image-generation execution selects Astra Medium',
      'tiny short-context mechanical work selects Astra Low'
    ]
  }
}

export function buildAgentEffortPolicy(roster: any = {}) {
  const decisions = Array.isArray(roster.roster) ? roster.roster.map((agent: any) => ({
    agent_id: agent.id,
    session_id: agent.session_id,
    role: agent.role,
    model: agent.model,
    reasoning_effort: agent.reasoning_effort,
    model_reasoning_effort: agent.model_reasoning_effort,
    model_tier: agent.model_tier,
    model_profile: agent.model_profile,
    model_selection_reason: agent.model_selection_reason,
    reasoning_profile: agent.reasoning_profile,
    reason: agent.reasoning_reason,
    dynamic: true
  })) : []
  return {
    schema: 'sks.agent-effort-policy.v1',
    policy_version: 1,
    dynamic: true,
    service_tier: 'fast',
    model_catalog_policy: 'official_subagent_four_profile_matrix',
    model_constraint: [ASTRA_SUBAGENT_MODEL],
    model_tiers: ['low', 'medium', 'high', 'max'].map((effort) => `${ASTRA_SUBAGENT_MODEL}-${effort}`),
    allowed_efforts: ['low', 'medium', 'high', 'max'],
    model_effort_capability: codexModelEffortCapability({ model: ASTRA_SUBAGENT_MODEL }),
    max_agents: roster.max_agents || 20,
    agent_count: roster.agent_count || decisions.length,
    concurrency: roster.concurrency || decisions.length,
    decisions,
    rule: 'All child agents use GPT-6 Astra: Low for tiny short-context mechanical work, Medium for reads and tool execution, High for ordinary implementation, and Max for focused judgment. The parent keeps its user-selected model.'
  }
}

export function reasoningProfileName(effort: AgentReasoningEffort | string) {
  return 'sks-agent-' + String(effort || 'medium') + '-fast'
}

export function decideAgentWorkerModel(input: {
  effort?: AgentReasoningEffort | string | null
  prompt?: string
  role?: string
  agentId?: string
  readonly?: boolean
  writePolicy?: string
  mainModel?: string | null
} = {}): {
  model: string
  model_reasoning_effort: AgentModelReasoningEffort
  model_tier: AgentWorkerModelTier
  model_profile: string
  reason: string
} {
  // Parent and provider model selections never override the child profile.
  // Keep mainModel/effort in the input contract for existing callers.
  const decision = decideOfficialSubagentModel({
    persona: { role: String(input.role || '') as AgentPersona['role'], write_policy: String(input.writePolicy || '') },
    prompt: String(input.prompt || ''),
    agentId: String(input.agentId || 'agent'),
    readonly: input.readonly === true
  })
  return {
    model: decision.model,
    model_reasoning_effort: decision.model_reasoning_effort,
    model_tier: decision.model_tier,
    model_profile: decision.model_profile,
    reason: decision.model_selection_reason
  }
}

function safeProfileSegment(value: string): string {
  return String(value || 'codex-selected').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'codex-selected'
}
