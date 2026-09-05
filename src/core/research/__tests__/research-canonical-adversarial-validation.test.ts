import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateCanonicalResearchAdversarialEvidence } from '../../research.js'
import { recordSubagentEvent, writeSubagentEvidence } from '../../subagents/subagent-evidence.js'
import { buildResearchReviewArtifactDigest } from '../research-review-artifact-digest.js'
import { writeVerifiedSuperSearchFixture } from './research-source-evidence-fixture.js'

const personas = ['evidence', 'method', 'falsification']

test('canonical Research gate validates three lifecycle-correlated official reviewer threads', async () => {
  const fixture = await writeCanonicalFixture()
  const result = await validateCanonicalResearchAdversarialEvidence(fixture.dir)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.official_subagent_evidence_ok, true)
  assert.equal(result.reviewer_thread_ids.length, personas.length)
})

test('canonical Research gate fails closed on ambiguous parent outcome text', async () => {
  const fixture = await writeCanonicalFixture()
  fixture.parent.thread_outcomes[0]!.summary = 'Reviewer result is pending and verification was not run.'
  await fsp.writeFile(path.join(fixture.dir, 'subagent-parent-summary.json'), JSON.stringify(fixture.parent))
  const result = await validateCanonicalResearchAdversarialEvidence(fixture.dir)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some((blocker: string) => blocker.includes('parent_thread_outcome_text_contradiction') || blocker.includes('parent_outcome_invalid')), JSON.stringify(result))
})

test('canonical Research gate requires a fresh review cycle after every revision', async () => {
  const fixture = await writeCanonicalFixture()
  await fsp.writeFile(path.join(fixture.dir, 'research-revision-ledger.json'), JSON.stringify({
    schema: 'sks.research-revision-ledger.v1',
    generated_at: '2026-07-13T01:00:00.000Z',
    bounded_max_cycles: 3,
    revisions: [{ cycle: 1, revised_at: '2026-07-13T01:00:00.000Z', ok: true, workflow_run_id: 'revision-run-1', blockers: [] }],
    blockers: []
  }))
  const convergence = JSON.parse(await fsp.readFile(path.join(fixture.dir, 'research-adversarial-convergence.json'), 'utf8'))
  convergence.revision_cycles = 1
  await fsp.writeFile(path.join(fixture.dir, 'research-adversarial-convergence.json'), JSON.stringify(convergence))
  const result = await validateCanonicalResearchAdversarialEvidence(fixture.dir)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some((blocker: string) => blocker.includes('revision_not_followed_by_review') || blocker.includes('post_revision_review_not_fresh')), JSON.stringify(result))
})

test('canonical Research gate rejects a manuscript changed after the recorded review digest', async () => {
  const fixture = await writeCanonicalFixture()
  await fsp.appendFile(path.join(fixture.dir, 'research-report.md'), '\nPost-review mutation.\n')
  const result = await validateCanonicalResearchAdversarialEvidence(fixture.dir)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some((blocker: string) => blocker.includes('artifact_bundle_sha256_mismatch')), JSON.stringify(result))
})

test('canonical Research gate rejects reviewer source IDs absent from the current source ledger', async () => {
  const fixture = await writeCanonicalFixture()
  const ledger = JSON.parse(await fsp.readFile(path.join(fixture.dir, 'research-adversarial-review.json'), 'utf8'))
  ledger.review_cycles[0].reviewers[0].evidence_source_ids = ['source-not-in-ledger']
  await fsp.writeFile(path.join(fixture.dir, 'research-adversarial-review.json'), JSON.stringify(ledger))
  const result = await validateCanonicalResearchAdversarialEvidence(fixture.dir)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some((blocker: string) => blocker.includes('reviewer_source_unknown')), JSON.stringify(result))
})

async function writeCanonicalFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-canonical-review-'))
  const runId = 'research-review-run-1'
  const reviewedAt = '2026-07-13T00:00:00.000Z'
  await fsp.writeFile(path.join(dir, 'research-plan.json'), JSON.stringify({ mission_id: 'M-canonical', artifacts: { research_paper: 'research-paper.md' } }))
  await fsp.writeFile(path.join(dir, 'research-report.md'), '# Research report\n\nEvidence-bound fixture.\n')
  await fsp.writeFile(path.join(dir, 'research-paper.md'), '# Research paper\n\nEvidence-bound fixture.\n')
  const verifiedSources = await writeVerifiedSuperSearchFixture(dir, personas.map((_persona, index) => `source-${index + 1}`), 'canonical')
  await fsp.writeFile(path.join(dir, 'source-ledger.json'), JSON.stringify({ sources: verifiedSources, counterevidence_sources: [] }))
  await fsp.writeFile(path.join(dir, 'claim-evidence-matrix.json'), JSON.stringify({ schema: 'sks.claim-evidence-matrix.v1', mission_id: 'M-canonical', claims: [], key_claim_ids: [], unsupported_claims: [], triangulated_claim_count: 0, blockers: [] }))
  const reviewArtifacts = await buildResearchReviewArtifactDigest(dir, { artifacts: { research_paper: 'research-paper.md' } })
  const reviewers = personas.map((personaId, index) => ({
    schema: 'sks.research-adversarial-reviewer-outcome.v1',
    persona_id: personaId,
    verdict: 'approve',
    strongest_challenge: 'Attempted a source-linked falsification of the manuscript.',
    evidence_source_ids: [`source-${index + 1}`],
    critical_objections: [],
    major_objections: [],
    minor_objections: [],
    required_revisions: [],
    falsifiers: ['Remove the cited source.'],
    cheap_probes: ['Re-run the evidence check.'],
    confidence: 'high',
    review_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
    thread_id: `official-thread-${index + 1}`,
    thread_status: 'completed'
  }))
  const parent = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'All three composite reviewer threads completed with structured outcomes.',
    run_id: runId,
    thread_outcomes: reviewers.map(({ thread_id, thread_status: _threadStatus, ...outcome }) => ({
      thread_id,
      status: 'completed',
      summary: JSON.stringify(outcome)
    })),
    changed_files: [],
    verification: [],
    blockers: []
  }
  await fsp.writeFile(path.join(dir, 'subagent-parent-summary.json'), JSON.stringify(parent))
  for (const reviewer of reviewers) {
    await recordSubagentEvent(dir, { thread_id: reviewer.thread_id, workflow_run_id: runId }, 'SubagentStart')
    await recordSubagentEvent(dir, { thread_id: reviewer.thread_id, workflow_run_id: runId }, 'SubagentStop')
  }
  await writeSubagentEvidence(dir, { requestedSubagents: personas.length, parentSummary: parent, parentSummaryPresent: true, workflowStatus: 'parent_completed', runId })
  await fsp.writeFile(path.join(dir, 'research-adversarial-review.json'), JSON.stringify({
    schema: 'sks.research-adversarial-review-ledger.v1',
    generated_at: reviewedAt,
    execution_class: 'real',
    review_cycles: [{ schema: 'sks.research-adversarial-review-cycle.v1', cycle: 1, execution_class: 'real', reviewed_at: reviewedAt, workflow_run_id: runId, review_artifacts: reviewArtifacts, reviewers, blockers: [] }],
    final_cycle: 1,
    blockers: []
  }))
  await fsp.writeFile(path.join(dir, 'research-revision-ledger.json'), JSON.stringify({ schema: 'sks.research-revision-ledger.v1', generated_at: reviewedAt, bounded_max_cycles: 3, revisions: [], blockers: [] }))
  await fsp.writeFile(path.join(dir, 'research-adversarial-convergence.json'), JSON.stringify({
    schema: 'sks.research-adversarial-convergence.v1', checked_at: reviewedAt, execution_class: 'real', passed: true,
    official_subagent_workflow: true, official_subagent_evidence_ok: true, workflow_run_id: runId,
    reviewer_count_required: personas.length, reviewer_count_observed: personas.length, review_cycles: 1, revision_cycles: 0,
    review_artifacts: reviewArtifacts, review_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
    current_artifact_bundle_sha256: reviewArtifacts.bundle_sha256, review_artifact_hashes_ok: true,
    unresolved_critical_objections: 0, unresolved_major_objections: 0, unresolved_material_objections: 0, advisory_objections: 0, honest_mode_ok: true,
    novelty_guaranteed: false, publication_acceptance_guaranteed: false, blockers: []
  }))
  await fsp.writeFile(path.join(dir, 'research-honest-mode.json'), JSON.stringify({
    schema: 'sks.research-honest-mode.v1', checked_at: reviewedAt, execution_class: 'real', ok: true,
    guarantees: { novelty: false, breakthrough: false, publication_acceptance: false }, blockers: []
  }))
  return { dir, parent }
}
