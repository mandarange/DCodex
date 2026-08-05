#!/usr/bin/env node
// @ts-nocheck
import { emitGate, importDist, root } from './gate-lib.js'

const args = process.argv.slice(2)
const requireReal = args.includes('--require-real')
const allowNetwork = args.includes('--allow-network')
const allowDesktop = args.includes('--allow-desktop')
const json = args.includes('--json')
const timeoutMs = Number(
  readArg('--timeout-ms')
    || process.env.SKS_CODEX_CURRENT_CORE_REAL_PROBE_TIMEOUT_MS
    || process.env.SKS_CODEX_CURRENT_CORE_REAL_PROBE_TIMEOUT_MS
    || 120000
)
const missionId = readArg('--mission-id') || process.env.SKS_MISSION_ID || process.env.SNEAKOSCOPE_MISSION_ID || null
const probes = readRepeated('--probe')
const mod = await importDist('core/codex-control/codex-current-core-probe-runner.js')
const writer = await importDist('core/codex-control/codex-current-core-real-probes.js')
const result = await mod.runCodexCurrentCoreRealProbes({ root, missionId, requireReal, allowNetwork, allowDesktop, timeoutMs, probes })
const artifacts = await writer.writeCodexCurrentCoreRealProbeResult(root, result, { missionId, writeDist: true })
const ok = requireReal ? result.release_authorizing === true : result.overall_ok === true
emitGate(requireReal ? 'codex:current-core-real-probes:require-real' : 'codex:current-core-real-probes', {
  ok,
  overall_ok: result.overall_ok,
  release_authorizing: result.release_authorizing,
  target_version: result.target_version,
  compatibility_origin: result.compatibility_origin,
  compatibility_authority: result.compatibility_authority,
  parsed_version: result.parsed_version,
  requested_probes: result.requested_probes,
  skipped: result.skipped,
  blockers: result.blockers,
  warnings: result.warnings,
  external_integration_status: result.external_integration_status,
  temp_cleanup: result.temp_cleanup,
  artifact: '.sneakoscope/codex-current-core-real-probes.json',
  mission_artifact: artifacts.mission_artifact ? `.sneakoscope/missions/${missionId}/codex-current-core-real-probes.json` : null,
  ...(json ? { result } : {})
})
if (!ok) process.exitCode = 1

function readArg(name) {
  const idx = args.indexOf(name)
  return idx >= 0 ? args[idx + 1] : null
}

function readRepeated(name) {
  const out = []
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1]) out.push(args[i + 1])
  return out
}
