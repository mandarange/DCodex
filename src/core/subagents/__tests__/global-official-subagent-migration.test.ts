import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '../../fsx.js'
import { repairAgentRoleConfigs } from '../../agents/agent-role-config.js'
import { installCodexAgents } from '../../init/skills.js'
import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  managedOfficialSubagentRoleBody,
  managedOfficialSubagentRoleContent,
  type ManagedOfficialSubagentRole
} from '../../managed-assets/managed-assets-manifest.js'
import { refreshGlobalOfficialSubagentAgentConfigs } from '../official-subagent-config.js'

function previousManagedRole(role: ManagedOfficialSubagentRole): string {
  const previousModel = role.model_policy === 'terra_max_context_tools' ? 'gpt-5.6-terra' : 'gpt-5.6-sol'
  const body = managedOfficialSubagentRoleBody(role)
    .replace('model = "gpt-6-astra"', `model = "${previousModel}"`)
    .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "max"')
  return managedOfficialSubagentRoleContent(role)
    .replace(managedOfficialSubagentRoleBody(role), body)
    .replace(/sks_managed_body_sha256 = "[a-f0-9]+"/, `sks_managed_body_sha256 = "${sha256(body)}"`)
}

test('global refresh migrates the previous managed catalog, preserves Luna, and is idempotent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-global-role-migration-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, 'custom-codex-home')
  const agentsDir = path.join(codexHome, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    await fs.writeFile(path.join(agentsDir, role.filename), previousManagedRole(role))
  }
  const before = await fs.readFile(path.join(agentsDir, 'explorer.toml'), 'utf8')
  const plan = await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: false })
  assert.equal(plan.stale.length, 24)
  assert.equal(plan.existing.length, 1)
  assert.equal(await fs.readFile(path.join(agentsDir, 'explorer.toml'), 'utf8'), before)
  const result = await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: true })
  assert.equal(result.ok, true)
  assert.equal(result.updated.length, 24)
  assert.deepEqual(result.created, [])
  for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    assert.equal(await fs.readFile(path.join(agentsDir, role.filename), 'utf8'), managedOfficialSubagentRoleContent(role))
  }
  const second = await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: true })
  assert.equal(second.existing.length, 25)
  assert.deepEqual(second.updated, [])
})

test('global refresh does not create absent roles or overwrite provider edits and symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-global-role-preserve-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, '.codex')
  const absent = await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: true })
  assert.equal(absent.ok, true)
  assert.deepEqual(absent.missing, [])
  await assert.rejects(fs.stat(codexHome), { code: 'ENOENT' })
  const agentsDir = path.join(codexHome, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  const explorer = MANAGED_OFFICIAL_SUBAGENT_ROLES.find((role) => role.codex_name === 'explorer')!
  const userText = previousManagedRole(explorer).replace('model = "gpt-5.6-terra"', 'model = "custom/provider-model"')
  await fs.writeFile(path.join(agentsDir, explorer.filename), userText)
  const target = path.join(root, 'user-worker.toml')
  await fs.writeFile(target, 'name = "user_worker"\n')
  await fs.symlink(target, path.join(agentsDir, 'worker.toml'))
  const result = await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: true })
  assert.equal(result.ok, false)
  assert.equal(result.preserved.length, 2)
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.updated, [])
  assert.equal(await fs.readFile(path.join(agentsDir, explorer.filename), 'utf8'), userText)
  assert.equal(await fs.readFile(target, 'utf8'), 'name = "user_worker"\n')
  assert.equal((await fs.readdir(agentsDir)).length, 2)
})

test('canonical role repair detects and repairs stale active global roles alongside project roles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-global-role-repair-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const agentsDir = path.join(codexHome, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  const explorer = MANAGED_OFFICIAL_SUBAGENT_ROLES.find((role) => role.codex_name === 'explorer')!
  await fs.writeFile(path.join(agentsDir, explorer.filename), previousManagedRole(explorer))
  const input = { root, home, codexHome, globalRuntimeRoot: path.join(root, 'global-runtime') }
  const plan = await repairAgentRoleConfigs({ ...input, apply: false })
  assert.equal(plan.ok, false)
  assert.ok(plan.blockers.some((blocker) => blocker.startsWith('stale_global_official_subagent_agent:')))
  const result = await repairAgentRoleConfigs({ ...input, apply: true })
  assert.equal(result.ok, true)
  assert.equal(result.global_role_repair?.updated.length, 1)
  assert.ok(result.repaired.includes(path.join(agentsDir, explorer.filename)))
  assert.equal(await fs.readFile(path.join(agentsDir, explorer.filename), 'utf8'), managedOfficialSubagentRoleContent(explorer))
  assert.equal((await fs.readdir(agentsDir)).length, 1)
})


test('setup role installation honors its explicit Codex home when refreshing global roles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-global-role-setup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, 'custom-codex')
  const agentsDir = path.join(codexHome, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  const explorer = MANAGED_OFFICIAL_SUBAGENT_ROLES.find((role) => role.codex_name === 'explorer')!
  await fs.writeFile(path.join(agentsDir, explorer.filename), previousManagedRole(explorer))
  const result = await installCodexAgents(root, { home, codexHome, globalRuntimeRoot: path.join(root, 'runtime') })
  assert.equal(result.ok, true)
  assert.equal(result.global_role_repair?.updated.length, 1)
  assert.equal(await fs.readFile(path.join(agentsDir, explorer.filename), 'utf8'), managedOfficialSubagentRoleContent(explorer))
  assert.equal((await fs.readdir(agentsDir)).length, 1)
})


test('global refresh preserves user settings prepended above managed metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-global-role-prefix-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, '.codex')
  const agentsDir = path.join(codexHome, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  const role = MANAGED_OFFICIAL_SUBAGENT_ROLES.find((entry) => entry.codex_name === 'implementation_specialist')!
  const file = path.join(agentsDir, role.filename)
  for (const setting of ['sandbox_mode = "read-only"', 'model_provider = "private-provider"']) {
    const text = setting + '\n' + previousManagedRole(role)
    await fs.writeFile(file, text)
    const result = await refreshGlobalOfficialSubagentAgentConfigs(codexHome, { apply: true })
    assert.equal(result.ok, false)
    assert.equal(result.preserved.length, 1)
    assert.deepEqual(result.updated, [])
    assert.equal(await fs.readFile(file, 'utf8'), text)
  }
})
