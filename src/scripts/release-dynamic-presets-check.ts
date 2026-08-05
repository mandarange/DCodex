#!/usr/bin/env node
import { assertGate, emitGate, packageScripts, readText } from './gate-lib.js'
import { importDist, root } from './gate-lib.js'

const scripts = packageScripts()
const dagMod = await importDist('core/release/release-gate-dag.js')
const manifest = dagMod.loadReleaseGateManifest(root)
const releaseCount = dagMod.selectReleaseGatePreset(manifest, 'release').length
const incrementalCount = dagMod.selectReleaseGatePreset(manifest, 'incremental').length
const dynamicCount = releaseCount + incrementalCount
const confidenceOnlyCount = manifest.gates.filter((gate: any) => gate.preset.includes('confidence')).length
const dag = readText('src/core/release/release-gate-dag.ts')
const runner = readText('src/scripts/release-gate-dag-runner.ts')
for (const name of ['release:check:affected', 'release:check:full', 'release:check:fast', 'release:check:confidence']) {
  assertGate(Boolean(scripts[name]), `missing package script ${name}`)
}
assertGate(String(scripts['release:check']).includes('release:check:affected'), 'release:check must default to affected preset')
assertGate(
  ['release:check:affected', 'release:check:fast', 'release:check:confidence'].every((name) => String(scripts[name]).includes('release:ensure-build'))
    && String(scripts['release:check:confidence']).includes('--sla 5m'),
  'affected/fast/confidence checks must reuse a source-bound fresh build and keep the five-minute SLA'
)
assertGate(dag.includes('selectAffectedReleaseGates'), 'release DAG must use affected selector')
assertGate(dagMod.selectReleaseGatePreset(manifest, 'affected').length === dynamicCount, 'affected preset must select release and incremental gates before affected filtering')
assertGate(dagMod.selectReleaseGatePreset(manifest, 'fast').length === dynamicCount, 'fast preset must select release and incremental gates before affected filtering')
assertGate(
  dagMod.selectReleaseGatePreset(manifest, 'confidence').length === dynamicCount + confidenceOnlyCount,
  'confidence preset must retain release, incremental, and comprehensive confidence gates before affected filtering'
)
let unknownPresetBlocked = false
try {
  dagMod.selectReleaseGatePreset(manifest, 'unknown-preset')
} catch (error: any) {
  unknownPresetBlocked = /release_gate_preset_empty_or_unknown/.test(String(error?.message || error))
}
assertGate(unknownPresetBlocked, 'unknown or empty release presets must fail closed')
assertGate(runner.includes('--changed-since') && runner.includes('--full') && runner.includes('--sla'), 'release DAG runner must parse changed-since/full/sla')
emitGate('release:dynamic-presets', { presets: 4 })
