#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

export async function runRuntimeDomainGate(id: string) {
  if (id.startsWith('codex-app:') || id === 'doctor:codex-app-harness') return codexAppGate(id)
  if (id.startsWith('loop:')) return loopGate(id)
  throw new Error(`unknown_gate:${id}`)
}

async function codexAppGate(id: string) {
  const rootDir = await tempRoot(`sks-${id.replace(/[:/]/g, '-')}-`)
  const previous = swapEnv({
    SKS_CODEX_0138_FAKE: '1',
    SKS_CODEX_0139_FAKE: '1',
    SKS_CODEX_PLUGIN_JSON_FAKE: '1',
    SKS_CODEX_AGENT_TYPE_SUPPORTED: id.includes('blackbox') ? '1' : ''
  })
  try {
    if (id === 'codex-app:harness-matrix' || id === 'doctor:codex-app-harness' || id === 'codex-app:harness-blackbox') {
      const mod = await importDist('core/codex-app/codex-app-harness-matrix.js')
      const matrix = await mod.buildCodexAppHarnessMatrix({ root: rootDir })
      assertGate(matrix.schema === 'sks.codex-app-harness-matrix.v1', 'harness matrix schema mismatch', matrix)
      assertGate(matrix.app_features.plugin_json === true, 'fixture should expose plugin_json', matrix)
      if (id === 'doctor:codex-app-harness') {
        const doctor = fs.readFileSync(path.join(root, 'src/commands/doctor.ts'), 'utf8')
        assertGate(doctor.includes('Codex App Harness:'), 'doctor output must include Codex App Harness section')
        assertGate(doctor.includes('codex_app_harness_matrix'), 'doctor JSON must include codex_app_harness_matrix')
      }
      return emitGate(id, { ok: matrix.ok, warnings: matrix.warnings.length })
    }
    if (id === 'codex-app:skill-sync' || id === 'codex-app:skill-agent-blackbox') {
      const mod = await importDist('core/codex-app/codex-skill-sync.js')
      const skillsRoot = path.join(rootDir, 'skills')
      await fsp.mkdir(path.join(skillsRoot, 'ulw-loop'), { recursive: true })
      const report = await mod.syncCodexSksSkills({ root: rootDir, skillsRoot, apply: true })
      assertGate(report.interop.clobbered_external_routes === false && report.external_route_names_preserved.includes('ulw-loop'), 'skill sync must preserve existing external route skills', report)
      return emitGate(id, { desired: report.desired_skills.length })
    }
    if (id === 'codex-app:agent-role-sync') {
      const mod = await importDist('core/codex-app/codex-agent-role-sync.js')
      const manifest = await importDist('core/managed-assets/managed-assets-manifest.js')
      const codexHome = path.join(rootDir, 'codex-home')
      const report = await mod.syncCodexAgentRoles({ root: rootDir, codexHome, apply: true, agentTypeSupported: true })
      const expectedRoles = manifest.MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role: any) => role.codex_name)
      assertGate(report.fallback === 'agent_type', 'agent role sync should use agent_type when supported', report)
      assertGate(report.directive_roles.length === 0 && report.official_roles.join(',') === expectedRoles.join(','), 'agent role sync must expose the official project custom-agent catalog', report)
      assertGate(manifest.MANAGED_OFFICIAL_SUBAGENT_ROLES.every((role: any) => fs.existsSync(path.join(rootDir, '.codex', 'agents', role.filename))), 'official project agent catalog missing', report)
      assertGate(!fs.existsSync(path.join(codexHome, 'agents')), 'agent role sync must not create global directive roles', report)
      return emitGate(id, { roles: report.official_roles.length })
    }
    if (id === 'codex-app:init-deep') {
      const mod = await importDist('core/codex-app/codex-init-deep.js')
      await fsp.mkdir(path.join(rootDir, 'src/core/runtime'), { recursive: true })
      await fsp.writeFile(path.join(rootDir, 'src/core/runtime/a.ts'), 'export {}\n')
      const report = await mod.runCodexInitDeep({ root: rootDir, apply: true })
      assertGate(report.root_agents_preserved === true, 'init-deep must preserve user AGENTS.md', report)
      return emitGate(id, { guidance: report.directory_guidance.length })
    }
    if (id === 'codex-app:hook-lifecycle') {
      const mod = await importDist('core/codex-app/codex-hook-lifecycle.js')
      const report = await mod.buildCodexHookLifecycle({ root: rootDir })
      assertGate(report.approval_state === 'unknown', 'hook lifecycle must report unknown approval when not detectable', report)
      return emitGate(id, { lifecycle: Object.keys(report.lifecycle).length })
    }
    if (id === 'codex-app:execution-profile') {
      const mod = await importDist('core/codex-app/codex-app-execution-profile.js')
      const profile = await mod.resolveCodexAppExecutionProfile({ root: rootDir })
      assertGate(['codex-app-native', 'codex-cli-headless', 'sks-loop-headless', 'degraded-no-app'].includes(profile.mode), 'execution profile mode invalid', profile)
      return emitGate(id, { mode: profile.mode })
    }
  } finally {
    restoreEnv(previous)
  }
}

async function loopGate(id: string) {
  const rootDir = await tempRoot(`sks-${id.replace(/[:/]/g, '-')}-`)
  if (id === 'loop:planner-project-memory') {
    const init = await importDist('core/codex-app/codex-init-deep.js')
    const planner = await importDist('core/loops/loop-planner.js')
    await fsp.mkdir(path.join(rootDir, 'src/core/loops'), { recursive: true })
    await fsp.writeFile(path.join(rootDir, 'src/core/loops/a.ts'), 'export {}\n')
    await init.runCodexInitDeep({ root: rootDir, apply: true })
    const plan = await planner.planLoopsFromRequest({ root: rootDir, missionId: 'M-loop-memory', request: 'update loop planner project memory', sourceCommand: 'loop' })
    assertGate(plan.project_memory?.injected === true, 'loop planner must consume init-deep memory hints', plan)
    return emitGate(id, { injected: true })
  }
  const planDir = path.join(rootDir, '.sneakoscope', 'missions', 'M-loop-cont', 'loops')
  await fsp.mkdir(planDir, { recursive: true })
  await fsp.writeFile(path.join(rootDir, '.sneakoscope', 'missions', 'M-loop-cont', 'loops', 'loop-plan.json'), JSON.stringify({ graph: { nodes: [{ loop_id: 'loop-a' }] } }))
  const mod = await importDist('core/loops/loop-continuation-enforcer.js')
  const report = await mod.evaluateLoopContinuation({ root: rootDir, missionId: 'M-loop-cont' })
  assertGate(report.should_continue === true, 'loop continuation should request resume when proof missing', report)
  emitGate(id, { should_continue: report.should_continue })
}

async function tempRoot(prefix: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  await fsp.mkdir(path.join(dir, '.sneakoscope', 'reports'), { recursive: true })
  return dir
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
