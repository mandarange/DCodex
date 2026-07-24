import { HARD_NARUTO_MAX_THREADS, type SubagentCapacityController } from './thread-budget.js'
import type { BoundedTriwikiAttention } from './triwiki-attention.js'
import { coreEngineeringDirectiveReferenceText } from '../lean-engineering-policy.js'
import {
  MAX_AUTOMATIC_REVIEWER_COUNT,
  MAX_AUTOMATIC_SUBAGENT_COUNT,
  MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT,
  officialSubagentOnDemandRoleCatalog,
  officialSubagentRoleCatalog,
  selectOfficialSubagentRole
} from './agent-catalog.js'
import type { RoleModelPreference } from './role-model-preferences.js'
import { childInheritsActiveMainModel } from '../provider/model-router.js'

export interface ActiveMainModelRouting {
  provider: string
  model: string
}

export interface OfficialSubagentSlice {
  id: string
  title: string
  description: string
  kind: 'worker' | 'expert'
  agent?: string
  paths?: string[]
  readOnly?: boolean
}

export function buildOfficialSubagentPrompt(input: {
  goal: string
  slices: OfficialSubagentSlice[]
  maxThreads: number
  requestedSubagents?: number
  requestedSubagentsExplicit?: boolean
  requestedSubagentsSource?: 'operator' | 'route_contract' | 'automatic'
  decompositionStatus?: 'ready' | 'parent_required'
  firstWave?: number
  waveCount?: number
  capacity?: SubagentCapacityController
  triwikiAttention?: BoundedTriwikiAttention
  recommendedAgents?: readonly string[]
  roleModelPreferences?: Readonly<Record<string, RoleModelPreference>>
  activeMainModel?: ActiveMainModelRouting | null
}): string {
  const maxThreads = clampThreads(input.maxThreads)
  const requestedSubagents = normalizeRequestedSubagents(input.requestedSubagents, input.slices.length)
  const firstWave = input.firstWave === undefined
    ? Math.min(requestedSubagents, maxThreads)
    : normalizeRequestedSubagents(input.firstWave, 0)
  const waveCount = input.waveCount === undefined
    ? firstWave > 0 ? Math.ceil(requestedSubagents / firstWave) : 0
    : normalizeRequestedSubagents(input.waveCount, 0)
  const parentDecompositionRequired = input.decompositionStatus === 'parent_required'
  const requestedSource = input.requestedSubagentsSource === 'route_contract'
    ? 'route_contract'
    : input.requestedSubagentsExplicit === true || input.requestedSubagentsSource === 'operator'
      ? 'operator'
      : 'automatic'
  const requestedPolicy = requestedSource === 'operator'
    ? `${requestedSubagents} (explicit operator request)`
    : requestedSource === 'route_contract'
      ? `${requestedSubagents} (route-owned exact orchestration contract)`
      : `${requestedSubagents} (dynamic automatic target; keep the final decomposed plan and evidence count exact)`
  const triwiki = renderBoundedTriwikiAttention(input.triwikiAttention)
  const resolvedSlices = input.slices.map((slice) => ({
    slice,
    agentName: slice.agent || selectOfficialSubagentRole({
      title: slice.title,
      description: slice.description,
      role: slice.kind,
      ...(slice.paths === undefined ? {} : { paths: slice.paths }),
      readOnly: slice.readOnly === true,
      requiresWrite: slice.readOnly !== true
    })
  }))
  const sliceSafety = validateOfficialSubagentSlices(resolvedSlices.map(({ slice, agentName }) => ({
    ...slice,
    agent: agentName
  })))
  const catalog = renderAgentCatalog([
    ...resolvedSlices.map((row) => row.agentName),
    ...(input.recommendedAgents || [])
  ])
  const activeMainModel = normalizedActiveMainModel(input.activeMainModel)
  const inheritActiveMainOntoChildren = childInheritsActiveMainModel(activeMainModel?.model)
  const spawnModelRouting = renderSpawnModelRouting(activeMainModel)
  const rows = resolvedSlices.map(({ slice, agentName }, index) => {
    const mode = slice.readOnly ? 'read-only' : 'use the parent permission mode'
    const paths = (slice.paths || []).map((entry) => String(entry).trim()).filter(Boolean)
    const role = officialSubagentOnDemandRoleCatalog([agentName])[0]
    const preference = input.roleModelPreferences?.[agentName]
    const sealedReasoning = role?.model_reasoning_effort || 'medium'
    const sealedModel = role?.model || null
    const effectiveModel = preference
      ? `${preference.provider}:${preference.model}/${preference.reasoning_effort} (user override)`
      : inheritActiveMainOntoChildren && activeMainModel
        ? `${activeMainModel.provider}:${activeMainModel.model}/${sealedReasoning} (active main model)`
        : sealedModel
          ? `${inferDisplayProvider(sealedModel)}:${sealedModel}/${sealedReasoning} (sealed role policy)`
          : 'managed default/dynamic routing'
    const spawnContract = preference
      ? `pass the exact catalog slug model=${JSON.stringify(preference.model)} and reasoning_effort=${JSON.stringify(preference.reasoning_effort)} when spawning this role; logical provider=${JSON.stringify(preference.provider)} is encoded by the active router/catalog and is not a spawn_agent argument`
      : inheritActiveMainOntoChildren && activeMainModel
        ? `pass the exact active main model=${JSON.stringify(activeMainModel.model)} and reasoning_effort=${JSON.stringify(sealedReasoning)} when spawning this role; the current app session already owns provider=${JSON.stringify(activeMainModel.provider)}`
        : sealedModel
          ? `pass model=${JSON.stringify(sealedModel)} and reasoning_effort=${JSON.stringify(sealedReasoning)} from the sealed role policy; do not replace Luna/Terra/Sol High/Sol Max with the parent active main model`
          : 'omit model/reasoning overrides and preserve the installed custom-agent default'

    return [
      `${index + 1}. [${slice.id}] use custom agent \`${agentName}\``,
      `   title: ${slice.title}`,
      `   task: ${slice.description}`,
      `   model policy: ${role ? `${role.model_policy} (${role.model}/${role.model_reasoning_effort})` : 'resolve from installed custom agent'}`,
      `   effective model preference: ${effectiveModel}`,
      `   spawn contract: ${spawnContract}`,
      '   context contract: pass fork_turns="none" and carry this complete bounded slice contract in message because agent_type is selected',
      `   mode: ${mode}`,
      `   paths: ${paths.join(', ') || 'assigned by parent'}`
    ].join('\n')
  }).join('\n')

  return `
Use a Codex subagent workflow for the independent slices below.

${coreEngineeringDirectiveReferenceText()}

Parent agent:
- model policy: ${activeMainModel ? `keep the current app-selected main model ${activeMainModel.provider}:${activeMainModel.model}` : 'gpt-5.6-sol with max reasoning'}
- owns decomposition, integration, and final answer
- do not do duplicate work already delegated

Host capability policy:
- confirm requested tools in the project MCP inventory; if unavailable or unhealthy, return blocked proof and never fabricate a fallback
- DB: schema first. SQL-only may stop there; retrieval defaults to one bounded query and allows at most four total for separate aggregation or verification. Every query needs a prior schema receipt for the same datasource and matching snapshot
- spreadsheet: prefer the smallest create/edit mutation; allow at most three updates, inspect after create and every update, and require the final mutation artifact receipt
- document: write_file/edit_file then html_to_pdf|html_to_screenshot(source_path=...); never raw html
- Slack delivery is ACAS-runtime-only, never a model tool

Subagent rules:
- use only Codex official subagent threads; do not launch shell workers, a custom scheduler, a worker pool, or model fanout
- select the narrowest matching project custom agent by its description; the custom agent name is the spawn type
- custom \`agent_type\` selection and spawn-time \`model\`/\`reasoning_effort\` overrides must use \`fork_turns="none"\` or a positive bounded turn count, with the complete bounded slice contract in \`message\`
- \`spawn_agent\` has no per-child provider argument; cross-provider preferences must use exact model slugs advertised by the active Codex backend/catalog (for example a single multi-provider router exposing \`provider/model\`)
- never combine \`fork_turns="all"\` or the omitted/default full-history mode with \`agent_type\`, \`model\`, or \`reasoning_effort\`; Codex rejects that start before SubagentStart
- a full-history fork is allowed only when \`agent_type\`, \`model\`, and \`reasoning_effort\` are all omitted
${spawnModelRouting}
- use \`worker\` with gpt-5.6-luna and max reasoning for tiny short-context mechanical work such as simple search, typing, rename, copy, label, or one-line edits with no exploration or judgment
- use gpt-5.6-sol with high reasoning for ordinary UI, logic, backend, and native implementation
- use gpt-5.6-sol with max reasoning only for focused unresolved, high-risk, final-review, architecture, security, database, research, release, or other explicit judgment slices
- use gpt-5.6-terra with medium reasoning for read-heavy documentation/exploration, long-context analysis, large or repository-wide search, and direct Computer Use, Browser/Chrome, or image-generation execution
- explicit task class and phase win over incidental keywords: Terra gathers/explores/searches broadly, Luna handles tiny mechanical edits, Sol High implements, and Sol Max performs the focused judgment pass
- never assign Luna to long-context, broad exploration, review, debugging, planning, or tool-heavy work
- never collapse every child onto the parent Sol model when a sealed Luna or Terra role matches the slice
- automatic fan-out starts at four for bounded non-trivial work, six for explicit parallel work, and eight for large-scale work; it may expand only up to ${MAX_AUTOMATIC_SUBAGENT_COUNT} when independent useful slices and healthy host capacity remain positive
- prefer the largest useful first wave the host can sustain; shrink only under live resource pressure or unsafe overlapping ownership
- automatic reviewer-only fan-out is capped at ${MAX_AUTOMATIC_REVIEWER_COUNT} for ordinary work and ${MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT} for critical multi-domain review
- requested subagents: ${requestedPolicy}
- max open agent threads: ${maxThreads} (hard cap, never a utilization target)
- selected first-wave concurrency: ${firstWave}
- planned waves: ${waveCount}
- wave lifecycle authority: root parent updates \`subagent-plan.json.wave_lifecycle\` under the same workflow_run_id after every SubagentStart/SubagentStop
- before every wave compute C_t = min(ready DAG width, disjoint ownership, verifier capacity, tool concurrency, available thread slots after reservations, marginal-useful workers); launch n_t <= C_t only while marginal useful throughput stays positive
- capacity snapshot: ${renderCapacity(input.capacity)}
- max depth: 1 applies only to child nesting; the root parent may and should launch later direct-child waves after earlier children settle
- subagents must not spawn subagents
- parallel writes require disjoint paths
- if paths overlap, run those slices serially
- reject duplicate slice fingerprints and homogeneous clone work; diversity may come from roles, disjoint shards, or different tool surfaces
- security, database, release, authorization, and irreversible-effect checks are protected strata; aggregate speed or accuracy never offsets a failed protected gate
- after each settled wave: collect results, close completed threads, refresh evidence and the wave lifecycle ledger, read \`wave_lifecycle.next_parent_actions\` / \`parent_guidance\`, rescan the ready DAG, then launch the next defensible direct-child wave when \`remaining_to_start > 0\`
- recovered thread capacity is reusable by later root-owned waves; completed child threads do not permanently consume the mission fan-out budget
- when PreTool/UserPrompt guidance says \`spawn_next_direct_child_wave_upto:N\`, spawn that next wave immediately with sealed custom-agent model/effort profiles; do not wait for another user message
- automatic targets may resize between waves when the ready DAG changes, but update plan/evidence before spawning; explicit operator and route-owned counts remain exact
- wait for every final planned subagent before integrating
- close completed threads after collecting results so capacity returns to the root parent
${parentDecompositionRequired ? `- decomposition status: parent_required
- before spawning, decompose the goal into independent, non-overlapping slices
- do not invent write scopes merely to reach the requested count
${requestedSource === 'operator'
    ? '- the explicit operator count is authoritative; if it cannot be defended safely, block and report instead of silently changing it'
    : requestedSource === 'route_contract'
      ? '- the route-owned exact count is authoritative; preserve it and follow the route-specific orchestration contract'
      : `- after decomposition, resize the automatic plan to the useful independent slice count, bounded by C_t and ${MAX_AUTOMATIC_SUBAGENT_COUNT}; update plan/evidence before the first spawn
- if fewer defensible slices exist, reduce the count; if more defensible slices and positive capacity exist, increase only within the automatic ceiling`}` : '- decomposition status: ready'}

Slice safety:
${renderSliceSafety(sliceSafety, parentDecompositionRequired)}

Central TriWiki context:
${triwiki}

Role model preference metadata:
${renderRoleModelPreferenceMetadata(input.roleModelPreferences, activeMainModel)}

Project custom agent catalog:
${catalog}

Goal:
${String(input.goal || '').trim()}

Slices:
${rows || '(parent decomposition required before any subagent is spawned)'}

Final parent output:
- return one JSON object as the final message; prose outside that object is not completion evidence
- use this exact schema so SKS can correlate every stopped agent thread with a trustworthy parent outcome:
{
  "schema": "sks.subagent-parent-summary.v1",
  "run_id": "workflow_run_id from subagent-plan.json",
  "status": "completed|blocked|failed",
  "summary": "Completion Summary: concise integrated result. Honest Mode: goal/evidence/checks/gaps assessment.",
  "thread_outcomes": [
    { "thread_id": "official agent/thread id", "status": "completed|blocked|failed", "summary": "slice result" }
  ],
  "changed_files": [],
  "verification": [
    { "name": "focused check", "status": "passed|not_applicable", "reason": "required when not_applicable" }
  ],
  "artifacts": [
    {
      "path": "workspace-relative/verified-output.xlsx",
      "kind": "spreadsheet",
      "media_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sha256": "sha256:<64 lowercase hex>",
      "bytes": 1,
      "role": "deliverable|scratch|temp|log"
    }
  ],
  "capabilities_used": [
    {
      "id": "declared host capability id",
      "status": "passed|failed",
      "tool_names": ["actually called host tool"],
      "receipt_sha256": "sha256:<64 lowercase hex>"
    }
  ],
  "blockers": []
}
- include one thread_outcomes row for every requested subagent; a SubagentStop event alone never proves success
- copy workflow_run_id from subagent-plan.json into run_id so delayed or stale summaries cannot bind to another run
- if changed_files is non-empty, include at least one passed named check or a specifically justified not_applicable verification row
- use empty artifacts/capabilities_used arrays when no host capability was used; SKS overwrites these fields with observed Codex JSONL evidence before persistence
- keep completion summary and Honest Mode wording inside the JSON fields; do not add prose outside the object
`.trim()
}

function renderRoleModelPreferenceMetadata(
  preferences: Readonly<Record<string, RoleModelPreference>> | undefined,
  activeMainModel: ActiveMainModelRouting | null
): string {
  const rows = Object.entries(preferences || {}).map(([role, preference]) => ({
    role,
    provider: preference.provider,
    model: preference.model,
    reasoning_effort: preference.reasoning_effort,
    source: 'user-scoped-owner-only'
  }))
  if (activeMainModel && childInheritsActiveMainModel(activeMainModel.model)) {
    rows.push({
      role: '*',
      provider: activeMainModel.provider,
      model: activeMainModel.model,
      reasoning_effort: 'role-managed',
      source: 'active-main-model-fallback'
    })
  }
  return rows.length ? JSON.stringify(rows) : '[]'
}

function normalizedActiveMainModel(value: ActiveMainModelRouting | null | undefined): ActiveMainModelRouting | null {
  const provider = String(value?.provider || '').trim()
  const model = String(value?.model || '').trim()
  return provider && model ? { provider, model } : null
}

function inferDisplayProvider(model: string): string {
  return model.includes('/') ? model.split('/', 1)[0] || 'openai' : 'openai'
}

function renderSpawnModelRouting(activeMainModel: ActiveMainModelRouting | null): string {
  const inheritActiveMain = childInheritsActiveMainModel(activeMainModel?.model)
  const precedence = inheritActiveMain
    ? '- model routing precedence applies to every child, including slices created after parent decomposition: exact user role override -> active main model -> installed custom-agent default'
    : '- model routing precedence applies to every child, including slices created after parent decomposition: exact user role override -> sealed role policy (Luna Max / Terra Medium / Sol High / Sol Max) -> installed custom-agent default'
  const roleOverride = '- when Role model preference metadata lists the selected role with source "user-scoped-owner-only", pass that row\'s exact model and reasoning_effort to spawn_agent'
  if (!activeMainModel) {
    return [
      precedence,
      roleOverride,
      '- when no user override exists, pass the sealed role model/effort from the selected custom agent; do not default every child to Sol'
    ].join('\n')
  }
  if (!inheritActiveMain) {
    return [
      precedence,
      roleOverride,
      `- parent keeps the app-selected main model ${activeMainModel.provider}:${activeMainModel.model}, but children must keep sealed Luna/Terra/Sol High/Sol Max role profiles`,
      '- for every role without a user override, including slices created after parent decomposition, pass that role\'s sealed model and reasoning_effort; never replace Luna or Terra with the parent Sol model'
    ].join('\n')
  }
  return [
    precedence,
    roleOverride,
    `- for every role without a user override, including slices created after parent decomposition, pass model=${JSON.stringify(activeMainModel.model)} and the selected custom role's installed reasoning effort; provider=${JSON.stringify(activeMainModel.provider)} remains owned by the current app session`,
    `- do not substitute a managed GPT model for the active main model ${activeMainModel.provider}:${activeMainModel.model}`
  ].join('\n')
}

export interface OfficialSubagentSliceSafety {
  safe: boolean
  blockers: string[]
  duplicate_slice_ids: string[][]
  overlapping_write_scopes: Array<{ left: string; right: string; path: string }>
  unassigned_write_scopes: string[]
  distinct_role_count: number
}

export function validateOfficialSubagentSlices(slices: readonly OfficialSubagentSlice[]): OfficialSubagentSliceSafety {
  const blockers: string[] = []
  const duplicateSliceIds: string[][] = []
  const overlappingWriteScopes: Array<{ left: string; right: string; path: string }> = []
  const unassignedWriteScopes: string[] = []
  const fingerprints = new Map<string, string[]>()

  for (const slice of slices) {
    const id = String(slice.id || '').trim() || 'unnamed'
    const paths = normalizedPaths(slice.paths)
    const fingerprint = [
      normalizedIntent(slice.title),
      normalizedIntent(slice.description),
      String(slice.agent || slice.kind || '').trim().toLowerCase(),
      paths.join('|'),
      slice.readOnly === true ? 'read-only' : 'write'
    ].join('::')
    const ids = fingerprints.get(fingerprint) || []
    ids.push(id)
    fingerprints.set(fingerprint, ids)
    if (slice.readOnly !== true && paths.length === 0) unassignedWriteScopes.push(id)
  }

  for (const ids of fingerprints.values()) {
    if (ids.length < 2) continue
    duplicateSliceIds.push(ids)
    blockers.push(`duplicate_slice_fingerprint:${ids.join(',')}`)
  }

  const writable = slices
    .filter((slice) => slice.readOnly !== true)
    .map((slice) => ({ id: String(slice.id || '').trim() || 'unnamed', paths: normalizedPaths(slice.paths) }))
  for (let leftIndex = 0; leftIndex < writable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < writable.length; rightIndex += 1) {
      const left = writable[leftIndex]!
      const right = writable[rightIndex]!
      const overlap = firstOverlappingPath(left.paths, right.paths)
      if (!overlap) continue
      overlappingWriteScopes.push({ left: left.id, right: right.id, path: overlap })
      blockers.push(`overlapping_write_scope:${left.id}:${right.id}:${overlap}`)
    }
  }
  if (writable.length > 1) {
    for (const id of unassignedWriteScopes) blockers.push(`unassigned_parallel_write_scope:${id}`)
  }

  return {
    safe: blockers.length === 0,
    blockers: [...new Set(blockers)],
    duplicate_slice_ids: duplicateSliceIds,
    overlapping_write_scopes: overlappingWriteScopes,
    unassigned_write_scopes: unassignedWriteScopes,
    distinct_role_count: new Set(slices.map((slice) => String(slice.agent || slice.kind || '').trim()).filter(Boolean)).size
  }
}

function renderBoundedTriwikiAttention(value: BoundedTriwikiAttention | undefined): string {
  if (!value?.available || value.anchors.length === 0) {
    return [
      '- no bounded attention anchors are available; rely on current scoped sources',
      '- do not compensate by making every subagent reread the entire repository or full TriWiki pack'
    ].join('\n')
  }
  const anchors = value.anchors.map((anchor) => ({
    id: anchor.id,
    claim_hash: anchor.claim_hash,
    source_hash: anchor.source_hash,
    hydrate_hint: anchor.hydrate_hint
  }))
  return [
    `- consume these ${anchors.length} attention.use_first anchors before broad discovery`,
    '- hydrate a referenced source only when its anchor is relevant to the assigned slice or a risky decision',
    '- do not inject the full context pack or make each subagent repeat repository-wide context discovery',
    `- bounded anchors: ${JSON.stringify(anchors)}`
  ].join('\n')
}

function renderAgentCatalog(requested: readonly string[]): string {
  const names = [...new Set(requested.map(String).map((name) => name.trim()).filter(Boolean))]
  const selected = officialSubagentOnDemandRoleCatalog(names.length ? names : ['expert'])
  const preferred = new Set(names)
  return [
    `- metadata mode: on-demand (${selected.length}/${officialSubagentRoleCatalog().length} roles included; full catalog is not injected)`,
    ...selected.map((role) => {
      const marker = preferred.has(role.name) ? ' [suggested for this goal]' : ''
      return `- \`${role.name}\`${marker}: ${role.model_policy}, ${role.model}/${role.model_reasoning_effort}, ${role.sandbox_mode}; ${role.description}`
    })
  ].join('\n')
}

function renderCapacity(capacity: SubagentCapacityController | undefined): string {
  if (!capacity) return 'parent recomputes after decomposition; no pre-decomposition capacity snapshot available'
  return JSON.stringify({
    formula: capacity.formula,
    selected_capacity: capacity.selected_capacity,
    available_thread_slots: capacity.available_thread_slots,
    limiting_factors: capacity.limiting_factors,
    reservations: capacity.reservations,
    marginal_useful_throughput_positive: capacity.marginal_useful_throughput_positive
  })
}

function renderSliceSafety(value: OfficialSubagentSliceSafety, parentDecompositionRequired: boolean): string {
  if (parentDecompositionRequired) {
    return [
      '- pending parent decomposition; validate duplicate fingerprints, write-scope overlap, ownership assignment, and role/shard/tool diversity before spawning',
      '- unsafe decomposition must be merged, serialized, or blocked before any child starts'
    ].join('\n')
  }
  if (value.safe) {
    return `- validated safe: ${value.distinct_role_count} distinct role(s), no duplicate slice fingerprint, and no overlapping write scope`
  }
  return `- blocked: ${value.blockers.join(', ')}`
}

function normalizedIntent(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizedPaths(paths: readonly string[] | undefined): string[] {
  return [...new Set((paths || [])
    .map((entry) => String(entry || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean))]
    .sort()
}

function firstOverlappingPath(leftPaths: readonly string[], rightPaths: readonly string[]): string | null {
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      const leftPrefix = pathPrefix(left)
      const rightPrefix = pathPrefix(right)
      if (leftPrefix === '.'
        || rightPrefix === '.'
        || leftPrefix === rightPrefix
        || leftPrefix.startsWith(`${rightPrefix}/`)
        || rightPrefix.startsWith(`${leftPrefix}/`)) {
        return left.length <= right.length ? left : right
      }
    }
  }
  return null
}

function pathPrefix(value: string): string {
  const wildcard = value.search(/[?*[{]/)
  const prefix = wildcard >= 0 ? value.slice(0, wildcard) : value
  return prefix.replace(/\/+$/, '') || '.'
}

function clampThreads(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.min(HARD_NARUTO_MAX_THREADS, Math.floor(parsed)))
}

function normalizeRequestedSubagents(value: unknown, fallback: number): number {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed)) return Math.max(0, Math.min(HARD_NARUTO_MAX_THREADS, fallback))
  return Math.max(0, Math.min(HARD_NARUTO_MAX_THREADS, Math.floor(parsed)))
}
