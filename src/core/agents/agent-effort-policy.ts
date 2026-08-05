import type { AgentPersona } from './agent-schema.js'
import { codexModelEffortCapability, type CodexModelEffortCapability } from '../codex-control/codex-model-capabilities.js'
import { OPENROUTER_DEFAULT_MODEL } from '../codex-app/openrouter-provider.js'
import { managedOfficialSubagentRoleByName } from '../managed-assets/managed-assets-manifest.js'
import { isNarutoGpt56Model } from '../provider/model-router.js'
import type { OpenRouterReasoningEffort } from '../providers/openrouter/openrouter-types.js'
import { decideSubagentModel, subagentModelProfile } from '../subagents/model-policy.js'

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

const XHIGH_SIGNAL_RE = /(frontier|autoresearch|novelty|hypothesis|falsif|forensic|from-chat-img|image\s*work\s*order|새로운\s*연구|가설|포렌식)/i
const HIGH_SIGNAL_RE = /(database|supabase|sql|migration|security|permission|mad|release|publish|deploy|architecture|policy|schema|hook|rollback|db|보안|배포|마이그레이션|데이터베이스|권한|릴리즈)/i
const MEDIUM_SIGNAL_RE = /(terminal|cli|tool(?:\s|-)?call|router|routing|orchestrat|pipeline|multi[-\s]?session|multi[-\s]?agent|lease|ledger|proof|검증|파이프라인|오케스트레이션|병렬|에이전트)/i
const SIMPLE_SIGNAL_RE = /(tiny|simple|small|one[-\s]?line|typo|copy|label|spacing|rename|readme|docs?|간단|단순|오타|문구|라벨)/i
const SIMPLE_CODE_MOD_RE = /(tiny|simple|small|one[-\s]?line|typo|copy|label|spacing|rename|readme|docs?|minor|bounded|간단|단순|작은|오타|문구|라벨|이름\s*변경)/i

export function decideAgentEffort(input: { persona?: Partial<AgentPersona>; prompt?: string; agentId?: string; readonly?: boolean } = {}): AgentEffortDecision {
  const persona = input.persona || {}
  const prompt = String(input.prompt || '')
  const role = String(persona.role || '')
  const agentId = String(input.agentId || persona.id || 'agent')
  const text = [prompt, role, persona.risk_focus, persona.write_policy, persona.stable_id].join(' ')
  let effort = promptEffort(text)
  let reason = effortReason(effort)

  if (/(db|safety|security|release|schema)/i.test([role, agentId, persona.stable_id, persona.risk_focus].join(' '))) {
    effort = effort === 'xhigh' ? 'xhigh' : 'high'
    reason = 'risk_guardian_lane'
  } else if (/(integrator|architect|verifier)/i.test([role, agentId, persona.stable_id].join(' ')) && effort === 'low') {
    effort = 'medium'
    reason = 'planning_verification_minimum'
  } else if (input.readonly === true && SIMPLE_SIGNAL_RE.test(prompt) && !HIGH_SIGNAL_RE.test(text) && !MEDIUM_SIGNAL_RE.test(text)) {
    effort = 'low'
    reason = 'read_only_simple_slice'
  } else if (/implementer/i.test(role) && effort === 'xhigh') {
    effort = 'high'
    reason = 'implementation_lane_capped_at_high'
  }

  const modelDecision = decideAgentWorkerModel({ effort, prompt, role, agentId, readonly: input.readonly === true || persona.read_only === true, writePolicy: String(persona.write_policy || '') })
  const modelCapability = codexModelEffortCapability({ model: modelDecision.model, defaultEffort: modelDecision.model_reasoning_effort })
  return {
    schema: 'sks.agent-effort-decision.v1',
    policy_version: 1,
    agent_id: agentId,
    role,
    model: modelDecision.model,
    reasoning_effort: effort,
    model_reasoning_effort: modelDecision.model_reasoning_effort,
    model_tier: modelDecision.model_tier,
    model_profile: modelDecision.model_profile,
    model_selection_reason: modelDecision.reason,
    model_effort_capability: modelCapability,
    reasoning_profile: reasoningProfileName(effort),
    service_tier: 'fast',
    reason,
    dynamic: true,
    escalation_triggers: [
      'DB/security/release/schema risk detected',
      'lease conflict or proof blocker appears',
      'verification fails or output schema validation fails',
      'user requests real backend or broader agent fan-out'
    ],
    downshift_triggers: [
      'read-only simple docs/copy slice',
      'mock fixture backend with no risky file ownership',
      'agent assigned narrow inventory-only work'
    ]
  }
}

// Official Codex subagents use one of four fixed profiles: Luna Max for tiny
// mechanical work, Sol High for ordinary implementation, Sol Max for
// judgment, and Terra Max for long-context or Codex-tool execution.
export function decideOfficialSubagentModel(input: { persona?: Partial<AgentPersona>; prompt?: string; agentId?: string; readonly?: boolean } = {}): AgentEffortDecision {
  const persona = input.persona || {}
  const prompt = String(input.prompt || '')
  const role = String(persona.role || '')
  const agentId = String(input.agentId || persona.id || 'subagent')
  const routingRole = [agentId, persona.naruto_role, persona.work_kind, role].filter(Boolean).join(' ')
  const managedRole = managedOfficialSubagentRoleByName(agentId)
    || managedOfficialSubagentRoleByName(String(persona.naruto_role || ''))
    || managedOfficialSubagentRoleByName(role)
  // Installed custom-agent roles already seal Luna/Terra/Sol High/Sol Max.
  // Prefer that catalog contract over re-scoring the parent goal text, which
  // otherwise collapses almost every child onto Sol.
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
        'focused review, debugging, planning, integration, security, database, research, release, or unresolved ambiguity selects Sol Max',
        'incidental judgment vocabulary does not override a clearly classified implementation or context/tools slice',
        'requested model/effort profile unavailable blocks instead of silently falling back'
      ],
      downshift_triggers: [
        'ordinary UI, logic, backend, or native implementation selects Sol High',
        'long-context, Browser/Chrome, Computer Use, image-generation, or large search selects Terra Max',
        'tiny short-context mechanical search/typing/rename work selects Luna Max'
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
      'focused review, debugging, planning, integration, security, database, research, release, or unresolved ambiguity selects Sol Max',
      'incidental judgment vocabulary does not override a clearly classified implementation or context/tools slice',
      'requested model/effort profile unavailable blocks instead of silently falling back'
    ],
    downshift_triggers: [
      'ordinary UI, logic, backend, or native implementation selects Sol High',
      'long-context, Browser/Chrome, Computer Use, or image-generation execution selects Terra Max',
      'tiny short-context mechanical work selects Luna Max'
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
  const narutoFamilyOnly = decisions.length > 0 && decisions.every((decision: any) => isNarutoGpt56Model(decision.model))
  return {
    schema: 'sks.agent-effort-policy.v1',
    policy_version: 1,
    dynamic: true,
    service_tier: 'fast',
    model_catalog_policy: narutoFamilyOnly ? 'official_subagent_four_profile_matrix' : 'codex_catalog_passthrough',
    model_constraint: narutoFamilyOnly ? ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] : null,
    model_tiers: narutoFamilyOnly
      ? ['gpt-5.6-luna-max', 'gpt-5.6-sol-high', 'gpt-5.6-sol-max', 'gpt-5.6-terra-max']
      : ['codex-selected-low', 'codex-selected-medium', 'codex-selected-high', 'codex-selected-xhigh', 'glm-5.2-minimal', 'glm-5.2-low', 'glm-5.2-high', 'glm-5.2-xhigh'],
    allowed_efforts: narutoFamilyOnly ? ['high', 'max'] : codexModelEffortCapability().advertised_efforts,
    model_effort_capability: codexModelEffortCapability(),
    max_agents: roster.max_agents || 20,
    agent_count: roster.agent_count || decisions.length,
    concurrency: roster.concurrency || decisions.length,
    decisions,
    rule: narutoFamilyOnly
      ? 'Official Naruto subagents use GPT-5.6 Luna Max only for tiny short-context mechanical work, GPT-5.6 Sol High for ordinary implementation, GPT-5.6 Sol Max for judgment-heavy work, and GPT-5.6 Terra Max for long-context or Browser/Chrome, Computer Use, and image-generation execution. Judgment wins when one slice cannot be safely split.'
      : 'Codex/OpenAI workers inherit the current Codex-selected model, including future catalog entries; SKS changes only advertised reasoning effort. Explicit non-Codex provider modes retain their provider model.'
  }
}

export function reasoningProfileName(effort: AgentReasoningEffort | string) {
  return 'sks-agent-' + String(effort || 'medium') + '-fast'
}

function promptEffort(text: string): AgentReasoningEffort {
  if (XHIGH_SIGNAL_RE.test(text)) return 'xhigh'
  if (HIGH_SIGNAL_RE.test(text)) return 'high'
  if (SIMPLE_SIGNAL_RE.test(text) && !MEDIUM_SIGNAL_RE.test(text)) return 'low'
  if (MEDIUM_SIGNAL_RE.test(text)) return 'medium'
  return 'medium'
}

function effortReason(effort: AgentReasoningEffort) {
  if (effort === 'xhigh') return 'frontier_or_forensic_signal'
  if (effort === 'high') return 'safety_release_db_schema_signal'
  if (effort === 'low') return 'simple_bounded_slice'
  return 'default_orchestration_slice'
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
  const mainModel = String(input.mainModel || process.env.SKS_CODEX_MODEL || process.env.CODEX_MODEL || '').trim()
  const glmMain = isGlmWorkerMode(mainModel)
  const effort = String(input.effort || 'medium')
  const text = [input.prompt, input.role, input.agentId, input.writePolicy].map((item) => String(item || '')).join(' ')
  const simpleText = [input.prompt, input.role, input.agentId].map((item) => String(item || '')).join(' ')
  const risky = HIGH_SIGNAL_RE.test(text) || XHIGH_SIGNAL_RE.test(text)
  const simple = SIMPLE_CODE_MOD_RE.test(simpleText) && !HIGH_SIGNAL_RE.test(simpleText) && !XHIGH_SIGNAL_RE.test(simpleText)
  if (glmMain) {
    const openRouterEffort = openRouterWorkerEffort({ effort, risky, simple })
    return {
      model: OPENROUTER_DEFAULT_MODEL,
      model_reasoning_effort: openRouterEffort,
      model_tier: `glm-5.2-${openRouterEffort === 'none' ? 'minimal' : openRouterEffort}` as AgentWorkerModelTier,
      model_profile: desktopBridgeOpenRouterProfile(openRouterEffort),
      reason: `desktop_bridge_openrouter_${openRouterEffort}_worker`
    }
  }
  const modelEffort: AgentModelReasoningEffort = risky || effort === 'high' || effort === 'xhigh'
    ? 'high'
    : simple || effort === 'low'
      ? 'low'
      : 'medium'
  const modelLabel = mainModel || 'codex-selected'
  return {
    model: mainModel,
    model_reasoning_effort: modelEffort,
    model_tier: `${modelLabel}-${modelEffort}`,
    model_profile: `sks-agent-${safeProfileSegment(modelLabel)}-${modelEffort}-fast`,
    reason: mainModel ? 'explicit_model_preserved' : 'codex_catalog_model_inherited'
  }
}

function safeProfileSegment(value: string): string {
  return String(value || 'codex-selected').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'codex-selected'
}

function isGlmWorkerMode(mainModel: string): boolean {
  const model = String(mainModel || '').trim().toLowerCase()
  return model === OPENROUTER_DEFAULT_MODEL
    || model === 'glm-5.2'
    || model === 'glm5.2'
}

function openRouterWorkerEffort(input: { effort: string; risky: boolean; simple: boolean }): OpenRouterReasoningEffort {
  if (input.effort === 'xhigh') return 'xhigh'
  if (input.risky || input.effort === 'high') return 'high'
  if (input.simple || input.effort === 'low') return 'minimal'
  return 'low'
}

function desktopBridgeOpenRouterProfile(effort: OpenRouterReasoningEffort): string {
  return `desktop-bridge-openrouter-${effort}`
}
