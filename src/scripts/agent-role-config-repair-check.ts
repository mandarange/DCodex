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
const staleManagedText = [
  '# SKS-MANAGED-ASSET',
  '# sks_managed_schema = 1',
  '# sks_managed_id = "sks-explorer"',
  '# sks_managed_version = "4.8.1"',
  'name = "analysis_scout"',
  'description = "SKS stale managed role"',
  'sandbox_mode = "workspace-write"',
  'permission_profile = "sks-workspace-write"',
  'legacy_sandbox_projection = "workspace-write"',
  'developer_instructions = """',
  'SKS stale role',
  '"""',
  ''
].join('\n')
fs.writeFileSync(path.join(staleRoot, '.codex', 'agents', 'analysis-scout.toml'), staleManagedText)
const stalePlan = await mod.repairAgentRoleConfigs({ root: staleRoot, apply: false, codexHome: path.join(staleRoot, 'codex-home') })
const staleRepair = await mod.repairAgentRoleConfigs({ root: staleRoot, apply: true, codexHome: path.join(staleRoot, 'codex-home') })
const preservedText = fs.readFileSync(path.join(staleRoot, '.codex', 'agents', 'analysis-scout.toml'), 'utf8')
const createdText = fs.readFileSync(workerFile, 'utf8')
const createdParsed = parse(createdText)
const globalRole = path.join(root, 'codex-home', 'agents', 'analysis-scout.toml')
fs.mkdirSync(path.dirname(globalRole), { recursive: true })
fs.writeFileSync(globalRole, 'name = "analysis_scout"\ndescription = "SKS stale global role"\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "low"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = """\nSKS role\n"""\n')
const globalRepair = await mod.repairAgentRoleConfigs({ root, apply: true, codexHome: path.join(root, 'codex-home') })
const globalPreservedText = fs.readFileSync(globalRole, 'utf8')
const report = {
  schema: 'sks.agent-role-config-repair-check.v1',
  plan_ok: plan.ok === true && plan.missing.includes('worker.toml') && plan.missing.includes('expert.toml') && !plan.missing.includes('analysis-scout.toml'),
  repair_ok: repair.ok === true,
  official_agents_created: fs.existsSync(workerFile) && fs.existsSync(expertFile),
  managed_body_hash_present: createdText.includes('# SKS-MANAGED-OFFICIAL-SUBAGENT') && /sks_managed_body_sha256 = "[a-f0-9]{64}"/.test(createdText),
  generated_toml_parses: createdParsed.name === 'worker' && createdParsed.model === 'gpt-5.6-luna' && createdParsed.model_reasoning_effort === 'max',
  generated_toml_uses_supported_keys: !Object.hasOwn(createdParsed, 'permission_profile') && !Object.hasOwn(createdParsed, 'legacy_sandbox_projection'),
  generated_inherits_parent_sandbox: !Object.hasOwn(createdParsed, 'sandbox_mode'),
  legacy_preserved: !stalePlan.stale.includes('analysis-scout.toml') && !staleRepair.repaired.includes('.codex/agents/analysis-scout.toml') && preservedText === staleManagedText,
  global_legacy_preserved: !globalRepair.repaired.some((file) => file.endsWith('codex-home/agents/analysis-scout.toml')) && globalPreservedText.includes('model = "gpt-5.6-terra"'),
  warnings_suppressed: repair.warnings_suppressed === true,
  artifact_written: fs.existsSync(path.join(root, '.sneakoscope', 'reports', 'agent-role-config-repair.json'))
}
const ok = report.plan_ok && report.repair_ok && report.official_agents_created && report.managed_body_hash_present && report.generated_toml_parses && report.generated_toml_uses_supported_keys && report.generated_inherits_parent_sandbox && report.legacy_preserved && report.global_legacy_preserved && report.warnings_suppressed && report.artifact_written
assertGate(ok, 'doctor --fix must create only official worker/expert configs and preserve legacy role TOMLs', report)
emitGate('agent:role-config-repair', report)
