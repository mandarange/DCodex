// First import: the subagent-skill-availability guard ledger resolves
// $HOME/.sneakoscope and would otherwise pollute the operator's real home.
import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evaluateHookPayload, refreshOfficialSubagentCompletionArtifacts } from '../../hooks-runtime.js'
import { sha256 } from '../../fsx.js'
import { withFileLock } from '../../locks/file-lock.js'
import { loadStateForSession, setCurrent } from '../../mission.js'
import { validateRouteCompletionProof } from '../../proof/route-proof-gate.js'
import { buildSsotGuard } from '../../safety/ssot-guard.js'
import {
  OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION,
  prepareOfficialSubagentMission
} from '../../subagents/official-subagent-preparation.js'
import {
  createSubagentWaveLifecycle,
  type SubagentCountPolicy
} from '../../subagents/wave-lifecycle.js'
import { buildNarutoProofProjection } from '../../subagents/naruto-proof-projection.js'
import { installGlobalSkills } from '../../init/skills.js'
import { checkStopGate } from '../../stop-gate/stop-gate-check.js'
import {
  HOST_CAPABILITY_HOOK_RUNTIME_FILENAME,
  createHostCapabilityHookRuntimeBinding,
  inspectHostCapabilityRuntime,
  requestHostCapabilities
} from '../../agent-bridge/host-capability-runtime.js'

test('valid current-run Naruto proof is full, byte-stable, and invalidates reflection once', async () => {
  const fixture = await createNarutoFixture()
  try {
    await fixture.refresh()
    const proofFile = path.join(fixture.dir, 'completion-proof.json')
    const firstProofBytes = await fsp.readFile(proofFile, 'utf8')
    const proof = JSON.parse(firstProofBytes)
    const [evidenceIndex, contract, trust] = await Promise.all([
      readJson(path.join(fixture.dir, 'evidence-index.json')),
      readJson(path.join(fixture.dir, 'route-completion-contract.json')),
      readJson(path.join(fixture.dir, 'trust-report.json'))
    ])

    assert.equal(proof.route, '$sks-naruto')
    assert.equal(proof.evidence.route_gate.workflow_run_id, fixture.runId)
    assert.equal(proof.evidence.route_gate.target_subagents, 4)
    assert.equal(proof.evidence.route_contract, `.sneakoscope/missions/${fixture.missionId}/route-completion-contract.json`)
    assert.equal(proof.evidence.trust_report, `.sneakoscope/missions/${fixture.missionId}/trust-report.json`)
    assert.equal(evidenceIndex.schema, 'sks.evidence-index.v1')
    assert.equal(contract.schema, 'sks.route-completion-contract.v1')
    assert.equal(trust.schema, 'sks.trust-report.v1')

    const firstState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.equal(firstState.reflection_invalidation_required, true)
    assert.equal(firstState.reflection_invalidation_reason, 'naruto_terminal_proof_committed')
    assert.equal(firstState.reflection_invalidated_for_workflow_run_id, fixture.runId)
    assert.match(String(firstState.reflection_invalidated_at || ''), /^2026-/)

    await fixture.refresh()
    assert.equal(await fsp.readFile(proofFile, 'utf8'), firstProofBytes)
    const retriedState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.equal(retriedState.reflection_invalidated_at, firstState.reflection_invalidated_at)
    assert.equal(retriedState.reflection_invalidated_for_workflow_run_id, fixture.runId)
  } finally {
    await fixture.cleanup()
  }
})

test('newer same-run terminal proof resolves a stale official-subagent compliance hard blocker', async () => {
  const fixture = await createNarutoFixture()
  try {
    await writeJson(path.join(fixture.dir, 'hard-blocker.json'), {
      schema: 'sks.hard-blocker.v1',
      passed: false,
      status: 'hard_blocked',
      created_at: '2026-07-19T02:00:00.000Z',
      reason: 'compliance_loop_guard_tripped',
      route: '$Naruto',
      gate: 'official-subagent-evidence',
      evidence: ['official evidence was incomplete before the parent resumed']
    })
    await writeJson(path.join(fixture.dir, 'compliance-loop-guard.json'), {
      schema_version: 1,
      updated_at: '2026-07-19T02:00:00.000Z',
      mission_id: fixture.missionId,
      route: '$Naruto',
      gate: 'official-subagent-evidence',
      repeat_count: 3,
      limit: 3,
      tripped: true,
      missing: ['parent_summary_missing']
    })

    await fixture.refresh()

    await assert.rejects(fsp.access(path.join(fixture.dir, 'hard-blocker.json')))
    await assert.rejects(fsp.access(path.join(fixture.dir, 'compliance-loop-guard.json')))
    const resolvedFile = path.join(fixture.dir, 'hard-blocker.resolved.json')
    const resolvedBytes = await fsp.readFile(resolvedFile, 'utf8')
    const resolved = JSON.parse(resolvedBytes)
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.passed, true)
    assert.equal(resolved.workflow_run_id, fixture.runId)
    assert.equal(resolved.original_hard_blocker.gate, 'official-subagent-evidence')
    assert.match(resolved.hard_blocker_sha256, /^sha256:[a-f0-9]{64}$/)
    assert.match(resolved.compliance_loop_guard_sha256, /^sha256:[a-f0-9]{64}$/)
    assert.equal((await checkStopGate({
      root: fixture.root,
      route: 'Naruto',
      missionId: fixture.missionId,
      allowLatestFallback: false
    })).action, 'allow_stop')

    await fixture.refresh()
    assert.equal(await fsp.readFile(resolvedFile, 'utf8'), resolvedBytes)
  } finally {
    await fixture.cleanup()
  }
})

test('terminal Naruto proof preserves unrelated hard blockers', async () => {
  const fixture = await createNarutoFixture()
  try {
    await writeJson(path.join(fixture.dir, 'hard-blocker.json'), {
      schema: 'sks.hard-blocker.v1',
      passed: false,
      status: 'hard_blocked',
      created_at: '2026-07-19T02:00:00.000Z',
      reason: 'managed_config_requires_human_remedy',
      route: '$Naruto',
      gate: 'managed-config',
      evidence: ['manual repair is still required']
    })
    await writeJson(path.join(fixture.dir, 'compliance-loop-guard.json'), {
      schema_version: 1,
      updated_at: '2026-07-19T02:00:00.000Z',
      mission_id: fixture.missionId,
      route: '$Naruto',
      gate: 'managed-config',
      repeat_count: 3,
      limit: 3,
      tripped: true,
      missing: ['manual_repair']
    })

    await fixture.refresh()

    assert.equal((await readJson(path.join(fixture.dir, 'hard-blocker.json'))).reason, 'managed_config_requires_human_remedy')
    await fsp.access(path.join(fixture.dir, 'compliance-loop-guard.json'))
    await assert.rejects(fsp.access(path.join(fixture.dir, 'hard-blocker.resolved.json')))
    assert.equal((await checkStopGate({
      root: fixture.root,
      route: 'Naruto',
      missionId: fixture.missionId,
      allowLatestFallback: false
    })).action, 'hard_blocked')
  } finally {
    await fixture.cleanup()
  }
})

test('later mission compliance events do not stale the sealed current-run Naruto terminal bundle', async () => {
  const fixture = await createNarutoFixture()
  const terminalArtifacts = [
    'subagent-plan.json',
    'subagent-events.jsonl',
    'subagent-parent-summary.json',
    'subagent-evidence.json',
    'naruto-summary.json',
    'naruto-gate.json'
  ] as const
  try {
    await fixture.refresh()
    const initialValidation = await validateRouteCompletionProof(fixture.root, {
      missionId: fixture.missionId,
      route: '$Naruto',
      state: fixture.state
    })
    assert.equal(initialValidation.ok, true)
    assert.equal(initialValidation.proof.evidence.route_gate.workflow_run_id, fixture.runId)

    const terminalStats = await Promise.all(terminalArtifacts.map((file) => fsp.stat(path.join(fixture.dir, file))))
    const terminalBytes = await Promise.all(terminalArtifacts.map((file) => fsp.readFile(path.join(fixture.dir, file))))
    const newestTerminalMtime = Math.max(...terminalStats.map((stat) => stat.mtimeMs))
    await waitFor(async () => Date.now() > newestTerminalMtime + 5)
    const complianceEvent = {
      ts: new Date().toISOString(),
      type: 'pipeline.compliance_loop_guard',
      gate: 'reflection',
      repeat_count: 1,
      limit: 3,
      tripped: false,
      missing: []
    }
    await fsp.appendFile(path.join(fixture.dir, 'events.jsonl'), `${JSON.stringify(complianceEvent)}\n`)
    const complianceEventTime = Date.parse(complianceEvent.ts)
    for (const stat of terminalStats) assert.ok(stat.mtimeMs < complianceEventTime)

    await Promise.all([
      'completion-proof.json',
      'completion-proof.md',
      'evidence-index.json',
      'route-completion-contract.json',
      'trust-report.json'
    ].map((file) => fsp.rm(path.join(fixture.dir, file), { force: true })))
    await fixture.refresh()

    const refreshedTerminalStats = await Promise.all(terminalArtifacts.map((file) => fsp.stat(path.join(fixture.dir, file))))
    const refreshedTerminalBytes = await Promise.all(terminalArtifacts.map((file) => fsp.readFile(path.join(fixture.dir, file))))
    for (const [index, file] of terminalArtifacts.entries()) {
      assert.equal(refreshedTerminalStats[index]!.mtimeMs, terminalStats[index]!.mtimeMs, `${file}:mtime`)
      assert.deepEqual(refreshedTerminalBytes[index], terminalBytes[index], `${file}:bytes`)
    }

    const [evidenceIndex, trust, validation] = await Promise.all([
      readJson(path.join(fixture.dir, 'evidence-index.json')),
      readJson(path.join(fixture.dir, 'trust-report.json')),
      validateRouteCompletionProof(fixture.root, {
        missionId: fixture.missionId,
        route: '$Naruto',
        state: fixture.state
      })
    ])
    assert.equal(evidenceIndex.ok, true)
    assert.equal(evidenceIndex.status, 'verified')
    assert.deepEqual(evidenceIndex.issues, [])
    for (const file of terminalArtifacts) {
      const relativePath = `.sneakoscope/missions/${fixture.missionId}/${file}`
      const records = evidenceIndex.records.filter((record: any) => record.path === relativePath)
      assert.equal(records.length, 1, relativePath)
      assert.equal(records[0].source, 'real', relativePath)
      assert.equal(records[0].freshness, 'fresh', relativePath)
      assert.equal(records[0].trust, 'high', relativePath)
      assert.deepEqual(records[0].issues, [], relativePath)
    }
    assert.equal(trust.ok, true)
    assert.equal(trust.status, 'verified')
    assert.deepEqual(trust.issues, [])
    assert.deepEqual(trust.blockers, [])
    assert.equal(validation.ok, true)
    assert.equal(validation.status, 'verified')
    assert.equal(validation.proof.evidence.route_gate.workflow_run_id, fixture.runId)
  } finally {
    await fixture.cleanup()
  }
})

test('missing, malformed, and wrong-run Naruto proofs are retried and repaired', async () => {
  const fixture = await createNarutoFixture()
  try {
    await fixture.refresh()
    const proofFile = path.join(fixture.dir, 'completion-proof.json')

    await fsp.rm(proofFile)
    await fixture.refresh()
    assert.equal((await readJson(proofFile)).evidence.route_gate.workflow_run_id, fixture.runId)

    await fsp.writeFile(proofFile, '{not-json}\n')
    await fixture.refresh()
    assert.equal((await readJson(proofFile)).evidence.route_gate.workflow_run_id, fixture.runId)

    const wrongRunProof = await readJson(proofFile)
    wrongRunProof.evidence.route_gate.workflow_run_id = 'stale-run'
    await writeJson(proofFile, wrongRunProof)
    const rejected = await validateRouteCompletionProof(fixture.root, {
      missionId: fixture.missionId,
      route: '$Naruto',
      state: fixture.state
    })
    assert.equal(rejected.ok, false)
    assert.ok(rejected.issues.includes('official_subagent_workflow_run_id_mismatch'))

    await fixture.refresh()
    const repaired = await validateRouteCompletionProof(fixture.root, {
      missionId: fixture.missionId,
      route: '$Naruto',
      state: fixture.state
    })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.proof.evidence.route_gate.workflow_run_id, fixture.runId)
  } finally {
    await fixture.cleanup()
  }
})

test('a failed first Naruto finalization retries after the proof path becomes writable', async () => {
  const fixture = await createNarutoFixture()
  const proofFile = path.join(fixture.dir, 'completion-proof.json')
  try {
    await fsp.mkdir(proofFile)
    await fixture.refresh().catch(() => null)
    assert.equal((await fsp.stat(proofFile)).isDirectory(), true)
    const failedState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.notEqual(failedState.reflection_invalidated_for_workflow_run_id, fixture.runId)

    await fsp.rm(proofFile, { recursive: true })
    await fixture.refresh()
    assert.equal((await fsp.stat(proofFile)).isFile(), true)
    assert.equal((await readJson(proofFile)).evidence.route_gate.workflow_run_id, fixture.runId)
    const recoveredState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.equal(recoveredState.reflection_invalidated_for_workflow_run_id, fixture.runId)
  } finally {
    await fixture.cleanup()
  }
})

test('terminal Naruto commit shares the event lock and rejects a later terminal event', async () => {
  const fixture = await createNarutoFixture()
  let terminalRefresh: Promise<unknown> | null = null
  try {
    await withFileLock({
      lockPath: path.join(fixture.dir, '.subagent-evidence.lock'),
      timeoutMs: 5_000,
      staleMs: 60_000
    }, async () => {
      terminalRefresh = fixture.refresh()
      await new Promise((resolve) => setTimeout(resolve, 75))
      assert.equal((await readJson(path.join(fixture.dir, 'naruto-gate.json'))).passed, false)
    })
    assert.ok(terminalRefresh)
    await terminalRefresh

    const gate = await readJson(path.join(fixture.dir, 'naruto-gate.json'))
    assert.equal(gate.passed, true)
    assert.equal(gate.terminal, true)
    const eventFile = path.join(fixture.dir, 'subagent-events.jsonl')
    const terminalEvents = await fsp.readFile(eventFile, 'utf8')
    await evaluateHookPayload('subagent-stop', {
      conversation_id: fixture.sessionKey,
      session_id: fixture.sessionKey,
      turn_id: 'late-terminal-event',
      hook_event_name: 'SubagentStop',
      agent_id: 'late-thread',
      agent_type: 'worker',
      model: 'gpt-5.6-luna',
      last_assistant_message: 'Late result.',
      stop_hook_active: false
    }, { root: fixture.root, state: fixture.state })
    assert.equal(await fsp.readFile(eventFile, 'utf8'), terminalEvents)
  } finally {
    await fixture.cleanup()
  }
})

test('exact mode keeps its sealed lifecycle target and blocks requested-target mutation', async () => {
  const fixture = await createNarutoFixture({
    countPolicy: 'exact',
    requestedSubagents: 4,
    initialTarget: 2,
    effectiveTarget: 2,
    threadIds: ['thread-a', 'thread-b']
  })
  try {
    await fixture.refresh()
    const [plan, evidence, gate] = await Promise.all([
      readJson(path.join(fixture.dir, 'subagent-plan.json')),
      readJson(path.join(fixture.dir, 'subagent-evidence.json')),
      readJson(path.join(fixture.dir, 'naruto-gate.json'))
    ])
    assert.equal(plan.wave_lifecycle.target_subagents, 2)
    assert.equal(plan.wave_lifecycle.target_change_rejected, true)
    assert.equal(evidence.count_policy, 'exact')
    assert.equal(evidence.target_subagents, 2)
    assert.ok(evidence.blockers.includes('subagent_target_change_rejected'))
    assert.equal(gate.passed, false)
    assert.ok(gate.blockers.includes('subagent_target_change_rejected'))
    await assert.rejects(fsp.access(path.join(fixture.dir, 'completion-proof.json')))
  } finally {
    await fixture.cleanup()
  }
})

test('automatic over-cap starts block only at the cumulative ceiling while max_threads stays concurrent capacity', async () => {
  const overCeiling = await createNarutoFixture({
    fanoutAutomaticCeiling: 3,
    maxThreads: 12
  })
  try {
    await overCeiling.refresh()
    const [evidence, gate] = await Promise.all([
      readJson(path.join(overCeiling.dir, 'subagent-evidence.json')),
      readJson(path.join(overCeiling.dir, 'naruto-gate.json'))
    ])
    assert.equal(evidence.target_subagents, 3)
    assert.ok(evidence.blockers.includes('subagent_automatic_fanout_cap_exceeded:4/3'))
    assert.equal(gate.passed, false)
    assert.ok(gate.blockers.includes('subagent_automatic_fanout_cap_exceeded:4/3'))
    await assert.rejects(fsp.access(path.join(overCeiling.dir, 'completion-proof.json')))
  } finally {
    await overCeiling.cleanup()
  }

  const laterWaves = await createNarutoFixture({
    fanoutAutomaticCeiling: 10,
    maxThreads: 3
  })
  try {
    await laterWaves.refresh()
    const [evidence, gate] = await Promise.all([
      readJson(path.join(laterWaves.dir, 'subagent-evidence.json')),
      readJson(path.join(laterWaves.dir, 'naruto-gate.json'))
    ])
    assert.equal(evidence.target_subagents, 4)
    assert.equal(evidence.blockers.some((item: string) => item.startsWith('subagent_automatic_fanout_cap_exceeded:')), false)
    assert.equal(gate.passed, true)
    await fsp.access(path.join(laterWaves.dir, 'completion-proof.json'))
  } finally {
    await laterWaves.cleanup()
  }
})

test('hook events reject an explicit stale run and bind a runless Stop to its current-run Start', async () => {
  const fixture = await createNarutoFixture({
    requestedSubagents: 1,
    initialTarget: 1,
    effectiveTarget: 1,
    threadIds: []
  })
  try {
    await evaluateHookPayload('subagent-start', {
      conversation_id: fixture.sessionKey,
      session_id: fixture.sessionKey,
      turn_id: 'stale-start',
      hook_event_name: 'SubagentStart',
      workflow_run_id: 'stale-run',
      agent_id: 'reused-thread',
      agent_type: 'worker',
      model: 'gpt-5.6-luna'
    }, { root: fixture.root, state: fixture.state })
    await evaluateHookPayload('subagent-stop', {
      conversation_id: fixture.sessionKey,
      session_id: fixture.sessionKey,
      turn_id: 'orphan-stale-stop',
      hook_event_name: 'SubagentStop',
      agent_id: 'reused-thread',
      agent_type: 'worker',
      model: 'gpt-5.6-luna',
      last_assistant_message: 'Delayed stale-run result.',
      stop_hook_active: false
    }, { root: fixture.root, state: fixture.state })
    await evaluateHookPayload('subagent-start', {
      conversation_id: fixture.sessionKey,
      session_id: fixture.sessionKey,
      turn_id: 'current-start',
      hook_event_name: 'SubagentStart',
      workflow_run_id: fixture.runId,
      agent_id: 'current-thread',
      agent_type: 'worker',
      model: 'gpt-5.6-luna'
    }, { root: fixture.root, state: fixture.state })
    await evaluateHookPayload('subagent-stop', {
      conversation_id: fixture.sessionKey,
      session_id: fixture.sessionKey,
      turn_id: 'runless-stop',
      hook_event_name: 'SubagentStop',
      agent_id: 'current-thread',
      agent_type: 'worker',
      model: 'gpt-5.6-luna',
      last_assistant_message: 'Current-run result.',
      stop_hook_active: false
    }, { root: fixture.root, state: fixture.state })

    const events = await readJsonl(path.join(fixture.dir, 'subagent-events.jsonl'))
    assert.equal(events.length, 2)
    assert.equal(events[0].run_id, fixture.runId)
    assert.equal(events[1].run_id, fixture.runId)
  } finally {
    await fixture.cleanup()
  }
})

test('a terminal gate with a partial stale bundle rebuilds summary and evidence', async () => {
  const fixture = await createNarutoFixture()
  try {
    await fixture.refresh()
    const evidenceFile = path.join(fixture.dir, 'subagent-evidence.json')
    const staleEvidence = await readJson(evidenceFile)
    staleEvidence.run_id = 'stale-run'
    staleEvidence.ok = false
    staleEvidence.status = 'incomplete'
    staleEvidence.blockers = ['stale_fixture']
    await writeJson(evidenceFile, staleEvidence)
    await fsp.rm(path.join(fixture.dir, 'naruto-summary.json'))

    await fixture.refresh()
    const [rebuiltEvidence, rebuiltSummary] = await Promise.all([
      readJson(evidenceFile),
      readJson(path.join(fixture.dir, 'naruto-summary.json'))
    ])
    assert.equal(rebuiltEvidence.run_id, fixture.runId)
    assert.equal(rebuiltEvidence.ok, true)
    assert.equal(rebuiltSummary.workflow_run_id, fixture.runId)
    assert.equal(rebuiltSummary.status, 'completed')
    assert.equal(rebuiltSummary.ok, true)
  } finally {
    await fixture.cleanup()
  }
})

test('repairing proof after reflection changes the digest and invalidates the same run again', async () => {
  const fixture = await createNarutoFixture()
  try {
    await fixture.refresh()
    const proofFile = path.join(fixture.dir, 'completion-proof.json')
    const firstProofBytes = await fsp.readFile(proofFile, 'utf8')
    const firstState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    const firstDigest = firstState.reflection_invalidated_for_proof_digest
    assert.ok(typeof firstDigest === 'string' && firstDigest.length >= 32)

    await setCurrent(fixture.root, {
      reflection_invalidation_required: false,
      reflection_revalidated_at: new Date().toISOString()
    }, { sessionKey: fixture.sessionKey })
    await fsp.rm(proofFile)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await fixture.refresh()

    const repairedProofBytes = await fsp.readFile(proofFile, 'utf8')
    const repairedState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.notEqual(repairedProofBytes, firstProofBytes)
    assert.equal(repairedState.reflection_invalidation_required, true)
    assert.equal(repairedState.reflection_invalidated_for_workflow_run_id, fixture.runId)
    assert.ok(typeof repairedState.reflection_invalidated_for_proof_digest === 'string')
    assert.notEqual(repairedState.reflection_invalidated_for_proof_digest, firstDigest)
    assert.notEqual(repairedState.reflection_invalidated_at, firstState.reflection_invalidated_at)
  } finally {
    await fixture.cleanup()
  }
})

test('stale M1 finalization cannot reactivate M1 or contaminate current M2 session state', async () => {
  const fixture = await createNarutoFixture()
  const m2MissionId = `M-20260719-130000-${Math.random().toString(16).slice(2, 10)}`
  const m2Dir = path.join(fixture.root, '.sneakoscope', 'missions', m2MissionId)
  let staleRefresh: Promise<unknown> | null = null
  try {
    await fsp.mkdir(m2Dir, { recursive: true })
    await writeJson(path.join(m2Dir, 'mission.json'), {
      id: m2MissionId,
      mode: 'Work',
      prompt: 'new current mission',
      created_at: '2026-07-19T04:00:00.000Z'
    })

    await withFileLock({
      lockPath: path.join(fixture.dir, '.naruto-finalize.lock'),
      timeoutMs: 5_000,
      staleMs: 30_000
    }, async () => {
      staleRefresh = fixture.refresh()
      await waitFor(async () => (await readJson(path.join(fixture.dir, 'naruto-gate.json'))).terminal === true)
      await setCurrent(fixture.root, {
        mission_id: m2MissionId,
        mode: 'WORK',
        route: 'Work',
        route_command: '$Work',
        phase: 'IMPLEMENT',
        reflection_invalidation_required: false,
        reflection_invalidated_at: 'm2-reflection-sentinel',
        reflection_invalidation_reason: 'm2-stable',
        reflection_invalidated_for_workflow_run_id: 'm2-run',
        reflection_invalidated_for_proof_digest: 'm2-digest',
        subagents_spawned: false,
        subagents_reported: false,
        subagents_verified: false,
        subagent_evidence_file: 'm2-evidence.json',
        parent_summary_present: false
      }, { replace: true, sessionKey: fixture.sessionKey })
    })
    assert.ok(staleRefresh)
    await staleRefresh

    const current: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.equal(current.mission_id, m2MissionId)
    assert.equal(current.mode, 'WORK')
    assert.equal(current.phase, 'IMPLEMENT')
    assert.equal(current.reflection_invalidation_required, false)
    assert.equal(current.reflection_invalidated_at, 'm2-reflection-sentinel')
    assert.equal(current.reflection_invalidation_reason, 'm2-stable')
    assert.equal(current.reflection_invalidated_for_workflow_run_id, 'm2-run')
    assert.equal(current.reflection_invalidated_for_proof_digest, 'm2-digest')
    assert.equal(current.subagents_spawned, false)
    assert.equal(current.subagents_reported, false)
    assert.equal(current.subagents_verified, false)
    assert.equal(current.subagent_evidence_file, 'm2-evidence.json')
    assert.equal(current.parent_summary_present, false)
    assert.equal((await readJson(path.join(fixture.dir, 'completion-proof.json'))).mission_id, fixture.missionId)
    await assert.rejects(fsp.access(path.join(m2Dir, 'completion-proof.json')))
  } finally {
    await fixture.cleanup()
  }
})

test('delayed R1 finalization is a no-op after R2 prepares in the same mission', async () => {
  const fixture = await createNarutoFixture()
  const r2RunId = `${fixture.runId}-r2`
  let staleRefresh: Promise<unknown> | null = null
  try {
    await withFileLock({
      lockPath: path.join(fixture.dir, '.naruto-finalize.lock'),
      timeoutMs: 5_000,
      staleMs: 30_000
    }, async () => {
      staleRefresh = fixture.refresh()
      await waitFor(async () => (await readJson(path.join(fixture.dir, 'naruto-gate.json'))).terminal === true)
      await prepareOfficialSubagentMission({
        root: fixture.root,
        dir: fixture.dir,
        missionId: fixture.missionId,
        goal: 'fresh R2 task',
        route: '$Naruto',
        sessionScope: fixture.sessionKey,
        requestedSubagents: 1,
        requestedSubagentsExplicit: true,
        workflowRunId: r2RunId,
        mode: 'naruto',
        preparationOnly: true,
        statePatch: ({ budget, workflowRunId }) => ({
          mission_id: fixture.missionId,
          official_subagent_run_id: workflowRunId,
          phase: 'NARUTO_DELEGATION_CONTEXT_READY',
          requested_subagents: budget.requestedSubagents,
          target_subagents: budget.requestedSubagents,
          subagents_spawned: false,
          subagents_reported: false,
          subagents_verified: false,
          parent_summary_present: false,
          reflection_invalidation_required: false,
          reflection_invalidated_at: null,
          reflection_invalidation_reason: null,
          reflection_invalidated_for_workflow_run_id: null,
          reflection_invalidated_for_proof_digest: null
        })
      })
    })
    assert.ok(staleRefresh)
    await staleRefresh

    const [plan, evidence, summary, gate, sessionState] = await Promise.all([
      readJson(path.join(fixture.dir, 'subagent-plan.json')),
      readJson(path.join(fixture.dir, 'subagent-evidence.json')),
      readJson(path.join(fixture.dir, 'naruto-summary.json')),
      readJson(path.join(fixture.dir, 'naruto-gate.json')),
      loadStateForSession(fixture.root, fixture.sessionKey)
    ])
    assert.equal(plan.workflow_run_id, r2RunId)
    assert.equal(evidence.run_id, r2RunId)
    assert.equal(evidence.preparation_only, true)
    assert.equal(summary.workflow_run_id, r2RunId)
    assert.equal(summary.status, 'delegation_context_ready')
    assert.equal(gate.workflow_run_id, r2RunId)
    assert.equal(gate.passed, false)
    assert.equal(gate.terminal, false)
    assert.equal(sessionState.mission_id, fixture.missionId)
    assert.equal(sessionState.official_subagent_run_id, r2RunId)
    assert.equal(sessionState.phase, 'NARUTO_DELEGATION_CONTEXT_READY')
    assert.equal(sessionState.reflection_invalidation_required, false)
    assert.equal(sessionState.reflection_invalidated_for_workflow_run_id, null)
    assert.equal(await fsp.readFile(path.join(fixture.dir, 'subagent-events.jsonl'), 'utf8'), '')
    await assert.rejects(fsp.access(path.join(fixture.dir, 'subagent-parent-summary.json')))
    await assert.rejects(fsp.access(path.join(fixture.dir, 'completion-proof.json')))
    await assert.rejects(fsp.access(path.join(fixture.dir, 'completion-proof.md')))
  } finally {
    await fixture.cleanup()
  }
})

test('interrupted same-mission preparation recovers its committed bundle and clears its transaction marker', async () => {
  const fixture = await createNarutoFixture()
  const markerFile = path.join(fixture.dir, OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION)
  const r2RunId = `${fixture.runId}-crash-r2`
  const preparationInput = (workflowRunId: string, failureInjection?:
    | 'after_marker_before_artifact'
    | 'after_cleanup_and_evidence_promotion_before_plan'
    | 'after_artifact_commit_before_state'
    | 'after_state_commit_before_marker_clear') => ({
    root: fixture.root,
    dir: fixture.dir,
    missionId: fixture.missionId,
    goal: `recover ${workflowRunId}`,
    route: '$Naruto',
    sessionScope: fixture.sessionKey,
    requestedSubagents: 1,
    requestedSubagentsExplicit: true,
    workflowRunId,
    mode: 'naruto' as const,
    preparationOnly: true,
    ...(failureInjection ? { failureInjection } : {}),
    statePatch: ({ budget, workflowRunId: targetRunId }: any) => ({
      mission_id: fixture.missionId,
      official_subagent_run_id: targetRunId,
      phase: 'NARUTO_DELEGATION_CONTEXT_READY',
      requested_subagents: budget.requestedSubagents,
      target_subagents: budget.requestedSubagents,
      subagents_verified: false,
      reflection_invalidation_required: false,
      reflection_invalidated_for_workflow_run_id: null,
      reflection_invalidated_for_proof_digest: null
    })
  })
  try {
    await assert.rejects(
      prepareOfficialSubagentMission(preparationInput(r2RunId, 'after_artifact_commit_before_state')),
      /after_artifact_commit_before_state/
    )
    const interruptedMarker = await readJson(markerFile)
    const interruptedPlan = await readJson(path.join(fixture.dir, 'subagent-plan.json'))
    const interruptedState: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    assert.equal(interruptedPlan.workflow_run_id, r2RunId)
    assert.equal(interruptedState.official_subagent_run_id, fixture.runId)
    assert.equal(interruptedMarker.previous_workflow_run_id, fixture.runId)
    assert.equal(interruptedMarker.target_workflow_run_id, r2RunId)

    const recovered = await prepareOfficialSubagentMission(preparationInput(r2RunId))
    const [plan, evidence, summary, gate, recoveredState] = await Promise.all([
      readJson(path.join(fixture.dir, 'subagent-plan.json')),
      readJson(path.join(fixture.dir, 'subagent-evidence.json')),
      readJson(path.join(fixture.dir, 'naruto-summary.json')),
      readJson(path.join(fixture.dir, 'naruto-gate.json')),
      loadStateForSession(fixture.root, fixture.sessionKey)
    ])
    assert.equal(recovered.workflowRunId, r2RunId)
    assert.equal(recovered.evidence.run_id, r2RunId)
    assert.equal(plan.workflow_run_id, r2RunId)
    assert.equal(evidence.run_id, r2RunId)
    assert.equal(summary.workflow_run_id, r2RunId)
    assert.equal(gate.workflow_run_id, r2RunId)
    assert.equal(recoveredState.official_subagent_run_id, r2RunId)
    await assert.rejects(fsp.access(markerFile))

    await assert.rejects(
      prepareOfficialSubagentMission(preparationInput(r2RunId, 'after_state_commit_before_marker_clear')),
      /after_state_commit_before_marker_clear/
    )
    const idempotent = await prepareOfficialSubagentMission(preparationInput(r2RunId))
    assert.equal(idempotent.workflowRunId, r2RunId)
    assert.equal((await loadStateForSession(fixture.root, fixture.sessionKey)).official_subagent_run_id, r2RunId)
    await assert.rejects(fsp.access(markerFile))

    const r3RunId = `${fixture.runId}-preplan-r3`
    await assert.rejects(
      prepareOfficialSubagentMission(preparationInput(r3RunId, 'after_cleanup_and_evidence_promotion_before_plan')),
      /after_cleanup_and_evidence_promotion_before_plan/
    )
    assert.equal((await readJson(path.join(fixture.dir, 'subagent-plan.json'))).workflow_run_id, r2RunId)
    assert.equal((await loadStateForSession(fixture.root, fixture.sessionKey)).official_subagent_run_id, r2RunId)
    const eventsBeforeHook = await fsp.readFile(path.join(fixture.dir, 'subagent-events.jsonl'), 'utf8')
    const evidenceBeforeHook = await fsp.readFile(path.join(fixture.dir, 'subagent-evidence.json'), 'utf8')
    const r2State: any = await loadStateForSession(fixture.root, fixture.sessionKey)
    await evaluateHookPayload('subagent-start', {
      conversation_id: fixture.sessionKey,
      session_id: fixture.sessionKey,
      turn_id: 'blocked-during-preparation',
      hook_event_name: 'SubagentStart',
      workflow_run_id: r2RunId,
      agent_id: 'must-not-record',
      agent_type: 'worker',
      model: 'gpt-5.6-luna'
    }, { root: fixture.root, state: r2State })
    await refreshOfficialSubagentCompletionArtifacts(fixture.root, r2State, fixture.parentSummary, fixture.sessionKey)
    assert.equal(await fsp.readFile(path.join(fixture.dir, 'subagent-events.jsonl'), 'utf8'), eventsBeforeHook)
    assert.equal(await fsp.readFile(path.join(fixture.dir, 'subagent-evidence.json'), 'utf8'), evidenceBeforeHook)
    const resumed = await prepareOfficialSubagentMission(preparationInput(r3RunId))
    assert.equal(resumed.workflowRunId, r3RunId)
    assert.equal((await readJson(path.join(fixture.dir, 'subagent-plan.json'))).workflow_run_id, r3RunId)
    assert.equal((await loadStateForSession(fixture.root, fixture.sessionKey)).official_subagent_run_id, r3RunId)
    await assert.rejects(fsp.access(markerFile))

    const r4RunId = `${fixture.runId}-marker-only-r4`
    await assert.rejects(
      prepareOfficialSubagentMission(preparationInput(r4RunId, 'after_marker_before_artifact')),
      /after_marker_before_artifact/
    )
    assert.equal((await readJson(path.join(fixture.dir, 'subagent-plan.json'))).workflow_run_id, r3RunId)
    assert.equal((await loadStateForSession(fixture.root, fixture.sessionKey)).official_subagent_run_id, r3RunId)
    const restarted = await prepareOfficialSubagentMission(preparationInput(r4RunId))
    assert.equal(restarted.workflowRunId, r4RunId)
    assert.equal((await readJson(path.join(fixture.dir, 'subagent-plan.json'))).workflow_run_id, r4RunId)
    assert.equal((await loadStateForSession(fixture.root, fixture.sessionKey)).official_subagent_run_id, r4RunId)
    await assert.rejects(fsp.access(markerFile))
  } finally {
    await fixture.cleanup()
  }
})

test('a dead Naruto finalization lock is reclaimed promptly', { timeout: 8_000 }, async () => {
  const fixture = await createNarutoFixture()
  try {
    const lockDir = path.join(fixture.dir, '.naruto-finalize.lock')
    await fsp.mkdir(lockDir)
    const heartbeat = new Date(Date.now() - 120_000).toISOString()
    await writeJson(path.join(lockDir, 'owner.json'), {
      schema: 'sks.file-lock-owner.v1',
      owner: 'dead-finalizer',
      pid: deadPid(),
      hostname: os.hostname(),
      acquired_at: heartbeat,
      heartbeat_at: heartbeat,
      stale_ms: 15 * 60_000
    })

    await fixture.refresh()
    await fsp.access(path.join(fixture.dir, 'completion-proof.json'))
  } finally {
    await fixture.cleanup()
  }
})

test('Naruto Stop binds observed host receipts into the parent summary and completion proof', async () => {
  const fixture = await createNarutoFixture()
  const oldHome = process.env.HOME
  try {
    const home = path.join(fixture.root, 'home')
    await fsp.mkdir(home, { recursive: true })
    const install = await installGlobalSkills(home)
    assert.equal(install.ok, true, JSON.stringify(install))
    process.env.HOME = home
    const hostState = {
      ...fixture.state,
      required_skills: ['naruto', 'pipeline-runner', 'prompt-pipeline', 'honest-mode']
    }
    const planFile = path.join(fixture.dir, 'subagent-plan.json')
    const plan = await readJson(planFile)
    plan.goal = 'Create and deliver an Excel workbook.'
    await writeJson(planFile, plan)
    const runtime = await inspectHostCapabilityRuntime({
      root: fixture.root,
      request: requestHostCapabilities(plan.goal),
      projectTrusted: true,
      dependencies: hostCapabilityDependencies([
        'spreadsheet_create',
        'spreadsheet_inspect',
        'spreadsheet_update'
      ])
    })
    await writeJson(path.join(fixture.dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), createHostCapabilityHookRuntimeBinding({
      missionId: fixture.missionId,
      workflowRunId: fixture.runId,
      sessionScope: fixture.sessionKey,
      runtime
    }))
    const artifactBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('bounded-xlsx-fixture')
    ])
    await fsp.mkdir(path.join(fixture.root, 'reports'), { recursive: true })
    await fsp.writeFile(path.join(fixture.root, 'reports', 'final.xlsx'), artifactBytes)
    const artifact = {
      path: 'reports/final.xlsx',
      kind: 'spreadsheet',
      media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sha256: `sha256:${sha256(artifactBytes)}`,
      bytes: artifactBytes.length,
      role: 'deliverable'
    }
    for (const payload of [
      {
        turn_id: 'host-create',
        tool_name: 'mcp__acas-tools__spreadsheet_create',
        tool_input: { path: artifact.path },
        tool_response: { structured_content: { artifact } },
        tool_use_id: 'host-create-use'
      },
      {
        turn_id: 'host-inspect',
        tool_name: 'mcp__acas-tools__spreadsheet_inspect',
        tool_input: { path: artifact.path },
        tool_response: {
          structured_content: {
            ok: true,
            path: artifact.path,
            sheet_names: ['Summary'],
            row_counts: { Summary: 1 },
            formulas: [],
            error_cells: []
          }
        },
        tool_use_id: 'host-inspect-use'
      }
    ]) {
      const preTool: any = await evaluateHookPayload('pre-tool', {
        ...payload,
        session_id: fixture.sessionKey
      }, { root: fixture.root, state: hostState })
      assert.equal(preTool.decision, undefined, preTool.reason)
      await evaluateHookPayload('post-tool', {
        ...payload,
        session_id: fixture.sessionKey
      }, { root: fixture.root, state: hostState })
    }

    await refreshOfficialSubagentCompletionArtifacts(
      fixture.root,
      fixture.state,
      fixture.parentSummary,
      fixture.sessionKey
    )
    const [parentSummary, evidence, gate, proof] = await Promise.all([
      readJson(path.join(fixture.dir, 'subagent-parent-summary.json')),
      readJson(path.join(fixture.dir, 'subagent-evidence.json')),
      readJson(path.join(fixture.dir, 'naruto-gate.json')),
      buildNarutoProofProjection({
        artifactDir: fixture.dir,
        missionId: fixture.missionId,
        workspaceRoot: fixture.root
      })
    ])
    assert.equal(gate.passed, true)
    assert.equal(evidence.host_capability_evidence.ok, true)
    assert.deepEqual(parentSummary.artifacts, [artifact])
    assert.deepEqual(parentSummary.capabilities_used, evidence.host_capability_evidence.capabilities_used)
    assert.deepEqual(proof.result.artifacts, [artifact])
    assert.deepEqual(proof.result.capabilities_used, evidence.host_capability_evidence.capabilities_used)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    await fixture.cleanup()
  }
})

test('Naruto Stop blocks host capability claims when no observed runtime evidence exists', async () => {
  const fixture = await createNarutoFixture()
  try {
    const planFile = path.join(fixture.dir, 'subagent-plan.json')
    const plan = await readJson(planFile)
    plan.goal = 'Create and deliver an Excel workbook.'
    await writeJson(planFile, plan)
    const claimed = {
      ...fixture.parentSummary,
      artifacts: [{
        path: 'reports/unobserved.xlsx',
        kind: 'spreadsheet',
        media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha256: `sha256:${'c'.repeat(64)}`,
        bytes: 64,
        role: 'deliverable'
      }],
      capabilities_used: [{
        id: 'host.spreadsheet.workbook.v1',
        status: 'passed',
        tool_names: ['spreadsheet_create', 'spreadsheet_inspect'],
        receipt_sha256: `sha256:${'d'.repeat(64)}`
      }]
    }
    await refreshOfficialSubagentCompletionArtifacts(
      fixture.root,
      fixture.state,
      claimed,
      fixture.sessionKey
    )
    const gate = await readJson(path.join(fixture.dir, 'naruto-gate.json'))
    assert.equal(gate.passed, false)
    assert.ok(gate.blockers.includes('host_capability_hook_runtime_missing'))
    await assert.rejects(fsp.access(path.join(fixture.dir, 'completion-proof.json')))
  } finally {
    await fixture.cleanup()
  }
})

test('Naruto Stop prose cannot erase a persisted structured failed parent summary', async () => {
  const fixture = await createNarutoFixture()
  try {
    const failedParentSummary = {
      ...fixture.parentSummary,
      status: 'failed',
      summary: 'The parent integrated every slice but the route exceeded its automatic fanout cap.',
      thread_outcomes: fixture.parentSummary.thread_outcomes.map((outcome) => ({
        ...outcome,
        status: 'failed'
      })),
      blockers: ['subagent_automatic_fanout_cap_exceeded']
    }
    await refreshOfficialSubagentCompletionArtifacts(
      fixture.root,
      fixture.state,
      failedParentSummary,
      fixture.sessionKey
    )
    await refreshOfficialSubagentCompletionArtifacts(
      fixture.root,
      fixture.state,
      'Completion Summary: the route remains blocked because its automatic fanout cap was exceeded.',
      fixture.sessionKey
    )

    const [persisted, evidence] = await Promise.all([
      readJson(path.join(fixture.dir, 'subagent-parent-summary.json')),
      readJson(path.join(fixture.dir, 'subagent-evidence.json'))
    ])
    assert.deepEqual(persisted, failedParentSummary)
    assert.equal(evidence.parent_summary_trustworthy, true)
    assert.equal(evidence.parent_summary_status, 'failed')
    assert.equal(evidence.run_id, fixture.runId)
    assert.ok(evidence.blockers.includes('parent_summary_failed'))
    assert.ok(!evidence.blockers.includes('parent_summary_untrusted'))
  } finally {
    await fixture.cleanup()
  }
})

interface NarutoFixtureOptions {
  countPolicy?: SubagentCountPolicy
  requestedSubagents?: number
  initialTarget?: number
  effectiveTarget?: number
  threadIds?: string[]
  fanoutAutomaticCeiling?: number
  maxThreads?: number
}

async function createNarutoFixture(options: NarutoFixtureOptions = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-auto-finalize-'))
  const missionId = `M-20260719-120000-${Math.random().toString(16).slice(2, 10)}`
  const runId = `naruto-auto-finalize-${Math.random().toString(16).slice(2, 10)}`
  const sessionKey = `auto-finalize-${Math.random().toString(16).slice(2, 10)}`
  const dir = path.join(root, '.sneakoscope', 'missions', missionId)
  const countPolicy = options.countPolicy || 'dynamic_automatic'
  const requestedSubagents = options.requestedSubagents ?? 2
  const initialTarget = options.initialTarget ?? requestedSubagents
  const effectiveTarget = options.effectiveTarget ?? 4
  const threadIds = options.threadIds ?? ['thread-a', 'thread-b', 'thread-c', 'thread-d']
  const parentSummary = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: `All ${threadIds.length} independent slices completed and were integrated.`,
    thread_outcomes: threadIds.map((threadId) => ({
      thread_id: threadId,
      status: 'completed',
      summary: `${threadId} completed`
    })),
    changed_files: [],
    verification: [{ name: 'focused Naruto verification', status: 'passed' }],
    blockers: [],
    run_id: runId
  }
  const state = {
    mission_id: missionId,
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    official_subagent_run_id: runId,
    subagents_required: true,
    proof_required: true,
    reflection_required: true,
    _session_key: sessionKey
  }

  await fsp.mkdir(dir, { recursive: true })
  const lifecycle = createSubagentWaveLifecycle({
    workflowRunId: runId,
    targetSubagents: initialTarget,
    countPolicy
  })
  lifecycle.target_subagents = effectiveTarget
  await writeJson(path.join(dir, 'mission.json'), {
    id: missionId,
    mode: 'Naruto',
    prompt: 'focused Naruto proof fixture',
    created_at: '2026-07-19T03:00:00.000Z'
  })
  await writeJson(path.join(dir, 'subagent-plan.json'), {
    schema: 'sks.subagent-plan.v1',
    mission_id: missionId,
    route: '$Naruto',
    workflow: 'official_codex_subagent',
    workflow_run_id: runId,
    requested_subagents: requestedSubagents,
    requested_subagents_source: countPolicy === 'dynamic_automatic' ? 'automatic' : 'operator',
    max_threads: options.maxThreads ?? 12,
    max_depth: 1,
    config_blockers: [],
    ...(options.fanoutAutomaticCeiling === undefined
      ? {}
      : { fanout_policy: { automatic_ceiling: options.fanoutAutomaticCeiling } }),
    wave_lifecycle: lifecycle
  })
  const events = threadIds.flatMap((threadId) => [
    event('SubagentStart', threadId, 'started', runId),
    event('SubagentStop', threadId, 'stopped', runId)
  ])
  await fsp.writeFile(path.join(dir, 'subagent-events.jsonl'), `${events.map((row) => JSON.stringify(row)).join('\n')}\n`)
  await writeJson(path.join(dir, 'ssot-guard.json'), buildSsotGuard({
    route: 'Naruto',
    mode: 'NARUTO',
    task: 'auto finalize fixture'
  }))
  await writeJson(path.join(dir, 'naruto-gate.json'), {
    schema: 'sks.naruto-gate.v1',
    workflow: 'official_codex_subagent',
    workflow_run_id: runId,
    mission_id: missionId,
    passed: false,
    terminal: false,
    blockers: ['parent_summary_missing'],
    config_blockers: []
  })
  await setCurrent(root, {
    ...state,
    reflection_invalidation_required: false
  }, { replace: true, sessionKey })

  return {
    root,
    dir,
    missionId,
    runId,
    sessionKey,
    state,
    parentSummary,
    refresh: () => refreshOfficialSubagentCompletionArtifacts(root, state, parentSummary, sessionKey),
    cleanup: () => fsp.rm(root, { recursive: true, force: true })
  }
}

function event(eventName: 'SubagentStart' | 'SubagentStop', threadId: string, outcome: string, runId: string) {
  return {
    schema: 'sks.subagent-event.v1',
    event_name: eventName,
    thread_id: threadId,
    run_id: runId,
    outcome,
    occurred_at: '2026-07-19T03:00:00.000Z'
  }
}

async function readJson(file: string) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

async function readJsonl(file: string) {
  return (await fsp.readFile(file, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function writeJson(file: string, value: unknown) {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed_out_waiting_for_condition')
}

function deadPid() {
  for (const pid of [999_999, 888_888, 777_777]) {
    try {
      process.kill(pid, 0)
    } catch (error: any) {
      if (error?.code === 'ESRCH') return pid
    }
  }
  throw new Error('dead_pid_fixture_unavailable')
}

function hostCapabilityDependencies(toolNames: string[]) {
  return {
    inventory: async () => ({
      schema: 'sks.mcp-inventory.v2',
      ok: true,
      scope: 'project',
      source: 'fixture_inventory',
      servers: [{
        name: 'acas-tools',
        enabled: true,
        enabled_tools: [...toolNames],
        disabled_tools: []
      }],
      server_count: 1,
      enabled_count: 1,
      failed_count: 0,
      blockers: [],
      warnings: []
    }) as any,
    health: async () => ({
      schema: 'sks.mcp-health.v1',
      ok: true,
      name: 'acas-tools',
      scope: 'project',
      status: 'healthy',
      tool_names: [...toolNames]
    }) as any
  }
}
