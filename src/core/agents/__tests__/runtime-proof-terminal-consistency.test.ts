import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRuntimeProofSummary } from '../runtime-proof-summary.js'

async function runtimeFixture(terminal: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-runtime-terminal-'))
  const missionId = terminal ? 'M-terminal' : 'M-active'
  const dir = path.join(root, '.sneakoscope', 'missions', missionId)
  const agents = path.join(dir, 'agents')
  await fs.mkdir(agents, { recursive: true })
  await fs.writeFile(path.join(agents, 'parallel-runtime-proof.json'), JSON.stringify({
    mission_id: missionId,
    passed: false,
    speedup_ratio: 0.5,
    blockers: ['speedup_ratio_below_target']
  }))
  await fs.writeFile(path.join(agents, 'agent-scheduler-state.json'), JSON.stringify({ target_active_slots: 1 }))
  if (terminal) {
    await fs.writeFile(path.join(dir, 'stop-gate.json'), JSON.stringify({
      schema: 'sks.stop-gate.v1',
      mission_id: missionId,
      passed: true,
      terminal: true,
      terminal_state: 'completed',
      blockers: []
    }))
  }
  return { root, missionId }
}

test('terminal Naruto proof honors the canonical stop gate without retaining a superseded speedup blocker', async () => {
  const fixture = await runtimeFixture(true)
  const summary = await buildRuntimeProofSummary(fixture.root, fixture.missionId)
  assert.equal(summary.ok, true)
  assert.equal(summary.terminal_proof.accepted, true)
  assert.equal(summary.parallel.proof_passed, false)
  assert.ok(!summary.blockers.includes('speedup_ratio_below_target'))
})

test('active Naruto proof keeps the speedup blocker', async () => {
  const fixture = await runtimeFixture(false)
  const summary = await buildRuntimeProofSummary(fixture.root, fixture.missionId)
  assert.equal(summary.ok, false)
  assert.equal(summary.terminal_proof.accepted, false)
  assert.ok(summary.blockers.includes('speedup_ratio_below_target'))
})
