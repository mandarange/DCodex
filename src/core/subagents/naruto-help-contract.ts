import {
  NARUTO_PARENT_EFFORT,
  NARUTO_PARENT_MODEL
} from './model-policy.js'
import { NARUTO_ACTIONS } from '../safety/command-contract/types.js'
import {
  DEFAULT_AUTOMATIC_SUBAGENT_COUNT,
  MAX_AUTOMATIC_REVIEWER_COUNT,
  MAX_AUTOMATIC_SUBAGENT_COUNT,
  MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT,
  officialSubagentRolePlan
} from './agent-catalog.js'

export const NARUTO_HELP_SCHEMA = 'sks.naruto-subagent-workflow.v1'

export function buildNarutoHelpResult() {
  return {
    schema: NARUTO_HELP_SCHEMA,
    ok: true,
    action: 'help',
    workflow: 'official_codex_subagent',
    description: '$sks-naruto is the canonical SKS Naruto parallel system; Codex official subagents are the sealed transport. $sks-work is the intended execution alias.',
    usage: [
      'sks naruto run "<task>" [--agents N] [--max-threads N] [--trusted-project] [--json]',
      'sks naruto status [latest|M-...] [--json]',
      'sks naruto subagents [latest|M-...] [--json]',
      'sks naruto proof [latest|M-...] [--json]',
      'sks naruto parent-summary --mission M-... --stdin [--json] (active Codex App Naruto only)'
    ],
    commands: [...NARUTO_ACTIONS],
    default_requested_subagents: DEFAULT_AUTOMATIC_SUBAGENT_COUNT,
    scaling_policy: 'dynamic_capacity_min_ready_dag_disjoint_verifier_tools_available_marginal',
    automatic_subagent_ceiling: MAX_AUTOMATIC_SUBAGENT_COUNT,
    automatic_reviewer_ceiling: MAX_AUTOMATIC_REVIEWER_COUNT,
    critical_multi_domain_reviewer_ceiling: MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT,
    max_threads_is_cap_not_target: true,
    four_profiles_are_not_agent_cap: true,
    max_depth: 1,
    triwiki_context: 'bounded_attention_use_first_with_on_demand_hydration',
    model_routing_policy: {
      luna_max: 'tiny_short_context_mechanical_only',
      sol_high: 'ordinary_ui_logic_backend_and_native_implementation',
      sol_max: 'review_debug_planning_architecture_security_database_research_release_and_judgment',
      terra_medium: 'long_context_computer_use_browser_chrome_and_image_generation_execution',
      mixed_slice_rule: 'split_execution_from_judgment_when_possible_otherwise_sol_max_wins'
    },
    completion_evidence: {
      lifecycle_events: ['SubagentStart', 'SubagentStop'],
      stop_is_success_evidence: false,
      structured_parent_summary: 'subagent-parent-summary.json'
    },
    parent: { model: NARUTO_PARENT_MODEL, model_reasoning_effort: NARUTO_PARENT_EFFORT },
    agent_catalog_mode: 'full_catalog_only_on_explicit_help',
    agents: officialSubagentRolePlan()
  }
}
