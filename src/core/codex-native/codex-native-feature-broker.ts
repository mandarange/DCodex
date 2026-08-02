import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { findCodexBinary } from '../codex-adapter.js'
import { codexAppIntegrationStatus } from '../codex-app.js'
import { probeCodexAgentTypeSupport } from '../codex-app/codex-agent-type-probe.js'
import { probeCodexHookApprovalState } from '../codex-app/codex-hook-approval-probe.js'
import { detectCodex0138Capability } from '../codex-control/codex-0138-capability.js'
import { detectCodex0139Capability } from '../codex-control/codex-0139-capability.js'
import { detectCodex0140Capability } from '../codex-control/codex-0140-capability.js'
import { detectCodex0144Capability, type Codex0144FeatureKey } from '../codex-control/codex-0144-capability.js'
import { buildCodexPluginInventory } from '../codex-plugins/codex-plugin-json.js'
import { nowIso, runProcess, sha256, writeJsonAtomic } from '../fsx.js'
import { inspectConfinedPath } from '../managed-path-safety.js'
import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  MANAGED_SKILLS,
  managedOfficialSubagentRoleOwnsText
} from '../managed-assets/managed-assets-manifest.js'
import { buildMcpPluginServerCandidates } from '../mcp/mcp-plugin-inventory.js'
import { codexNativeFeatureState, computeCodexNativeInvocationDefaults, type CodexNativeFeatureMatrix, type CodexNativeFeatureState } from './codex-native-feature-matrix.js'
import { currentCodexSkillRoots, currentSksSkillName, resolveAuthoritativeSksSkillSources } from './sks-skill-paths.js'
import { messageOf } from '../errors/message.js'
import { isRecord } from '../json/records.js'

const REPORT_PATH = '.sneakoscope/reports/codex-native-feature-matrix.json'
const REQUIRED_SKILL_NAMES = MANAGED_SKILLS.map((skill) => currentSksSkillName(skill.id))
const REQUIRED_AGENT_ROLES = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.id)
const invocationMatrixCache = new Map<string, CodexNativeFeatureMatrix>()

export async function buildCodexNativeFeatureMatrix(input: {
  root: string
  missionDir?: string | null
  applyRepairs?: boolean
  repairManagedAssets?: boolean
  mode?: 'read-only' | 'repair'
  snapshot?: CodexNativeFeatureMatrix | null
} = { root: process.cwd() }): Promise<CodexNativeFeatureMatrix> {
  const root = path.resolve(input.root || process.cwd())
  if (input.snapshot) {
    await writeCodexNativeFeatureMatrix(root, input.snapshot, input.missionDir)
    return input.snapshot
  }
  const deprecatedApplyRepairs = input.applyRepairs === true
  const mode = input.mode || (deprecatedApplyRepairs || input.repairManagedAssets === true ? 'repair' : 'read-only')
  const repairManagedAssets = mode === 'repair' && (input.repairManagedAssets === true || deprecatedApplyRepairs)
  const managedAssetFingerprint = await readManagedAssetFingerprint(root)
  const cacheKey = JSON.stringify({
    root,
    mode,
    repairManagedAssets,
    codexHome: process.env.CODEX_HOME || null,
    managedAssetFingerprint,
    fixture: [
      process.env.SKS_CODEX_0138_FAKE,
      process.env.SKS_CODEX_0139_FAKE,
      process.env.SKS_CODEX_0140_FAKE,
      process.env.SKS_CODEX_0144_FAKE,
      process.env.SKS_CODEX_PLUGIN_JSON_FAKE
    ]
  })
  if (!input.missionDir && !repairManagedAssets && invocationMatrixCache.has(cacheKey)) {
    return invocationMatrixCache.get(cacheKey) as CodexNativeFeatureMatrix
  }
  const fixtureMode = process.env.SKS_CODEX_0138_FAKE === '1' || process.env.SKS_CODEX_0139_FAKE === '1' || process.env.SKS_CODEX_0140_FAKE === '1' || process.env.SKS_CODEX_0144_FAKE === '1' || process.env.SKS_CODEX_PLUGIN_JSON_FAKE === '1'
  const codexBin = fixtureMode ? process.env.CODEX_BIN || 'codex' : await findCodexBinary().catch(() => null)
  const version = codexBin ? await codexVersion(codexBin) : null
  const cap0138 = await detectCodex0138Capability({ codexBin }).catch((err: unknown) => ({ blockers: [messageOf(err)] }))
  const cap0139 = await detectCodex0139Capability({ codexBin }).catch((err: unknown) => ({ blockers: [messageOf(err)] }))
  const cap0140 = await detectCodex0140Capability({ codexBin }).catch((err: unknown) => ({ blockers: [messageOf(err)] }))
  const cap0144 = await detectCodex0144Capability({ codexBin, root }).catch((err: unknown) => ({
    schema: 'sks.codex-0144-capability.v1',
    ok: false,
    release_authorizing: false,
    feature_states: {},
    blockers: [messageOf(err)],
    warnings: ['codex_0144_probe_exception']
  }))
  const app = await codexAppIntegrationStatus({ codex: { bin: codexBin, version, available: Boolean(codexBin) } }).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
  const plugins = await buildCodexPluginInventory().catch((err: unknown) => ({
    schema: 'sks.codex-plugin-inventory.v1' as const,
    generated_at: nowIso(),
    codex_0138_capability: null,
    fetch_concurrency: 0,
    detail_fetch_count: 0,
    detail_fetch_failed_count: 0,
    duration_ms: 0,
    plugins: [],
    marketplace_available: false,
    blockers: [messageOf(err)]
  }))
  const mcpCandidates = buildMcpPluginServerCandidates(plugins)
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'codex-plugin-inventory.json'), plugins).catch(() => undefined)
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'mcp-plugin-server-candidates.json'), mcpCandidates).catch(() => undefined)
  const hookApproval = await probeCodexHookApprovalState(root, { codexBin }).catch((err: unknown) => ({
    schema: 'sks.codex-hook-approval-probe.v1' as const,
    generated_at: nowIso(),
    ok: false,
    detectable: false,
    approval_state: 'unknown' as const,
    sources_checked: [],
    blockers: [messageOf(err)],
    warnings: ['hook_approval_probe_failed']
  }))
  const agentType = await probeCodexAgentTypeSupport(root, { codexBin }).catch((err: unknown) => ({
    schema: 'sks.codex-agent-type-probe.v1' as const,
    generated_at: nowIso(),
    ok: false,
    supported: false,
    source: 'unknown' as const,
    spawn_tool_name: 'unknown' as const,
    schema_path: null,
    evidence: [],
    blockers: [messageOf(err)],
    warnings: ['agent_type_probe_failed_message_role_fallback']
  }))
  const skillSync = await inspectManagedSkillState(root)
  const agentRoles = await inspectManagedAgentRoleState(root)
  const appRecord: Record<string, unknown> = isRecord(app) ? app : {}
  const requiredSkills = isRecord(appRecord.required_skills) ? appRecord.required_skills : {}
  const skills = isRecord(appRecord.skills) ? appRecord.skills : {}
  const skillShadows = isRecord(appRecord.skill_shadows) ? appRecord.skill_shadows : {}
  const skillPickerReady = requiredSkills.ok === true || skills.ok === true || skillShadows.ok !== false
  const hookApproved = hookApproval.approval_state === 'approved'
  const hookInstalled = hookApproval.approval_state !== 'not_installed'
  const features: CodexNativeFeatureMatrix['features'] = {
    plugin_json: boolState(booleanFeature(cap0138, 'supports_plugin_json'), 'actual-probe', '.sneakoscope/codex-0138-capability.json', blockersOf(cap0138)),
    plugin_marketplace: boolState(booleanFeature(cap0139, 'supports_marketplace_source_field') || plugins.marketplace_available, 'plugin-inventory', '.sneakoscope/codex-plugin-inventory.json', blockersOf(plugins)),
    hook_approval: codexNativeFeatureState({
      ok: hookApproved,
      source: 'actual-probe',
      artifact_path: '.sneakoscope/reports/codex-hook-approval-probe.json',
      evidence: [`approval_state:${hookApproval.approval_state}`],
      blockers: hookApproval.approval_state === 'modified_requires_reapproval' ? ['hook_modified_requires_reapproval'] : [],
      warnings: [...hookApproval.warnings, ...(!hookApproved && hookInstalled ? ['hook_derived_evidence_not_counted'] : [])],
      unavailableStatus: hookInstalled ? 'unknown' : 'unavailable'
    }),
    skill_picker: boolState(skillPickerReady, 'config', '.sneakoscope/reports/codex-native-feature-matrix.json', [], skillPickerReady ? [] : ['skill_picker_unverified']),
    skill_sync: boolState(recordOk(skillSync) !== false, 'actual-probe', '.sneakoscope/reports/codex-skill-sync.json', blockersOf(skillSync)),
    agent_roles: boolState(recordOk(agentRoles) !== false, 'actual-probe', '.sneakoscope/reports/codex-agent-role-sync.json', blockersOf(agentRoles)),
    agent_type: codexNativeFeatureState({
      ok: agentType.supported === true,
      source: agentType.source === 'fixture' ? 'fixture' : 'actual-probe',
      artifact_path: '.sneakoscope/reports/codex-agent-type-probe.json',
      evidence: agentType.evidence,
      blockers: [],
      warnings: [...agentType.warnings, ...(agentType.supported ? [] : ['agent_type_unavailable_message_role_fallback'])],
      unavailableStatus: 'fallback'
    }),
    mcp_inventory: codexNativeFeatureState({
      ok: mcpCandidates.candidates.length > 0,
      source: 'plugin-inventory',
      artifact_path: '.sneakoscope/mcp-plugin-server-candidates.json',
      evidence: [`candidate_count:${mcpCandidates.candidates.length}`],
      blockers: [...plugins.blockers, ...mcpCandidates.blockers],
      warnings: mcpCandidates.candidates.length ? [] : ['mcp_plugin_candidates_empty'],
      unavailableStatus: 'fallback'
    }),
    app_handoff: boolState(booleanFeature(cap0138, 'supports_app_handoff'), 'actual-probe', '.sneakoscope/codex-0138-capability.json', blockersOf(cap0138)),
    image_path_exposure: boolState(booleanFeature(cap0138, 'supports_image_path_exposure'), 'actual-probe', '.sneakoscope/codex-0138-capability.json', blockersOf(cap0138)),
    code_mode_web_search: boolState(booleanFeature(cap0139, 'supports_code_mode_web_search'), 'actual-probe', '.sneakoscope/codex-0139-capability.json', blockersOf(cap0139)),
    codex_0144: boolState(recordOk(cap0144) === true, 'actual-probe', '.sneakoscope/codex/codex-0144-capability.json', blockersOf(cap0144), warningsOf(cap0144)),
    multi_agent_mode: codex0144State(cap0144, 'multi_agent_mode_schema'),
    rollout_budget: codex0144State(cap0144, 'rollout_budget_schema'),
    indexed_web_search: codex0144State(cap0144, 'indexed_web_search_schema'),
    current_time_read: codex0144State(cap0144, 'current_time_read_schema'),
    terminal_subagent_error: codex0144State(cap0144, 'terminal_subagent_error_schema'),
    exec_mcp_reconnect: codex0144State(cap0144, 'exec_mcp_reconnect_schema'),
    plugin_catalog_refresh: codex0144State(cap0144, 'plugin_catalog_refresh_schema'),
    native_thread_list_search: codex0144State(cap0144, 'native_thread_list_search_schema'),
    remote_native_environment: codex0144State(cap0144, 'remote_native_environment_schema'),
    app_server_overload: codex0144State(cap0144, 'app_server_overload_schema'),
    codex_0140: boolState(booleanFeature(cap0140, 'supports_0140'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    usage_views: boolState(booleanFeature((cap0140 as any)?.features || {}, 'usage_views'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    goal_attachment_preservation: boolState(booleanFeature((cap0140 as any)?.features || {}, 'goal_attachment_preservation'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    session_delete: boolState(booleanFeature((cap0140 as any)?.features || {}, 'session_delete'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    import_command: boolState(booleanFeature((cap0140 as any)?.features || {}, 'import_command'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    unified_mentions: boolState(booleanFeature((cap0140 as any)?.features || {}, 'unified_mentions'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    bedrock_managed_auth: boolState(booleanFeature((cap0140 as any)?.features || {}, 'bedrock_managed_auth'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    sqlite_auto_recovery: boolState(booleanFeature((cap0140 as any)?.features || {}, 'sqlite_auto_recovery'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    mcp_reliability: boolState(booleanFeature((cap0140 as any)?.features || {}, 'mcp_reliability'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    non_tty_interrupt: boolState(booleanFeature((cap0140 as any)?.features || {}, 'non_tty_interrupt'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    large_repo_responsiveness: boolState(booleanFeature((cap0140 as any)?.features || {}, 'large_repo_responsiveness'), 'actual-probe', '.sneakoscope/codex-0140-capability.json', blockersOf(cap0140)),
    slash_command_bridge: boolState(true, 'config', '.sneakoscope/reports/codex-native-feature-matrix.json'),
    project_memory: boolState(true, 'config', '.sneakoscope/context/AGENTS.generated.md')
  }
  const matrixBase = {
    schema: 'sks.codex-native-feature-matrix.v1' as const,
    generated_at: nowIso(),
    ok: false,
    codex_cli: { available: Boolean(codexBin), version, bin: codexBin },
    features,
    probes: {
      codex_0138: cap0138,
      codex_0139: cap0139,
      codex_0140: cap0140,
      codex_0144: cap0144,
      app,
      plugin_inventory: plugins,
      mcp_candidates: mcpCandidates,
      hook_approval: hookApproval,
      agent_type: agentType,
      skill_sync: skillSync,
      agent_roles: agentRoles
    },
    invocation_defaults: {
      loop_worker_role_strategy: 'message-role' as const,
      multi_agent_mode: 'none' as const,
      rollout_budget_strategy: 'sks-local-only' as const,
      qa_visual_review_strategy: 'headless-artifact' as const,
      research_source_strategy: 'local-files' as const,
      image_followup_strategy: 'artifact-path' as const,
      hook_evidence_policy: 'unknown-do-not-count' as const,
      skill_bridge_strategy: 'cli-only' as const,
      current_time_source: 'external-clock' as const,
      overload_retry_policy: 'generic' as const
    },
    blockers: [
      ...(!codexBin ? ['codex_cli_missing'] : []),
      ...Object.values(features).flatMap((feature) => feature.blockers)
    ],
    warnings: [
      ...Object.values(features).flatMap((feature) => feature.warnings),
      ...(deprecatedApplyRepairs ? ['deprecated_apply_repairs_input'] : []),
      ...(mode === 'repair' && !repairManagedAssets ? ['repair_mode_without_managed_asset_repair'] : [])
    ]
  }
  const matrix: CodexNativeFeatureMatrix = {
    ...matrixBase,
    ok: matrixBase.blockers.length === 0,
    invocation_defaults: computeCodexNativeInvocationDefaults(matrixBase)
  }
  await writeCodexNativeFeatureMatrix(root, matrix, input.missionDir)
  if (!input.missionDir && !repairManagedAssets) invocationMatrixCache.set(cacheKey, matrix)
  return matrix
}

async function inspectManagedSkillState(root: string): Promise<{ ok: boolean; apply: false; artifact_path: string; existing_count: number; managed_count: number; missing_required: string[]; blockers: string[]; warnings: string[] }> {
  const home = path.resolve(process.env.HOME || os.homedir())
  const authoritativeRoot = currentCodexSkillRoots({ root, home }).find((entry) => entry.scope === 'global')?.root
  const resolution = await resolveAuthoritativeSksSkillSources({
    root,
    home,
    skillNames: REQUIRED_SKILL_NAMES
  })
  const managed = new Set(resolution.sources.map((source) => source.canonical_name))
  const missing = REQUIRED_SKILL_NAMES.filter((name) => !managed.has(name))
  const existingCount = authoritativeRoot ? await countConfinedSkillDirectories(home, authoritativeRoot) : 0
  return {
    ok: missing.length === 0,
    apply: false,
    artifact_path: '.sneakoscope/reports/codex-skill-sync.json',
    existing_count: existingCount,
    managed_count: managed.size,
    missing_required: missing,
    blockers: [
      ...(missing.length ? [`managed_skills_missing:${missing.join(',')}`] : []),
      ...resolution.blockers.map((blocker) => `managed_skill_${blocker}`)
    ],
    warnings: existingCount > managed.size ? ['non_sks_skill_dirs_ignored'] : []
  }
}

async function inspectManagedAgentRoleState(root: string): Promise<{ ok: boolean; apply: false; artifact_path: string; existing_count: number; managed_count: number; missing_required: string[]; blockers: string[]; warnings: string[] }> {
  const dir = path.join(root, '.codex', 'agents')
  let existingCount = 0
  const managed = new Set<string>()
  const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  existingCount = rows.filter((row) => row.isFile() && row.name.endsWith('.toml')).length
  for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    const text = await fs.readFile(path.join(dir, role.filename), 'utf8').catch(() => '')
    if (managedOfficialSubagentRoleOwnsText(text, role)) managed.add(role.id)
  }
  const missing = REQUIRED_AGENT_ROLES.filter((role) => !managed.has(role))
  return {
    ok: missing.length === 0,
    apply: false,
    artifact_path: '.sneakoscope/reports/codex-agent-role-sync.json',
    existing_count: existingCount,
    managed_count: managed.size,
    missing_required: missing,
    blockers: missing.length ? [`managed_agent_roles_missing:${missing.join(',')}`] : [],
    warnings: existingCount > managed.size ? ['non_sks_agent_roles_ignored'] : []
  }
}

async function readManagedAssetFingerprint(root: string): Promise<string[]> {
  const home = path.resolve(process.env.HOME || os.homedir())
  const authoritativeSkillRoots = currentCodexSkillRoots({ root, home })
    .filter((entry) => entry.scope === 'global')
    .map((entry) => entry.root)
  const dirs = [
    path.join(root, '.codex', 'agents'),
    ...(process.env.CODEX_HOME ? [path.join(process.env.CODEX_HOME, 'agents')] : [])
  ]
  const rows: string[] = []
  for (const dir of authoritativeSkillRoots) rows.push(...await readConfinedSkillRootFingerprint(home, dir))
  for (const dir of dirs) {
    const stat = await fs.stat(dir).catch(() => null)
    rows.push(`${dir}:${stat ? `${stat.mtimeMs}:${stat.size}` : 'missing'}`)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      const childStat = await fs.stat(file).catch(() => null)
      rows.push(`${file}:${entry.isDirectory() ? 'dir' : 'file'}:${childStat ? `${childStat.mtimeMs}:${childStat.size}` : 'missing'}`)
      if (entry.isDirectory()) {
        const skillFile = path.join(file, 'SKILL.md')
        const skillStat = await fs.stat(skillFile).catch(() => null)
        if (skillStat) rows.push(`${skillFile}:file:${skillStat.mtimeMs}:${skillStat.size}`)
      }
    }
  }
  return rows
}

async function countConfinedSkillDirectories(home: string, skillsRoot: string): Promise<number> {
  try {
    const inspection = await inspectConfinedPath(home, skillsRoot)
    if (!inspection.exists || inspection.leafSymlink || !inspection.stat?.isDirectory()) return 0
    const rows = await fs.readdir(skillsRoot, { withFileTypes: true })
    return rows.filter((row) => row.isDirectory()).length
  } catch {
    return 0
  }
}

async function readConfinedSkillRootFingerprint(home: string, skillsRoot: string): Promise<string[]> {
  try {
    const inspection = await inspectConfinedPath(home, skillsRoot)
    if (!inspection.exists) return [`${skillsRoot}:missing`]
    if (inspection.leafSymlink || !inspection.stat?.isDirectory()) return [`${skillsRoot}:unsafe`]
    const rows = [`${skillsRoot}:directory`]
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(skillsRoot, entry.name, 'SKILL.md')
      try {
        const child = await inspectConfinedPath(home, file)
        if (!child.exists) {
          rows.push(`${entry.name}:missing`)
        } else if (child.leafSymlink || !child.stat?.isFile()) {
          rows.push(`${entry.name}:unsafe`)
        } else {
          const text = await fs.readFile(file, 'utf8')
          rows.push(`${entry.name}:file:${sha256(text)}`)
        }
      } catch {
        rows.push(`${entry.name}:unsafe`)
      }
    }
    return rows
  } catch {
    return [`${skillsRoot}:unsafe`]
  }
}

export async function writeCodexNativeFeatureMatrix(root: string, matrix: CodexNativeFeatureMatrix, missionDir?: string | null): Promise<void> {
  await writeJsonAtomic(path.join(root, REPORT_PATH), matrix)
  if (missionDir) await writeJsonAtomic(path.join(missionDir, 'codex-native-feature-matrix.json'), matrix).catch(() => undefined)
}

function boolState(ok: boolean, source: CodexNativeFeatureState['source'], artifactPath: string, blockers: string[] = [], warnings: string[] = []): CodexNativeFeatureState {
  return codexNativeFeatureState({
    ok,
    source,
    artifact_path: artifactPath,
    blockers: ok ? [] : blockers,
    warnings: ok ? warnings : [...warnings, ...(!blockers.length ? ['feature_unavailable'] : [])]
  })
}

async function codexVersion(bin: string): Promise<string | null> {
  const run = await runProcess(bin, ['--version'], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch(() => null)
  return run?.code === 0 ? `${run.stdout || run.stderr || ''}`.trim() || null : null
}

function booleanFeature(value: unknown, key: string): boolean {
  return isRecord(value) && value[key] === true
}

function blockersOf(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.blockers)) return []
  return value.blockers.map((item) => String(item)).filter(Boolean)
}

function recordOk(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.ok === 'boolean' ? value.ok : undefined
}

function warningsOf(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.warnings)) return []
  return value.warnings.map((item) => String(item)).filter(Boolean)
}

function codex0144State(capability: unknown, key: Codex0144FeatureKey): CodexNativeFeatureState {
  const state = isRecord(capability)
    && isRecord(capability.feature_states)
    && isRecord(capability.feature_states[key])
    ? capability.feature_states[key]
    : null
  const evidence = Array.isArray(state?.evidence) ? state.evidence.map(String) : []
  const blockers = Array.isArray(state?.blockers) ? state.blockers.map(String) : [`codex_0144_${key}_not_verified`]
  const supported = state?.supported === true
  const certainty = typeof state?.certainty === 'string' ? state.certainty : ''
  const input: {
    ok: boolean
    source: CodexNativeFeatureState['source']
    artifact_path: string
    evidence: string[]
    blockers: string[]
    warnings: string[]
    unavailableStatus?: 'unavailable' | 'unknown' | 'blocked' | 'fallback'
  } = {
    ok: supported,
    source: 'actual-probe',
    artifact_path: '.sneakoscope/codex/codex-0144-capability.json',
    evidence,
    blockers: supported ? [] : blockers,
    warnings: certainty && certainty !== 'actual' && certainty !== 'discovered' ? [`codex_0144_${key}_${certainty}`] : []
  }
  if (!supported) input.unavailableStatus = 'fallback'
  return codexNativeFeatureState(input)
}
