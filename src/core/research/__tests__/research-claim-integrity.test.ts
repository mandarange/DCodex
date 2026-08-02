import test from 'node:test'
import assert from 'node:assert/strict'
import { buildClaimEvidenceMatrixFromSourceShards } from '../research-claim-builder.js'
import { RESEARCH_SOURCE_ACQUISITION_MODEL_POLICY, researchSourceRow } from '../research-super-search.js'
import { densifyImplementationBlueprint } from '../implementation-blueprint-densifier.js'
import { linkSourceLedgerToClaimMatrix } from '../research-source-ledger-merge.js'
import { buildSourceQualityReport } from '../source-quality-report.js'
import { recalculateResearchClaimEvidenceMatrix } from '../research-claim-synthesizer.js'
import { validateClaimEvidenceMatrix } from '../claim-evidence-matrix.js'
import { normalizeResearchSynthesisOutput, validateResearchSynthesisOutput } from '../research-synthesis-writer.js'

test('Research source acquisition uses Terra Max while judgment stages remain separate', () => {
  assert.deepEqual(RESEARCH_SOURCE_ACQUISITION_MODEL_POLICY, {
    model: 'gpt-5.6-terra',
    model_reasoning_effort: 'max'
  })
})

test('unrelated live-looking sources cannot fabricate a shared high-confidence stage claim', async () => {
  const ledger = {
    sources: [
      { id: 'cat', layer: 'academic_literature', stance: 'supports', claim_ids: ['stage-claim-2'], notes: 'Domestic cat nutrition study' },
      { id: 'quantum', layer: 'official_government_data', stance: 'supports', claim_ids: ['stage-claim-2'], notes: 'Quantum error correction theorem' }
    ],
    counterevidence_sources: [
      { id: 'banana', layer: 'counterevidence_factcheck', stance: 'undermines', claim_ids: ['stage-claim-2'], notes: 'Banana crop failure report' }
    ]
  }
  const matrix = await buildClaimEvidenceMatrixFromSourceShards({
    dir: '',
    cycle: 1,
    plan: { mission_id: 'M1' },
    sourceLedger: ledger,
    noveltyLedger: null,
    falsificationLedger: null
  })
  assert.equal(matrix.claims.some((claim) => claim.id === 'stage-claim-2' && claim.confidence === 'high'), false)
  assert.equal(matrix.triangulated_claim_count, 0)
})

test('live Super Search rows use content-derived source claims and conservative stance', () => {
  const baseSource: any = {
    source_id: 'source-1',
    provider_id: 'codex_web',
    source_family: 'web',
    source_type: 'article',
    title: 'A neutral page mentioning the topic',
    canonical_url: 'https://example.com/neutral',
    original_url: 'https://example.com/neutral',
    domain: 'example.com',
    author: 'Example',
    published_at: '2026-01-01',
    updated_at: null,
    retrieved_at: '2026-01-02T00:00:00.000Z',
    language: 'en',
    snippet: 'This page provides background context without a failure or refutation finding.',
    content_artifact: 'content/source-1.txt',
    content_sha256: 'abc',
    content_length: 100,
    acquisition_verdict: 'verified_content',
    acquisition_path: ['web'],
    authority_tier: 'A1',
    freshness_score: 1,
    relevance_score: 1,
    trust_score: 0.9,
    primary_source: true,
    authenticated_source: false,
    local_only_raw: false,
    duplicate_cluster_id: null,
    independence_cluster_id: null,
    warnings: [],
    blockers: []
  }
  const row = researchSourceRow(baseSource, {
    id: 'counterevidence_factcheck',
    label: 'Counterevidence',
    purpose: 'Find failures',
    evidence_role: 'falsification',
    examples: [],
    query_templates: []
  })
  assert.match(row.claim_ids[0] || '', /^source-claim-[a-f0-9]{16}$/)
  assert.equal(row.stance, 'context')
})

test('live source acquisition never infers counterevidence from generic negative keywords', () => {
  const source: any = {
    source_id: 'source-counter',
    provider_id: 'direct_url',
    source_family: 'web',
    source_type: 'article',
    title: 'Quantum gravity experiment failed independent replication',
    canonical_url: 'https://example.com/quantum-gravity-failure',
    original_url: 'https://example.com/quantum-gravity-failure',
    domain: 'example.com',
    author: 'Example',
    published_at: '2026-01-01',
    updated_at: null,
    retrieved_at: '2026-01-02T00:00:00.000Z',
    language: 'en',
    snippet: 'The quantum gravity result failed replication and contradicts the claimed proof.',
    content_artifact: 'content/source-counter.txt',
    content_sha256: 'a'.repeat(64),
    content_length: 200,
    acquisition_verdict: 'verified_content',
    acquisition_path: ['direct_url_fetch'],
    authority_tier: 'A1',
    freshness_score: 1,
    relevance_score: 1,
    trust_score: 0.9,
    primary_source: true,
    authenticated_source: false,
    local_only_raw: false,
    duplicate_cluster_id: null,
    independence_cluster_id: 'example.com',
    warnings: [],
    blockers: []
  }
  const row = researchSourceRow(source, {
    id: 'counterevidence_factcheck',
    label: 'Counterevidence',
    purpose: 'Find failures',
    evidence_role: 'falsification',
    examples: [],
    query_templates: []
  })
  assert.equal(row.stance, 'context')
  assert.equal(row.counterevidence_target_claim_id, undefined)
  assert.equal(row.contradiction_rationale, undefined)

  const unrelated = researchSourceRow({ ...source, title: 'Banana crop failure', snippet: 'Banana exports failed this year.' }, {
    id: 'counterevidence_factcheck',
    label: 'Counterevidence',
    purpose: 'Find failures',
    evidence_role: 'falsification',
    examples: [],
    query_templates: []
  })
  assert.equal(unrelated.stance, 'context')
  assert.equal(unrelated.counterevidence_target_claim_id, undefined)
})

test('claim synthesis accepts counterevidence only through an exact claim-relative structured link', () => {
  const counter = verifiedSource('counter', 'counterevidence_factcheck', 'Quantum gravity proof failed independent replication', 'counter.example')
  const ledger = { sources: [counter], counterevidence_sources: [] }
  const matrix = recalculateResearchClaimEvidenceMatrix(singleClaimMatrix([], ['counter']), { mission_id: 'M-counter-link' }, ledger)
  assert.deepEqual(matrix.claims[0]?.counterevidence_ids, ['counter'])
  assert.equal(matrix.claims[0]?.counterevidence_links[0]?.target_claim_id, 'claim-1')
  const linked = linkSourceLedgerToClaimMatrix(ledger, matrix)
  assert.deepEqual(linked.counterevidence_sources.map((row: any) => row.id), ['counter'])
  assert.equal(linked.counterevidence_sources[0]?.counterevidence_target_claim_id, 'claim-1')
})

test('generic scientific questions produce a research-validation blueprint instead of an SKS code plan', async () => {
  const blueprint = await densifyImplementationBlueprint({
    root: process.cwd(),
    dir: '/tmp',
    plan: { mission_id: 'M1', prompt: 'derive a new quantum gravity theorem', artifacts: { research_paper: 'quantum-gravity-research-paper.md' } },
    claimMatrix: { key_claim_ids: ['c1'], claims: [{ id: 'c1', claim: 'quantum gravity evidence', importance: 'high' }] },
    sourceLedger: {},
    existingBlueprint: null,
    backend: 'deterministic'
  })
  assert.equal(blueprint.handoff_type, 'research_validation')
  assert.equal(blueprint.repository_aware, false)
  assert.equal(blueprint.existing_files.some((file: string) => file.startsWith('src/core/research/')), false)
  assert.doesNotMatch(JSON.stringify(blueprint), /final\.md|release-gates\.v2|npm run release/i)
})

test('context-only source rows remain complete metadata without becoming cited claims', () => {
  const sourceLedger = {
    sources: [{
      id: 'context-source',
      layer: 'public_discourse',
      kind: 'article',
      title: 'Background context',
      locator: 'https://example.com/context',
      publisher_or_author: 'Example',
      accessed_at: '2026-07-13T00:00:00.000Z',
      reliability: 'medium',
      credibility: 'contextual',
      stance: 'context',
      claim_ids: []
    }],
    counterevidence_sources: [],
    source_layers: [{ id: 'public_discourse', status: 'covered' }],
    citation_coverage: { all_key_claims_cited: true }
  }
  const report = buildSourceQualityReport(sourceLedger, { key_claim_ids: [] })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.sources[0]?.missing_fields.includes('claim_ids'), false)
})

test('mock claim synthesis selects only evidence-linked claims as key claims', async () => {
  const sourceLedger = {
    sources: [
      { id: 'support-1', layer: 'academic_literature', kind: 'deterministic_fixture', stance: 'supports', claim_ids: ['claim-1'], notes: 'Evidence one.' },
      { id: 'context-1', layer: 'public_discourse', kind: 'deterministic_fixture', stance: 'context', claim_ids: ['context-candidate'], notes: 'Context only.' }
    ],
    counterevidence_sources: [
      { id: 'counter-1', layer: 'counterevidence_factcheck', kind: 'deterministic_fixture', stance: 'undermines', claim_ids: ['claim-1'], notes: 'Counterevidence.' }
    ]
  }
  const matrix = await buildClaimEvidenceMatrixFromSourceShards({
    dir: '',
    cycle: 1,
    plan: { mission_id: 'M-key-claims' },
    sourceLedger,
    noveltyLedger: null,
    falsificationLedger: null
  })
  assert.deepEqual(matrix.key_claim_ids, ['claim-1'])
  assert.equal(matrix.key_claim_ids.some((id) => id.startsWith('unlinked-source-')), false)
  const linked = linkSourceLedgerToClaimMatrix(sourceLedger, matrix)
  assert.equal(linked.citation_coverage.all_key_claims_cited, true)
  assert.deepEqual(linked.sources.find((row: any) => row.id === 'context-1')?.claim_ids, [])
})

test('weak or semantically unrelated rows cannot become high-confidence real evidence', () => {
  const weak = (id: string, layer: string, text: string) => ({
    id,
    layer,
    kind: 'web_result',
    title: text,
    locator: `https://example.com/${id}`,
    publisher_or_author: 'Example',
    accessed_at: '2026-07-13T00:00:00.000Z',
    reliability: 'high',
    credibility: 'weak_content:0.20',
    stance: layer === 'counterevidence_factcheck' ? 'undermines' : 'context',
    claim_ids: [],
    notes: text,
    acquisition_verdict: 'weak_content',
    domain: 'example.com',
    independence_cluster_id: 'example.com'
  })
  const ledger = {
    sources: [
      weak('s1', 'academic_literature', 'Quantum cat nutrition survey'),
      weak('s2', 'official_government_data', 'Quantum banana export statistics'),
      weak('s3', 'public_discourse', 'Quantum fashion discussion')
    ],
    counterevidence_sources: [weak('c1', 'counterevidence_factcheck', 'Quantum bicycle criticism')]
  }
  const matrix = recalculateResearchClaimEvidenceMatrix(singleClaimMatrix(['s1', 's2', 's3'], ['c1']), { mission_id: 'M-weak' }, ledger)
  assert.equal(matrix.claims[0]?.confidence, 'low')
  assert.deepEqual(matrix.claims[0]?.source_ids, [])
  assert.ok(matrix.blockers.some((blocker) => blocker.startsWith('claim_source_not_verified:')))
  assert.ok(matrix.blockers.includes('unsupported_important_claim:claim-1'))
})

test('same-domain sources do not count as independent confirmations', () => {
  const ledger = {
    sources: ['s1', 's2', 's3'].map((id) => verifiedSource(id, 'academic_literature', 'Quantum gravity theory evidence', 'same.example')),
    counterevidence_sources: []
  }
  const matrix = recalculateResearchClaimEvidenceMatrix(singleClaimMatrix(['s1', 's2', 's3'], [], 'high'), { mission_id: 'M-domain' }, ledger)
  assert.equal(matrix.claims[0]?.triangulation.independent_confirmation_count, 1)
  assert.equal(matrix.claims[0]?.confidence, 'low')
  assert.ok(matrix.blockers.includes('unsupported_important_claim:claim-1'))
})

test('verified counterevidence without a structured target and rationale is rejected', () => {
  const counter = {
    ...verifiedSource('counter', 'counterevidence_factcheck', 'Quantum gravity proof failed replication', 'counter.example'),
    stance: 'undermines'
  }
  const ledger = { sources: [], counterevidence_sources: [counter] }
  const matrix = recalculateResearchClaimEvidenceMatrix(singleClaimMatrix([], ['counter'], 'critical', false), { mission_id: 'M-counter-link' }, ledger)
  assert.deepEqual(matrix.claims[0]?.counterevidence_ids, [])
  assert.ok(matrix.blockers.includes('claim_counterevidence_link_missing:claim-1:counter'))
})

test('claim validation rejects dangling or cross-claim counterevidence links', () => {
  const ledger = { sources: [verifiedSource('counter', 'counterevidence_factcheck', 'Quantum gravity proof failed replication', 'counter.example')], counterevidence_sources: [] }
  const matrix: any = singleClaimMatrix([], ['counter'])
  matrix.claims[0].counterevidence_links = [
    { source_id: 'counter', target_claim_id: 'different-claim', contradiction_rationale: 'This directly contradicts the conclusive quantum gravity proof claim.' },
    { source_id: 'unlisted', target_claim_id: 'claim-1', contradiction_rationale: 'This directly contradicts the conclusive quantum gravity proof claim.' }
  ]
  const validation = validateClaimEvidenceMatrix(matrix, ledger, null)
  assert.equal(validation.ok, false)
  assert.ok(validation.blockers.includes('claim_counterevidence_target_mismatch:claim-1:counter'))
  assert.ok(validation.blockers.includes('claim_counterevidence_link_unlisted:claim-1:unlisted'))
  assert.ok(validation.blockers.includes('claim_counterevidence_link_source_unknown:claim-1:unlisted'))
})

test('semantic links preserve original source stance and acquisition class', () => {
  const source = verifiedSource('s1', 'academic_literature', 'Quantum gravity evidence remains uncertain', 'academic.example')
  const ledger = {
    sources: [source],
    counterevidence_sources: [],
    source_layers: [{ id: 'academic_literature', status: 'covered' }],
    citation_coverage: { all_key_claims_cited: false }
  }
  const matrix = recalculateResearchClaimEvidenceMatrix(singleClaimMatrix(['s1'], [], 'medium'), { mission_id: 'M-stance' }, ledger)
  const linked = linkSourceLedgerToClaimMatrix(ledger, matrix)
  assert.equal(linked.sources[0]?.stance, 'context')
  assert.equal(linked.sources[0]?.acquisition_verdict, 'verified_content')
  assert.deepEqual(linked.sources[0]?.supports, ['claim-1'])
  assert.equal(buildSourceQualityReport(linked, matrix).ok, true)
})

test('semantic links reject a real source whose Super Search provenance was not validated', () => {
  const source = {
    ...verifiedSource('s-unvalidated', 'academic_literature', 'Unvalidated source row', 'academic.example'),
    super_search_provenance: { validated: false }
  }
  const ledger = { sources: [source], counterevidence_sources: [] }
  const matrix = singleClaimMatrix(['s-unvalidated'], [], 'medium')
  const linked = linkSourceLedgerToClaimMatrix(ledger, matrix)
  assert.deepEqual(linked.sources[0]?.supports, [])
  assert.ok(linked.claim_link_blockers.includes('claim_support_source_untrusted:claim-1:s-unvalidated'))
})

test('synthesis validation rejects global references without claim-local semantics and citations', () => {
  const sourceIds = ['source-1', 'source-2', 'source-3', 'source-4']
  const headings = ['Question', 'Methodology', 'Source Map', 'Key Claims', 'Evidence Matrix Summary', 'Counterevidence', 'Falsification', 'Implementation Blueprint', 'Experiment / Validation Plan', 'Limitations', 'References']
  const report = headings.map((heading, index) => `## ${heading}\n${heading === 'Implementation Blueprint' ? Array.from({ length: 330 }, (_unused, word) => `implementation${word}`).join(' ') : `section${index} claim-filler-${index + 1}`}`).join('\n\n') + `\n\n${sourceIds.join(' ')}`
  const paper = ['Abstract', 'Introduction', 'Methodology', 'Findings', 'Discussion', 'Limitations', 'Conclusion', 'References'].map((heading) => `## ${heading}\npaper`).join('\n')
  const output = normalizeResearchSynthesisOutput({
    schema: 'sks.research-synthesis-output.v1',
    mission_id: 'M-synthesis',
    report_markdown: report,
    paper_markdown: paper,
    synthesis_summary: { key_claim_ids: ['claim-1'], source_ids_used: sourceIds, counterevidence_ids_used: [], blueprint_sections_used: [], experiment_steps_used: [] },
    blockers: []
  })
  const claimMatrix = { key_claim_ids: ['claim-1'], claims: [{ id: 'claim-1', claim: 'Quantum gravity evidence remains uncertain', source_ids: ['source-1'], counterevidence_ids: [], counterevidence_links: [] }] }
  const validation = validateResearchSynthesisOutput(output, { min_report_words: 1, min_key_claims: 1 }, claimMatrix, { sources: sourceIds.map((id) => ({ id })), counterevidence_sources: [] })
  assert.equal(validation.ok, false)
  assert.ok(validation.blockers.includes('research_synthesis_key_claim_id_missing:claim-1'))
  assert.ok(validation.blockers.includes('research_synthesis_key_claim_local_citation_missing:claim-1'))
})

function singleClaimMatrix(sourceIds: string[], counterevidenceIds: string[], importance = 'critical', structuredLinks = true) {
  return {
    schema: 'sks.claim-evidence-matrix.v1',
    mission_id: 'M-claim',
    claims: [{
      id: 'claim-1',
      claim: 'Quantum gravity has been conclusively proven',
      claim_type: 'fact',
      importance,
     source_ids: sourceIds,
     local_evidence_ids: [],
     counterevidence_ids: counterevidenceIds,
      counterevidence_links: structuredLinks ? counterevidenceIds.map((sourceId) => ({
        source_id: sourceId,
        target_claim_id: 'claim-1',
        contradiction_rationale: 'Quantum gravity proof failed independent replication and directly challenges the conclusive proof claim.'
      })) : [],
     triangulation: { source_layers: [], independent_confirmation_count: 0, conflicts: [] },
      confidence: 'low',
      falsifiable: true,
      test_or_probe: 'Replicate the result.'
    }],
    key_claim_ids: ['claim-1'],
    unsupported_claims: [],
    triangulated_claim_count: 0,
    blockers: []
  }
}

function verifiedSource(id: string, layer: string, text: string, domain: string) {
  return {
    id,
    layer,
    kind: 'known_url',
    title: text,
    locator: `https://${domain}/${id}`,
    publisher_or_author: domain,
    accessed_at: '2026-07-13T00:00:00.000Z',
    reliability: 'high',
    credibility: 'verified_content:0.95',
    stance: 'context',
    claim_ids: [],
    notes: text,
    acquisition_verdict: 'verified_content',
    content_artifact: `content/${id}.txt`,
    content_sha256: 'a'.repeat(64),
    content_length: 200,
    domain,
    authority_tier: 'A1',
    primary_source: true,
    independence_cluster_id: domain,
    super_search_provenance: { validated: true }
  }
}
