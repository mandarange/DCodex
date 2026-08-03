// First import: gate-cache coverage spawns npm and must not inherit the user's
// real HOME/npm state.
import './helpers/isolated-test-home.js'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  preflightExecutionControl,
  recordExecutionObservation
} from '../runtime/execution-control.js'
import { evaluateLoopContinuation } from '../loops/loop-continuation-enforcer.js'
import { loopGatePath, loopPlanPath } from '../loops/loop-artifacts.js'
import { graphProofFromLoopProofs } from '../loops/loop-scheduler.js'
import { runLoopGates } from '../loops/loop-gate-runner.js'
import { computeLoopDiff } from '../loops/loop-worktree-runtime.js'
import type { SksLoopGatePlan, SksLoopNode, SksLoopProof } from '../loops/loop-schema.js'
import { emptyCompletionProof } from '../proof/proof-schema.js'
import { validateCompletionProof } from '../proof/validation.js'
import { proofStatusBlocks } from '../proof/route-proof-policy.js'
import { assessRuntimeEvidence } from '../proof/runtime-evidence-policy.js'
import { buildRuntimeTruthMatrix } from '../proof/runtime-truth-matrix.js'
import { runAgentScheduler } from '../agents/agent-scheduler.js'
import { finalizationRepeatDecision } from '../hooks-runtime/stop-repeat-guard.js'
import { honestModeLoopbackBudgetExhausted } from '../hooks-runtime.js'
import { qaExecutionProgressFingerprint } from '../qa-loop/qa-execution-control.js'
import { runProcess } from '../fsx.js'

test('execution control stops repeated semantic results before the attempt ceiling', () => {
  const budget = { max_attempts: 10, max_elapsed_ms: 60_000, max_no_progress: 2 }
  let state = preflightExecutionControl(null, budget).state
  state = recordExecutionObservation(state, budget, { fingerprint: { result: 'same' }, idempotencyKey: 'gate:one' })
  state = recordExecutionObservation(state, budget, { fingerprint: { result: 'same' }, idempotencyKey: 'gate:one' })
  state = recordExecutionObservation(state, budget, { fingerprint: { result: 'same' }, idempotencyKey: 'gate:one' })

  assert.equal(state.status, 'stopped')
  assert.equal(state.stop_reason, 'no_progress')
  assert.equal(state.attempts, 3)
  assert.deepEqual(state.seen_idempotency_keys, ['gate:one'])
  assert.equal(preflightExecutionControl(state, budget).allowed, false)
})

test('QA progress fingerprint ignores reordered duplicate reasons but observes real ledger growth', () => {
  const first = qaExecutionProgressFingerprint({
    gate: { passed: false, reasons: ['beta', 'alpha'], gate: { blockers: ['same'], action_ledger: [{}] } },
    process: { code: 1, timedOut: false }
  })
  const duplicate = qaExecutionProgressFingerprint({
    gate: { passed: false, reasons: ['alpha', 'beta'], gate: { blockers: ['same'], action_ledger: [{}] } },
    process: { code: 1, timedOut: false }
  })
  const progressed = qaExecutionProgressFingerprint({
    gate: { passed: false, reasons: ['alpha', 'beta'], gate: { blockers: ['same'], action_ledger: [{}, {}] } },
    process: { code: 1, timedOut: false }
  })

  assert.deepEqual(duplicate, first)
  assert.notDeepEqual(progressed, first)
})

test('loop continuation becomes terminal unverified after bounded identical checks', async (t) => {
  const root = await tempRoot(t, 'sks-loop-continuation-')
  const missionId = 'M-loop-bounded'
  await writeJson(loopPlanPath(root, missionId), {
    schema: 'sks.loop-plan.v1',
    graph: { nodes: [{ loop_id: 'loop-one' }] }
  })

  const first = await evaluateLoopContinuation({ root, missionId, maxContinuationTurns: 2 })
  const second = await evaluateLoopContinuation({ root, missionId, maxContinuationTurns: 2 })
  const third = await evaluateLoopContinuation({ root, missionId, maxContinuationTurns: 2 })

  assert.equal(first.should_continue, true)
  assert.equal(second.should_continue, true)
  assert.equal(third.should_continue, false)
  assert.equal(third.terminal_blocked, true)
  assert.equal(third.stop_reason, 'continuation_budget_exhausted')
  assert.equal(third.resume_instruction, null)
  assert.ok(third.blockers.includes('loop_continuation_budget_exhausted'))
})

test('contradictory completed loop proof cannot count as graph completion', () => {
  const proof = loopProof({ checkerOk: false, checkerBlockers: ['tests_missing'] })
  const graph = graphProofFromLoopProofs({
    missionId: 'M-proof-truth',
    proofs: [proof],
    maxActiveLoops: 1,
    maxActiveWorkers: 1,
    wallMs: 25
  })

  assert.equal(graph.ok, false)
  assert.equal(graph.completed_loops, 0)
  assert.ok(graph.blockers.includes('loop-one:loop_checker_unverified'))
  assert.ok(graph.blockers.includes('loop-one:loop_checker_blockers_present'))
})

test('completion proof validation separates schema validity from verified completion', () => {
  const contradictory = validateCompletionProof(emptyCompletionProof({
    execution_class: 'real',
    status: 'verified',
    unverified: ['runtime_behavior'],
    blockers: ['runtime_receipt_missing']
  }))
  assert.equal(contradictory.schema_ok, true)
  assert.equal(contradictory.completion_ok, false)
  assert.ok(contradictory.issues.includes('verified_with_unverified_claims'))
  assert.ok(contradictory.issues.includes('verified_with_blockers'))
  assert.equal(proofStatusBlocks('mock_only'), true)

  const verified = validateCompletionProof(emptyCompletionProof({
    execution_class: 'real',
    status: 'verified',
    unverified: [],
    blockers: []
  }))
  assert.equal(verified.completion_ok, true)
})

test('runtime truth rejects generated success and accepts receipt-backed runtime evidence', async (t) => {
  const generated = assessRuntimeEvidence({ ok: true, status: 'passed', proof_level: 'proven' }, { required: true })
  assert.equal(generated.working_claim_allowed, false)
  assert.equal(generated.proof_level, 'blocked')
  assert.ok(generated.blockers.includes('runtime_success_claim_without_receipt'))

  const observedAt = new Date().toISOString()
  const runtime = assessRuntimeEvidence({
    schema: 'sks.runtime-evidence.v1',
    runtime_status: 'proven',
    evidence_source: 'runtime',
    receipts: [{ command: 'node focused-runtime-check.mjs', exit_code: 0, observed_at: observedAt }]
  }, { candidateProofLevel: 'proven', required: true })
  assert.equal(runtime.working_claim_allowed, true)
  assert.equal(runtime.proof_level, 'proven')

  const fixtureWrappedReceipt = assessRuntimeEvidence({
    execution_class: 'mock_fixture',
    proof_level: 'proven',
    runtime_evidence: {
      schema: 'sks.runtime-evidence.v1',
      runtime_status: 'proven',
      evidence_source: 'runtime',
      receipts: [{ command: 'echo fixture', exit_code: 0, observed_at: observedAt }]
    }
  }, { candidateProofLevel: 'proven', required: true })
  assert.equal(fixtureWrappedReceipt.working_claim_allowed, false)
  assert.ok(fixtureWrappedReceipt.blockers.includes('runtime_success_claim_without_receipt'))

  const root = await tempRoot(t, 'sks-runtime-matrix-')
  const matrix = await buildRuntimeTruthMatrix({
    root,
    releaseVersion: 'test',
    required: { native_worker_backend_router: true },
    reports: { 'agent-worker-backend-router.json': { ok: true, status: 'passed' } }
  })
  const row = matrix.rows.find((item) => item.subsystem === 'native_worker_backend_router')
  assert.equal(row?.working_claim_allowed, false)
  assert.equal(row?.proof_level, 'blocked')
  assert.ok(row?.blockers.includes('runtime_success_claim_without_receipt'))
  assert.equal(matrix.ok, false)

  const schedulerMatrix = await buildRuntimeTruthMatrix({
    root,
    releaseVersion: 'test',
    reports: {
      'agent-scheduler-state.json': {
        status: 'drained',
        completion_claim_allowed: true,
        pending_queue_drained: true,
        all_slots_closed_after_drain: true,
        all_generations_closed: true,
        blockers: [],
        runtime_evidence: {
          schema: 'sks.runtime-evidence.v1',
          runtime_status: 'proven',
          evidence_source: 'runtime',
          receipts: [{ command: 'runAgentScheduler', exit_code: 0, observed_at: observedAt }]
        }
      }
    }
  })
  const schedulerRow = schedulerMatrix.rows.find((item) => item.subsystem === 'dynamic_scheduler')
  assert.equal(schedulerRow?.working_claim_allowed, true)
  assert.equal(schedulerRow?.runtime_status, 'proven')
})

test('loop gate cache deduplicates an identical successful check', async (t) => {
  const root = await tempRoot(t, 'sks-loop-gate-cache-')
  await writeJson(path.join(root, 'package.json'), {
    name: 'loop-gate-cache-fixture',
    version: '1.0.0',
    type: 'module',
    scripts: { 'check:cached': 'node counter.mjs' }
  })
  await fsp.writeFile(path.join(root, 'counter.mjs'), [
    "import fs from 'node:fs'",
    "const file = 'counter.txt'",
    "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0",
    "fs.writeFileSync(file, String(count + 1))"
  ].join('\n'))
  const gates: SksLoopGatePlan = {
    triage: ['check:cached'],
    local: [],
    checker: [],
    integration: [],
    final: []
  }
  const node = loopNode()

  const first = await runLoopGates({ root, missionId: 'M-cache', node, gates, cacheKey: 'snapshot-one' })
  const second = await runLoopGates({ root, missionId: 'M-cache', node, gates, cacheKey: 'snapshot-one' })
  const artifact = JSON.parse(await fsp.readFile(loopGatePath(root, 'M-cache', node.loop_id, 'check:cached'), 'utf8'))

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(await fsp.readFile(path.join(root, 'counter.txt'), 'utf8'), '1')
  assert.equal(artifact.cache_hit, true)
  assert.equal(artifact.cache_hits, 1)

  const changedInput = await runLoopGates({ root, missionId: 'M-cache', node, gates, cacheKey: 'snapshot-two' })
  const changedArtifact = JSON.parse(await fsp.readFile(loopGatePath(root, 'M-cache', node.loop_id, 'check:cached'), 'utf8'))
  assert.equal(changedInput.ok, true)
  assert.equal(await fsp.readFile(path.join(root, 'counter.txt'), 'utf8'), '2')
  assert.equal(changedArtifact.cache_hit, false)
})

test('loop input fingerprint changes when an untracked file changes', async (t) => {
  const root = await tempRoot(t, 'sks-loop-untracked-fingerprint-')
  await fsp.writeFile(path.join(root, 'tracked.txt'), 'base\n')
  for (const args of [
    ['init', '-q'],
    ['add', 'tracked.txt'],
    ['-c', 'user.email=sks@example.invalid', '-c', 'user.name=SKS', 'commit', '-qm', 'base']
  ]) {
    const result = await runProcess('git', args, { cwd: root, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
    assert.equal(result.code, 0, result.stderr)
  }
  await fsp.writeFile(path.join(root, 'untracked.txt'), 'one')
  const ownerScope = { files: ['untracked.txt'], directories: [] } as any
  const first = await computeLoopDiff({ root, ownerScope })
  await fsp.writeFile(path.join(root, 'untracked.txt'), 'two')
  const second = await computeLoopDiff({ root, ownerScope })

  assert.deepEqual(first.changed_files, ['untracked.txt'])
  assert.equal(first.patch_bytes, 3)
  assert.notEqual(second.diff_sha256, first.diff_sha256)
  assert.deepEqual(first.blockers, [])
  assert.deepEqual(second.blockers, [])
})

test('scheduler wall budget stops a never-settling worker with an explicit unverified result', { timeout: 2_000 }, async (t) => {
  const root = await tempRoot(t, 'sks-scheduler-budget-')
  let cleanupReason = ''
  const started = Date.now()
  const result = await runAgentScheduler({
    root,
    missionId: 'M-scheduler-budget',
    rootHash: 'fixture',
    roster: schedulerRoster(),
    partition: { slices: [{ id: 'work-one', role: 'verifier', dependencies: [] }] },
    targetActiveSlots: 1,
    maxActiveSlots: 1,
    maxWallMs: 30,
    launchSession: async () => new Promise(() => undefined),
    onStop: async (reason) => { cleanupReason = reason }
  })

  assert.ok(Date.now() - started < 1_000)
  assert.equal(result.ok, false)
  assert.equal(result.state.status, 'blocked')
  assert.equal(result.state.stop_reason, 'scheduler_wall_time_budget_exhausted')
  assert.equal(result.state.completion_claim_allowed, false)
  assert.equal(cleanupReason, 'scheduler_wall_time_budget_exhausted')
  assert.equal(result.queue.items[0]?.status, 'blocked')
  assert.equal(result.results[0]?.verification?.status, 'unverified')
})

test('scheduler terminates dependency deadlock and failed workers without false success', async (t) => {
  const deadlockRoot = await tempRoot(t, 'sks-scheduler-deadlock-')
  const deadlock = await runAgentScheduler({
    root: deadlockRoot,
    missionId: 'M-scheduler-deadlock',
    rootHash: 'fixture',
    roster: schedulerRoster(),
    partition: { slices: [
      { id: 'one', role: 'verifier', dependencies: ['two'] },
      { id: 'two', role: 'verifier', dependencies: ['one'] }
    ] },
    targetActiveSlots: 1,
    maxActiveSlots: 1,
    launchSession: async () => ({ status: 'done' })
  })
  assert.equal(deadlock.ok, false)
  assert.equal(deadlock.state.stop_reason, 'scheduler_unresolvable_dependencies')
  assert.ok(deadlock.queue.items.every((item) => item.status === 'blocked'))

  const failedRoot = await tempRoot(t, 'sks-scheduler-failed-')
  const failed = await runAgentScheduler({
    root: failedRoot,
    missionId: 'M-scheduler-failed',
    rootHash: 'fixture',
    roster: schedulerRoster(),
    partition: { slices: [{ id: 'one', role: 'verifier', dependencies: [] }] },
    targetActiveSlots: 1,
    maxActiveSlots: 1,
    launchSession: async () => ({ status: 'failed', blockers: ['runtime_failed'], artifacts: [] })
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.state.completion_claim_allowed, false)
  assert.ok(failed.state.blockers.includes('scheduler_work_item_failed:one'))
})

test('repeated finalization and Honest Mode retry exhaustion end as unverified', async (t) => {
  const root = await tempRoot(t, 'sks-finalization-repeat-')
  const state = { mission_id: 'M-repeat', route: 'Naruto', mode: 'NARUTO' }
  const payload = { conversation_id: 'conversation-repeat' }
  const first = await finalizationRepeatDecision(root, state, payload, 'same missing proof', 'completion_summary_missing')
  const second = await finalizationRepeatDecision(root, state, payload, 'same missing proof', 'completion_summary_missing')
  assert.equal(first, null)
  assert.equal(second?.status, 'unverified')
  assert.equal(second?.completion_claim_allowed, false)
  assert.equal(second?.stop_reason, 'finalization_repeat_budget_exhausted')

  assert.equal(honestModeLoopbackBudgetExhausted({ mission_id: 'M-honest', implementation_allowed: true, honest_loop_attempt_count: 1 }), false)
  assert.equal(honestModeLoopbackBudgetExhausted({ mission_id: 'M-honest', implementation_allowed: true, honest_loop_attempt_count: 2 }), true)
})

async function tempRoot(t: TestContext, prefix: string) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

async function writeJson(file: string, value: unknown) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function schedulerRoster() {
  return {
    agent_count: 1,
    concurrency: 1,
    roster: [{ id: 'agent-one', persona_id: 'verifier', role: 'verifier', write_policy: 'read-only' }]
  }
}

function loopNode(): SksLoopNode {
  return {
    schema: 'sks.loop-node.v1',
    loop_id: 'loop-one',
    mission_id: 'M-cache',
    route: '$QA-LOOP'
  } as unknown as SksLoopNode
}

function loopProof(input: { checkerOk: boolean; checkerBlockers: string[] }): SksLoopProof {
  return {
    schema: 'sks.loop-proof.v1',
    mission_id: 'M-proof-truth',
    loop_id: 'loop-one',
    status: 'completed',
    maker_result: { ok: true, worker_count: 1, artifacts: [], patch_candidates: [] },
    checker_result: { ok: input.checkerOk, worker_count: 1, artifacts: [], blockers: input.checkerBlockers },
    gate_result: { ok: true, selected_gates: [], passed_gates: [], failed_gates: [], skipped_gates: [], blockers: [] },
    blockers: [],
    handoff: { required: false, reason: null, artifact: null }
  } as unknown as SksLoopProof
}
