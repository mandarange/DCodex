import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  RESEARCH_EXECUTION_CONTROL_ARTIFACT,
  buildResearchHonestMode,
  evaluateReviewCycle,
  parseOfficialReviewParentSummary,
  runResearchAdversarialReviewLoop
} from '../research-adversarial-review.js'
import { recordSubagentEvent } from '../../subagents/subagent-evidence.js'
import { writeVerifiedSuperSearchFixture } from './research-source-evidence-fixture.js'

const reviewerIds = ['einstein', 'von_neumann', 'skeptic'] as const

function mockSource(id: string) {
  return { id, kind: 'selftest' }
}

const digestFixture = {
  schema: 'sks.research-review-artifact-digest.v1' as const,
  generated_at: '2026-07-13T00:00:00.000Z',
  artifacts: [
    { artifact: 'research-report.md', sha256: '1'.repeat(64), bytes: 10 },
    { artifact: 'research-paper.md', sha256: '2'.repeat(64), bytes: 10 },
    { artifact: 'source-ledger.json', sha256: '3'.repeat(64), bytes: 10 },
    { artifact: 'claim-evidence-matrix.json', sha256: '4'.repeat(64), bytes: 10 }
  ],
  bundle_sha256: 'a'.repeat(64),
  blockers: []
}

test('mock adversarial loop records three composite structured outcomes without making genius or novelty guarantees', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-adversarial-'))
  const plan = { mission_id: 'M-RESEARCH-ADVERSARIAL', prompt: 'bounded evidence research', artifacts: { research_paper: 'research-paper.md' } }
  const sources = Array.from({ length: 8 }, (_unused, index) => mockSource(`source-${index + 1}`))
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources, counterevidence_sources: [] }))
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({ schema: 'sks.claim-evidence-matrix.v1', claims: [] }))
  await fsp.writeFile(path.join(dir, 'research-report.md'), '# Report\n\nEvidence-bound fixture.')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), '# Paper\n\nEvidence-bound fixture.')
  const result = await runResearchAdversarialReviewLoop({ root: dir, dir, plan, timeoutMs: 1000, mock: true })
  assert.equal(result.gate.passed, true)
  assert.equal(result.plan.reviewer_count, reviewerIds.length)
  assert.deepEqual([...new Set(result.plan.reviewers.map((reviewer: any) => reviewer.custom_agent))], ['research_reviewer'])
  assert.equal(result.gate.reviewer_count_observed, reviewerIds.length)
  assert.equal(result.gate.genius_level_guaranteed, false)
  assert.equal(result.gate.novelty_guaranteed, false)
  const debate = JSON.parse(await fsp.readFile(path.join(dir, 'debate-ledger.json'), 'utf8'))
  assert.equal(debate.unanimous_consensus, true)
  assert.equal(debate.exchanges.length, reviewerIds.length)
})

test('adversarial review stops when the same objection set survives a revision', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-adversarial-no-progress-'))
  const plan = { mission_id: 'M-RESEARCH-NO-PROGRESS', prompt: 'bounded evidence research', artifacts: { research_paper: 'research-paper.md' } }
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources: [mockSource('source-1')], counterevidence_sources: [] }))
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({ schema: 'sks.claim-evidence-matrix.v1', claims: [] }))
  await fsp.writeFile(path.join(dir, 'research-report.md'), '# Report\n\nEvidence-bound fixture.')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), '# Paper\n\nEvidence-bound fixture.')

  const result = await runResearchAdversarialReviewLoop({
    root: dir,
    dir,
    plan,
    timeoutMs: 2000,
    maxCycles: 3,
    mock: true,
    reviewCycleImpl: async (_input, cycle, _maxThreads, reviewArtifacts) => ({
      schema: 'sks.research-adversarial-review-cycle.v1',
      cycle,
      execution_class: 'mock_fixture',
      reviewed_at: new Date().toISOString(),
      review_artifacts: reviewArtifacts,
      blockers: [],
      reviewers: reviewerIds.map((personaId, index) => ({
        schema: 'sks.research-adversarial-reviewer-outcome.v1',
        persona_id: personaId,
        verdict: index === 0 ? 'revise' : 'approve',
        strongest_challenge: 'The same material objection remains unresolved.',
        evidence_source_ids: ['source-1'],
        critical_objections: [],
        major_objections: index === 0 ? [{
          id: 'stable-objection',
          severity: 'major',
          claim_ids: ['claim-1'],
          source_ids: ['source-1'],
          reason: 'The control is still missing.',
          required_revision: 'Add or downgrade the control claim.'
        }] : [],
        minor_objections: [],
        required_revisions: [],
        eureka: { exclamation: 'Eureka!', idea: 'The objection is stable.', source_ids: ['source-1'] },
        falsifiers: ['Provide the missing control.'],
        cheap_probes: ['Inspect the control artifact.'],
        confidence: 'high',
        review_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
        thread_id: `mock-stable-${cycle}-${personaId}`,
        thread_status: 'completed'
      }))
    }),
    revisionCycleImpl: async (_input, cycle, _maxThreads, objectionIds) => ({
      schema: 'sks.research-revision-cycle.v1',
      cycle,
      ok: true,
      objection_ids: objectionIds,
      addressed_objection_ids: objectionIds,
      changed_artifacts: ['research-report.md'],
      blockers: []
    })
  })

  const control = JSON.parse(await fsp.readFile(path.join(dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(result.review_cycles.length, 2)
  assert.equal(result.revisions.length, 1)
  assert.ok(result.gate.blockers.includes('research_review_no_progress'))
  assert.equal(control.status, 'stopped')
  assert.equal(control.stop_reason, 'no_progress')
})

test('structured reviewer convergence fails closed on a critical objection', () => {
  const reviewers = reviewerIds.map((personaId, index) => ({
    schema: 'sks.research-adversarial-reviewer-outcome.v1',
    persona_id: personaId,
    verdict: index === 0 ? 'revise' : 'approve',
    strongest_challenge: 'Attempted falsification',
    evidence_source_ids: ['source-1'],
    critical_objections: index === 0 ? [{ id: 'critical-1', severity: 'critical', claim_ids: ['claim-1'], source_ids: ['source-1'], reason: 'missing control', required_revision: 'add or downgrade control claim' }] : [],
    major_objections: [],
    minor_objections: [],
    required_revisions: [],
    eureka: { exclamation: 'Eureka!', idea: 'bounded insight', source_ids: ['source-1'] },
    falsifiers: ['counterexample'],
    cheap_probes: ['probe'],
    confidence: 'high',
    review_artifact_bundle_sha256: digestFixture.bundle_sha256,
    thread_id: `thread-${index + 1}`,
    thread_status: 'completed'
  }))
  const result = evaluateReviewCycle({ reviewers, review_artifacts: digestFixture, blockers: [] }, new Set(['source-1']))
  assert.equal(result.ok, false)
  assert.equal(result.critical_objections, 1)
  assert.ok(result.blockers.includes('critical_objections_unresolved'))
})

test('official parent summary parser rejects prose-only thread outcomes', () => {
  const parsed = parseOfficialReviewParentSummary(JSON.stringify({
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'done',
    thread_outcomes: [{ thread_id: 'thread-1', status: 'completed', summary: 'looks good' }],
    changed_files: [],
    verification: [],
    blockers: []
  }))
  assert.equal(parsed.ok, false)
  assert.ok(parsed.blockers.some((blocker) => blocker.startsWith('reviewer_outcome_unstructured:')))
})

test('official reviewer parser rejects prose-wrapped parent JSON, wrong reviewer schema, and duplicate threads', () => {
  const ids = reviewerIds
  const outcome = (personaId: string) => ({
    schema: 'wrong.schema',
    persona_id: personaId,
    verdict: 'approve',
    strongest_challenge: 'challenge',
    evidence_source_ids: ['source-1'],
    critical_objections: [],
    major_objections: [],
    minor_objections: [],
    required_revisions: [],
    eureka: { exclamation: 'Eureka!', idea: 'idea', source_ids: ['source-1'] },
    falsifiers: ['falsifier'],
    cheap_probes: ['probe'],
    confidence: 'high',
    review_artifact_bundle_sha256: digestFixture.bundle_sha256
  })
  const parent = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'done',
    thread_outcomes: ids.map((id) => ({ thread_id: 'same-thread', status: 'completed', summary: JSON.stringify(outcome(id)) })),
    changed_files: [],
    verification: [],
    blockers: []
  }
  const proseWrapped = parseOfficialReviewParentSummary(`prefix ${JSON.stringify(parent)} suffix`)
  assert.equal(proseWrapped.ok, false)
  assert.ok(proseWrapped.blockers.includes('official_subagent_parent_summary_invalid'))

  const exact = parseOfficialReviewParentSummary(JSON.stringify(parent))
  assert.equal(exact.ok, false)
  assert.ok(exact.blockers.some((blocker) => blocker.includes('parent_thread_outcome_duplicate:same-thread')))

  const wrongSchema = parseOfficialReviewParentSummary(JSON.stringify({
    ...parent,
    thread_outcomes: ids.map((id, index) => ({ thread_id: `thread-${index + 1}`, status: 'completed', summary: JSON.stringify(outcome(id)) }))
  }))
  assert.equal(wrongSchema.ok, false)
  assert.ok(wrongSchema.blockers.some((blocker) => blocker.startsWith('reviewer_schema_invalid:')))
})

test('approve with a major objection remains blocked and revisable', () => {
  const reviewers = reviewerIds.map((personaId, index) => ({
    schema: 'sks.research-adversarial-reviewer-outcome.v1' as const,
    persona_id: personaId,
    verdict: 'approve' as const,
    strongest_challenge: 'Attempted falsification',
    evidence_source_ids: ['source-1'],
    critical_objections: [],
    major_objections: index === 0 ? [{ id: 'major-1', severity: 'major' as const, claim_ids: ['claim-1'], source_ids: ['source-1'], reason: 'material flaw', required_revision: 'fix the material flaw' }] : [],
    minor_objections: [],
    required_revisions: [],
    eureka: { exclamation: 'Eureka!' as const, idea: 'bounded insight', source_ids: ['source-1'] },
    falsifiers: ['counterexample'],
    cheap_probes: ['probe'],
    confidence: 'high' as const,
    review_artifact_bundle_sha256: digestFixture.bundle_sha256,
    thread_id: `thread-${index + 1}`,
    thread_status: 'completed' as const
  }))
  const result = evaluateReviewCycle({ reviewers, review_artifacts: digestFixture, blockers: [] }, new Set(['source-1']))
  assert.equal(result.ok, false)
  assert.equal(result.open_objections, 1)
  assert.equal(result.revisable, true)
  assert.ok(result.blockers.includes('major_objections_unresolved'))
})

test('review convergence rejects stale artifact digests and source IDs outside the current ledger', () => {
  const reviewers = reviewerIds.map((personaId, index) => ({
    schema: 'sks.research-adversarial-reviewer-outcome.v1' as const,
    persona_id: personaId,
    verdict: 'approve' as const,
    strongest_challenge: 'Attempted falsification',
    evidence_source_ids: [index === 0 ? 'unknown-source' : 'source-1'],
    critical_objections: [],
    major_objections: [],
    minor_objections: [],
    required_revisions: [],
    eureka: { exclamation: 'Eureka!' as const, idea: 'bounded insight', source_ids: ['source-1'] },
    falsifiers: ['counterexample'],
    cheap_probes: ['probe'],
    confidence: 'high' as const,
    review_artifact_bundle_sha256: 'b'.repeat(64),
    thread_id: `thread-${index + 1}`,
    thread_status: 'completed' as const
  }))
  const result = evaluateReviewCycle({ reviewers, review_artifacts: digestFixture, blockers: [] }, new Set(['source-1']))
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('reviewer_artifact_bundle_sha256_mismatch:einstein'))
  assert.ok(result.blockers.includes('reviewer_evidence_source_unknown:einstein:unknown-source'))
})

test('real review convergence requires three distinct lifecycle-correlated official research_reviewer threads', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-adversarial-real-'))
  await fsp.mkdir(path.join(dir, '.codex', 'agents'), { recursive: true })
  await fsp.writeFile(path.join(dir, '.codex', 'agents', 'research-reviewer.toml'), [
    'name = "research_reviewer"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    'sandbox_mode = "read-only"'
  ].join('\n'))
  const plan = { mission_id: 'M-RESEARCH-LIFECYCLE', prompt: 'bounded evidence research', artifacts: { research_paper: 'research-paper.md' } }
  const sources = await writeVerifiedSuperSearchFixture(dir, Array.from({ length: 8 }, (_unused, index) => `source-${index + 1}`), 'lifecycle')
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources, counterevidence_sources: [] }))
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({ schema: 'sks.claim-evidence-matrix.v1', claims: [] }))
  await fsp.writeFile(path.join(dir, 'research-report.md'), '# Report\n\nEvidence-bound fixture.')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), '# Paper\n\nEvidence-bound fixture.')
  const result = await runResearchAdversarialReviewLoop({
    root: dir,
    dir,
    plan,
    timeoutMs: 1000,
    maxCycles: 1,
    appSession: false,
    runWorkflowImpl: async (workflow) => {
      const subagentPlan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
      const artifactBundle = subagentPlan.review_artifacts.bundle_sha256
      assert.match(workflow.prompt, new RegExp(artifactBundle))
      assert.ok(subagentPlan.slices.every((slice: any) => slice.agent === 'research_reviewer'))
      assert.match(workflow.prompt, /use custom agent `research_reviewer`/)
      const ids = reviewerIds
      const threadOutcomes = []
      for (const [index, personaId] of ids.entries()) {
        const threadId = `official-thread-${index + 1}`
        await recordSubagentEvent(dir, { thread_id: threadId, workflow_run_id: subagentPlan.workflow_run_id }, 'SubagentStart')
        await recordSubagentEvent(dir, { thread_id: threadId, workflow_run_id: subagentPlan.workflow_run_id }, 'SubagentStop')
        threadOutcomes.push({
          thread_id: threadId,
          status: 'completed',
          summary: JSON.stringify({
            schema: 'sks.research-adversarial-reviewer-outcome.v1',
            persona_id: personaId,
            verdict: 'approve',
            strongest_challenge: 'Attempted source-linked falsification.',
            evidence_source_ids: [`source-${index + 1}`],
            critical_objections: [],
            major_objections: [],
            minor_objections: [],
            required_revisions: [],
            eureka: { exclamation: 'Eureka!', idea: 'A bounded source-linked insight.', source_ids: [`source-${index + 1}`] },
            falsifiers: ['Remove the cited evidence.'],
            cheap_probes: ['Re-run the cited source check.'],
            confidence: 'high',
            review_artifact_bundle_sha256: artifactBundle
          })
        })
      }
      return {
        schema: 'sks.subagent-workflow.v1',
        workflow: 'official_codex_subagent',
        ok: true,
        status: 'parent_completed',
        prepared: false,
        codex_exit_code: 0,
        parent_summary: JSON.stringify({
          schema: 'sks.subagent-parent-summary.v1',
          status: 'completed',
          summary: 'All three independent composite reviewer threads completed.',
          thread_outcomes: threadOutcomes,
          changed_files: [],
          verification: [],
          blockers: []
        })
      }
    }
  })
  assert.equal(result.gate.passed, true, JSON.stringify(result.gate))
  assert.equal(result.gate.official_subagent_evidence_ok, true)
  assert.equal(result.review_cycles[0].subagent_evidence.completed_threads, reviewerIds.length)
  assert.equal(new Set(result.review_cycles[0].reviewers.map((reviewer: any) => reviewer.thread_id)).size, reviewerIds.length)
})

test('real adversarial review fails closed when the project research_reviewer config is missing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-adversarial-config-'))
  const plan = { mission_id: 'M-RESEARCH-CONFIG', prompt: 'bounded evidence research', artifacts: { research_paper: 'research-paper.md' } }
  const sources = await writeVerifiedSuperSearchFixture(dir, ['source-1'], 'config-missing')
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources, counterevidence_sources: [] }))
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({ schema: 'sks.claim-evidence-matrix.v1', claims: [] }))
  await fsp.writeFile(path.join(dir, 'research-report.md'), '# Report\n\nEvidence-bound fixture.')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), '# Paper\n\nEvidence-bound fixture.')
  let workflowCalled = false
  const result = await runResearchAdversarialReviewLoop({
    root: dir,
    dir,
    plan,
    timeoutMs: 1000,
    maxCycles: 1,
    appSession: false,
    runWorkflowImpl: async () => {
      workflowCalled = true
      return { status: 'parent_completed' }
    }
  })
  assert.equal(workflowCalled, false)
  assert.equal(result.gate.passed, false)
  assert.ok(result.gate.blockers.includes('research_reviewer_agent_config_missing'), JSON.stringify(result.gate))
  assert.ok(result.gate.blockers.includes('research_reviewer_name_mismatch:missing'), JSON.stringify(result.gate))
  assert.ok(result.gate.blockers.includes('research_reviewer_sandbox_mismatch:missing'), JSON.stringify(result.gate))
})

test('adversarial review uses one absolute cycle deadline and fails closed after it expires', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-adversarial-timeout-'))
  await fsp.mkdir(path.join(dir, '.codex', 'agents'), { recursive: true })
  await fsp.writeFile(path.join(dir, '.codex', 'agents', 'research-reviewer.toml'), 'name = "research_reviewer"\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\nsandbox_mode = "read-only"\n')
  const plan = { mission_id: 'M-RESEARCH-TIMEOUT', prompt: 'bounded evidence research', artifacts: { research_paper: 'research-paper.md' } }
  const sources = await writeVerifiedSuperSearchFixture(dir, ['source-1'], 'timeout')
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources, counterevidence_sources: [] }))
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({ schema: 'sks.claim-evidence-matrix.v1', claims: [] }))
  await fsp.writeFile(path.join(dir, 'research-report.md'), '# Report\n\nEvidence-bound fixture.')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), '# Paper\n\nEvidence-bound fixture.')
  const observedTimeouts: number[] = []
  const result = await runResearchAdversarialReviewLoop({
    root: dir,
    dir,
    plan,
    timeoutMs: 500,
    maxCycles: 1,
    appSession: false,
    runWorkflowImpl: async (workflow) => {
      observedTimeouts.push(Number(workflow.timeoutMs))
      return new Promise(() => {})
    }
  })
  assert.equal(observedTimeouts.length, 1)
  assert.ok(observedTimeouts[0]! <= 500 && observedTimeouts[0]! > 0)
  assert.equal(result.gate.passed, false)
  assert.ok(result.gate.blockers.includes('research_cycle_timeout_exceeded'), JSON.stringify(result.gate))
  const control = JSON.parse(await fsp.readFile(path.join(dir, 'research-execution-control.json'), 'utf8'))
  assert.equal(control.stop_reason, 'time_budget_exhausted')
})

test('Research Honest Mode distinguishes disclaimers from English and Korean overclaims', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-honest-mode-'))
  const plan = { artifacts: { research_paper: 'research-paper.md' } }
  await fsp.writeFile(path.join(dir, 'research-report.md'), 'We do not guarantee novelty or publication acceptance.')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), 'This is not proven to be a breakthrough result.')
  const disclaimer = await buildResearchHonestMode(dir, plan, 'real')
  assert.equal(disclaimer.ok, true, JSON.stringify(disclaimer))

  await fsp.writeFile(path.join(dir, 'research-report.md'), '이 연구는 아인슈타인급 천재성과 세계 최초 혁신 논문임을 보장한다.')
  const overclaim = await buildResearchHonestMode(dir, plan, 'real')
  assert.equal(overclaim.ok, false)
  assert.ok(overclaim.blockers.some((blocker) => blocker.startsWith('unsupported_genius_or_novelty_claim:')))

  for (const text of [
    'This is a world-first breakthrough paper.',
    'This revolutionary discovery establishes a novel theory.',
    'Peer reviewers will certainly accept this paper.'
  ]) {
    await fsp.writeFile(path.join(dir, 'research-report.md'), text)
    const englishOverclaim = await buildResearchHonestMode(dir, plan, 'real')
    assert.equal(englishOverclaim.ok, false, text)
  }

  await fsp.writeFile(path.join(dir, 'research-report.md'), 'This is not a world-first breakthrough paper, and peer reviewers will not necessarily accept it.')
  const negative = await buildResearchHonestMode(dir, plan, 'real')
  assert.equal(negative.ok, true, JSON.stringify(negative))

  await fsp.writeFile(path.join(dir, 'research-report.md'), 'Our paper establishes novelty.')
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({
    key_claim_ids: ['claim-1'],
    claims: [{ id: 'claim-1', claim: 'A bounded mechanism remains testable.' }]
  }))
  await fsp.writeFile(path.join(dir, 'novelty-ledger.json'), JSON.stringify({ entries: [{ id: 'claim-1', novelty: 3 }] }))
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources: [], counterevidence_sources: [] }))
  const unsupportedNovelty = await buildResearchHonestMode(dir, plan, 'real')
  assert.equal(unsupportedNovelty.ok, false)
  assert.ok(unsupportedNovelty.blockers.some((blocker: string) => blocker.startsWith('novelty_claim_without_prior_art_proof:')))
  assert.equal(unsupportedNovelty.prior_art_proof.coverage_complete, false)
})
