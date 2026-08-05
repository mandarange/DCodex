#!/usr/bin/env node
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repairCodexAppFastUi } from '../core/codex-app/codex-app-fast-ui-repair.js'

const tempRoots = new Set<string>()
process.once('exit', cleanupTempRoots)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-fast-ui-'))
tempRoots.add(root)
const codexHome = path.join(root, 'home', '.codex')
await fs.mkdir(path.join(root, '.codex'), { recursive: true })
await fs.mkdir(codexHome, { recursive: true })
await fs.writeFile(path.join(root, '.codex', 'config.toml'), 'model = "future-codex-model"\nmodel_reasoning_effort = "medium"\nmodel_provider = "codex-lb"\n')
await fs.writeFile(path.join(codexHome, 'config.toml'), '# SKS forced fast UI during legacy install\nmodel = "legacy-sks-model"\nmodel_reasoning_effort = "xhigh"\nmodel_provider = "codex-lb"\nservice_tier = "fast"\n[features]\nfast_mode = false # user disabled, must remain untouched\n\n[profiles.sks-fast-high]\nmodel = "legacy-profile-model"\nservice_tier = "fast"\n\n[model_providers.codex-lb]\nname = "codex-lb"\nbase_url = "https://lb.example.test/backend-api/codex"\nwire_api = "responses"\nenv_key = "CODEX_LB_API_KEY"\nsupports_websockets = true\nrequires_openai_auth = false\n')

// Keep this hermetic: selected codex-lb readiness must not inherit the release
// runner's machine credentials or perform a real model-catalog lookup.
const fixtureEnv: NodeJS.ProcessEnv = {}
const plan = await repairCodexAppFastUi(root, { codexHome, apply: false, env: fixtureEnv })
const repaired = await repairCodexAppFastUi(root, { codexHome, apply: true, env: fixtureEnv })
const projectAfter = await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8')
const homeAfter = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')
const homeTopLevel = homeAfter.split(/\n\s*\[/)[0] || ''
const backups = repaired.actions.filter((action: any) => action.changed).map((action: any) => action.backup_path).filter(Boolean)
const unsafeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-fast-ui-unsafe-'))
tempRoots.add(unsafeRoot)
const unsafeCodexHome = path.join(unsafeRoot, 'home', '.codex')
await fs.mkdir(path.join(unsafeRoot, '.codex'), { recursive: true })
await fs.mkdir(unsafeCodexHome, { recursive: true })
await fs.writeFile(path.join(unsafeCodexHome, 'config.toml'), 'service_tier = "standard"\n')
const unsafePlan = await repairCodexAppFastUi(unsafeRoot, { codexHome: unsafeCodexHome, apply: false, env: fixtureEnv })
const unsafeAfter = await fs.readFile(path.join(unsafeCodexHome, 'config.toml'), 'utf8')
const ok = plan.fast_selector === 'manual_action_required'
  && plan.provider_selector === 'manual_action_required'
  && plan.selected_provider_blockers.includes('bridge_active_route_not_selected')
  && plan.selected_provider_blockers.includes('combined_catalog_active_generation_missing')
  && plan.selected_provider_blockers.includes('bridge_route_policy_missing')
  && plan.provider_actions.includes('sks bridge provider configure')
  && plan.provider_actions.includes('sks bridge provider validate')
  && plan.provider_actions.includes('sks bridge provider enable')
  && plan.provider_actions.includes('sks bridge catalog sync')
  && plan.provider_actions.includes('sks bridge route set-default')
  && plan.safe_auto_apply === true
  && repaired.fast_selector === 'repaired'
  // The retired SKS-owned direct selection is removed; the hermetic fixture has
  // no verified Desktop Bridge route, so provider readiness remains manual.
  && repaired.provider_selector === 'manual_action_required'
  && repaired.selected_provider_blockers.includes('bridge_active_route_not_selected')
  && repaired.selected_provider_blockers.includes('combined_catalog_active_generation_missing')
  && repaired.selected_provider_blockers.includes('bridge_route_policy_missing')
  && repaired.safe_auto_apply === true
  && backups.length >= 1
  && /^model\s*=\s*"future-codex-model"$/m.test(projectAfter.split(/\n\s*\[/)[0] || '')
  && /^model_reasoning_effort\s*=\s*"medium"$/m.test(projectAfter.split(/\n\s*\[/)[0] || '')
  && !/^model\s*=/m.test(homeTopLevel)
  && !/^model_reasoning_effort\s*=/m.test(homeTopLevel)
  && !/^model_provider\s*=/m.test(homeTopLevel)
  && /model_provider\s*=\s*"codex-lb"/.test(projectAfter)
  && /^service_tier\s*=\s*"fast"$/m.test(homeTopLevel)
  && /fast_mode = false/.test(homeAfter)
  && !/\[user\.fast_mode\]/.test(homeAfter)
  && !/\[profiles\.sks-fast-high\]/.test(homeAfter)
  && /\[model_providers\.codex-lb\]/.test(homeAfter)
  && unsafePlan.requires_confirmation === false
  && unsafePlan.safe_auto_apply === false
  && unsafePlan.actions.every((action: any) => action.changed === false)
  && unsafeAfter === 'service_tier = "standard"\n'

await Promise.all([
  fs.rm(root, { recursive: true, force: true }),
  fs.rm(unsafeRoot, { recursive: true, force: true })
])
tempRoots.clear()
process.removeListener('exit', cleanupTempRoots)
emit({ schema: 'sks.doctor-fixes-codex-app-fast-ui-check.v1', ok, plan, repaired, unsafe_plan: unsafePlan, project_after: projectAfter, home_after: homeAfter, unsafe_after: unsafeAfter, blockers: ok ? [] : ['doctor_fixes_codex_app_fast_ui_check_failed'] })

function emit(report: Record<string, unknown>) {
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

function cleanupTempRoots() {
  for (const candidate of tempRoots) {
    try { syncFs.rmSync(candidate, { recursive: true, force: true }) } catch {}
  }
}
