import path from 'node:path';
import { ASTRA_SUBAGENT_MODEL, SUBAGENT_EFFORT } from '../subagents/model-policy.js';
import { nowIso, writeJsonAtomic, writeTextAtomic } from '../fsx.js';
import { CLAIM_EVIDENCE_MATRIX_ARTIFACT, buildClaimEvidenceMatrixFromLedgers, writeClaimEvidenceMatrix } from './claim-evidence-matrix.js';
import { DEFAULT_RESEARCH_QUALITY_CONTRACT, writeResearchQualityContract } from './research-quality-contract.js';
import { SOURCE_QUALITY_REPORT_ARTIFACT, writeSourceQualityReport } from './source-quality-report.js';
import { defaultImplementationBlueprint, writeImplementationBlueprint } from './implementation-blueprint.js';
import { IMPLEMENTATION_BLUEPRINT_MARKDOWN_ARTIFACT, renderImplementationBlueprintMarkdown } from './implementation-blueprint-markdown.js';
import { defaultExperimentPlan, writeExperimentPlan } from './experiment-plan.js';
import { defaultReplicationPack, writeReplicationPack } from './replication-pack.js';
import { writeResearchHandoffArtifacts } from './research-handoff.js';
import { writeResearchWorkGraph } from './research-work-graph.js';
import { analyzeResearchReportQuality } from './research-report-quality.js';
import { buildRealisticResearchPaper, buildRealisticResearchReport } from './research-realistic-report.js';
import { buildResearchReviewArtifactDigest } from './research-review-artifact-digest.js';
import { defaultAgentLedger, defaultResearchGate, defaultSourceLedger, evaluateResearchGate, researchAgentAgentName, RESEARCH_AGENT_COUNCIL, RESEARCH_PAPER_SECTION_GROUPS, researchPaperArtifactForPlan, RESEARCH_REVIEWER_CUSTOM_AGENT, RESEARCH_SOURCE_LAYER_IDS, RESEARCH_SOURCE_LAYERS, RESEARCH_SOURCE_SKILL_ARTIFACT, researchSourceSkillMarkdown } from '../research.js';

export async function writeMockResearchResult(dir: any, plan: any) {
  const paperArtifact = researchPaperArtifactForPlan(plan);
  const mockClaimIds = Array.from({ length: DEFAULT_RESEARCH_QUALITY_CONTRACT.min_key_claims }, (_unused, index) => `mock-claim-${index + 1}`);
  const primaryMockSources = RESEARCH_SOURCE_LAYERS.map((layer: any, index: any) => ({
    id: `mock-source-${index + 1}`,
    layer: layer.id,
    kind: 'selftest',
    title: `Mock ${layer.label} coverage`,
    locator: 'writeMockResearchResult',
    publisher_or_author: 'SKS mock research fixture',
    published_at: nowIso().slice(0, 10),
    accessed_at: nowIso(),
    reliability: 'mock',
    credibility: 'mock',
    stance: layer.id === 'counterevidence_factcheck' ? 'undermines' : 'supports',
    supports: layer.id === 'counterevidence_factcheck' ? [] : [mockClaimIds[index % mockClaimIds.length]],
    undermines: layer.id === 'counterevidence_factcheck' ? [mockClaimIds[0]] : [],
    claim_ids: [mockClaimIds[index % mockClaimIds.length]],
    ...(layer.id === 'counterevidence_factcheck' ? {
      counterevidence_target_claim_id: mockClaimIds[0],
      contradiction_rationale: `Mock-only fixture explicitly challenges ${mockClaimIds[0]}.`
    } : {}),
    notes: `Selftest fixture for the ${layer.id} source layer; no live web call is made in --mock mode.`
  }));
  const supplementalMockSources = RESEARCH_SOURCE_LAYERS.map((layer: any, index: any) => ({
    id: `mock-source-${index + 8}`,
    layer: layer.id,
    kind: 'selftest-supplement',
    title: `Supplemental mock ${layer.label} triangulation`,
    locator: 'writeMockResearchResult',
    publisher_or_author: 'SKS mock research fixture',
    published_at: nowIso().slice(0, 10),
    accessed_at: nowIso(),
    reliability: 'mock',
    credibility: 'mock',
    stance: layer.id === 'counterevidence_factcheck' ? 'undermines' : 'supports',
    supports: layer.id === 'counterevidence_factcheck' ? [] : [mockClaimIds[(index + 1) % mockClaimIds.length]],
    undermines: layer.id === 'counterevidence_factcheck' ? [mockClaimIds[(index + 2) % mockClaimIds.length]] : [],
    claim_ids: [mockClaimIds[(index + 1) % mockClaimIds.length]],
    ...(layer.id === 'counterevidence_factcheck' ? {
      counterevidence_target_claim_id: mockClaimIds[(index + 2) % mockClaimIds.length],
      contradiction_rationale: `Mock-only fixture explicitly challenges ${mockClaimIds[(index + 2) % mockClaimIds.length]}.`
    } : {}),
    notes: `Second selftest source for ${layer.id}; it makes source-count and triangulation checks non-trivial.`
  }));
  const mockLayerSources = [...primaryMockSources, ...supplementalMockSources];
  const sourceLedger = {
    schema_version: 1,
    policy: 'layered_source_retrieval_and_triangulation',
    created_at: nowIso(),
    mode: 'selftest_mock',
    source_layer_skill: {
      artifact: RESEARCH_SOURCE_SKILL_ARTIFACT,
      status: 'created'
    },
    web_search_passes: 1,
    source_layers: RESEARCH_SOURCE_LAYERS.map((layer: any, index: any) => ({
      id: layer.id,
      label: layer.label,
      required: true,
      status: 'covered',
      evidence_role: layer.evidence_role,
      query_templates: layer.query_templates || [],
      source_ids: [`mock-source-${index + 1}`, `mock-source-${index + 8}`],
      counterevidence_ids: layer.id === 'counterevidence_factcheck' ? ['mock-counter-1', 'mock-counter-2'] : [],
      blocker: null,
      notes: 'Mock mode records layer coverage without live web access.'
    })),
    layer_coverage: {
      required: [...RESEARCH_SOURCE_LAYER_IDS],
      covered: [...RESEARCH_SOURCE_LAYER_IDS],
      missing: [],
      notes: ['mock fixture covers every research source layer']
    },
    queries: RESEARCH_SOURCE_LAYERS.map((layer: any) => ({
      agent_id: layer.id === 'counterevidence_factcheck' ? 'skeptic' : null,
      layer: layer.id,
      query: `mock ${layer.id} layered research source search for ${plan.prompt}`,
      status: 'mocked'
    })),
    sources: mockLayerSources,
    counterevidence_sources: [
      {
        id: 'mock-counter-1',
        layer: 'counterevidence_factcheck',
        kind: 'selftest',
        title: 'Mock overclaim counterexample',
        locator: 'writeMockResearchResult',
        publisher_or_author: 'SKS mock research fixture',
        published_at: nowIso().slice(0, 10),
        accessed_at: nowIso(),
        reliability: 'mock',
        credibility: 'mock',
        stance: 'undermines',
        undermines: [mockClaimIds[0]],
        claim_ids: [mockClaimIds[0]],
        counterevidence_target_claim_id: mockClaimIds[0],
        contradiction_rationale: `Mock-only fixture explicitly challenges ${mockClaimIds[0]}.`,
        notes: 'Shows the gate must fail if a run produces no tests or falsifiers.'
      },
      {
        id: 'mock-counter-2',
        layer: 'counterevidence_factcheck',
        kind: 'selftest',
        title: 'Mock missing-replication counterexample',
        locator: 'writeMockResearchResult',
        publisher_or_author: 'SKS mock research fixture',
        published_at: nowIso().slice(0, 10),
        accessed_at: nowIso(),
        reliability: 'mock',
        credibility: 'mock',
        stance: 'undermines',
        undermines: [mockClaimIds[1]],
        claim_ids: [mockClaimIds[1]],
        counterevidence_target_claim_id: mockClaimIds[1],
        contradiction_rationale: `Mock-only fixture explicitly challenges ${mockClaimIds[1]}.`,
        notes: 'Shows the gate must fail if replication commands and experiment steps are absent.'
      }
    ],
    triangulation: {
      cross_layer_checks: [
        {
          id: 'mock-triangulation-1',
          claim: 'Research Mode should not synthesize from a single corpus.',
          source_ids: ['mock-source-1', 'mock-source-2', 'mock-source-5', 'mock-counter-1'],
          result: 'survives_with_layered_evidence_requirement'
        },
        {
          id: 'mock-triangulation-2',
          claim: 'Public discourse is useful only when checked against formal and official layers.',
          source_ids: ['mock-source-1', 'mock-source-2', 'mock-source-5', 'mock-source-6'],
          result: 'downgrade_popularity_to_signal_not_truth'
        }
      ],
      conflicts: [],
      synthesis_notes: ['mock fixture requires cross-layer checks before synthesis']
    },
    quality_model: defaultSourceLedger(plan).quality_model,
    citation_coverage: {
      all_key_claims_cited: true,
      key_claim_ids: mockClaimIds,
      cited_claim_ids: mockClaimIds,
      uncited_claim_ids: [],
      source_claim_map: Object.fromEntries(mockLayerSources.map((source: any) => [source.id, source.claim_ids || []])),
      notes: ['mock report, claim matrix, and novelty ledger cite all mock key claims']
    },
    blockers: []
  };
  const agentLedger = {
    ...defaultAgentLedger(plan),
    agents: RESEARCH_AGENT_COUNCIL.map((agent: any) => ({
      id: agent.id,
      agent_name: researchAgentAgentName(agent),
      display_name: agent.display_name || agent.label,
      persona: agent.persona || agent.role,
      persona_boundary: agent.persona_boundary,
      role: agent.role,
      mandate: agent.mandate,
      model_policy: {
        custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
        model: ASTRA_SUBAGENT_MODEL,
        reasoning_effort: SUBAGENT_EFFORT,
        enforcement_source: 'mock_fixture'
      },
      query_set: sourceLedger.queries.filter((query: any) => query.agent_id === agent.id).map((query: any) => query.query),
      findings: [
        {
          id: `mock-${agent.id}-finding-1`,
          claim: `${agent.display_name || agent.label} supports a source-cited, falsifiable research gate for ${plan.prompt}.`,
          source_ids: ['mock-source-1'],
          status: 'mock_supported'
        }
      ],
      falsifiers: ['A run without cited sources, counterevidence, or cheap probes should fail the research gate.'],
      cheap_probes: ['Compare discovery-loop output against a summary-only baseline and count testable insights.'],
      challenge_or_response: 'Participated in the mock evidence-bound debate.'
    })),
    synthesis: {
      surviving_claims: ['mock-insight-1'],
      downgraded_claims: [],
      unresolved_conflicts: []
    }
  };
  const debateLedger = {
    schema_version: 1,
    created_at: nowIso(),
    mode: 'independent_evidence_bound_reviews',
    required_participants: RESEARCH_AGENT_COUNCIL.map((agent: any) => agent.id),
    participant_display_names: RESEARCH_AGENT_COUNCIL.map((agent: any) => researchAgentAgentName(agent)),
    consensus_iterations: 2,
    review_complete: true,
    agent_agreements: RESEARCH_AGENT_COUNCIL.map((agent: any) => ({
      agent_id: agent.id,
      agent_name: researchAgentAgentName(agent),
      display_name: agent.display_name || agent.label,
      material_objections_resolved: true,
      final_position: 'Agrees to keep the falsifiable, source-cited research mechanism as the surviving claim.',
      source_ids: ['mock-source-1', 'mock-counter-1']
    })),
    exchanges: [
      { id: 'mock-review-1', from: 'evidence', to: 'research_synthesis', stance: 'challenge', claim: 'The source links must support the stated claim and include counterevidence.', source_ids: ['mock-source-1'] },
      { id: 'mock-review-2', from: 'method', to: 'research_synthesis', stance: 'challenge', claim: 'The method must expose its assumptions, inputs, outputs, and limits.', source_ids: ['mock-source-1', 'mock-counter-1'] },
      { id: 'mock-review-3', from: 'falsification', to: 'research_synthesis', stance: 'challenge', claim: 'The claim must be downgraded if counterevidence or replication checks fail.', source_ids: ['mock-counter-1'] }
    ],
    synthesis_pressure: {
      strongest_disagreement: 'Whether a falsifiable novelty gate should optimize for formal criteria or cheap experiments first.',
      changed_minds: ['mock council accepted citation coverage as a gate, not a report afterthought'],
      unresolved_conflicts: []
    }
  };
  const falsificationLedger = {
    schema_version: 1,
    schema: 'sks.falsification-ledger.v1',
    created_at: nowIso(),
    cases: Array.from({ length: DEFAULT_RESEARCH_QUALITY_CONTRACT.min_falsification_cases }, (_unused, index) => ({
      id: `mock-falsification-${index + 1}`,
      target_claim: mockClaimIds[index % mockClaimIds.length],
      attack: [
        'The claim fails if the output only summarizes background material.',
        'The claim fails if no independent source layer confirms it.',
        'The claim fails if counterevidence is absent.',
        'The claim fails if no replication step can be run.'
      ][index] || 'The claim fails if the decisive test cannot be specified.',
      source_ids: [index % 2 === 0 ? 'mock-counter-1' : 'mock-counter-2'],
      result: 'survives_with_gate_requirement',
      next_decisive_test: `Run decisive mock test ${index + 1} and compare against a summary-only baseline.`
    })),
    unresolved_failures: [],
    next_decisive_tests: ['Run paired prompt comparison and measure cited testable insights.']
  };
  const ledger = {
    schema_version: 1,
    entries: mockClaimIds.map((claimId, index) => ({
      id: claimId,
      claim: [
        'A useful research run must optimize for falsifiable novelty, not only breadth of summary.',
        'Source quality must be a first-class artifact rather than an implicit reviewer judgment.',
        'A claim matrix makes implementation handoff safer by separating facts, hypotheses, and recommendations.',
        'Counterevidence needs its own minimum threshold because single-source skepticism is too brittle.',
        'A report-length floor catches summary-only outputs that dodge hard synthesis.',
        'An implementation blueprint turns research into actionable but still read-only handoff material.',
        'Replication artifacts make research pipeline behavior auditable after the run.',
        'A final reviewer artifact prevents passed gates from relying on unstated assumptions.'
      ][index],
      type: index < 3 ? 'methodological_insight' : 'implementation_guidance',
      novelty: 2,
      confidence: 2,
      falsifiability: 2,
      source_ids: [`mock-source-${(index % RESEARCH_SOURCE_LAYERS.length) + 1}`, `mock-source-${((index + 1) % RESEARCH_SOURCE_LAYERS.length) + 1}`],
     counterevidence_ids: [index % 2 === 0 ? 'mock-counter-1' : 'mock-counter-2'],
      counterevidence_links: [{
        source_id: index % 2 === 0 ? 'mock-counter-1' : 'mock-counter-2',
        target_claim_id: claimId,
        contradiction_rationale: `Mock counterevidence challenges ${claimId} by testing whether the cited support survives a negative result.`
      }],
     evidence: [`mock-source-${(index % RESEARCH_SOURCE_LAYERS.length) + 1}`, `mock-source-${((index + 1) % RESEARCH_SOURCE_LAYERS.length) + 1}`],
      falsifiers: [index % 2 === 0 ? 'mock-counter-1' : 'mock-counter-2'],
      next_experiment: `Run the same topic through summary-only and discovery-loop prompts, then compare claim ${index + 1} support, falsification, and reproducibility.`
    }))
  };
  const claimMatrix = buildClaimEvidenceMatrixFromLedgers({
    missionId: plan?.mission_id || '',
    sourceLedger,
    noveltyLedger: ledger,
    falsificationLedger
  });
  const blueprint = defaultImplementationBlueprint(plan);
  const experimentPlan = defaultExperimentPlan(plan);
  const replicationPack = defaultReplicationPack(plan);
  await writeTextAtomic(path.join(dir, RESEARCH_SOURCE_SKILL_ARTIFACT), researchSourceSkillMarkdown(plan));
  await writeJsonAtomic(path.join(dir, 'source-ledger.json'), sourceLedger);
  await writeResearchQualityContract(dir, plan.quality_contract || DEFAULT_RESEARCH_QUALITY_CONTRACT);
  await writeClaimEvidenceMatrix(dir, claimMatrix);
  await writeSourceQualityReport(dir, sourceLedger, claimMatrix);
  await writeImplementationBlueprint(dir, blueprint);
  await writeTextAtomic(path.join(dir, IMPLEMENTATION_BLUEPRINT_MARKDOWN_ARTIFACT), renderImplementationBlueprintMarkdown(blueprint));
  await writeExperimentPlan(dir, experimentPlan);
  await writeReplicationPack(dir, replicationPack);
  await writeResearchHandoffArtifacts(dir, plan, blueprint);
  await writeResearchWorkGraph(dir, plan);
  await writeJsonAtomic(path.join(dir, 'agent-ledger.json'), agentLedger);
  await writeJsonAtomic(path.join(dir, 'debate-ledger.json'), debateLedger);
  await writeJsonAtomic(path.join(dir, 'falsification-ledger.json'), falsificationLedger);
  await writeJsonAtomic(path.join(dir, 'novelty-ledger.json'), ledger);
  const mockSourceIds = [...mockLayerSources.map((source: any) => source.id), 'mock-counter-1', 'mock-counter-2'];
  const mockCounterIds = ['mock-counter-1', 'mock-counter-2'];
  const researchReportText = buildRealisticResearchReport({
    plan,
    claims: claimMatrix.claims,
    keyClaimIds: claimMatrix.key_claim_ids,
    sourceIds: mockSourceIds,
    counterevidenceIds: mockCounterIds,
    blueprint,
    falsificationLedger,
    experimentPlan,
    replicationPack
  });
  const researchPaperText = buildRealisticResearchPaper({
    plan,
    claims: claimMatrix.claims,
    keyClaimIds: claimMatrix.key_claim_ids,
    sourceIds: mockSourceIds,
    counterevidenceIds: mockCounterIds
  });
  const reportQuality = analyzeResearchReportQuality(researchReportText);
  await writeJsonAtomic(path.join(dir, 'research-synthesis-output.json'), {
    schema: 'sks.research-synthesis-output.v1',
    mission_id: plan?.mission_id || '',
    generated_at: nowIso(),
    report_markdown: researchReportText,
    paper_markdown: researchPaperText,
    synthesis_summary: {
      key_claim_ids: claimMatrix.key_claim_ids,
      source_ids_used: mockSourceIds,
      counterevidence_ids_used: mockCounterIds,
      blueprint_sections_used: blueprint.sections.map((section: any) => section.id),
      experiment_steps_used: experimentPlan.steps.map((step: any) => step.id)
    },
    quality_signals: {
      report_word_count: reportQuality.word_count,
      source_citation_count: reportQuality.source_id_mentions.length,
      unique_source_ids_cited: mockSourceIds.filter((id) => researchReportText.includes(id)).length,
      key_claims_covered: claimMatrix.key_claim_ids.filter((id: string) => researchReportText.includes(id)).length,
      repeated_paragraph_ratio: reportQuality.repetition.repeated_paragraph_ratio,
      template_phrase_hits: reportQuality.repetition.template_phrase_hits
    },
    blockers: reportQuality.blockers
  });
  await writeTextAtomic(path.join(dir, 'research-report.md'), `${researchReportText}\n`);
  await writeTextAtomic(path.join(dir, paperArtifact), `${researchPaperText}\n`);
  await writeJsonAtomic(path.join(dir, 'research-gate.json'), {
    ...defaultResearchGate(),
    passed: true,
    report_present: true,
    research_paper_artifact: paperArtifact,
    paper_present: true,
    paper_sections: RESEARCH_PAPER_SECTION_GROUPS.length,
    research_source_skill_present: true,
    source_ledger_present: true,
    agent_ledger_present: true,
    debate_ledger_present: true,
    novelty_ledger_present: true,
    falsification_ledger_present: true,
    web_search_passes: 1,
    source_entries: mockLayerSources.length,
    source_layers_required: RESEARCH_SOURCE_LAYER_IDS.length,
    source_layers_covered: RESEARCH_SOURCE_LAYER_IDS.length,
    triangulation_checks: sourceLedger.triangulation.cross_layer_checks.length,
    xhigh_agents: 0,
    counterevidence_sources: 2,
    candidate_insights: ledger.entries.length,
    falsification_passes: 1,
    falsification_cases: falsificationLedger.cases.length,
    testable_predictions: experimentPlan.steps.length,
    citation_coverage: true,
    evidence: ['mock research report', `mock research paper: ${paperArtifact}`, 'mock research source skill', 'mock layered source ledger', 'mock agent ledger', 'mock debate ledger', 'mock novelty ledger', 'mock falsification ledger'],
    notes: ['mock mode records the new contract but does not call a model or perform live web browsing']
  });
  await writeJsonAtomic(path.join(dir, 'research-final-review.codex.json'), {
    schema: 'sks.research-codex-final-review.v1',
    reviewed_at: nowIso(),
    verdict: 'approve',
    unsupported_claim_ids: [],
    missing_evidence: [],
    blueprint_findings: ['mock complete package fixture has implementation blueprint sections'],
    falsification_findings: ['mock complete package fixture has counterevidence and falsification cases'],
    template_like_prose: false,
    source_density_ok: true,
    implementation_concreteness_ok: true,
    evidence_bound_synthesis_ok: true,
    required_revisions: [],
    confidence: 'high',
    mock: true
  });
  const adversarialReviewedAt = nowIso();
  const reviewArtifacts = await buildResearchReviewArtifactDigest(dir, plan);
  const adversarialReviewers = RESEARCH_AGENT_COUNCIL.map((agent: any, index: number) => ({
    schema: 'sks.research-adversarial-reviewer-outcome.v1',
    persona_id: String(agent.id),
    verdict: 'approve',
    strongest_challenge: `${researchAgentAgentName(agent)} mock fixture challenges unsupported claims and missing replication evidence.`,
    evidence_source_ids: [`mock-source-${(index % mockLayerSources.length) + 1}`],
    critical_objections: [],
    major_objections: [],
    minor_objections: [],
    required_revisions: [],
    falsifiers: ['Remove the cited mock source or leave a required revision unresolved.'],
    cheap_probes: ['Run the canonical adversarial validation fixture.'],
    confidence: 'high',
    review_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
    thread_id: `mock-review-1-${agent.id}`,
    thread_status: 'completed'
  }));
  await writeJsonAtomic(path.join(dir, 'research-adversarial-review.json'), {
    schema: 'sks.research-adversarial-review-ledger.v1',
    generated_at: adversarialReviewedAt,
    execution_class: 'mock_fixture',
    review_cycles: [{
      schema: 'sks.research-adversarial-review-cycle.v1',
      cycle: 1,
      execution_class: 'mock_fixture',
      reviewed_at: adversarialReviewedAt,
      workflow: { status: 'mock_fixture', workflow: 'official_codex_subagent_contract_fixture' },
      review_artifacts: reviewArtifacts,
      reviewers: adversarialReviewers,
      blockers: []
    }],
    final_cycle: 1,
    convergence_artifact: 'research-adversarial-convergence.json',
    blockers: []
  });
  await writeJsonAtomic(path.join(dir, 'research-revision-ledger.json'), {
    schema: 'sks.research-revision-ledger.v1',
    generated_at: adversarialReviewedAt,
    bounded_max_cycles: 3,
    revisions: [],
    blockers: []
  });
  await writeJsonAtomic(path.join(dir, 'research-adversarial-convergence.json'), {
    schema: 'sks.research-adversarial-convergence.v1',
    checked_at: adversarialReviewedAt,
    execution_class: 'mock_fixture',
    passed: true,
    official_subagent_workflow: true,
    official_subagent_evidence_ok: true,
    workflow_run_id: null,
    reviewer_count_required: RESEARCH_AGENT_COUNCIL.length,
    reviewer_count_observed: RESEARCH_AGENT_COUNCIL.length,
    review_cycles: 1,
    revision_cycles: 0,
    review_artifacts: reviewArtifacts,
    review_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
    current_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
    review_artifact_hashes_ok: reviewArtifacts.blockers.length === 0,
    unresolved_critical_objections: 0,
    unresolved_major_objections: 0,
    unresolved_material_objections: 0,
    advisory_objections: 0,
    honest_mode_ok: true,
    novelty_guaranteed: false,
    publication_acceptance_guaranteed: false,
    blockers: []
  });
  await writeJsonAtomic(path.join(dir, 'research-honest-mode.json'), {
    schema: 'sks.research-honest-mode.v1',
    checked_at: adversarialReviewedAt,
    execution_class: 'mock_fixture',
    ok: true,
    guarantees: {
      novelty: false,
      breakthrough: false,
      publication_acceptance: false
    },
    verified_claim: 'Only artifact shape and fail-closed gate behavior were exercised.',
    unverified: ['scientific novelty', 'publication acceptance'],
    overclaims: [],
    blockers: []
  });
  return evaluateResearchGate(dir);
}
