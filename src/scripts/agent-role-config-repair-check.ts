#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const mod = await importDist('core/agents/agent-role-config.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-role-repair-'))
fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true })
const plan = await mod.repairAgentRoleConfigs({ root, apply: false, codexHome: path.join(root, 'codex-home') })
const repair = await mod.repairAgentRoleConfigs({ root, apply: true, codexHome: path.join(root, 'codex-home'), reportPath: path.join(root, '.sneakoscope', 'reports', 'agent-role-config-repair.json') })
const workerFile = path.join(root, '.codex', 'agents', 'worker.toml')
const expertFile = path.join(root, '.codex', 'agents', 'expert.toml')
const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-role-stale-'))
fs.mkdirSync(path.join(staleRoot, '.codex', 'agents'), { recursive: true })
const manifest = await importDist('core/managed-assets/managed-assets-manifest.js')
const staleManagedText = manifest.managedAgentRoleContent(manifest.managedAgentRoleByFile('analysis-scout.toml'))
fs.writeFileSync(path.join(staleRoot, '.codex', 'agents', 'analysis-scout.toml'), staleManagedText)
const stalePlan = await mod.repairAgentRoleConfigs({ root: staleRoot, apply: false, codexHome: path.join(staleRoot, 'codex-home') })
const staleRepair = await mod.repairAgentRoleConfigs({ root: staleRoot, apply: true, codexHome: path.join(staleRoot, 'codex-home') })
const retiredManagedRemoved = !fs.existsSync(path.join(staleRoot, '.codex', 'agents', 'analysis-scout.toml'))
const createdText = fs.readFileSync(workerFile, 'utf8')
const createdParsed = parse(createdText)
const globalRole = path.join(root, 'codex-home', 'agents', 'analysis-scout.toml')
fs.mkdirSync(path.dirname(globalRole), { recursive: true })
const globalCustomText = 'name = "analysis_scout"\ndescription = "SKS stale global role"\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "low"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = """\nSKS role\n"""\n'
fs.writeFileSync(globalRole, globalCustomText)
const globalRepair = await mod.repairAgentRoleConfigs({ root, apply: true, codexHome: path.join(root, 'codex-home') })
const quarantineRoot = path.join(root, 'codex-home', '.sneakoscope', 'quarantine', 'retired-agent-roles')
const quarantined = fs.readdirSync(quarantineRoot, { recursive: true }).filter((file) => String(file).endsWith('analysis-scout.toml'))
const globalPreservedText = quarantined.length === 1 ? fs.readFileSync(path.join(quarantineRoot, String(quarantined[0])), 'utf8') : ''
const report = {
  schema: 'sks.agent-role-config-repair-check.v1',
  plan_ok: plan.ok === true && plan.missing.includes('worker.toml') && plan.missing.includes('expert.toml') && !plan.missing.includes('analysis-scout.toml'),
  repair_ok: repair.ok === true,
  official_agents_created: fs.existsSync(workerFile) && fs.existsSync(expertFile),
  managed_body_hash_present: createdText.includes('# SKS-MANAGED-OFFICIAL-SUBAGENT') && /sks_managed_body_sha256 = "[a-f0-9]{64}"/.test(createdText),
  generated_toml_parses: createdParsed.name === 'worker' && createdParsed.model === 'gpt-6-astra' && createdParsed.model_reasoning_effort === 'low',
  generated_toml_uses_supported_keys: !Object.hasOwn(createdParsed, 'permission_profile') && !Object.hasOwn(createdParsed, 'legacy_sandbox_projection'),
  generated_inherits_parent_sandbox: !Object.hasOwn(createdParsed, 'sandbox_mode'),
  retired_managed_removed: stalePlan.retired_role_cleanup.detected_count === 1 && staleRepair.retired_role_cleanup.removed_count === 1 && retiredManagedRemoved,
  global_user_collision_quarantined: !fs.existsSync(globalRole) && globalRepair.retired_role_cleanup.quarantined_user_collision_count === 1 && globalPreservedText === globalCustomText,
  warnings_suppressed: repair.warnings_suppressed === true,
  artifact_written: fs.existsSync(path.join(root, '.sneakoscope', 'reports', 'agent-role-config-repair.json'))
}
const ok = report.plan_ok && report.repair_ok && report.official_agents_created && report.managed_body_hash_present && report.generated_toml_parses && report.generated_toml_uses_supported_keys && report.generated_inherits_parent_sandbox && report.retired_managed_removed && report.global_user_collision_quarantined && report.warnings_suppressed && report.artifact_written
assertGate(ok, 'role repair must create official Astra configs, remove retired managed roles, and preserve user collisions in quarantine', report)
emitGate('agent:role-config-repair', report)
