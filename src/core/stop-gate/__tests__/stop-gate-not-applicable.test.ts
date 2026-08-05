import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMission } from '../../mission.js'
import { writeRouteCompletionProof } from '../../proof/route-adapter.js'
import { evaluateStop } from '../../pipeline.js'
import { checkStopGate } from '../stop-gate-check.js'

test('trustworthy terminal blocked Naruto gate allows an honest stop without claiming pass', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-terminal-blocked-naruto-'))
  try {
    const mission: any = await createMission(root, { mode: 'naruto', prompt: 'finish with an external blocker' })
    const gatePath = path.join(mission.dir, 'naruto-gate.json')
    const gate = {
      schema: 'sks.naruto-gate.v1',
      workflow: 'official_codex_subagent',
      mission_id: mission.id,
      status: 'blocked',
      passed: false,
      terminal: true,
      terminal_state: 'blocked',
      subagent_plan_ready: true,
      official_subagent_evidence: true,
      subagent_evidence_ready: true,
      parent_summary_present: true,
      session_cleanup: true,
      ssot_guard: true,
      evidence: {},
      blockers: ['parent_summary_blocked'],
      missing_fields: ['parent_summary_blocked'],
      updated_at: new Date().toISOString()
    }
    await fs.writeFile(gatePath, JSON.stringify(gate))

    const checked = await checkStopGate({
      root,
      route: 'Naruto',
      missionId: mission.id,
      explicitGatePath: gatePath,
      allowLatestFallback: false
    })
    assert.equal(checked.ok, true)
    assert.equal(checked.action, 'allow_stop')
    assert.equal(checked.normalized_gate?.passed, false)
    assert.equal(checked.normalized_gate?.terminal_state, 'blocked')
    assert.equal(checked.diagnostics.reason, 'gate_terminal_blocked')

    await fs.writeFile(gatePath, JSON.stringify({
      ...gate,
      blockers: ['parent_summary_blocked', 'unsettled_code_failure']
    }))
    const unsafe = await checkStopGate({
      root,
      route: 'Naruto',
      missionId: mission.id,
      explicitGatePath: gatePath,
      allowLatestFallback: false
    })
    assert.equal(unsafe.ok, false)
    assert.equal(unsafe.action, 'continue')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('not_applicable satisfies only the active gate and still enforces proof reflection and work-order coverage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-not-applicable-independent-gates-'))
  try {
    const mission: any = await createMission(root, { mode: 'db', prompt: 'review database configuration' })
    const dir = mission.dir
    const state = {
      mission_id: mission.id,
      route: 'DB',
      route_command: '$DB',
      mode: 'DB',
      stop_gate: 'db-review.json',
      proof_required: true,
      reflection_required: true,
      agents_required: false,
      subagents_required: true,
      context7_required: false,
      prompt: 'review database configuration'
    }
    await fs.writeFile(path.join(dir, 'db-review.json'), JSON.stringify({
      status: 'not_applicable',
      reason: 'fixture_has_no_live_database_operation'
    }))

    const proofBlocked: any = await evaluateStop(root, state, { last_assistant_message: 'DB review complete.' })
    assert.equal(proofBlocked.decision, 'block')
    assert.match(proofBlocked.reason, /Completion Proof/i)

    await writeRouteCompletionProof(root, {
      missionId: mission.id,
      route: '$DB',
      status: 'verified',
      executionClass: 'real',
      lightweightEvidence: true,
      gate: {
        workflow: 'official_codex_subagent',
        official_subagent_evidence: true,
        parent_summary_present: true
      },
      summary: { manual_review_required: false }
    })
    const noQuestionReflectionBlocked: any = await evaluateStop(root, state, { last_assistant_message: 'DB review complete.' }, { noQuestion: true })
    assert.equal(noQuestionReflectionBlocked.decision, 'block')
    assert.match(noQuestionReflectionBlocked.reason, /reflection/i)
    const reflectionBlocked: any = await evaluateStop(root, state, { last_assistant_message: 'DB review complete.' })
    assert.equal(reflectionBlocked.decision, 'block')
    assert.match(reflectionBlocked.reason, /reflection/i)

    await fs.writeFile(path.join(dir, 'reflection.md'), '# Reflection\n\nNo issue found.\n')
    await fs.writeFile(path.join(dir, 'reflection-gate.json'), JSON.stringify({
      passed: true,
      created_at: new Date().toISOString(),
      reflection_artifact: true,
      no_issue_acknowledged: true,
      wiki_refreshed_or_packed: true,
      wiki_validated: true
    }))
    await fs.writeFile(path.join(dir, 'work-order-ledger.json'), JSON.stringify({
      schema_version: 1,
      mission_id: mission.id,
      route: 'DB',
      source_inventory_complete: true,
      all_customer_requests_preserved: true,
      all_customer_requests_mapped: true,
      all_work_items_verified: false,
      items: [{
        id: 'REQ-1',
        status: 'pending',
        implementation_tasks: [],
        implementation_evidence: [],
        verification_evidence: []
      }]
    }))
    const coverageBlocked: any = await evaluateStop(root, state, { last_assistant_message: 'DB review complete.' })
    assert.equal(coverageBlocked.decision, 'block')
    assert.match(coverageBlocked.reason, /work-order-ledger/i)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('canonical not_applicable gate satisfies only the active gate contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-canonical-not-applicable-'))
  try {
    const mission: any = await createMission(root, { mode: 'naruto', prompt: 'no applicable runtime action' })
    const gatePath = path.join(mission.dir, 'naruto-gate.json')
    await fs.writeFile(gatePath, JSON.stringify({
      schema: 'sks.stop-gate.v1',
      route: 'Naruto',
      route_command: '$Naruto',
      mission_id: mission.id,
      gate_file: 'naruto-gate.json',
      gate_abs_path: gatePath,
      status: 'not_applicable',
      passed: false,
      reason: 'fixture_has_no_applicable_subagent_action',
      terminal: false,
      terminal_state: 'blocked',
      evidence: {},
      blockers: [],
      missing_fields: [],
      created_at: new Date().toISOString()
    }))
    const checked = await checkStopGate({ root, route: 'Naruto', missionId: mission.id, explicitGatePath: gatePath })
    assert.equal(checked.ok, true)
    assert.equal(checked.action, 'allow_stop')
    assert.equal(checked.diagnostics.reason, 'gate_not_applicable')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('canonical not_applicable normalizes omitted arrays and rejects malformed arrays', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-canonical-not-applicable-normalize-'))
  try {
    const mission: any = await createMission(root, { mode: 'naruto', prompt: 'no applicable runtime action' })
    const gatePath = path.join(mission.dir, 'naruto-gate.json')
    const base = {
      schema: 'sks.stop-gate.v1',
      route: 'Naruto',
      route_command: '$Naruto',
      mission_id: mission.id,
      gate_file: 'naruto-gate.json',
      gate_abs_path: gatePath,
      status: 'not_applicable',
      passed: false,
      reason: 'fixture_has_no_applicable_subagent_action',
      terminal: false,
      terminal_state: 'blocked',
      evidence: {},
      created_at: new Date().toISOString()
    }
    await fs.writeFile(gatePath, JSON.stringify(base))
    const omitted = await checkStopGate({ root, route: 'Naruto', missionId: mission.id, explicitGatePath: gatePath })
    assert.equal(omitted.ok, true)
    assert.equal(omitted.action, 'allow_stop')

    await fs.writeFile(gatePath, JSON.stringify({ ...base, blockers: 'contradictory' }))
    const malformed = await checkStopGate({ root, route: 'Naruto', missionId: mission.id, explicitGatePath: gatePath })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.action, 'continue')
    assert.ok(malformed.diagnostics.missing_fields.includes('blockers'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('legacy Naruto not_applicable rejects malformed blocker and missing-field arrays', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-legacy-naruto-not-applicable-normalize-'))
  try {
    const mission: any = await createMission(root, { mode: 'naruto', prompt: 'no applicable runtime action' })
    const gatePath = path.join(mission.dir, 'naruto-gate.json')
    await fs.writeFile(gatePath, JSON.stringify({
      schema: 'sks.naruto-gate.v1',
      route: '$Naruto',
      mission_id: mission.id,
      status: 'not_applicable',
      passed: false,
      reason: 'fixture_has_no_applicable_subagent_action',
      evidence: {},
      blockers: 'contradictory',
      missing_fields: 'also_contradictory',
      updated_at: new Date().toISOString()
    }))

    const checked = await checkStopGate({ root, route: 'Naruto', missionId: mission.id, explicitGatePath: gatePath })
    assert.equal(checked.ok, false)
    assert.equal(checked.action, 'continue')
    assert.ok(checked.diagnostics.missing_fields.includes('blockers'))
    assert.ok(checked.diagnostics.missing_fields.includes('missing_fields:missing_fields_invalid'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('generic not_applicable rejects contradictory blocker and missing-field arrays', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-generic-not-applicable-contradiction-'))
  try {
    const mission: any = await createMission(root, { mode: 'db', prompt: 'review database configuration' })
    const state = {
      mission_id: mission.id,
      route: 'DB',
      route_command: '$DB',
      mode: 'DB',
      stop_gate: 'db-review.json',
      proof_required: false,
      reflection_required: false,
      agents_required: false,
      subagents_required: false,
      context7_required: false
    }
    await fs.writeFile(path.join(mission.dir, 'db-review.json'), JSON.stringify({
      status: 'not_applicable',
      reason: 'fixture_has_no_live_database_operation',
      blockers: ['contradictory'],
      missing_fields: ['also_contradictory']
    }))
    const decision: any = await evaluateStop(root, state, { last_assistant_message: 'DB review complete.' })
    assert.equal(decision.decision, 'block')
    assert.match(String(decision.reason || ''), /Missing gate fields: blockers, missing_fields/i)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Naruto not_applicable skips only official artifacts and still requires proof and reflection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-not-applicable-independent-'))
  try {
    const mission: any = await createMission(root, { mode: 'naruto', prompt: 'no applicable subagent action' })
    const dir = mission.dir
    const state = {
      mission_id: mission.id,
      route: 'Naruto',
      route_command: '$Naruto',
      mode: 'NARUTO',
      stop_gate: 'naruto-gate.json',
      proof_required: true,
      reflection_required: true,
      agents_required: false,
      subagents_required: false,
      context7_required: false,
      prompt: 'no applicable subagent action'
    }
    await fs.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({
      schema: 'sks.stop-gate.v1',
      route: 'Naruto',
      route_command: '$Naruto',
      mission_id: mission.id,
      gate_file: 'naruto-gate.json',
      status: 'not_applicable',
      passed: false,
      reason: 'task_has_no_applicable_subagent_action',
      evidence: {},
      blockers: [],
      missing_fields: []
    }))
    await fs.writeFile(path.join(dir, 'work-order-ledger.json'), JSON.stringify({
      schema_version: 1,
      mission_id: mission.id,
      route: 'Naruto',
      source_inventory_complete: true,
      all_customer_requests_preserved: true,
      all_customer_requests_mapped: true,
      all_work_items_verified: true,
      items: []
    }))

    const proofBlocked: any = await evaluateStop(root, state, { last_assistant_message: 'Done.' })
    assert.equal(proofBlocked.decision, 'block')
    assert.match(proofBlocked.reason, /Completion Proof/i)

    await writeRouteCompletionProof(root, {
      missionId: mission.id,
      route: '$Naruto',
      status: 'verified',
      executionClass: 'real',
      lightweightEvidence: true,
      gate: {
        workflow: 'official_codex_subagent',
        official_subagent_evidence: true,
        parent_summary_present: true
      },
      summary: { manual_review_required: false }
    })
    const reflectionBlocked: any = await evaluateStop(root, state, { last_assistant_message: 'Done.' })
    assert.equal(reflectionBlocked.decision, 'block')
    assert.match(reflectionBlocked.reason, /reflection/i)

    await fs.writeFile(path.join(dir, 'reflection.md'), '# Reflection\n\nNo issue found.\n')
    await fs.writeFile(path.join(dir, 'reflection-gate.json'), JSON.stringify({
      passed: true,
      created_at: new Date().toISOString(),
      reflection_artifact: true,
      no_issue_acknowledged: true,
      wiki_refreshed_or_packed: true,
      wiki_validated: true
    }))
    const allowed: any = await evaluateStop(root, state, { last_assistant_message: 'Done.' })
    assert.equal(allowed.continue, true)
    assert.match(String(allowed.systemMessage || ''), /not applicable and independent gates passed/i)
    assert.doesNotMatch(String(allowed.systemMessage || ''), /subagent-parent-summary/i)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
