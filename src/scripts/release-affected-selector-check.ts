#!/usr/bin/env node
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const dag = await importDist('core/release/release-gate-dag.js')
const selectorMod = await importDist('core/release/release-gate-affected-selector.js')
const manifest = dag.loadReleaseGateManifest(root)
const gates = dag.selectReleaseGatePreset(manifest, 'affected')
const releaseIds = new Set<string>(dag.selectReleaseGatePreset(manifest, 'release').map((gate: any) => String(gate.id)))
const incrementalIds = new Set<string>(dag.selectReleaseGatePreset(manifest, 'incremental').map((gate: any) => String(gate.id)))
for (const id of ['test:commands-regression', 'test:menubar-doctor', 'test:core-root-regression']) {
  assertGate(!releaseIds.has(id), `${id} must stay outside the full release preset`, { release_ids: [...releaseIds] })
  assertGate(incrementalIds.has(id), `${id} must remain available to incremental selection`, { incremental_ids: [...incrementalIds] })
}
const selected = selectorMod.selectAffectedReleaseGates(root, manifest, gates, { changedSince: 'HEAD', preset: 'affected' })
const ids = new Set(selected.selection.selected_gate_ids)
for (const id of ['release:proof-truth', 'typecheck', 'schema:check']) {
  assertGate(ids.has(id), `affected selector must always keep ${id}`, selected.selection)
}

const codexCurrentOnly = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
  changedFiles: ['src/core/codex-control/codex-sdk-adapter.ts'],
  preset: 'affected'
})
const codexCurrentIds = new Set<string>(codexCurrentOnly.selection.selected_gate_ids.map(String))
for (const id of ['codex-control:all-pipelines', 'codex-control:event-stream-ledger', 'codex-sdk:all-pipelines', 'codex-sdk:integration-comprehensive']) {
  assertGate(codexCurrentIds.has(id), `codex current surface change must select ${id}`, codexCurrentOnly.selection)
}

const releaseScriptOnly = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
  changedFiles: ['src/scripts/release-full-parallelism-blackbox.ts'],
  preset: 'affected'
})
const releaseScriptIds = new Set<string>(releaseScriptOnly.selection.selected_gate_ids.map(String))
assertGate(releaseScriptIds.has('release:batch-runner-comprehensive'), 'release script change must select release gates', releaseScriptOnly.selection)
assertGate(![...releaseScriptIds].some((id) => id.startsWith('zellij:') || id.startsWith('naruto:') || id.startsWith('research:')), 'release script change must not expand to unrelated route gates', releaseScriptOnly.selection)
assertGate(releaseScriptIds.size < Math.ceil(gates.length / 3), 'release script change must stay affected-sized instead of near-full release', releaseScriptOnly.selection)

const schedulerScriptOnly = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
  changedFiles: ['src/scripts/scheduler-utilization-integral-check.ts'],
  preset: 'affected'
})
const schedulerScriptIds = new Set<string>(schedulerScriptOnly.selection.selected_gate_ids.map(String))
assertGate(schedulerScriptIds.has('scheduler:comprehensive'), 'scheduler script change must select scheduler gates', schedulerScriptOnly.selection)
assertGate(![...schedulerScriptIds].some((id) => id.startsWith('research:') || id.startsWith('zellij:')), 'scheduler script change must not expand to unrelated route gates', schedulerScriptOnly.selection)

const officialSubagentOnly = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
  changedFiles: ['src/core/subagents/subagent-evidence.ts'],
  preset: 'affected'
})
const officialSubagentIds = new Set<string>(officialSubagentOnly.selection.selected_gate_ids.map(String))
assertGate(officialSubagentIds.has('naruto:canonical-stop-gate'), 'official subagent source changes must select the canonical Naruto stop gate', officialSubagentOnly.selection)

for (const changedFile of [
  'src/core/codex-lb/codex-lb-tool-output-recovery.ts',
  'src/core/codex/codex-cli-update.ts',
  'src/core/codex-control/codex-reliability-shield.ts',
  'src/core/hooks-runtime.ts',
  'src/commands/codex.ts',
  'src/commands/codex-lb.ts',
  'src/commands/doctor.ts',
  'src/core/preflight/parallel-preflight-engine.ts'
]) {
  const selectedForRuntime = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
    changedFiles: [changedFile],
    preset: 'affected'
  })
  const runtimeIds = new Set<string>(selectedForRuntime.selection.selected_gate_ids.map(String))
  assertGate(runtimeIds.has('test:codex-runtime-recovery'), `Codex runtime change must select test:codex-runtime-recovery (${changedFile})`, selectedForRuntime.selection)
}

const doctorOnly = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
  changedFiles: ['src/commands/doctor.ts'],
  preset: 'affected'
})
const doctorIds = new Set<string>(doctorOnly.selection.selected_gate_ids.map(String))
assertGate(doctorIds.has('test:menubar-doctor'), 'Doctor changes must select test:menubar-doctor', doctorOnly.selection)

for (const changedFile of [
  'src/cli/router.ts',
  'src/cli/command-registry.ts',
  'src/bin/fast-inline.ts',
  'src/bin/sks-dispatch.ts'
]) {
  const selectedForCommands = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
    changedFiles: [changedFile],
    preset: 'affected'
  })
  const commandIds = new Set<string>(selectedForCommands.selection.selected_gate_ids.map(String))
  assertGate(commandIds.has('test:commands-regression'), `CLI implementation changes must select test:commands-regression (${changedFile})`, selectedForCommands.selection)
}

for (const changedFile of [
  'src/core/runtime/task-profile.ts',
  'src/core/routes.ts',
  'src/core/subagents/naruto-help-contract.ts',
  'src/core/commands/naruto-command.ts',
  'src/bin/fast-inline.ts',
  'test/blackbox/official-subagent-workflow-packed.test.mjs'
]) {
  const selectedForPolicy = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
    changedFiles: [changedFile],
    preset: 'affected'
  })
  const policyIds = new Set<string>(selectedForPolicy.selection.selected_gate_ids.map(String))
  assertGate(policyIds.has('test:official-subagent-policy'), `Task-profile, route, or help changes must select test:official-subagent-policy (${changedFile})`, selectedForPolicy.selection)
}

for (const changedFile of [
  'src/cli/command-manifest-lite.ts',
  'src/cli/command-registry.ts',
  'src/core/routes/dollar-manifest-lite.ts',
  'src/core/feature-registry.ts',
  'docs/feature-inventory.md',
  'test/unit/feature-registry.test.mjs'
]) {
  const selectedForFeatures = selectorMod.selectAffectedReleaseGates(root, manifest, gates, {
    changedFiles: [changedFile],
    preset: 'affected'
  })
  const featureIds = new Set<string>(selectedForFeatures.selection.selected_gate_ids.map(String))
  assertGate(featureIds.has('all-features:deep-completion'), `Command manifest, registry, inventory, or feature-test changes must select all-features:deep-completion (${changedFile})`, selectedForFeatures.selection)
}

emitGate('release:affected-selector', {
  selected: ids.size,
  skipped: selected.selection.skipped_gate_ids.length,
  release_script_selected: releaseScriptIds.size,
  scheduler_script_selected: schedulerScriptIds.size,
  official_subagent_selected: officialSubagentIds.size
})
