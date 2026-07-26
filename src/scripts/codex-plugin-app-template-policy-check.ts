#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_0138_FAKE = '1'
process.env.SKS_CODEX_PLUGIN_JSON_FAKE = '1'
const mod = await importDist('core/codex-plugins/codex-plugin-json.js')
const inventory = await mod.buildCodexPluginInventory()
const policy = mod.pluginAppTemplatePolicy(inventory)
assertGate(policy.qa_loop_app_handoff_recommended === true && policy.doctor_warnings[0].startsWith('plugin_app_template_unavailable:'), 'unavailable app templates must recommend QA /app handoff and doctor warnings', policy)
emitGate('codex-plugin:app-template-policy')
