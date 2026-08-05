import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateReleaseParallelFullCoverage } from '../../release-parallel-full-coverage.js'
import { RELEASE_GATE_CONTRACT_IDS, releaseGateContractSnapshot } from '../release-gate-contract.js'
import { selectReleaseGateClosure, selectReleaseGatePreset } from '../release-gate-dag.js'

const INCREMENTAL_ONLY_GATE_IDS = [
  'test:code-index-agent-bridge-regression',
  'test:codex-runtime-recovery',
  'test:commands-regression',
  'test:core-root-regression',
  'test:dfix-ppt-gate',
  'test:mad-sks-regression',
  'test:menubar-doctor',
  'test:official-subagent-policy',
  'test:proof-stop-gate',
  'test:triwiki-voxel-integrity'
]

test('release manifest matches the independent full gate contract exactly', () => {
  const manifest = JSON.parse(fs.readFileSync('release-gates.v2.json', 'utf8'))
  const ids = manifest.gates
    .filter((gate: any) => Array.isArray(gate.preset) && gate.preset.includes('release'))
    .map((gate: any) => String(gate.id))
    .sort()
  assert.deepEqual(ids, RELEASE_GATE_CONTRACT_IDS)
  for (const id of [
    'package:published-contract',
    'publish:packlist-performance',
    'publish:runtime-script-closure',
    'release:metadata-current',
    'docs:truthfulness'
  ]) assert.ok(ids.includes(id), id)

  const contract = releaseGateContractSnapshot()
  assert.equal(contract.count, ids.length)
  assert.match(contract.sha256, /^[a-f0-9]{64}$/)
})

test('full release excludes duplicate canonical suites while incremental selectors retain them', () => {
  const manifest = JSON.parse(fs.readFileSync('release-gates.v2.json', 'utf8'))
  const releaseIds = selectReleaseGatePreset(manifest, 'release').map((gate) => gate.id).sort()
  const incrementalIds = selectReleaseGatePreset(manifest, 'incremental').map((gate) => gate.id).sort()
  const confidenceOnlyIds = manifest.gates
    .filter((gate: any) => Array.isArray(gate.preset) && gate.preset.includes('confidence'))
    .map((gate: any) => String(gate.id))
    .sort()
  assert.equal(releaseIds.length, 29)
  assert.deepEqual(incrementalIds, INCREMENTAL_ONLY_GATE_IDS)
  assert.ok(confidenceOnlyIds.length > 0)
  for (const id of INCREMENTAL_ONLY_GATE_IDS) assert.equal(releaseIds.includes(id), false, id)
  for (const id of confidenceOnlyIds) assert.equal(releaseIds.includes(id), false, id)

  const combinedIds = [...releaseIds, ...incrementalIds].sort()
  for (const preset of ['affected', 'fast']) {
    assert.deepEqual(selectReleaseGatePreset(manifest, preset).map((gate) => gate.id).sort(), combinedIds, preset)
  }
  assert.deepEqual(
    selectReleaseGatePreset(manifest, 'confidence').map((gate) => gate.id).sort(),
    [...combinedIds, ...confidenceOnlyIds].sort()
  )

  assert.deepEqual(
    selectReleaseGateClosure(manifest, ['test:commands-regression']).map((gate) => gate.id),
    ['test:commands-regression']
  )
})

test('release coverage rejects both removed and uncontracted gates', () => {
  const removed = evaluateReleaseParallelFullCoverage(RELEASE_GATE_CONTRACT_IDS.slice(1))
  assert.equal(removed.ok, false)
  assert.deepEqual(removed.missing_critical_gates, [RELEASE_GATE_CONTRACT_IDS[0]])

  const added = evaluateReleaseParallelFullCoverage([...RELEASE_GATE_CONTRACT_IDS, 'self-authorized:new-gate'])
  assert.equal(added.ok, false)
  assert.deepEqual(added.unexpected_release_gates, ['self-authorized:new-gate'])
})
