#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const CORE_NO_TS_NOCHECK_DIRS = [
  'src/core/zellij',
  'src/core/doctor',
  'src/core/codex-app',
  'src/core/loops',
  'src/core/naruto'
]

const TARGET_TYPED_FILES = [
  'src/core/zellij/zellij-self-heal.ts',
  'src/core/zellij/homebrew-policy.ts',
  'src/core/doctor/doctor-zellij-repair.ts',
  'src/core/codex-app/codex-app-harness-matrix.ts',
  'src/core/codex-native/codex-native-pattern-analysis.ts',
  'src/core/codex-app/codex-skill-sync.ts',
  'src/core/codex-app/codex-agent-role-sync.ts',
  'src/core/codex-app/codex-init-deep.ts',
  'src/core/codex-app/codex-hook-lifecycle.ts',
  'src/core/codex-app/codex-app-execution-profile.ts',
  'src/core/codex-native/codex-native-interop-policy.ts',
  'src/core/loops/loop-continuation-enforcer.ts'
]

export async function runTypedRoutingGate(id: string) {
  if (id === 'lint:no-ts-nocheck-core') return noTsNoCheckCore(id)
  if (id === 'codex-app:type-safety') return codexAppTypeSafety(id)
  if (id === 'type-surface:codex-app') return typeSurfaceCodexApp(id)
  if (id.startsWith('zellij:')) return zellijGate(id)
  if (id.startsWith('codex-app:hook-approval')) return hookApprovalGate(id)
  if (id.startsWith('codex-app:agent-type')) return agentTypeGate(id)
  if (id.includes('init-deep') || id.includes('planner-project-memory-deep')) return initDeepGate(id)
  if (id.includes('execution-profile-routing')) return executionProfileRoutingGate(id)
  if (id === 'codex-app:skill-rich-content') return richContentGate(id)
  if (id === 'codex-app:agent-role-rich-content') return richContentGate(id)
  throw new Error(`unknown_gate:${id}`)
}

function noTsNoCheckCore(id: string) {
  const offenders: string[] = []
  for (const dir of CORE_NO_TS_NOCHECK_DIRS) {
    for (const file of walkTs(path.join(root, dir))) {
      const text = fs.readFileSync(file, 'utf8')
      if (/^\s*\/\/\s*@ts-nocheck\b/m.test(text)) offenders.push(path.relative(root, file))
    }
  }
  assertGate(offenders.length === 0, 'core @ts-nocheck offenders found', { offenders })
  emitGate(id, { scanned_dirs: CORE_NO_TS_NOCHECK_DIRS.length })
}

function codexAppTypeSafety(id: string) {
  const required = [
    'src/core/codex-app/codex-app-types.ts',
    'src/core/zellij/zellij-self-heal-types.ts',
    'src/core/codex-app/codex-hook-approval-probe.ts',
    'src/core/codex-app/codex-agent-type-probe.ts',
    'src/core/codex-native/codex-native-reference-source.ts'
  ]
  for (const file of [...required, ...TARGET_TYPED_FILES]) assertGate(fs.existsSync(path.join(root, file)), `missing ${file}`)
  for (const file of TARGET_TYPED_FILES) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assertGate(!/^\s*\/\/\s*@ts-nocheck\b/m.test(text), `target file still has @ts-nocheck: ${file}`)
  }
  const matrix = fs.readFileSync(path.join(root, 'src/core/codex-app/codex-app-harness-matrix.ts'), 'utf8')
  assertGate(!/hookApprovalKnown\s*=\s*false/.test(matrix), 'harness matrix must not hardcode hook approval unknown')
  assertGate(!/SKS_CODEX_AGENT_TYPE_SUPPORTED\s*===\s*['"]1['"]/.test(matrix), 'harness matrix must not use env-only agent_type support')
  emitGate(id, { target_files: TARGET_TYPED_FILES.length })
}

async function typeSurfaceCodexApp(id: string) {
  const types = await importDist('core/codex-app/codex-app-types.js')
  const zellijTypes = await importDist('core/zellij/zellij-self-heal-types.js')
  const agentProbe = await importDist('core/codex-app/codex-agent-type-probe.js')
  const sampleMatrix = {
    schema: 'sks.codex-app-harness-matrix.v1',
    generated_at: new Date().toISOString(),
    ok: true,
    codex_cli: { available: true, version: 'codex test' },
    app_features: {
      plugin_json: true,
      marketplace_add: true,
      marketplace_upgrade: true,
      startup_review_detectable: true,
      hook_approval_state_detectable: true,
      hook_approval_state: 'approved',
      skill_picker_ready: true,
      agent_type_supported: true,
      mcp_inventory_ready: true,
      app_handoff_ready: true,
      image_path_exposure_ready: true
    },
    sks_integrations: {
      dollar_skills_synced: true,
      agent_roles_synced: true,
      hooks_synced: true,
      init_deep_available: true,
      loop_mesh_app_profile_available: true
    },
    probes: {},
    blockers: [],
    warnings: []
  }
  assertGate(types.isCodexAppHarnessMatrix(sampleMatrix) === true, 'CodexAppHarnessMatrix guard rejected valid sample')
  const normalized = zellijTypes.normalizeZellijSelfHealResult({ schema: 'sks.zellij-self-heal.v1', ok: true, requested_by: 'setup', strategy: 'none-current', before: {}, after: {}, blockers: [], warnings: [] })
  assertGate(normalized.dry_run === false && Array.isArray(normalized.planned_mutations), 'zellij self-heal normalizer must backfill new fields', normalized)
  const payload = agentProbe.agentRolePayloadFor('sks-checker', { supported: true, schema: 'sks.codex-agent-type-probe.v1' })
  assertGate(payload.strategy === 'agent_type' && payload.agent_type === 'sks-checker', 'agent role payload must select agent_type when supported', payload)
  emitGate(id, { guards: 3 })
}

async function zellijGate(id: string) {
  const rootDir = await tempRoot(id)
  const selfHeal = await importDist('core/zellij/zellij-self-heal.js')
  if (id === 'zellij:self-heal-status-contract') {
    const update = await importDist('core/zellij/zellij-update.js')
    const result = await update.maybePromptZellijUpdateForLaunch(['--yes'], {
      label: 'MAD launch',
      root: rootDir,
      selfHealOnMissing: true,
      allowHeadlessFallback: true,
      env: fakeZellijEnv('missing', { brew: false })
    })
    assertGate(result.status === 'headless_fallback', 'missing zellij with headless fallback must return headless_fallback', result)
    return emitGate(id, { status: result.status })
  }
  const result = await selfHeal.repairZellijForSks({
    root: rootDir,
    requestedBy: 'doctor --fix',
    fixRequested: true,
    autoApprove: true,
    dryRun: id.includes('dry-run') || id.includes('typed-blackbox'),
    installHomebrew: false,
    env: fakeZellijEnv('missing', { brew: true })
  })
  assertGate(result.dry_run === true, 'dry-run zellij result must set dry_run', result)
  assertGate(result.planned_mutations.length >= 1, 'dry-run zellij result must include planned mutations', result)
  assertGate(result.mutation_guard_artifact?.endsWith('#planned'), 'dry-run zellij mutation artifact must be planned-only', result)
  emitGate(id, { planned: result.planned_mutations.length })
}

async function hookApprovalGate(id: string) {
  const rootDir = await tempRoot(id)
  const previous = swapEnv({ SKS_CODEX_HOOK_APPROVAL_FIXTURE: id.includes('blackbox') ? 'modified' : 'approved' })
  try {
    const probe = await importDist('core/codex-app/codex-hook-approval-probe.js')
    const report = await probe.probeCodexHookApprovalState(rootDir)
    if (id.includes('blackbox')) {
      assertGate(report.approval_state === 'modified_requires_reapproval' && report.ok === false, 'modified hook approval must require reapproval', report)
    } else {
      assertGate(report.approval_state === 'approved' && report.detectable === true, 'fixture approved hook state must be detectable', report)
    }
    if (id === 'codex-app:hook-approval-matrix') {
      const matrixMod = await importDist('core/codex-app/codex-app-harness-matrix.js')
      const matrix = await matrixMod.buildCodexAppHarnessMatrix({ root: rootDir })
      assertGate(matrix.app_features.hook_approval_state === report.approval_state, 'matrix must embed hook approval probe state', matrix)
      assertGate(matrix.probes.hook_approval.schema === 'sks.codex-hook-approval-probe.v1', 'matrix must embed hook approval probe')
    }
    emitGate(id, { state: report.approval_state })
  } finally {
    restoreEnv(previous)
  }
}

async function agentTypeGate(id: string) {
  const rootDir = await tempRoot(id)
  const schema = JSON.stringify([{ name: 'spawn_agent', parameters: { properties: { agent_type: { type: 'string' } } } }])
  const previous = swapEnv({ SKS_CODEX_TOOL_SCHEMA_JSON: schema })
  try {
    const probeMod = await importDist('core/codex-app/codex-agent-type-probe.js')
    const probe = await probeMod.probeCodexAgentTypeSupport(rootDir)
    assertGate(probe.supported === true && probe.source === 'codex-tool-schema', 'agent_type probe must detect schema support', probe)
    if (id.includes('routing') || id.includes('blackbox')) {
      const roleMod = await importDist('core/codex-app/codex-agent-role-sync.js')
      const report = await roleMod.syncCodexAgentRoles({ root: rootDir, codexHome: path.join(rootDir, 'codex-home'), apply: true })
      assertGate(report.fallback === 'agent_type', 'agent role sync must route to agent_type when probe supports it', report)
    }
    emitGate(id, { supported: probe.supported })
  } finally {
    restoreEnv(previous)
  }
}

async function initDeepGate(id: string) {
  const rootDir = await tempRoot(id)
  await fsp.mkdir(path.join(rootDir, 'src/core/zellij'), { recursive: true })
  for (let i = 0; i < 18; i += 1) await fsp.writeFile(path.join(rootDir, 'src/core/zellij', `f${i}.ts`), 'export {}\n')
  await fsp.writeFile(path.join(rootDir, 'src/core/zellij', 'AGENTS.md'), '# User local guidance\nKeep me.\n')
  const init = await importDist('core/codex-app/codex-init-deep.js')
  const report = await init.runCodexInitDeep({ root: rootDir, apply: true, directoryLocal: true })
  const agents = fs.readFileSync(path.join(rootDir, 'src/core/zellij', 'AGENTS.md'), 'utf8')
  assertGate(/BEGIN SKS INIT-DEEP MANAGED SECTION/.test(agents), 'directory AGENTS.md managed block missing', { agents })
  assertGate(agents.includes('Keep me.'), 'directory AGENTS.md must preserve user content', { agents })
  assertGate(report.directory_local_agents.backup_paths.length >= 1, 'directory AGENTS.md backup missing', report)
  if (id === 'loop:planner-project-memory-deep') {
    const planner = await importDist('core/loops/loop-planner.js')
    const plan = await planner.planLoopsFromRequest({ root: rootDir, missionId: 'M-memory-deep', request: 'change zellij self heal and loop planner', sourceCommand: 'loop' })
    assertGate(plan.graph.nodes.some((node: any) => Array.isArray(node.memory_hints) && node.memory_hints.length), 'loop nodes must consume deep memory hints', plan)
  }
  emitGate(id, { managed_agents: report.directory_local_agents.created.length + report.directory_local_agents.updated.length })
}

async function executionProfileRoutingGate(id: string) {
  const rootDir = await tempRoot(id)
  const previous = swapEnv({ SKS_CODEX_HOOK_APPROVAL_FIXTURE: 'approved', SKS_CODEX_AGENT_TYPE_FIXTURE: 'supported' })
  try {
    const profileMod = await importDist('core/codex-app/codex-app-execution-profile.js')
    const profile = await profileMod.resolveCodexAppExecutionProfile({ root: rootDir })
    assertGate(profile.agent_role_strategy === 'agent_type', 'execution profile must consume agent_type probe fixture', profile)
    if (id === 'qa-loop:execution-profile-routing' || id === 'pipeline:execution-profile-routing-blackbox') {
      const qa = await importDist('core/qa-loop.js')
      const dir = path.join(rootDir, '.sneakoscope', 'missions', 'M-qa')
      await fsp.mkdir(dir, { recursive: true })
      await qa.writeQaLoopArtifacts(dir, { id: 'M-qa', prompt: 'QA no UI' }, { sealed_hash: 'sealed', answers: { QA_SCOPE: 'api_e2e_only', TARGET_ENVIRONMENT: 'local_dev_server', DESTRUCTIVE_DEPLOYED_TESTS_ALLOWED: 'never' } })
      const gate = JSON.parse(fs.readFileSync(path.join(dir, 'qa-gate.json'), 'utf8'))
      assertGate(gate.codex_app_execution_profile?.agent_role_strategy === 'agent_type', 'QA gate must consume execution profile', gate)
    }
    if (id === 'research:execution-profile-routing' || id === 'pipeline:execution-profile-routing-blackbox') {
      const research = await importDist('core/research.js')
      const dir = path.join(rootDir, '.sneakoscope', 'missions', 'M-research')
      await fsp.mkdir(dir, { recursive: true })
      const plan = await research.writeResearchPlan(dir, 'research execution profile routing', { root: rootDir, missionId: 'M-research' })
      assertGate(plan.codex_app_execution_profile?.agent_role_strategy === 'agent_type', 'Research plan must consume execution profile', plan)
      assertGate(plan.web_research_policy.source_tool_routing, 'Research plan must include source tool routing', plan)
    }
    if (id === 'loop:execution-profile-routing' || id === 'pipeline:execution-profile-routing-blackbox') {
      const source = fs.readFileSync(path.join(root, 'src/core/loops/loop-worker-runtime.ts'), 'utf8')
      assertGate(source.includes('codex_app_execution_profile') && source.includes('SKS_CODEX_APP_EXECUTION_PROFILE'), 'Loop worker runtime must persist execution profile routing')
    }
    emitGate(id, { mode: profile.mode, strategy: profile.agent_role_strategy })
  } finally {
    restoreEnv(previous)
  }
}

async function richContentGate(id: string) {
  const rootDir = await tempRoot(id)
  if (id === 'codex-app:skill-rich-content') {
    const mod = await importDist('core/codex-app/codex-skill-sync.js')
    const skillsRoot = path.join(rootDir, 'skills')
    const report = await mod.syncCodexSksSkills({ root: rootDir, skillsRoot, apply: true })
    const skill = fs.readFileSync(path.join(skillsRoot, 'sks-loop', 'SKILL.md'), 'utf8')
    assertGate(/Purpose:|Evidence:|Fallback:/.test(skill), 'managed skill must include rich route content', { skill, report })
    for (const name of ['search-visibility-core', 'seo-geo-optimizer']) {
      const file = path.join(skillsRoot, name, 'SKILL.md')
      assertGate(fs.existsSync(file), `managed skill missing: ${name}`, { report })
      const text = fs.readFileSync(file, 'utf8')
      assertGate(/Purpose:|Use when:|Workflow:|Safety:|Evidence\/artifacts:|Failure\/recovery:|CLI entrypoint:/i.test(text), `managed skill lacks rich content: ${name}`, { text })
      assertGate(/ranking|citation|traffic|guarantee|보장/i.test(text), `managed skill must name forbidden guarantee boundary: ${name}`, { text })
      if (name === 'seo-geo-optimizer') assertGate(text.includes('sks seo-geo-optimizer doctor|audit|plan|apply|verify|status|rollback|fixture') && /not geolocation|GeoIP/i.test(text), 'seo-geo-optimizer skill must expose CLI entrypoint and geolocation disambiguation', { text })
    }
    return emitGate(id, { skills: report.created.length, search_visibility_skills_checked: 2 })
  }
  const previous = swapEnv({ SKS_CODEX_AGENT_TYPE_FIXTURE: 'supported' })
  try {
    const mod = await importDist('core/codex-app/codex-agent-role-sync.js')
    const codexHome = path.join(rootDir, 'codex-home')
    const report = await mod.syncCodexAgentRoles({ root: rootDir, codexHome, apply: true })
    const role = fs.readFileSync(path.join(rootDir, '.codex', 'agents', 'expert.toml'), 'utf8')
    assertGate(role.includes('model = "gpt-5.6-sol"') && role.includes('Do not spawn another subagent.'), 'official expert role must include Sol Max and no-nesting instructions', { role, report })
    assertGate(!fs.existsSync(path.join(codexHome, 'agents')), 'rich-content sync must not create global directive roles', report)
    emitGate(id, { roles: report.created.length })
  } finally {
    restoreEnv(previous)
  }
}

function* walkTs(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkTs(full)
    else if (entry.isFile() && full.endsWith('.ts')) yield full
  }
}

async function tempRoot(id: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-315-${id.replace(/[^a-z0-9]+/gi, '-')}-`))
  await fsp.mkdir(path.join(dir, '.sneakoscope', 'reports'), { recursive: true })
  return dir
}

function fakeZellijEnv(status: string, opts: { brew?: boolean } = {}) {
  return {
    ...process.env,
    SKS_ZELLIJ_CAPABILITY_FAKE_STATUS: status,
    SKS_ZELLIJ_CAPABILITY_FAKE_VERSION: status === 'too_old' ? '0.40.0' : '0.44.0',
    SKS_ZELLIJ_SELF_HEAL_BEFORE_STATUS: status,
    SKS_ZELLIJ_SELF_HEAL_BEFORE_VERSION: status === 'too_old' ? '0.40.0' : '',
    SKS_ZELLIJ_SELF_HEAL_AFTER_STATUS: 'ok',
    SKS_ZELLIJ_SELF_HEAL_AFTER_VERSION: '0.44.3',
    SKS_ZELLIJ_LATEST_VERSION: '0.44.3',
    SKS_ZELLIJ_SELF_HEAL_FAKE_RUN: '1',
    SKS_ZELLIJ_SELF_HEAL_BREW_PRESENT: opts.brew ? '1' : '0'
  }
}

function swapEnv(next: Record<string, string>) {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(next)) {
    previous[key] = process.env[key]
    if (value === '') delete process.env[key]
    else process.env[key] = value
  }
  return previous
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
