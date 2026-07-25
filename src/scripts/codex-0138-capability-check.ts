#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_0138_FAKE = '1'
process.env.SKS_CODEX_VERSION_FAKE = 'codex-cli 0.138.0'
const mod = await importDist('core/codex-control/codex-0138-capability.js')
const cap = await mod.detectCodex0138Capability({ codexBin: 'codex' })
assertGate(cap.ok === true, 'Codex 0.138 capability detector must accept 0.138.0', cap)
assertGate(cap.supports_app_handoff && cap.supports_plugin_json && cap.supports_image_path_exposure && cap.supports_model_defined_efforts && cap.supports_app_server_token_usage && cap.supports_oauth_mcp_prerefresh, '0.138 feature flags missing', cap)
emitGate('codex:0138-capability', { parsed_version: cap.parsed_version })
