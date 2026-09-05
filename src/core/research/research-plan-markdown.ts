export function renderResearchPlanMarkdown(plan: any, helpers: {
  researchPaperArtifactForPlan: (plan: any) => string
  researchAgentAgentName: (agent: any) => string
}) {
  const lines: any[] = []
  lines.push('# SKS Research Plan')
  lines.push('')
  lines.push(`Prompt: ${plan.prompt}`)
  lines.push(`Depth: ${plan.depth}`)
  lines.push(`Methodology: ${plan.methodology}`)
  lines.push(`Research paper: ${helpers.researchPaperArtifactForPlan(plan)}`)
  if (plan.codex_app_execution_profile) {
    lines.push(`Execution profile: ${plan.codex_app_execution_profile.mode}; agent role strategy ${plan.codex_app_execution_profile.agent_role_strategy}`)
  }
  if (plan.execution_policy) {
    lines.push(`Execution: ${plan.execution_policy.normal_run}; default cycle timeout ${plan.execution_policy.default_cycle_timeout_minutes} minutes`)
    if (plan.execution_policy.default_max_cycles) lines.push(`Adversarial review loop: run three independent official research_reviewer threads, revise critical, major, or required findings, then run a fresh three-thread cycle; default safety cap ${plan.execution_policy.default_max_cycles} cycles`)
    lines.push(`Mock policy: ${plan.execution_policy.mock_policy}`)
  }
  if (plan.mutation_policy) lines.push(`Mutation policy: ${plan.mutation_policy.rule}`)
  lines.push('')
  if (plan.quality_contract) {
    const contract = plan.quality_contract
    lines.push('## Quality Contract')
    lines.push(`- minimum sources: ${contract.min_sources_total}`)
    lines.push(`- minimum source layers covered: ${contract.min_source_layers_covered}`)
    lines.push(`- minimum counterevidence sources: ${contract.min_counterevidence_sources}`)
    lines.push(`- minimum key claims: ${contract.min_key_claims}`)
    lines.push(`- minimum triangulated claims: ${contract.min_trianguled_claims}`)
    lines.push(`- minimum blueprint sections: ${contract.min_implementation_blueprint_sections}`)
    lines.push(`- minimum falsification cases: ${contract.min_falsification_cases}`)
    lines.push(`- minimum experiment steps: ${contract.min_experiment_steps}`)
    lines.push(`- minimum report words: ${contract.min_report_words}`)
    lines.push('')
  }
  if (plan.native_agent_plan) {
    lines.push('## Official Subagent Review Plan')
    lines.push(`Backend: ${plan.native_agent_plan.backend}`)
    lines.push(`Sessions: ${plan.native_agent_plan.session_count}`)
    lines.push(`AutoResearch batches: ${plan.native_agent_plan.autoresearch_cycle_policy?.uses_agent_batches ? 'enabled' : 'disabled'}`)
    for (const persona of plan.native_agent_plan.personas || []) {
      lines.push(`- ${persona.id}: ${persona.role}; outputs ${(persona.outputs || []).join(', ')}`)
    }
    for (const batch of plan.native_agent_plan.batches || []) {
      lines.push(`- batch ${batch.id}: ${(batch.agents || []).join(', ')} -> ${(batch.outputs || []).join(', ')}`)
    }
    lines.push('')
  }
  lines.push('## Rules')
  for (const rule of plan.rules) lines.push(`- ${rule}`)
  lines.push('')
  if (plan.research_council?.agents?.length) {
    lines.push('## Independent Review Dimensions')
    lines.push(`Policy: ${plan.research_council.policy}`)
    for (const agent of plan.research_council.agents) lines.push(`- ${helpers.researchAgentAgentName(agent)}: ${agent.persona || agent.role} - ${agent.mandate} (${agent.persona_boundary || 'assigned review dimension'})`)
    lines.push('')
  }
  if (plan.web_research_policy) {
    lines.push('## Web Research Policy')
    lines.push(`Mode: ${plan.web_research_policy.mode}`)
    lines.push(`Requirement: ${plan.web_research_policy.requirement}`)
    if (plan.web_research_policy.source_tool_routing) lines.push(`Source tool routing: ${plan.web_research_policy.source_tool_routing.mode}`)
    for (const querySet of plan.web_research_policy.query_sets || []) lines.push(`- query set: ${querySet}`)
    if (plan.web_research_policy.skill_creator?.artifact) lines.push(`- source skill artifact: ${plan.web_research_policy.skill_creator.artifact}`)
    for (const layer of plan.web_research_policy.source_layers || []) {
      lines.push(`- layer ${layer.id}: ${layer.purpose}`)
    }
    lines.push('')
  }
  lines.push('## Outcome Rubric')
  for (const item of plan.outcome_rubric || []) lines.push(`- ${item.id}: ${item.description}`)
  lines.push('')
  lines.push('## Phases')
  for (const phase of plan.phases) lines.push(`- ${phase.id}: ${phase.goal}`)
  lines.push('')
  lines.push('## Required Artifacts')
  for (const artifact of plan.required_artifacts) lines.push(`- ${artifact}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function renderResearchSourceSkillMarkdown(plan: any, defaultLayers: readonly any[]) {
  const layers = plan?.web_research_policy?.source_layers?.length ? plan.web_research_policy.source_layers : defaultLayers
  const lines: any[] = []
  lines.push('# Research Source Layer Skill')
  lines.push('')
  lines.push('Status: route-local candidate skill. Use it inside this research mission before agent synthesis. Do not install or edit generated .agents/skills from this artifact.')
  lines.push('Real-run policy: collect live sources for as long as needed within the mission timeout; mock or fixture evidence is valid only for explicit --mock selftests.')
  lines.push('')
  lines.push('## Trigger')
  lines.push('- Any `$Research` run that must collect broad public evidence before synthesis, adversarial review, falsification, or paper writing.')
  lines.push('')
  lines.push('## Source Layers')
  for (const layer of layers) {
    lines.push(`- ${layer.id}: ${layer.purpose}`)
    lines.push(`  Examples: ${(layer.examples || []).join(', ')}`)
    lines.push(`  Query templates: ${(layer.query_templates || []).join(' | ')}`)
  }
  lines.push('')
  lines.push('## Output Contract')
  lines.push('- Fill source-ledger.json with `source_layers`, `sources[].layer`, `counterevidence_sources[].layer`, `citation_coverage`, `triangulation.cross_layer_checks`, and `blockers`.')
  lines.push('- Each source entry should record title, locator/URL, publisher or author when known, published_at when known, accessed_at, layer, reliability, credibility, stance, supports or undermines, and notes.')
  lines.push('- Public discourse sources such as X/Twitter or Reddit are signals and edge cases, not truth. They must be triangulated with formal, official, practitioner, or counterevidence layers.')
  lines.push('- If a layer cannot be searched with the available runtime or credentials, record the blocker and keep research-gate.json unpassed.')
  lines.push('- Do not modify repository source code or generated harness files during Research; write only route-local mission artifacts.')
  lines.push('')
  lines.push('## Official Reviewer Use')
  lines.push('- Only source-ledger ids with correlated verified-content Super Search proof may support a real-run reviewer finding.')
  lines.push('- Run exactly three independent official `research_reviewer` threads covering evidence integrity, method validity, and falsification or replication.')
  lines.push('- The skeptic lens must challenge the strongest claim using counterevidence or source-quality downgrades.')
  lines.push('- Critical, major, or required revisions trigger a mission-local `research_synthesizer` revision followed by a fresh three-thread review cycle; minor concerns remain advisory.')
  lines.push('- `agent-ledger.json` and `debate-ledger.json` are compatibility projections from official reviewer outcomes. Canonical convergence requires three trustworthy parent outcomes and no unresolved material objection.')
  lines.push('- Synthesis keeps only claims that survive cross-layer triangulation and falsification.')
  lines.push('')
  return `${lines.join('\n')}\n`
}
