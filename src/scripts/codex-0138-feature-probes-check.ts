#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_0138_FAKE = '1'
process.env.SKS_CODEX_VERSION_FAKE = 'codex-cli 0.138.0'
process.env.SKS_CODEX_0138_PROBE = '1'
process.env.SKS_CODEX_0138_FAKE_PLUGIN_JSON_FAIL = '1'
const mod = await importDist('core/codex-control/codex-0138-capability.js')
const cap = await mod.detectCodex0138Capability({ codexBin: 'codex' })
assertGate(cap.ok === false && cap.probe_mode === 'feature-probe' && cap.supports_plugin_json === false && cap.blockers.includes('codex_plugin_json_probe_failed'), '0.138 feature probes must override coarse version-only plugin JSON support and mark failed probes not ok')
emitGate('codex:0138-feature-probes', { probe_mode: cap.probe_mode, plugin_json: cap.feature_probe_results.plugin_json })
