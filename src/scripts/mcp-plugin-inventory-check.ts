#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_CURRENT_APP_FAKE = '1'
process.env.SKS_CODEX_PLUGIN_JSON_FAKE = '1'
const pluginMod = await importDist('core/codex-plugins/codex-plugin-json.js')
const mcpMod = await importDist('core/mcp/mcp-plugin-inventory.js')
const inventory = await pluginMod.buildCodexPluginInventory()
const candidates = mcpMod.buildMcpPluginServerCandidates(inventory)
assertGate(candidates.candidate_only === true && candidates.candidates.every((candidate) => candidate.auto_enable === false && candidate.destructive_tools_auto_enabled === false), 'remote MCP plugin inventory must be candidate-only and non-destructive by default', candidates)
emitGate('mcp:plugin-inventory', { candidates: candidates.candidates.length })
