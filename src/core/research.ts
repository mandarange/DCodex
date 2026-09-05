import path from 'node:path';
import { ASTRA_SUBAGENT_MODEL, SUBAGENT_EFFORT } from './subagents/model-policy.js';
import { appendJsonlBounded, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic, exists } from './fsx.js';
import { OUTCOME_RUBRIC } from './proof-field.js';
import { RESEARCH_REVIEWER_CONTRACT } from './recallpulse.js';
import { CLAIM_EVIDENCE_MATRIX_ARTIFACT, defaultClaimEvidenceMatrix, readClaimEvidenceMatrix, validateClaimEvidenceMatrix, writeClaimEvidenceMatrix } from './research/claim-evidence-matrix.js';
import { EXPERIMENT_PLAN_JSON_ARTIFACT, EXPERIMENT_PLAN_MARKDOWN_ARTIFACT, defaultExperimentPlan, readExperimentPlan, validateExperimentPlan, writeExperimentPlan } from './research/experiment-plan.js';
import { IMPLEMENTATION_BLUEPRINT_ARTIFACT, defaultImplementationBlueprint, readImplementationBlueprint, validateImplementationBlueprint, writeImplementationBlueprint } from './research/implementation-blueprint.js';
import { IMPLEMENTATION_BLUEPRINT_MARKDOWN_ARTIFACT, renderImplementationBlueprintMarkdown } from './research/implementation-blueprint-markdown.js';
import { REPLICATION_PACK_ARTIFACT, defaultReplicationPack, readReplicationPack, validateReplicationPack, writeReplicationPack } from './research/replication-pack.js';
import { RESEARCH_QUALITY_CONTRACT_ARTIFACT, DEFAULT_RESEARCH_QUALITY_CONTRACT, readResearchQualityContract, writeResearchQualityContract } from './research/research-quality-contract.js';
import { RESEARCH_FINAL_REVIEW_ARTIFACT, readResearchFinalReview, runResearchFinalReviewer } from './research/research-final-reviewer.js';
import { SOURCE_QUALITY_REPORT_ARTIFACT, readSourceQualityReport, writeSourceQualityReport } from './research/source-quality-report.js';
import { analyzeResearchReportQuality, countWords } from './research/research-report-quality.js';
import { validateFalsificationCoverage } from './research/falsification.js';
import { writeResearchHandoffArtifacts } from './research/research-handoff.js';
import { RESEARCH_WORK_GRAPH_ARTIFACT, writeResearchWorkGraph } from './research/research-work-graph.js';
import { buildResearchReviewArtifactDigest, validateResearchReviewArtifactDigest } from './research/research-review-artifact-digest.js';
import { RESEARCH_SOURCE_LAYER_IDS, RESEARCH_SOURCE_LAYERS } from './research/research-source-layer-catalog.js';
import { eligibleResearchSourceIdSet } from './research/research-source-evidence.js';
import { renderResearchPlanMarkdown, renderResearchSourceSkillMarkdown } from './research/research-plan-markdown.js';
import { resolveCodexAppExecutionProfile } from './codex-app/codex-app-execution-profile.js';
import { resolveCodexNativeInvocationPlan } from './codex-native/codex-native-invocation-router.js';
import {
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  buildSubagentEvidence,
  normalizeSubagentParentSummary,
  readSubagentEvents
} from './subagents/subagent-evidence.js';

export { RESEARCH_SOURCE_LAYER_IDS, RESEARCH_SOURCE_LAYERS } from './research/research-source-layer-catalog.js';

export const RESEARCH_PAPER_ARTIFACT = 'research-paper.md';
export const RESEARCH_SOURCE_SKILL_ARTIFACT = 'research-source-skill.md';
export const RESEARCH_REVIEWER_CUSTOM_AGENT = 'research_reviewer';
export const RESEARCH_REVIEWER_CONFIG_ARTIFACT = '.codex/agents/research-reviewer.toml';
const RESEARCH_ADVERSARIAL_REVIEW_LEDGER_ARTIFACT = 'research-adversarial-review.json';
const RESEARCH_ADVERSARIAL_CONVERGENCE_ARTIFACT = 'research-adversarial-convergence.json';
const RESEARCH_ADVERSARIAL_REVISION_LEDGER_ARTIFACT = 'research-revision-ledger.json';
const RESEARCH_HONEST_MODE_CANONICAL_ARTIFACT = 'research-honest-mode.json';
export const RESEARCH_PAPER_SECTION_GROUPS = Object.freeze([
  ['abstract'],
  ['introduction'],
  ['method', 'methodology'],
  ['results', 'findings'],
  ['discussion'],
  ['limitations', 'falsification'],
  ['conclusion', 'next experiment'],
  ['references', 'sources']
]);

function cleanResearchArtifactDate(value: any = '') {
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : nowIso().slice(0, 10);
}

function researchTitleSlug(prompt: any = '') {
  const cleaned = String(prompt || '')
    .normalize('NFKC')
    .replace(/[`"'<>]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const slug = cleaned.split('-').filter(Boolean).slice(0, 10).join('-').slice(0, 90).replace(/-+$/g, '');
  return slug || 'research';
}

export function researchPaperArtifactName(prompt: any = '', createdAt: any = nowIso(), opts: any = {}) {
  const titleSource = opts.title || opts.paperTitle || prompt;
  return `${cleanResearchArtifactDate(createdAt)}-${researchTitleSlug(titleSource)}-research-paper.md`;
}

export function isDatedResearchPaperArtifact(name: any = '') {
  return /^\d{4}-\d{2}-\d{2}-[^\s/\\]+-research-paper\.md$/u.test(String(name || ''));
}

export function researchPaperArtifactForPlan(plan: any = null) {
  const artifact = plan?.artifacts?.research_paper || plan?.paper_artifact;
  return artifact ? path.basename(String(artifact)) : RESEARCH_PAPER_ARTIFACT;
}

export async function findResearchPaperArtifact(dir: any, plan: any = null, opts: any = {}) {
  const preferred = researchPaperArtifactForPlan(plan);
  const allowLegacyFallback = opts.allowLegacyFallback === true || preferred === RESEARCH_PAPER_ARTIFACT;
  const names = [...new Set([preferred, allowLegacyFallback ? RESEARCH_PAPER_ARTIFACT : null].filter(Boolean))] as string[];
  for (const name of names) {
    const file = path.join(dir, name);
    if (await exists(file)) return { name, path: file, exists: true, preferred: name === preferred, legacy: name === RESEARCH_PAPER_ARTIFACT };
  }
  return { name: preferred, path: path.join(dir, preferred), exists: false, preferred: true, legacy: false };
}

export function researchAgentAgentName(agent: any = {}) {
  return String(agent.agent_name || agent.display_name || agent.label || agent.id || 'Research Agent').trim();
}

export const RESEARCH_AGENT_COUNCIL = Object.freeze(RESEARCH_REVIEWER_CONTRACT.map((agent: any) => {
  const displayName = agent.display_name || agent.label || agent.id;
  return Object.freeze({
    ...agent,
    display_name: displayName,
    label: displayName,
    agent_name: displayName,
    codex_agent_name: displayName,
    required_outputs: agent.required_outputs
  });
}));

export function researchNativeAgentPlan(prompt: any = '', opts: any = {}) {
  const personas = RESEARCH_AGENT_COUNCIL.map((persona: any) => ({
    id: persona.id,
    display_name: researchAgentAgentName(persona),
    persona: persona.persona,
    persona_boundary: persona.persona_boundary,
    role: persona.role,
    mandate: persona.mandate,
    custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
    model: ASTRA_SUBAGENT_MODEL,
    reasoning_effort: SUBAGENT_EFFORT,
    read_only: true
  }));
  const batches = [
    {
      id: 'research-official-adversarial-review',
      cycle_phase: 'R8_ADVERSARIAL_REVIEW',
      agents: personas.map((persona: any) => persona.id),
      mode: 'official_codex_subagent',
      read_only: true,
      outputs: ['subagent-plan.json', 'subagent-events.jsonl', 'subagent-parent-summary.json', 'subagent-evidence.json', 'research-adversarial-convergence.json']
    }
  ];
  return {
    schema: 'sks.research-official-subagent-plan.v1',
    prompt,
    backend: 'official_codex_subagent',
    legacy_runtime: false,
    legacy_artifact_alias_policy: {
      'agent-ledger.json': 'compatibility projection from evidence-correlated official reviewer outcomes; not independent runtime proof',
      'debate-ledger.json': 'compatibility projection from official adversarial reviewer outcomes; not a custom debate scheduler'
    },
    session_count: personas.length,
    personas,
    batches,
    communication: {
      plan: 'subagent-plan.json',
      lifecycle: 'subagent-events.jsonl',
      parent_summary: 'subagent-parent-summary.json',
      proof: 'subagent-evidence.json'
    },
    autoresearch_cycle_policy: {
      uses_agent_batches: true,
      batch_template: batches.map((batch) => ({ id: batch.id, agents: batch.agents, outputs: batch.outputs })),
      rule: 'Every AutoResearch synthesis is challenged by three independent review dimensions; material revisions are bounded and followed by a fresh review cycle.'
    }
  };
}

export function createResearchPlan(prompt: any, opts: any = {}) {
  const depth = opts.depth || 'frontier';
  const createdAt = nowIso();
  const paperArtifact = researchPaperArtifactName(prompt, createdAt, opts);
  const nativeAgentPlan = researchNativeAgentPlan(prompt, { paperArtifact, missionId: opts.missionId });
  const executionProfile = opts.executionProfile || null;
  const codexNativeInvocation = opts.codexNativeInvocation || null;
  const sourceStrategy = codexNativeInvocation?.mcp_source?.selected_strategy === 'codex-app-native'
    ? 'mcp-plugin-candidates'
    : codexNativeInvocation?.web_search?.selected_strategy === 'codex-cli-headless'
      ? 'web-sources'
      : executionProfile?.plugin_mcp_inventory_ready
        ? 'mcp-plugin-candidates'
        : 'local-files';
  return {
    schema_version: 1,
    mission_id: opts.missionId || null,
    prompt,
    depth,
    created_at: createdAt,
    methodology: opts.autoresearch ? 'super-search-autoresearch-with-official-subagent-adversarial-convergence' : 'super-search-semantic-claims-with-official-subagent-adversarial-convergence',
    paper_artifact: paperArtifact,
    quality_contract: DEFAULT_RESEARCH_QUALITY_CONTRACT,
    native_agent_plan: nativeAgentPlan,
    codex_app_execution_profile: executionProfile ? compactExecutionProfile(executionProfile) : null,
    codex_native_invocation: codexNativeInvocation,
    current_docs_policy: {
      context7_required: opts.context7Required === true,
      evidence_artifact: 'context7-evidence.jsonl',
      rule: 'External library, SDK, API, MCP, package-manager, and generated-doc claims require resolve-library-id plus query-docs evidence before completion.'
    },
    agent_sessions: nativeAgentPlan.personas,
    agent_batches: nativeAgentPlan.batches,
    autoresearch_cycle_policy: nativeAgentPlan.autoresearch_cycle_policy,
    artifacts: {
      research_paper: paperArtifact,
      legacy_research_paper: RESEARCH_PAPER_ARTIFACT,
      research_source_skill: RESEARCH_SOURCE_SKILL_ARTIFACT,
      quality_contract: RESEARCH_QUALITY_CONTRACT_ARTIFACT,
      claim_evidence_matrix: CLAIM_EVIDENCE_MATRIX_ARTIFACT,
      source_quality_report: SOURCE_QUALITY_REPORT_ARTIFACT,
      implementation_blueprint: IMPLEMENTATION_BLUEPRINT_ARTIFACT,
      implementation_blueprint_markdown: IMPLEMENTATION_BLUEPRINT_MARKDOWN_ARTIFACT,
      experiment_plan: EXPERIMENT_PLAN_JSON_ARTIFACT,
      experiment_plan_markdown: EXPERIMENT_PLAN_MARKDOWN_ARTIFACT,
      replication_pack: REPLICATION_PACK_ARTIFACT,
      final_review: RESEARCH_FINAL_REVIEW_ARTIFACT,
      research_work_graph: RESEARCH_WORK_GRAPH_ARTIFACT
    },
    objective: 'Find the shortest useful mechanism that can be falsified or applied, grounded in maximum available source retrieval rather than broad summary.',
    execution_policy: {
      normal_run: 'real_super_search_semantic_synthesis_and_official_subagent_review',
      default_cycle_timeout_minutes: 20,
      default_max_cycles: 3,
      safety_cap: 'Research performs bounded source acquisition and up to three adversarial review/revision cycles. Unresolved critical, major, or required revisions leave the gate blocked.',
      mock_policy: '--mock is for selftests and dry harness checks only; normal Research must block rather than silently substitute mock output.'
    },
    outcome_rubric: OUTCOME_RUBRIC,
    research_council: {
      mode: 'independent_review_dimensions',
      policy: 'Assign distinct evidence, method, and falsification review dimensions.',
      effort_policy: {
        custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
        required_model: ASTRA_SUBAGENT_MODEL,
        required_effort: SUBAGENT_EFFORT,
        applies_to: 'every_official_adversarial_reviewer',
        rule: 'Every adversarial reviewer uses the verified research_reviewer custom agent configuration with GPT-6 Astra Max. Long-context and source-tool acquisition uses Astra Medium; synthesis, falsification, and review use Astra Max.'
      },
      debate_policy: {
        mode: 'independent_adversarial_reviews_with_bounded_revision',
        rule: 'Three distinct official reviewer threads independently attack the synthesized manuscript. Critical, major, or required revisions trigger a bounded revision and fresh review; minor concerns remain advisory.'
      },
      agents: RESEARCH_AGENT_COUNCIL,
      protocol: [
        'Super Search and semantic claim synthesis complete before the official reviewer threads start.',
        'Each official reviewer records source-linked evidence, nonempty falsifiers, and a cheap decisive probe.',
        'Every reviewer attempts rejection independently; no reviewer lifecycle completion is treated as approval.',
        'Any critical, major, or required revision prevents convergence and triggers a bounded revision when evidence integrity is intact.',
        'A fresh three-thread review must clear material objections after every successful revision.'
      ]
    },
    web_research_policy: {
      mode: 'layered_source_retrieval_and_triangulation',
      requirement: 'Use every safely available public web/source route before synthesis, separated into source layers so the final claim is not dominated by one corpus or platform.',
      source_tool_routing: {
        mode: sourceStrategy,
        plugin_mcp_inventory_ready: executionProfile?.plugin_mcp_inventory_ready === true,
        execution_profile_artifact: executionProfile?.artifact_path || '.sneakoscope/reports/codex-app-execution-profile.json',
        codex_native_invocation_artifact: codexNativeInvocation ? 'research/codex-native-invocation.json' : null,
        rule: 'Prefer verified plugin/MCP candidates when available; otherwise record source-tool blockers instead of assuming live search coverage.'
      },
      query_sets: [
        'first-principles and theory sources',
        'plain-language explanations and empirical examples',
        'formal algorithms, definitions, or standards',
        'systems, strategy, scaling, or deployment evidence',
        'counterevidence, failures, critiques, and null results'
      ],
      source_layers: RESEARCH_SOURCE_LAYERS,
      source_priority: ['primary_sources', 'official_docs_or_standards', 'peer_reviewed_or_archival_sources', 'reputable_recent_sources', 'credible_counterevidence'],
      skill_creator: {
        artifact: RESEARCH_SOURCE_SKILL_ARTIFACT,
        status: 'route_local_candidate',
        rule: 'Before source gathering, create a route-local source collection skill that names the selected layers, query families, source-quality fields, blockers, and cross-layer triangulation checks. Do not edit generated .agents/skills during a research run.'
      },
      citation_rules: [
        'Every factual claim in the report must cite source-ledger ids or local project evidence.',
        'The final research paper must include references tied to source-ledger ids.',
        'Every required source layer must have at least one cited source or an explicit blocker; blockers keep the research gate unpassed.',
        'The source-ledger must include at least one cross-layer triangulation check comparing formal, current, discourse, practitioner, official, and counterevidence sources.',
        'Every novelty-ledger entry must cite at least one evidence source and at least one falsifier.',
        'If live web search is unavailable, record the blocker in source-ledger.json and keep research-gate.json unpassed.'
      ],
      minimums: {
        independent_agents: RESEARCH_AGENT_COUNCIL.length,
        web_search_passes: 1,
        source_entries: 1,
        source_layers: RESEARCH_SOURCE_LAYER_IDS.length,
        counterevidence_sources: 1,
        triangulation_checks: 1
      }
    },
    mutation_policy: {
      implementation_allowed: false,
      allowed_write_scope: 'route-local mission artifacts only',
      rule: 'Normal Research must not modify repository source, package, docs, config, or generated harness files. It may write only artifacts under its own .sneakoscope/missions/<mission-id>/ directory.'
    },
    artifact_policy: {
      research_paper: paperArtifact,
      rule: 'Write the final manuscript to the dated topic-specific research_paper artifact from this plan, not the legacy generic filename.'
    },
    rules: [
      'Do not modify code or project source files during Research. Research writes only route-local mission artifacts; implementation belongs to $Naruto or another execution route.',
      'Do not claim novelty without a novelty ledger entry.',
      'Separate facts, inferences, hypotheses, and speculations.',
      'Run three distinct evidence-correlated official reviewer subagent reviews after synthesis.',
      'Every reviewer must use the verified research_reviewer policy and return an exact structured outcome with source ids, falsifiers, and cheap probes.',
      'Project official reviewer outcomes into debate-ledger.json for compatibility only; the canonical proof is the lifecycle-correlated adversarial review and convergence artifacts.',
      'Maximize safe web/source search as layered source retrieval and record queries, source layers, citations, quality notes, triangulation checks, and blockers in source-ledger.json.',
      `Create ${RESEARCH_SOURCE_SKILL_ARTIFACT} as a route-local source collection skill before synthesis; do not edit generated .agents/skills during the research run.`,
      'Actively seek disconfirming evidence before synthesis.',
      `Turn the surviving research result into ${paperArtifact} with paper-style sections and references.`,
      'Keep unsupported source-free claims as hypotheses only.',
      'Prefer the smallest testable mechanism or implementation probe, but do not stop source gathering early for speed when the research question needs a longer pass.',
      'Do not ask the user mid-run; resolve scope using the research plan and safety policy.'
    ],
    phases: [
      { id: 'R0_FRAME', goal: 'Frame the target outcome, constraints, and what would make the idea useful.' },
      { id: 'R1_SOURCE_SKILL', goal: `Create ${RESEARCH_SOURCE_SKILL_ARTIFACT} with layer-specific search routes, quality fields, and blockers before source gathering.` },
      { id: 'R2_SOURCE_SEARCH', goal: 'Run layered web/source retrieval across papers, official data, standards, news, public discourse, developer knowledge, and counterevidence.' },
      { id: 'R3_REVIEW', goal: 'Collect source-linked evidence, falsifiers, and cheap probes from the independent review dimensions.' },
      { id: 'R4_REVISION', goal: 'Revise on critical, major, or required findings and run a fresh bounded review cycle.' },
      { id: 'R5_FALSIFY', goal: 'Attack each mechanism with counterexamples, missing evidence, source conflicts, and failure modes.' },
      { id: 'R6_APPLY', goal: 'Keep the smallest surviving mechanism, define a cheap probe, and write all ledgers.' },
      { id: 'R7_PAPER', goal: 'Convert the final research result into a concise paper manuscript with abstract, method, findings, limitations, and references.' }
    ],
    required_artifacts: [
      'research-report.md',
      paperArtifact,
      RESEARCH_SOURCE_SKILL_ARTIFACT,
      RESEARCH_QUALITY_CONTRACT_ARTIFACT,
      CLAIM_EVIDENCE_MATRIX_ARTIFACT,
      SOURCE_QUALITY_REPORT_ARTIFACT,
      IMPLEMENTATION_BLUEPRINT_ARTIFACT,
      IMPLEMENTATION_BLUEPRINT_MARKDOWN_ARTIFACT,
      EXPERIMENT_PLAN_JSON_ARTIFACT,
      EXPERIMENT_PLAN_MARKDOWN_ARTIFACT,
      REPLICATION_PACK_ARTIFACT,
      RESEARCH_FINAL_REVIEW_ARTIFACT,
      RESEARCH_WORK_GRAPH_ARTIFACT,
      'source-ledger.json',
      'novelty-ledger.json',
      'falsification-ledger.json',
      'research-gate.json'
    ]
  };
}

export function researchPlanMarkdown(plan: any) {
  return renderResearchPlanMarkdown(plan, { researchPaperArtifactForPlan, researchAgentAgentName });
}

export function researchSourceSkillMarkdown(plan: any) {
  return renderResearchSourceSkillMarkdown(plan, RESEARCH_SOURCE_LAYERS);
}

export function countResearchPaperSections(text: any = '') {
  const headings = String(text || '').toLowerCase().split(/\n/).filter((line: any) => /^#{1,3}\s+/.test(line));
  return RESEARCH_PAPER_SECTION_GROUPS.filter((group: any) => headings.some((heading: any) => group.some((term: any) => heading.includes(term)))).length;
}

export async function writeResearchPlan(dir: any, prompt: any, opts: any = {}) {
  const root = opts.root || missionRootFromDir(String(dir || ''));
  const executionProfile = opts.executionProfile || (root ? await resolveCodexAppExecutionProfile({ root }).catch(() => null) : null);
  const missionId = opts.missionId || path.basename(String(dir || ''));
  const codexNativeInvocation = root ? await resolveResearchCodexNativeInvocation(root, missionId).catch(() => null) : null;
  const plan = createResearchPlan(prompt, { ...opts, executionProfile, codexNativeInvocation });
  const noveltyLedger = {
    schema_version: 1,
    entries: [],
    rubric: {
      novelty: '0 known/restatement, 1 local reframing, 2 useful synthesis, 3 non-obvious testable insight',
      confidence: '0 speculation, 1 weak, 2 supported, 3 strongly supported',
      falsifiability: '0 vague, 1 indirectly testable, 2 directly testable, 3 cheap decisive test exists'
    }
  };
  const sourceLedger = defaultSourceLedger(plan);
  const claimMatrix = defaultClaimEvidenceMatrix(plan.mission_id || '');
  const blueprint = defaultImplementationBlueprint(plan);
  const experimentPlan = defaultExperimentPlan(plan);
  const replicationPack = defaultReplicationPack(plan);
  await writeJsonAtomic(path.join(dir, 'research-plan.json'), plan);
  if (executionProfile) await writeJsonAtomic(path.join(dir, 'research', 'execution-profile.json'), executionProfile).catch(() => undefined);
  if (codexNativeInvocation) await writeJsonAtomic(path.join(dir, 'research', 'codex-native-invocation.json'), codexNativeInvocation).catch(() => undefined);
  await writeTextAtomic(path.join(dir, 'research-plan.md'), researchPlanMarkdown(plan));
  await writeTextAtomic(path.join(dir, RESEARCH_SOURCE_SKILL_ARTIFACT), researchSourceSkillMarkdown(plan));
  await writeResearchQualityContract(dir, plan.quality_contract);
  await writeJsonAtomic(path.join(dir, 'novelty-ledger.json'), noveltyLedger);
  await writeJsonAtomic(path.join(dir, 'source-ledger.json'), sourceLedger);
  await writeClaimEvidenceMatrix(dir, claimMatrix);
  await writeSourceQualityReport(dir, sourceLedger, claimMatrix);
  await writeImplementationBlueprint(dir, blueprint);
  await writeTextAtomic(path.join(dir, IMPLEMENTATION_BLUEPRINT_MARKDOWN_ARTIFACT), renderImplementationBlueprintMarkdown(blueprint));
  await writeExperimentPlan(dir, experimentPlan);
  await writeReplicationPack(dir, replicationPack);
  await writeResearchHandoffArtifacts(dir, plan, blueprint);
  await writeResearchWorkGraph(dir, plan);
  await writeJsonAtomic(path.join(dir, 'agent-ledger.json'), defaultAgentLedger(plan));
  await writeJsonAtomic(path.join(dir, 'debate-ledger.json'), defaultDebateLedger(plan));
  await writeJsonAtomic(path.join(dir, 'falsification-ledger.json'), defaultFalsificationLedger());
  await writeJsonAtomic(path.join(dir, 'research-gate.json'), defaultResearchGate());
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'research.plan.created', depth: plan.depth });
  return plan;
}

async function resolveResearchCodexNativeInvocation(root: string, missionId: string) {
  const [pluginSource, mcpSource, webSearch] = await Promise.all([
    resolveCodexNativeInvocationPlan({ root, missionId, route: '$Research', desiredCapability: 'plugin-source' }),
    resolveCodexNativeInvocationPlan({ root, missionId, route: '$Research', desiredCapability: 'mcp-source' }),
    resolveCodexNativeInvocationPlan({ root, missionId, route: '$Research', desiredCapability: 'web-search' })
  ]);
  return {
    plugin_source: pluginSource,
    mcp_source: mcpSource,
    web_search: webSearch,
    selected_source_strategy: mcpSource.selected_strategy === 'codex-app-native'
      ? 'mcp-plugin-candidates'
      : webSearch.selected_strategy === 'codex-cli-headless'
        ? 'web-sources'
        : 'local-files',
    hook_derived_source_evidence_allowed: false
  };
}

function missionRootFromDir(dir: string): string | null {
  const normalized = path.resolve(String(dir || ''));
  const marker = `${path.sep}.sneakoscope${path.sep}missions${path.sep}`;
  const idx = normalized.indexOf(marker);
  return idx > 0 ? normalized.slice(0, idx) : null;
}

function compactExecutionProfile(profile: any) {
  return profile ? {
    mode: profile.mode || 'unknown',
    agent_role_strategy: profile.agent_role_strategy || 'message-role',
    hooks_approval_required: profile.hooks_approval_required === true,
    hook_approval_state: profile.hook_approval_state || 'unknown',
    plugin_mcp_inventory_ready: profile.plugin_mcp_inventory_ready === true,
    artifact_path: profile.artifact_path || '.sneakoscope/reports/codex-app-execution-profile.json'
  } : null;
}

export function defaultSourceLedger(plan: any = null) {
  const sourceLayers = plan?.web_research_policy?.source_layers?.length ? plan.web_research_policy.source_layers : RESEARCH_SOURCE_LAYERS;
  return {
    schema_version: 1,
    policy: plan?.web_research_policy?.mode || 'layered_source_retrieval_and_triangulation',
    created_at: nowIso(),
    source_layer_skill: {
      artifact: RESEARCH_SOURCE_SKILL_ARTIFACT,
      status: 'planned'
    },
    web_search_passes: 0,
    source_layers: sourceLayers.map((layer: any) => ({
      id: layer.id,
      label: layer.label,
      required: true,
      status: 'pending',
      evidence_role: layer.evidence_role,
      query_templates: layer.query_templates || [],
      source_ids: [],
      counterevidence_ids: [],
      blocker: null,
      notes: ''
    })),
    layer_coverage: {
      required: sourceLayers.map((layer: any) => layer.id),
      covered: [],
      missing: sourceLayers.map((layer: any) => layer.id),
      notes: []
    },
    queries: [],
    sources: [],
    counterevidence_sources: [],
    triangulation: {
      cross_layer_checks: [],
      conflicts: [],
      synthesis_notes: []
    },
    quality_model: {
      reporting_basis: 'Record enough source metadata to make search reproducible, including query, layer, locator, publisher or author, publication date when known, accessed_at, reliability, credibility, stance, and cited claim ids.',
      source_quality_fields: ['layer', 'kind', 'title', 'locator', 'publisher_or_author', 'published_at', 'accessed_at', 'reliability', 'credibility', 'stance', 'supports', 'undermines', 'claim_ids']
    },
    citation_coverage: {
      all_key_claims_cited: false,
      key_claim_ids: [],
      cited_claim_ids: [],
      uncited_claim_ids: [],
      source_claim_map: {},
      notes: []
    },
    blockers: []
  };
}

export function defaultAgentLedger(plan: any = null) {
  const agents = plan?.research_council?.agents || RESEARCH_AGENT_COUNCIL;
  return {
    schema_version: 1,
    council_mode: plan?.research_council?.mode || 'independent_review_dimensions',
    created_at: nowIso(),
    agents: agents.map((agent: any) => ({
      id: agent.id,
      agent_name: researchAgentAgentName(agent),
      display_name: agent.display_name || agent.label || agent.id,
      persona: agent.persona || agent.role,
      persona_boundary: agent.persona_boundary || 'Apply only the assigned review dimension and report evidence-bound findings.',
      role: agent.role,
      mandate: agent.mandate,
      model_policy: {
        custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
        model: ASTRA_SUBAGENT_MODEL,
        reasoning_effort: SUBAGENT_EFFORT,
        enforcement_source: RESEARCH_REVIEWER_CONFIG_ARTIFACT
      },
      observed_model: null,
      observed_reasoning_effort: null,
      query_set: [],
      findings: [],
      falsifiers: [],
      cheap_probes: [],
      challenge_or_response: ''
    })),
    synthesis: {
      surviving_claims: [],
      downgraded_claims: [],
      unresolved_conflicts: []
    }
  };
}

export function defaultDebateLedger(plan: any = null) {
  const agents = plan?.research_council?.agents || RESEARCH_AGENT_COUNCIL;
  return {
    schema_version: 1,
    created_at: nowIso(),
    mode: 'independent_evidence_bound_reviews',
    required_participants: agents.map((agent: any) => agent.id),
    participant_display_names: agents.map((agent: any) => researchAgentAgentName(agent)),
    consensus_iterations: 0,
    review_complete: false,
    agent_agreements: agents.map((agent: any) => ({
      agent_id: agent.id,
      agent_name: researchAgentAgentName(agent),
      display_name: agent.display_name || agent.label || agent.id,
      material_objections_resolved: false,
      final_position: '',
      source_ids: []
    })),
    exchanges: [],
    synthesis_pressure: {
      strongest_disagreement: '',
      changed_minds: [],
      unresolved_conflicts: []
    }
  };
}

export function defaultFalsificationLedger() {
  return {
    schema_version: 1,
    schema: 'sks.falsification-ledger.v1',
    created_at: nowIso(),
    quality_contract: {
      min_cases: DEFAULT_RESEARCH_QUALITY_CONTRACT.min_falsification_cases,
      required_fields: ['id', 'target_claim', 'attack', 'source_ids', 'result', 'next_decisive_test']
    },
    cases: [],
    unresolved_failures: [],
    next_decisive_tests: []
  };
}

function sourceLayerIdsForPlan(plan: any = null) {
  const layers = plan?.web_research_policy?.source_layers?.length ? plan.web_research_policy.source_layers : RESEARCH_SOURCE_LAYERS;
  return layers.map((layer: any) => layer.id).filter(Boolean);
}

function sourceLayerCoverageStats(sourceLedger: any = null, requiredLayerIds: any = RESEARCH_SOURCE_LAYER_IDS) {
  const covered = new Set();
  const sourceRows = [
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ];
  for (const source of sourceRows) {
    const layer = source?.layer || source?.layer_id || source?.source_layer;
    if (requiredLayerIds.includes(layer)) covered.add(layer);
  }
  for (const layer of Array.isArray(sourceLedger?.source_layers) ? sourceLedger.source_layers : []) {
    const id = layer?.id || layer?.layer;
    const sourceIds = [
      ...(Array.isArray(layer?.source_ids) ? layer.source_ids : []),
      ...(Array.isArray(layer?.counterevidence_ids) ? layer.counterevidence_ids : [])
    ];
    if (requiredLayerIds.includes(id) && layer?.status === 'covered' && sourceIds.length > 0) covered.add(id);
  }
  const missing = requiredLayerIds.filter((id: any) => !covered.has(id));
  return { covered: [...covered], missing, required: [...requiredLayerIds] };
}

export function defaultResearchGate() {
  return {
    passed: false,
    report_present: false,
    research_paper_artifact: null,
    paper_present: false,
    paper_sections: 0,
    research_source_skill_present: false,
    source_ledger_present: false,
    novelty_ledger_present: false,
    falsification_ledger_present: false,
    web_search_policy: 'layered_source_retrieval_and_triangulation',
    web_search_passes: 0,
    source_entries: 0,
    source_layers_required: RESEARCH_SOURCE_LAYER_IDS.length,
    source_layers_covered: 0,
    triangulation_checks: 0,
    xhigh_agents: 0,
    counterevidence_sources: 0,
    candidate_insights: 0,
    falsification_passes: 0,
    falsification_cases: 0,
    testable_predictions: 0,
    citation_coverage: false,
    web_search_blockers: [],
    unsafe_or_destructive_actions: false,
    unsupported_breakthrough_claims: 0,
    evidence: [],
    notes: []
  };
}

export async function validateCanonicalResearchAdversarialEvidence(dir: any) {
  const expectedPersonaIds = RESEARCH_AGENT_COUNCIL.map((agent: any) => String(agent.id));
  const expectedReviewerCount = expectedPersonaIds.length;
  const [reviewLedger, revisionLedger, convergenceGate, honestMode, researchPlan, sourceLedger] = await Promise.all([
    readJson(path.join(dir, RESEARCH_ADVERSARIAL_REVIEW_LEDGER_ARTIFACT), null),
    readJson(path.join(dir, RESEARCH_ADVERSARIAL_REVISION_LEDGER_ARTIFACT), null),
    readJson(path.join(dir, RESEARCH_ADVERSARIAL_CONVERGENCE_ARTIFACT), null),
    readJson(path.join(dir, RESEARCH_HONEST_MODE_CANONICAL_ARTIFACT), null),
    readJson(path.join(dir, 'research-plan.json'), null),
    readJson(path.join(dir, 'source-ledger.json'), null)
  ]);
  const blockers: string[] = [];
  if (reviewLedger?.schema !== 'sks.research-adversarial-review-ledger.v1') blockers.push('canonical_adversarial_review_ledger_invalid');
  if (revisionLedger?.schema !== 'sks.research-revision-ledger.v1') blockers.push('canonical_adversarial_revision_ledger_invalid');
  if (convergenceGate?.schema !== 'sks.research-adversarial-convergence.v1') blockers.push('canonical_adversarial_convergence_invalid');
  if (honestMode?.schema !== 'sks.research-honest-mode.v1') blockers.push('canonical_research_honest_mode_invalid');

  const reviewCycles = Array.isArray(reviewLedger?.review_cycles) ? reviewLedger.review_cycles : [];
  const revisions = Array.isArray(revisionLedger?.revisions) ? revisionLedger.revisions : [];
  const finalReview = reviewCycles.at(-1) || null;
  const finalCycle = Number(finalReview?.cycle || 0);
  const executionClass = String(convergenceGate?.execution_class || reviewLedger?.execution_class || finalReview?.execution_class || '');
  const mockOnly = executionClass === 'mock_fixture';
  if (!['real', 'mock_fixture'].includes(executionClass)) blockers.push('canonical_adversarial_execution_class_invalid');
  if (!finalReview) blockers.push('canonical_adversarial_final_review_missing');
  if (Number(reviewLedger?.final_cycle || 0) !== finalCycle || finalCycle < 1) blockers.push('canonical_adversarial_final_cycle_mismatch');
  if (reviewCycles.length !== finalCycle) blockers.push('canonical_adversarial_review_cycle_sequence_invalid');
  if (String(finalReview?.execution_class || '') !== executionClass) blockers.push('canonical_adversarial_final_execution_class_mismatch');
  if (normalizeResearchStrings(reviewLedger?.blockers).length) blockers.push(...normalizeResearchStrings(reviewLedger.blockers).map((blocker) => `canonical_adversarial_ledger:${blocker}`));
  if (normalizeResearchStrings(finalReview?.blockers).length) blockers.push(...normalizeResearchStrings(finalReview.blockers).map((blocker) => `canonical_adversarial_final_review:${blocker}`));

  const reviewers = Array.isArray(finalReview?.reviewers) ? finalReview.reviewers : [];
  const currentReviewArtifacts = await buildResearchReviewArtifactDigest(dir, researchPlan);
  const recordedReviewArtifacts = finalReview?.review_artifacts;
  blockers.push(...validateResearchReviewArtifactDigest(recordedReviewArtifacts, currentReviewArtifacts).map((blocker) => `canonical_adversarial_${blocker}`));
  const reviewedArtifactBundle = String(recordedReviewArtifacts?.bundle_sha256 || '');
  if (String(convergenceGate?.review_artifact_bundle_sha256 || '') !== reviewedArtifactBundle) blockers.push('canonical_adversarial_convergence_artifact_bundle_mismatch');
  if (String(convergenceGate?.current_artifact_bundle_sha256 || '') !== currentReviewArtifacts.bundle_sha256) blockers.push('canonical_adversarial_convergence_current_artifact_bundle_mismatch');
  if (convergenceGate?.review_artifact_hashes_ok !== true) blockers.push('canonical_adversarial_artifact_hashes_not_ok');
  const currentSourceIds = await eligibleResearchSourceIdSet(dir, sourceLedger, executionClass);
  const personaIds = reviewers.map((reviewer: any) => String(reviewer?.persona_id || '').trim()).filter(Boolean);
  const threadIds = reviewers.map((reviewer: any) => String(reviewer?.thread_id || '').trim()).filter(Boolean);
  if (reviewers.length !== expectedReviewerCount) blockers.push(`canonical_adversarial_reviewer_count:${reviewers.length}/${expectedReviewerCount}`);
  for (const personaId of expectedPersonaIds) {
    if (!personaIds.includes(personaId)) blockers.push(`canonical_adversarial_reviewer_missing:${personaId}`);
  }
  for (const duplicate of duplicateResearchStrings(personaIds)) blockers.push(`canonical_adversarial_reviewer_duplicate:${duplicate}`);
  for (const duplicate of duplicateResearchStrings(threadIds)) blockers.push(`canonical_adversarial_thread_duplicate:${duplicate}`);
  if (new Set(threadIds).size !== expectedReviewerCount) blockers.push('canonical_adversarial_distinct_threads_missing');
  for (const reviewer of reviewers) blockers.push(...canonicalResearchReviewerBlockers(reviewer, currentSourceIds, reviewedArtifactBundle));

  if (convergenceGate?.passed !== true) blockers.push('canonical_adversarial_convergence_not_passed');
  if (convergenceGate?.official_subagent_workflow !== true) blockers.push('canonical_adversarial_official_workflow_missing');
  if (Number(convergenceGate?.reviewer_count_required || 0) !== expectedReviewerCount) blockers.push('canonical_adversarial_required_reviewer_count_invalid');
  if (Number(convergenceGate?.reviewer_count_observed || 0) !== expectedReviewerCount) blockers.push('canonical_adversarial_observed_reviewer_count_invalid');
  if (Number(convergenceGate?.review_cycles || 0) !== reviewCycles.length) blockers.push('canonical_adversarial_review_cycle_count_mismatch');
  if (Number(convergenceGate?.revision_cycles || 0) !== revisions.length) blockers.push('canonical_adversarial_revision_cycle_count_mismatch');
  if (Number(convergenceGate?.unresolved_critical_objections || 0) !== 0) blockers.push('canonical_adversarial_critical_objections_open');
  if (Number(convergenceGate?.unresolved_major_objections || 0) !== 0) blockers.push('canonical_adversarial_major_objections_open');
  if (Number(convergenceGate?.unresolved_material_objections || 0) !== 0) blockers.push('canonical_adversarial_material_objections_open');
  if (convergenceGate?.honest_mode_ok !== true) blockers.push('canonical_adversarial_honest_mode_not_ok');
  if (normalizeResearchStrings(convergenceGate?.blockers).length) blockers.push(...normalizeResearchStrings(convergenceGate.blockers).map((blocker) => `canonical_adversarial_convergence:${blocker}`));
  if (convergenceGate?.novelty_guaranteed !== false || convergenceGate?.publication_acceptance_guaranteed !== false) {
    blockers.push('canonical_adversarial_guarantee_overclaim');
  }
  if (honestMode?.ok !== true || normalizeResearchStrings(honestMode?.blockers).length) blockers.push('canonical_research_honest_mode_not_ok');
  if (String(honestMode?.execution_class || '') !== executionClass) blockers.push('canonical_research_honest_mode_execution_class_mismatch');
  if (honestMode?.guarantees?.novelty !== false
    || honestMode?.guarantees?.breakthrough !== false
    || honestMode?.guarantees?.publication_acceptance !== false) {
    blockers.push('canonical_research_honest_mode_guarantee_overclaim');
  }

  const finalReviewedAt = researchTimestamp(finalReview?.reviewed_at);
  if (!finalReviewedAt) blockers.push('canonical_adversarial_final_review_timestamp_invalid');
  for (const revision of revisions) {
    const revisionCycle = Number(revision?.cycle || 0);
    if (revision?.ok !== true) blockers.push(`canonical_adversarial_revision_not_ok:${revisionCycle || 'unknown'}`);
    if (!researchTimestamp(revision?.revised_at)) blockers.push(`canonical_adversarial_revision_timestamp_invalid:${revisionCycle || 'unknown'}`);
    if (revisionCycle < 1 || revisionCycle >= finalCycle) blockers.push(`canonical_adversarial_revision_not_followed_by_review:${revisionCycle || 'unknown'}`);
  }
  if (finalCycle > 1) {
    const revisionCycles = new Set(revisions.map((revision: any) => Number(revision?.cycle || 0)));
    for (let cycle = 1; cycle < finalCycle; cycle += 1) {
      if (!revisionCycles.has(cycle)) blockers.push(`canonical_adversarial_review_without_revision:${cycle + 1}`);
    }
  }
  const latestRevisionAt = Math.max(0, ...revisions.map((revision: any) => researchTimestamp(revision?.revised_at)));
  if (latestRevisionAt && (!finalReviewedAt || finalReviewedAt < latestRevisionAt)) blockers.push('canonical_adversarial_post_revision_review_not_fresh');
  if (revisions.length) {
    const priorThreadIds = new Set(reviewCycles.slice(0, -1).flatMap((cycle: any) => (Array.isArray(cycle?.reviewers) ? cycle.reviewers : []).map((reviewer: any) => String(reviewer?.thread_id || '').trim()).filter(Boolean)));
    for (const threadId of threadIds) {
      if (priorThreadIds.has(threadId)) blockers.push(`canonical_adversarial_post_revision_thread_reused:${threadId}`);
    }
    const revisionRunIds = new Set(revisions.map((revision: any) => String(revision?.workflow_run_id || '').trim()).filter(Boolean));
    if (revisionRunIds.has(String(finalReview?.workflow_run_id || '').trim())) blockers.push('canonical_adversarial_post_revision_run_reused');
  }

  let rebuiltEvidence: any = null;
  let persistedEvidence: any = null;
  let normalizedParent: ReturnType<typeof normalizeSubagentParentSummary> | null = null;
  if (mockOnly) {
    if (convergenceGate?.official_subagent_evidence_ok !== true) blockers.push('canonical_adversarial_mock_contract_evidence_not_ok');
  } else if (executionClass === 'real') {
    const [parentSummary, evidence, events] = await Promise.all([
      readJson(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), null),
      readJson(path.join(dir, SUBAGENT_EVIDENCE_FILENAME), null),
      readSubagentEvents(dir)
    ]);
    normalizedParent = normalizeSubagentParentSummary(parentSummary);
    persistedEvidence = evidence;
    const workflowRunId = String(finalReview?.workflow_run_id || convergenceGate?.workflow_run_id || '').trim();
    if (!workflowRunId) blockers.push('canonical_adversarial_workflow_run_id_missing');
    if (!normalizedParent.trustworthy || normalizedParent.status !== 'completed') blockers.push(...(normalizedParent.blockers.length ? normalizedParent.blockers.map((blocker) => `canonical_adversarial_parent:${blocker}`) : ['canonical_adversarial_parent_untrustworthy']));
    if (normalizedParent.run_id !== workflowRunId) blockers.push('canonical_adversarial_parent_run_id_mismatch');
    rebuiltEvidence = buildSubagentEvidence({
      requestedSubagents: expectedReviewerCount,
      events,
      parentSummary,
      parentSummaryPresent: normalizedParent.present,
      workflowStatus: 'parent_completed',
      runId: workflowRunId
    });
    if (!rebuiltEvidence.ok) blockers.push(...rebuiltEvidence.blockers.map((blocker: string) => `canonical_adversarial_evidence:${blocker}`));
    if (evidence?.schema !== 'sks.subagent-evidence.v1' || evidence?.ok !== true || evidence?.status !== 'completed') blockers.push('canonical_adversarial_persisted_evidence_invalid');
    if (convergenceGate?.official_subagent_evidence_ok !== true) blockers.push('canonical_adversarial_convergence_evidence_not_ok');
    if (String(convergenceGate?.workflow_run_id || '') !== workflowRunId) blockers.push('canonical_adversarial_convergence_run_id_mismatch');
    if (String(evidence?.run_id || '') !== workflowRunId) blockers.push('canonical_adversarial_persisted_evidence_run_id_mismatch');
    if (!sameResearchStringSet(threadIds, rebuiltEvidence?.completed_thread_ids)) blockers.push('canonical_adversarial_rebuilt_thread_correlation_failed');
    if (!sameResearchStringSet(threadIds, evidence?.completed_thread_ids)) blockers.push('canonical_adversarial_persisted_thread_correlation_failed');
    if (Number(evidence?.requested_subagents || 0) !== expectedReviewerCount
      || Number(evidence?.started_threads || 0) !== expectedReviewerCount
      || Number(evidence?.completed_threads || 0) !== expectedReviewerCount
      || Number(evidence?.failed_threads || 0) !== 0
      || normalizeResearchStrings(evidence?.open_thread_ids).length
      || normalizeResearchStrings(evidence?.ambiguous_stop_thread_ids).length
      || normalizeResearchStrings(evidence?.unmatched_stop_thread_ids).length
      || evidence?.parent_summary_trustworthy !== true
      || evidence?.parent_summary_status !== 'completed') {
      blockers.push('canonical_adversarial_persisted_evidence_counts_invalid');
    }
    const finalReviewerByThread = new Map(reviewers.map((reviewer: any) => [String(reviewer?.thread_id || ''), reviewer]));
    for (const row of Array.isArray(normalizedParent.raw?.thread_outcomes) ? normalizedParent.raw.thread_outcomes : []) {
      const threadId = String(row?.thread_id || '').trim();
      const outcome = parseExactResearchJsonObject(row?.summary);
      const reviewer: any = finalReviewerByThread.get(threadId);
      if (!reviewer || row?.status !== 'completed' || !outcome) {
        blockers.push(`canonical_adversarial_parent_outcome_invalid:${threadId || 'unknown'}`);
        continue;
      }
      blockers.push(...canonicalResearchReviewerBlockers({ ...outcome, thread_id: threadId, thread_status: row.status }, currentSourceIds, reviewedArtifactBundle)
        .map((blocker) => `canonical_adversarial_parent_outcome:${blocker}`));
      if (outcome.schema !== 'sks.research-adversarial-reviewer-outcome.v1'
        || String(outcome.persona_id || '') !== String(reviewer.persona_id || '')
        || String(outcome.verdict || '') !== String(reviewer.verdict || '')) {
        blockers.push(`canonical_adversarial_parent_outcome_mismatch:${threadId}`);
      }
    }
  }

  return {
    schema: 'sks.research-canonical-adversarial-validation.v1',
    ok: [...new Set(blockers)].length === 0,
    execution_class: executionClass || null,
    mock_only: mockOnly,
    review_cycles: reviewCycles.length,
    revision_cycles: revisions.length,
    final_cycle: finalCycle || null,
    reviewer_thread_ids: [...new Set(threadIds)].sort(),
    workflow_run_id: String(finalReview?.workflow_run_id || convergenceGate?.workflow_run_id || '').trim() || null,
    parent_summary_trustworthy: normalizedParent?.trustworthy ?? false,
    official_subagent_evidence_ok: rebuiltEvidence?.ok ?? (mockOnly ? true : false),
    blockers: [...new Set(blockers)]
  };
}

function canonicalResearchReviewerBlockers(reviewer: any, currentSourceIds: Set<string> = new Set(), expectedArtifactBundle = ''): string[] {
  const personaId = String(reviewer?.persona_id || 'unknown');
  const blockers: string[] = [];
  if (reviewer?.schema !== 'sks.research-adversarial-reviewer-outcome.v1') blockers.push(`canonical_adversarial_reviewer_schema:${personaId}`);
  if (!String(reviewer?.thread_id || '').trim()) blockers.push(`canonical_adversarial_reviewer_thread_missing:${personaId}`);
  if (reviewer?.thread_status !== 'completed') blockers.push(`canonical_adversarial_reviewer_thread_not_completed:${personaId}`);
  if (!['approve', 'revise', 'reject'].includes(reviewer?.verdict)) blockers.push(`canonical_adversarial_reviewer_verdict_invalid:${personaId}`);
  if (!String(reviewer?.strongest_challenge || '').trim()) blockers.push(`canonical_adversarial_reviewer_challenge_missing:${personaId}`);
  if (!normalizeResearchStrings(reviewer?.evidence_source_ids).length) blockers.push(`canonical_adversarial_reviewer_evidence_missing:${personaId}`);
  if (!normalizeResearchStrings(reviewer?.falsifiers).length) blockers.push(`canonical_adversarial_reviewer_falsifier_missing:${personaId}`);
  if (!normalizeResearchStrings(reviewer?.cheap_probes).length) blockers.push(`canonical_adversarial_reviewer_probe_missing:${personaId}`);
  if (!/^[a-f0-9]{64}$/i.test(String(reviewer?.review_artifact_bundle_sha256 || ''))) blockers.push(`canonical_adversarial_reviewer_artifact_bundle_missing:${personaId}`);
  if (expectedArtifactBundle && String(reviewer?.review_artifact_bundle_sha256 || '') !== expectedArtifactBundle) blockers.push(`canonical_adversarial_reviewer_artifact_bundle_mismatch:${personaId}`);
  for (const sourceId of normalizeResearchStrings(reviewer?.evidence_source_ids)) {
    if (!currentSourceIds.has(sourceId)) blockers.push(`canonical_adversarial_reviewer_source_unknown:${personaId}:${sourceId}`);
  }
  const criticalObjections = Array.isArray(reviewer?.critical_objections) ? reviewer.critical_objections : [];
  const majorObjections = Array.isArray(reviewer?.major_objections) ? reviewer.major_objections : [];
  const minorObjections = Array.isArray(reviewer?.minor_objections) ? reviewer.minor_objections : [];
  const objections = [...criticalObjections, ...majorObjections, ...minorObjections];
  for (const objection of objections) {
    for (const sourceId of normalizeResearchStrings(objection?.source_ids)) {
      if (!currentSourceIds.has(sourceId)) blockers.push(`canonical_adversarial_reviewer_objection_source_unknown:${personaId}:${sourceId}`);
    }
  }
  const materialObjections = [...criticalObjections, ...majorObjections];
  const requiredRevisions = normalizeResearchStrings(reviewer?.required_revisions);
  if (materialObjections.length || requiredRevisions.length) blockers.push(`canonical_adversarial_reviewer_material_objections_open:${personaId}`);
  if (reviewer?.verdict === 'approve' && (materialObjections.length || requiredRevisions.length)) blockers.push(`canonical_adversarial_reviewer_approve_with_revision:${personaId}`);
  if (reviewer?.verdict !== 'approve' && !materialObjections.length && !requiredRevisions.length) blockers.push(`canonical_adversarial_reviewer_nonapproval_without_material_objection:${personaId}`);
  return blockers;
}

function normalizeResearchStrings(value: any): string[] {
  return [...new Set((Array.isArray(value) ? value : value == null ? [] : [value]).map((item) => String(item || '').trim()).filter(Boolean))];
}

function duplicateResearchStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function sameResearchStringSet(left: any, right: any): boolean {
  const a = normalizeResearchStrings(left).sort();
  const b = normalizeResearchStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function researchTimestamp(value: any): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseExactResearchJsonObject(value: any): any | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function evaluateResearchGate(dir: any) {
  const gate = await readJson(path.join(dir, 'research-gate.json'), defaultResearchGate());
  const contract = await readResearchQualityContract(dir);
  const plan = await readJson(path.join(dir, 'research-plan.json'), null);
  const context7Required = plan?.current_docs_policy?.context7_required === true;
  const context7Evidence = await researchContext7Evidence(dir);
  const reportPresent = await exists(path.join(dir, 'research-report.md'));
  const reportText = reportPresent ? await readText(path.join(dir, 'research-report.md'), '') : '';
  const reportQuality = analyzeResearchReportQuality(reportText);
  const synthesisOutput = await readJson(path.join(dir, 'research-synthesis-output.json'), null);
  const reportWordCount = countWords(reportText);
  const paperArtifact = await findResearchPaperArtifact(dir, plan);
  const paperPresent = paperArtifact.exists;
  const paperText = paperPresent ? await readText(paperArtifact.path, '') : '';
  const paperSections = paperPresent ? countResearchPaperSections(paperText) : 0;
  const sourceSkillPresent = await exists(path.join(dir, RESEARCH_SOURCE_SKILL_ARTIFACT));
  const sourcePresent = await exists(path.join(dir, 'source-ledger.json'));
  const ledgerPresent = await exists(path.join(dir, 'novelty-ledger.json'));
  const falsificationPresent = await exists(path.join(dir, 'falsification-ledger.json'));
  const sourceLedger = await readJson(path.join(dir, 'source-ledger.json'), null);
  const falsificationLedger = await readJson(path.join(dir, 'falsification-ledger.json'), null);
  const noveltyLedger = await readJson(path.join(dir, 'novelty-ledger.json'), null);
  const claimMatrixSummary = await readClaimEvidenceMatrix(dir);
  const claimMatrix = claimMatrixSummary.matrix;
  const claimMatrixValidation = validateClaimEvidenceMatrix(claimMatrix, sourceLedger, falsificationLedger);
  const blueprint = await readImplementationBlueprint(dir);
  const blueprintValidation = validateImplementationBlueprint(blueprint, contract);
  const experimentPlan = await readExperimentPlan(dir);
  const experimentValidation = validateExperimentPlan(experimentPlan, contract);
  const replicationPack = await readReplicationPack(dir);
  const replicationValidation = validateReplicationPack(replicationPack);
  const falsificationValidation = validateFalsificationCoverage(falsificationLedger, contract);
  const canonicalAdversarial = await validateCanonicalResearchAdversarialEvidence(dir);
  let sourceQualityReport = await readSourceQualityReport(dir);
  if (!sourceQualityReport && sourceLedger) sourceQualityReport = await writeSourceQualityReport(dir, sourceLedger, claimMatrix);
  const sourceEntries = Array.isArray(sourceLedger?.sources) ? sourceLedger.sources.length : 0;
  const counterEvidenceEntries = Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources.length : 0;
  const totalSourceEntries = sourceEntries + counterEvidenceEntries;
  const webSearchPasses = Math.max(Number(gate.web_search_passes || 0), Number(sourceLedger?.web_search_passes || 0));
  const requiredSourceLayers = sourceLayerIdsForPlan(plan);
  const sourceLayerStats = sourceLayerCoverageStats(sourceLedger, requiredSourceLayers);
  const triangulationChecks = Array.isArray(sourceLedger?.triangulation?.cross_layer_checks) ? sourceLedger.triangulation.cross_layer_checks.length : 0;
  const falsificationCases = Array.isArray(falsificationLedger?.cases) ? falsificationLedger.cases.length : 0;
  const searchBlockers = [
    ...(Array.isArray(gate.web_search_blockers) ? gate.web_search_blockers : []),
    ...(Array.isArray(sourceLedger?.blockers) ? sourceLedger.blockers : [])
  ].filter(Boolean);
  const citationCoverage = gate.citation_coverage === true || sourceLedger?.citation_coverage?.all_key_claims_cited === true;
  const reasons: any[] = [];
  if (!reportPresent && gate.report_present !== true) reasons.push('research_report_missing');
  if (context7Required && !context7Evidence.ok) reasons.push('context7_required_evidence_missing');
  if (reportWordCount < contract.min_report_words) reasons.push('research_report_too_short');
  if (!reportQuality.ok) reasons.push(...reportQuality.blockers);
  if (!paperPresent) reasons.push('research_paper_missing');
  if (paperSections < RESEARCH_PAPER_SECTION_GROUPS.length) reasons.push('research_paper_sections_missing');
  if (!sourceSkillPresent && gate.research_source_skill_present !== true) reasons.push('research_source_skill_missing');
  if (!sourcePresent && gate.source_ledger_present !== true) reasons.push('source_ledger_missing');
  if (!ledgerPresent && gate.novelty_ledger_present !== true) reasons.push('novelty_ledger_missing');
  if (!falsificationPresent && gate.falsification_ledger_present !== true) reasons.push('falsification_ledger_missing');
  if (webSearchPasses < 1) reasons.push('web_search_pass_missing');
  if (Math.max(Number(gate.source_entries || 0), sourceEntries) < 1) reasons.push('source_entry_missing');
  if (Math.max(Number(gate.source_entries || 0), totalSourceEntries) < contract.min_sources_total) reasons.push('source_entries_below_research_quality_contract');
  if (Math.max(Number(gate.source_layers_covered || 0), sourceLayerStats.covered.length) < requiredSourceLayers.length) reasons.push('source_layer_coverage_missing');
  if (Math.max(Number(gate.source_layers_covered || 0), sourceLayerStats.covered.length) < contract.min_source_layers_covered) reasons.push('source_layer_coverage_below_contract');
  if (Math.max(Number(gate.triangulation_checks || 0), triangulationChecks) < 1) reasons.push('cross_layer_triangulation_missing');
  if (Math.max(Number(gate.counterevidence_sources || 0), counterEvidenceEntries) < 1) reasons.push('counterevidence_source_missing');
  if (Math.max(Number(gate.counterevidence_sources || 0), counterEvidenceEntries) < contract.min_counterevidence_sources) reasons.push('counterevidence_below_contract');
  if ((gate.candidate_insights || 0) < 1) reasons.push('candidate_insight_missing');
  if ((gate.falsification_passes || 0) < 1) reasons.push('falsification_missing');
  if (Math.max(Number(gate.falsification_cases || 0), falsificationCases) < 1) reasons.push('falsification_case_missing');
  if (!falsificationValidation.ok) reasons.push(...falsificationValidation.blockers);
  if ((gate.testable_predictions || 0) < 1) reasons.push('testable_prediction_missing');
  if (!citationCoverage) reasons.push('citation_coverage_missing');
  if (!claimMatrixSummary.present) reasons.push('claim_evidence_matrix_missing');
  if (claimMatrix.key_claim_ids.length < contract.min_key_claims) reasons.push('key_claims_below_contract');
  if (claimMatrix.triangulated_claim_count < contract.min_trianguled_claims) reasons.push('triangulated_claims_below_contract');
  if (!claimMatrixValidation.ok) reasons.push(...claimMatrixValidation.blockers);
  if (!sourceQualityReport) reasons.push('source_quality_report_missing');
  if (sourceQualityReport && sourceQualityReport.ok !== true) reasons.push(...(Array.isArray(sourceQualityReport.blockers) ? sourceQualityReport.blockers : ['source_quality_report_not_ok']));
  if (!blueprint) reasons.push('implementation_blueprint_missing');
  if (!blueprintValidation.ok) reasons.push(...blueprintValidation.blockers);
  if (!experimentPlan) reasons.push('experiment_plan_missing');
  if (!experimentValidation.ok) reasons.push(...experimentValidation.blockers);
  if (!replicationPack) reasons.push('replication_pack_missing');
  if (!replicationValidation.ok) reasons.push(...replicationValidation.blockers);
  if (!canonicalAdversarial.ok) reasons.push(...canonicalAdversarial.blockers);
  for (const artifact of contract.required_artifacts || []) {
    if (artifact === RESEARCH_FINAL_REVIEW_ARTIFACT) continue;
    if (!(await exists(path.join(dir, artifact)))) reasons.push(`required_artifact_missing:${artifact}`);
  }
  let finalReview = await readResearchFinalReview(dir);
  finalReview = await runResearchFinalReviewer(dir, {
    contract,
    sourceLedger,
    claimMatrix,
    blueprint,
    experimentPlan,
    replicationPack,
    falsificationLedger,
    reportText,
    preliminaryReasons: reasons
  });
  if (!finalReview) reasons.push('final_review_missing');
  if (finalReview && finalReview.approved !== true) reasons.push('research_final_review_not_approved');
  if (searchBlockers.length > 0) reasons.push('web_search_blocked');
  if (gate.unsafe_or_destructive_actions === true) reasons.push('unsafe_or_destructive_actions_present');
  if ((gate.unsupported_breakthrough_claims || 0) > 0) reasons.push('unsupported_breakthrough_claims_present');
  const result = {
    checked_at: nowIso(),
    passed: gate.passed === true && reasons.length === 0,
    reasons,
    metrics: {
      research_paper_artifact: paperArtifact.name,
      paper_present: paperPresent || gate.paper_present === true,
      quality_contract: contract,
      report_word_count: reportWordCount,
      report_min_words: contract.min_report_words,
      report_quality: reportQuality,
      report_repetition: reportQuality.repetition,
      source_density_per_1000_words: reportQuality.source_density_per_1000_words,
      claim_density_per_1000_words: reportQuality.claim_density_per_1000_words,
      template_phrase_hits: reportQuality.repetition?.template_phrase_hits || [],
      synthesis: {
        writer: synthesisOutput ? (sourceLedger?.mode === 'selftest_mock' ? 'mock' : 'codex-sdk evidence-bound writer') : 'missing',
        repetition_ratio: reportQuality.repetition?.repeated_paragraph_ratio ?? null,
        source_density_per_1000_words: reportQuality.source_density_per_1000_words,
        claim_density_per_1000_words: reportQuality.claim_density_per_1000_words,
        template_phrase_hits: reportQuality.repetition?.template_phrase_hits || [],
        codex_final_review_verdict: finalReview?.codex_review?.verdict || null
      },
      web_search_passes: webSearchPasses,
      paper_sections: Math.max(Number(gate.paper_sections || 0), paperSections),
      research_source_skill_present: sourceSkillPresent || gate.research_source_skill_present === true,
      source_entries: Math.max(Number(gate.source_entries || 0), sourceEntries),
      source_entries_total_with_counterevidence: totalSourceEntries,
      min_sources_total: contract.min_sources_total,
      source_layers_required: requiredSourceLayers.length,
      source_layers_covered: Math.max(Number(gate.source_layers_covered || 0), sourceLayerStats.covered.length),
      min_source_layers_covered: contract.min_source_layers_covered,
      source_layers_missing: sourceLayerStats.missing,
      triangulation_checks: Math.max(Number(gate.triangulation_checks || 0), triangulationChecks),
      claim_evidence_matrix_present: claimMatrixSummary.present,
      key_claims: claimMatrix.key_claim_ids.length,
      min_key_claims: contract.min_key_claims,
      triangulated_claims: claimMatrix.triangulated_claim_count,
      min_triangulated_claims: contract.min_trianguled_claims,
      claim_evidence_matrix_ok: claimMatrixValidation.ok,
      claim_evidence_matrix_blockers: claimMatrixValidation.blockers,
      source_quality_report_ok: sourceQualityReport?.ok === true,
      xhigh_agents: 0,
      counterevidence_sources: Math.max(Number(gate.counterevidence_sources || 0), counterEvidenceEntries),
      min_counterevidence_sources: contract.min_counterevidence_sources,
      falsification_cases: Math.max(Number(gate.falsification_cases || 0), falsificationCases),
      falsification_validation: falsificationValidation,
      implementation_blueprint_validation: blueprintValidation,
      experiment_plan_validation: experimentValidation,
      replication_pack_validation: replicationValidation,
      canonical_adversarial_validation: canonicalAdversarial,
      novelty_entries: Array.isArray(noveltyLedger?.entries) ? noveltyLedger.entries.length : null,
      final_review_approved: finalReview?.approved === true,
      final_review_blockers: Array.isArray(finalReview?.blockers) ? finalReview.blockers : [],
      citation_coverage: citationCoverage,
      web_search_blockers: searchBlockers.length,
      context7_required: context7Required,
      context7_verified: context7Evidence.ok,
      context7_evidence_records: context7Evidence.count
    },
    gate: {
      ...gate,
      research_paper_artifact: paperArtifact.name,
      paper_present: paperPresent || gate.paper_present === true
    }
  };
  await writeJsonAtomic(path.join(dir, 'research-gate.evaluated.json'), result);
  return result;
}

async function researchContext7Evidence(dir: string) {
  const text = await readText(path.join(dir, 'context7-evidence.jsonl'), '');
  let resolve = false;
  let docs = false;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    count += 1;
    try {
      const row = JSON.parse(line);
      if (row?.stage === 'resolve-library-id') resolve = true;
      if (row?.stage === 'get-library-docs' || row?.stage === 'query-docs') docs = true;
    } catch {}
  }
  return { resolve, docs, ok: resolve && docs, count };
}

export { writeMockResearchResult } from './research/mock-result.js';
