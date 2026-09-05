#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse } from 'smol-toml'
import { syncCodexAgentRoles } from '../core/codex-app/codex-agent-role-sync.js'
import { MANAGED_OFFICIAL_SUBAGENT_ROLES } from '../core/managed-assets/managed-assets-manifest.js'

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sks-agent-role-content-'))
const codexHome = path.join(root, 'codex-home')
const report = await syncCodexAgentRoles({ root, codexHome, apply: true, agentTypeSupported: true })
const expert = await fs.promises.readFile(path.join(root, '.codex', 'agents', 'expert.toml'), 'utf8')
const worker = await fs.promises.readFile(path.join(root, '.codex', 'agents', 'worker.toml'), 'utf8')
const implementation = await fs.promises.readFile(path.join(root, '.codex', 'agents', 'implementation-specialist.toml'), 'utf8')
const browser = await fs.promises.readFile(path.join(root, '.codex', 'agents', 'browser-use-operator.toml'), 'utf8')
assertGate(expert.includes('model = "gpt-6-astra"') && expert.includes('model_reasoning_effort = "max"'), 'expert role must use Astra Max')
assertGate(worker.includes('model = "gpt-5.6-luna"') && worker.includes('model_reasoning_effort = "max"'), 'worker role must use Luna Max')
assertGate(implementation.includes('model = "gpt-6-astra"') && implementation.includes('model_reasoning_effort = "high"'), 'implementation role must use Astra High')
assertGate(browser.includes('model = "gpt-6-astra"') && browser.includes('model_reasoning_effort = "medium"'), 'browser role must use Astra Medium')
assertGate(expert.includes('Do not spawn another subagent.') && worker.includes('Do not redesign the task, expand scope, or spawn another subagent.'), 'official roles must prohibit nested delegation')
assertGate(MANAGED_OFFICIAL_SUBAGENT_ROLES.length === 25, 'official role catalog must contain all 25 roles')
for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
  const text = await fs.promises.readFile(path.join(root, '.codex', 'agents', role.filename), 'utf8')
  const doc = parse(text) as Record<string, unknown>
  assertGate(doc.model === (role.codex_name === 'worker' ? 'gpt-5.6-luna' : 'gpt-6-astra'), `official role managed model mismatch:${role.codex_name}`)
  assertGate(doc.name === role.codex_name && doc.model === role.model && doc.model_reasoning_effort === role.model_reasoning_effort, `official role policy mismatch:${role.codex_name}`)
  assertGate(Object.hasOwn(doc, 'sandbox_mode') === (role.sandbox === 'read-only'), `official role sandbox inheritance mismatch:${role.codex_name}`)
  assertGate(doc.sandbox_mode === role.sandbox, `official role sandbox value mismatch:${role.codex_name}`)
}
const distribution = Object.fromEntries(['luna_max_mechanical', 'sol_high_implementation', 'sol_max_judgment', 'terra_max_context_tools']
  .map((policy) => [policy, MANAGED_OFFICIAL_SUBAGENT_ROLES.filter((role) => role.model_policy === policy).length]))
assertGate(JSON.stringify(distribution) === JSON.stringify({
  luna_max_mechanical: 1,
  sol_high_implementation: 3,
  sol_max_judgment: 15,
  terra_max_context_tools: 6
}), 'official role policy distribution mismatch')
assertGate(!fs.existsSync(path.join(codexHome, 'agents')), 'agent role sync must not create global directive roles')
assertGate(report.strategy === 'agent_type' && report.probe_artifact_path && report.clobbered_user_roles === false && report.official_roles.length === MANAGED_OFFICIAL_SUBAGENT_ROLES.length, 'agent role report strategy/probe/catalog/no-clobber fields missing')
emitGate('codex-native:agent-role-content')

function assertGate(condition: unknown, message: string): asserts condition {
  if (condition) return
  console.error(JSON.stringify({ ok: false, message }, null, 2))
  process.exit(1)
}

function emitGate(gate: string): void {
  console.log(JSON.stringify({ schema: 'sks.release-gate.v1', ok: true, gate }, null, 2))
}
