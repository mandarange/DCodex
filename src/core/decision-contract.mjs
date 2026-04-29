import path from 'node:path';
import { readJson, writeJsonAtomic, nowIso, sha256 } from './fsx.mjs';
import { validateQaLoopAnswers } from './qa-loop.mjs';
import { inferAnswersForPrompt } from './questions.mjs';

function isEmptyAnswer(v, slot = {}) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return !slot.allow_empty;
  return false;
}

export function validateAnswers(schema, answers) {
  const errors = [];
  const resolved = [];
  for (const slot of schema.slots) {
    const value = answers[slot.id];
    if (slot.required && isEmptyAnswer(value, slot)) {
      errors.push({ slot: slot.id, error: 'required_answer_missing' });
      continue;
    }
    if (!isEmptyAnswer(value, slot) && slot.options) {
      const values = Array.isArray(value) ? value : [value];
      for (const val of values) {
        if (!slot.options.includes(val)) errors.push({ slot: slot.id, error: 'invalid_option', value: val, allowed: slot.options });
      }
    }
    if (!isEmptyAnswer(value, slot) || (Array.isArray(value) && value.length === 0 && slot.allow_empty)) resolved.push(slot.id);
  }
  const madSks = answers.MAD_SKS_MODE === 'explicit_invocation_only';
  if (answers.DESTRUCTIVE_DB_OPERATIONS_ALLOWED && answers.DESTRUCTIVE_DB_OPERATIONS_ALLOWED !== 'never' && !madSks) {
    errors.push({ slot: 'DESTRUCTIVE_DB_OPERATIONS_ALLOWED', error: 'sneakoscope_never_allows_destructive_database_operations' });
  }
  if (answers.DATABASE_TARGET_ENVIRONMENT === 'production_write' && !madSks) {
    errors.push({ slot: 'DATABASE_TARGET_ENVIRONMENT', error: 'production_write_target_forbidden' });
  }
  errors.push(...validateQaLoopAnswers(schema, answers));
  return { ok: errors.length === 0, errors, resolved, totalRequired: schema.slots.filter((s) => s.required).length };
}

export function buildDecisionContract({ mission, schema, answers }) {
  const madSks = answers.MAD_SKS_MODE === 'explicit_invocation_only';
  const defaults = {
    if_multiple_valid_implementations: 'choose_smallest_reversible_change',
    if_test_command_unknown: 'infer_from_repo_scripts_and_run_most_local_relevant_test',
    if_e2e_unavailable: 'run_unit_or_integration_and_record_e2e_not_executed',
    if_dependency_needed: 'avoid_new_dependency_unless_allowed_by_contract',
    if_existing_behavior_conflict: 'preserve_existing_public_behavior',
    if_visual_cartridge_conflict: 'vgraph_json_wins_over_rendered_gx_artifact',
    if_wiki_conflict: 'current_code_wins_over_wiki',
    if_low_confidence_claim: 'read_source_do_not_ask_user',
    if_unresolvable_optional_scope: 'defer_optional_subtask_and_complete_core_acceptance_criteria',
    if_unresolvable_required_scope: 'choose_safest_minimal_implementation_within_hard_constraints',
    if_database_uncertain: 'read_only_only_or_skip_database_action',
    if_database_write_needed: 'create_migration_file_only_unless_contract_allows_local_or_branch_apply',
    if_mcp_database_tool_needed: 'use_read_only_project_scoped_supabase_mcp_or_do_not_use_mcp',
    if_database_blast_radius_unknown: 'do_not_execute_live_dml'
  };
  const fallback = answers.MID_RALPH_UNKNOWN_POLICY || ['preserve_existing_behavior', 'smallest_reversible_change', 'defer_optional_scope', 'block_only_if_no_safe_path'];
  const contract = {
    schema_version: 2,
    mission_id: mission.id,
    status: 'sealed',
    sealed_at: nowIso(),
    ralph_mode: 'no_questions',
    prompt: mission.prompt,
    answers,
    hard_constraints: {
      ask_user_during_ralph: false,
      public_api_change_allowed: answers.PUBLIC_API_CHANGE_ALLOWED || 'no',
      db_schema_change_allowed: answers.DB_SCHEMA_CHANGE_ALLOWED || 'no',
      dependency_change_allowed: answers.DEPENDENCY_CHANGE_ALLOWED || 'no',
      auth_protocol_change_allowed: answers.AUTH_PROTOCOL_CHANGE_ALLOWED || 'no',
      destructive_db_operations_allowed: madSks ? 'mad_sks_scoped' : false,
      database_target_environment: answers.DATABASE_TARGET_ENVIRONMENT || 'no_database',
      database_write_mode: answers.DATABASE_WRITE_MODE || 'read_only_only',
      supabase_mcp_policy: answers.SUPABASE_MCP_POLICY || 'not_used',
      db_backup_or_branch_required: answers.DB_BACKUP_OR_BRANCH_REQUIRED || 'yes_for_any_write',
      db_max_blast_radius: answers.DB_MAX_BLAST_RADIUS || 'no_live_dml',
      qa_loop_scope: answers.QA_SCOPE || null,
      qa_loop_target_environment: answers.TARGET_ENVIRONMENT || null,
      qa_loop_mutation_policy: answers.QA_MUTATION_POLICY || null,
      qa_loop_credentials_saved: false,
      qa_loop_ui_requires_official_browser_or_computer_use: Boolean(answers.QA_SCOPE && answers.QA_SCOPE !== 'api_e2e_only'),
      mad_sks_mode: madSks ? 'explicit_invocation_only' : false,
      production_database_writes_allowed: madSks ? 'mad_sks_scoped' : false,
      mcp_direct_execute_sql_writes_allowed: madSks ? 'mad_sks_scoped' : false,
      db_reset_allowed: madSks ? 'mad_sks_scoped' : false,
      db_drop_allowed: madSks ? 'requires_table_delete_confirmation_when_table_removal' : false,
      db_truncate_allowed: madSks ? 'requires_table_delete_confirmation_when_table_removal' : false,
      db_mass_delete_update_allowed: madSks ? 'mad_sks_scoped' : false
    },
    database_safety: {
      policy: madSks ? 'mad_sks_scoped_override_table_delete_confirmation_required' : 'destructive_denied_always',
      supabase_mcp_recommended_url: 'https://mcp.supabase.com/mcp?project_ref=<project_ref>&read_only=true&features=database,docs',
      allowed_targets_for_write: madSks ? ['main_branch', 'production', 'local_dev', 'preview_branch', 'supabase_branch'] : ['local_dev', 'preview_branch', 'supabase_branch'],
      forbidden_operations: madSks ? ['TABLE_REMOVAL_WITHOUT_RUNTIME_CONFIRMATION'] : ['DROP', 'TRUNCATE', 'DELETE_WITHOUT_WHERE', 'UPDATE_WITHOUT_WHERE', 'DB_RESET', 'DB_PUSH', 'PROJECT_DELETE', 'BRANCH_RESET_OR_MERGE_OR_DELETE', 'DISABLE_RLS', 'BROAD_GRANT_REVOKE'],
      mad_sks_scope: madSks ? {
        active_only_when_prompt_contains: '$MAD-SKS',
        may_combine_with_primary_route: true,
        deactivates_when_active_mission_gate_passes: true,
        table_delete_confirmation_timeout_ms: 30000
      } : null,
      migration_apply_allowed: answers.DB_MIGRATION_APPLY_ALLOWED || 'no',
      read_only_query_limit: answers.DB_READ_ONLY_QUERY_LIMIT || '1000'
    },
    acceptance_criteria: Array.isArray(answers.ACCEPTANCE_CRITERIA) ? answers.ACCEPTANCE_CRITERIA : String(answers.ACCEPTANCE_CRITERIA || '').split('\n').map((x) => x.trim()).filter(Boolean),
    non_goals: Array.isArray(answers.NON_GOALS) ? answers.NON_GOALS : String(answers.NON_GOALS || '').split('\n').map((x) => x.trim()).filter(Boolean),
    test_scope: answers.TEST_SCOPE,
    approved_defaults: defaults,
    decision_ladder: [
      'seed_contract',
      'explicit_user_answer',
      'approved_defaults',
      'database_safety_policy',
      'AGENTS.md',
      'vgraph.json',
      'current_code_and_tests',
      ...fallback,
      'blocked_report_only_if_no_safe_path'
    ],
    implementation_allowed: true
  };
  contract.sealed_hash = sha256(JSON.stringify(contract));
  return contract;
}

export async function sealContract(missionDir, mission) {
  const schema = await readJson(path.join(missionDir, 'required-answers.schema.json'));
  const explicitAnswers = await readJson(path.join(missionDir, 'answers.json'));
  const inferred = inferAnswersForPrompt(mission?.prompt || schema?.prompt || '', explicitAnswers);
  const answers = {
    ...(schema.inferred_answers || {}),
    ...inferred.answers,
    ...explicitAnswers
  };
  const validation = validateAnswers(schema, answers);
  if (!validation.ok) return { ok: false, validation };
  const contract = buildDecisionContract({ mission, schema, answers });
  await writeJsonAtomic(path.join(missionDir, 'resolved-answers.json'), {
    explicit_answers: explicitAnswers,
    inferred_answers: { ...(schema.inferred_answers || {}), ...inferred.answers },
    inference_notes: { ...(schema.inference_notes || {}), ...inferred.notes },
    answers
  });
  await writeJsonAtomic(path.join(missionDir, 'decision-contract.json'), contract);
  await writeJsonAtomic(path.join(missionDir, 'answer-validation.json'), validation);
  return { ok: true, validation, contract };
}
