import { ASTRA_SUBAGENT_MODEL, SUBAGENT_EFFORT } from '../subagents/model-policy.js';

export const RECALLPULSE_DECISION_ARTIFACT = 'recallpulse-decision.json';
export const RECALLPULSE_HISTORY_ARTIFACT = 'recallpulse-history.jsonl';
export const MISSION_STATUS_LEDGER_ARTIFACT = 'mission-status-ledger.json';
export const MISSION_STATUS_HISTORY_ARTIFACT = 'mission-status-history.jsonl';
export const ROUTE_PROOF_CAPSULE_ARTIFACT = 'route-proof-capsule.json';
export const EVIDENCE_ENVELOPE_ARTIFACT = 'evidence-envelope.json';
export const RECALLPULSE_EVAL_ARTIFACT = 'recallpulse-eval-report.json';
export const RECALLPULSE_GOVERNANCE_ARTIFACT = 'recallpulse-governance-report.json';
export const RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT = 'recallpulse-task-goal-ledger.json';
export const RECALLPULSE_TASKS_FILE = 'docs/RECALLPULSE_0_8_0_TASKS.md';

export const RECALLPULSE_POLICY = Object.freeze({
  schema_version: 1,
  name: 'RecallPulse',
  mode: 'report_only',
  internal_origin: 'strong_reminder_intent',
  user_visible_language: 'neutral_positive_recall',
  profanity_policy: 'never_repeat_profane_origin_as_active_user_visible_prompt_text',
  first_milestone_done_when: [
    'report_only_decisions_written',
    'TriWiki_L1_L2_L3_decision_recorded',
    'durable_status_ledger_available',
    'duplicate_suppression_keys_recorded',
    'route_proof_capsule_written',
    'evidence_envelope_written',
    'eval_fixtures_pass',
    'existing_route_gates_remain_authoritative'
  ],
  stage_boundaries: {
    required: ['route_intake', 'before_planning', 'before_implementation', 'before_review', 'before_final'],
    optional: ['after_blocker_discovery', 'after_subagent_result', 'after_context7_evidence', 'after_db_safety_findings', 'after_failed_verification']
  },
  invariants: [
    'route_personalities_remain_owned_by_route_skills',
    'shared_recall_mechanics_live_in_one_common_spine',
    'cannot_bypass_db_safety',
    'cannot_bypass_visual_evidence_requirements',
    'cannot_replace_honest_mode',
    'cannot_replace_triwiki_validation_before_final',
    'cannot_introduce_unrequested_fallback_code',
    'record_uncertainty_for_stale_or_low_trust_memory',
    'prefer_current_source_evidence_over_old_memory',
    'distinguish_facts_inferences_hypotheses_and_tasks',
    'never_turn_alerting_into_repeated_nagging',
    'durable_state_beats_ephemeral_hook_text'
  ],
  no_regression: [
    'existing_route_gates',
    'generated_skill_installation',
    'codex_app_stop_hooks',
    'dfix_ultralight_behavior',
    'official_subagent_risk_scoped_review',
    'research_xhigh_agent_requirements',
    'db_destructive_operation_blocking',
    'imagegen_evidence_requirements'
  ],
  cache: {
    l1: {
      label: 'TriWiki L1',
      purpose: 'smallest active recall slice for the current stage',
      max_items_normal: 4,
      max_items_final: 6,
      max_tokens: 900,
      min_trust: 0.8,
      eligibility: ['trust_score', 'freshness', 'route_relevance', 'risk'],
      exclude: ['stale', 'conflicted', 'unsupported', 'low_confidence'],
      phrasing: 'positive_recall_only',
      reminder_style: 'short_remember_to_check_without_blame_language'
    },
    l2: {
      label: 'TriWiki L2',
      purpose: 'mission-local proof and execution memory',
      includes: ['route_context', 'decision_contract', 'gate_blockers', 'verification_results', 'subagent_handoffs', 'status_ledger_snapshot', 'route_artifacts', 'evidence_hashes', 'duplicate_keys', 'deduped_failed_recall']
    },
    l3: {
      label: 'TriWiki L3',
      purpose: 'source hydration from full TriWiki, ledgers, docs, and local code',
      triggers: ['stale_memory', 'low_trust_memory', 'source_conflict', 'final_claim', 'db_security_release', 'external_package_api', 'broad_route_policy', 'legacy_or_ignored_pack']
    },
    transitions: {
      promote_l3_to_l2: 'source_backed_claim_used_in_current_mission',
      promote_l2_to_l1: 'claim_immediately_stage_critical',
      demote_l1: 'claim_consumed_or_stage_changed',
      demote_l2: 'mission_phase_ended',
      demote_l3_candidate: 'stale_or_contradicted'
    },
    eviction: ['token_cost', 'duplicate_count', 'low_route_relevance', 'old_mission_scope', 'nice_to_know'],
    pinning: ['hard_safety_rules', 'user_acceptance_criteria', 'current_blockers', 'pending_verification_failures', 'release_version_facts']
  },
  actions: {
    cache_hit: 'enough_fresh_context_available',
    hydrate: 'source_or_l3_evidence_needed_before_proceeding',
    suppress: 'message_or_reminder_already_surfaced',
    escalate: 'route_must_use_heavier_gate_or_review_path',
    block: 'continuing_would_violate_policy_or_evidence_requirements',
    no_op: 'no_recall_relevant_item_for_stage'
  },
  input_contracts: ['stage_boundary', 'route_metadata', 'triwiki_attention', 'mission_artifact_freshness', 'hook_event', 'verification_result', 'user_message_context'],
  scoring: {
    deterministic: true,
    inputs: ['trust_score', 'freshness', 'route_relevance', 'risk', 'stage_id', 'route_id', 'artifact_freshness', 'duplicate_key'],
    weights: {
      trust_score: 0.32,
      route_relevance: 0.24,
      risk: 0.18,
      freshness: 0.14,
      stage_criticality: 0.08,
      duplicate_penalty: -0.12
    }
  },
  thresholds: {
    l1_default: 0.72,
    l1_final_claim: 0.84,
    db_security_release: 0.9,
    min_evidence_for_completion_claim: 1
  },
  invalid_context_pack_policy: {
    missing_pack: 'hydrate_and_report_only_no_behavior_change',
    coordinate_only_legacy_pack: 'hydrate_l3_and_require_refresh_before_final_claim',
    failed_wiki_validation: 'block_final_claim_until_validate_passes',
    stale_mission_id: 'bind_to_explicit_mission_id_or_report_latest_drift',
    subagent_child_mission: 'record_child_mission_handoff_in_l2_and_keep_parent_mission_binding',
    latest_mission_drift: 'resolve_latest_once_then_write_explicit_mission_id_into_artifacts',
    graduation: 'report_only_to_enforcement_only_after_shadow_eval_targets_pass'
  },
  status_ledger: {
    artifact: MISSION_STATUS_LEDGER_ARTIFACT,
    history_artifact: MISSION_STATUS_HISTORY_ARTIFACT,
    max_entries: 200,
    append_only_history: true,
    compacted_current_view: true,
    categories: ['info', 'progress', 'warning', 'blocker', 'verification', 'final'],
    audiences: ['user', 'route', 'reviewer', 'final-summary'],
    rule: 'hooks may point to ledger entries but must not be the only durable source'
  },
  repetition: {
    key_fields: ['route_id', 'mission_id', 'stage_id', 'claim_hash', 'evidence_hash', 'blocker_code', 'visible_message_hash'],
    repeat_budget: {
      route_stage: 2,
      finalization_hook: 2,
      blocker: 2,
      missing_artifact: 2
    },
    max_visible_repeat_count: 1,
    hidden_diagnostic_repeat_count: 20,
    cooldown_ms: 10 * 60 * 1000,
    reset_on: ['new_evidence', 'blocker_resolved', 'route_stage_changed'],
    no_reset_on: ['cosmetic_rewording', 'identical_missing_gate_artifact'],
    conversions: {
      duplicate_info_message: 'suppress_visible_repeat_and_keep_durable_status_row',
      repeated_blocker: 'escalate_to_route_gate_or_hard_blocker_when_no_progress_occurs',
      repeated_warning: 'convert_to_single_blocker_or_checklist_item_when_actionable',
      repeated_remember_message: 'convert_to_one_child_goal_checklist_item',
      repeated_hook_output: 'collapse_into_mission_status_ledger_summary'
    },
    telemetry: ['repeat_count', 'suppressed_count', 'cooldown_resets', 'alert_fatigue_proxy', 'message_useful_proxy', 'message_ignored_proxy'],
    regression_tests: ['duplicate_stop_hook_summary_collapses_to_status_ledger']
  },
  eval_targets: {
    required_recall_rate: 0.95,
    false_positive_hydration_rate_max: 0.2,
    duplicate_message_reduction_min: 0.5,
    token_cost_reduction_min: 0.05,
    route_gate_agreement_min: 0.98,
    critical_safety_regressions: 0,
    failed_selftest_increase: 0,
    route_completion_blocker_increase: 0,
    user_visible_confusion_report_increase: 0,
    unsupported_performance_claims: 0
  },
  route_registry_fields: ['shared_spine_enabled', 'recallpulse_stage_policy', 'status_projection_policy', 'repetition_budget', 'evidence_envelope_extensions', 'proof_capsule_extensions', 'persona_policy', 'release_notes_label'],
  feature_flag: 'SKS_RECALLPULSE_MODE',
  rollback: 'set SKS_RECALLPULSE_MODE=off or leave report_only unpromoted'
});

export const RESEARCH_REVIEWER_CONTRACT = Object.freeze([
  {
    id: 'evidence',
    display_name: 'Evidence Reviewer',
    persona: 'source integrity and claim linkage reviewer',
    role: 'evidence_integrity_reviewer',
    mandate: 'Check that material claims are supported by current eligible sources and that counterevidence is represented.',
    required_outputs: ['strongest_challenge', 'evidence_source_ids', 'falsifiers', 'cheap_probes']
  },
  {
    id: 'method',
    display_name: 'Method Reviewer',
    persona: 'method and validity reviewer',
    role: 'method_validity_reviewer',
    mandate: 'Check assumptions, method validity, limits, and whether the proposed tests can distinguish the claim from alternatives.',
    required_outputs: ['strongest_challenge', 'method_limits', 'falsifiers', 'cheap_probes']
  },
  {
    id: 'falsification',
    display_name: 'Falsification Reviewer',
    persona: 'falsification and replication reviewer',
    role: 'falsification_replication_reviewer',
    mandate: 'Attack the strongest surviving claim with counterevidence, replication risks, and decisive failure conditions.',
    required_outputs: ['strongest_challenge', 'counterevidence', 'falsifiers', 'cheap_probes']
  }
].map((agent: any) => Object.freeze({
  ...agent,
  persona_boundary: 'Apply only the assigned review dimension and report evidence-bound findings.',
  custom_agent: 'research_reviewer',
  model: ASTRA_SUBAGENT_MODEL,
  reasoning_effort: SUBAGENT_EFFORT,
  service_tier: 'fast'
})));
