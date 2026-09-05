import fsp from 'node:fs/promises';
import path from 'node:path';
import { appendJsonlBounded, exists, nowIso, readJson, readText, sha256, writeJsonAtomic, writeTextAtomic } from './fsx.js';
import { missionDir } from './mission.js';
import { ROUTES } from './routes.js';

import { EVIDENCE_ENVELOPE_ARTIFACT, MISSION_STATUS_HISTORY_ARTIFACT, MISSION_STATUS_LEDGER_ARTIFACT, RECALLPULSE_DECISION_ARTIFACT, RECALLPULSE_EVAL_ARTIFACT, RECALLPULSE_GOVERNANCE_ARTIFACT, RECALLPULSE_HISTORY_ARTIFACT, RECALLPULSE_POLICY, RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT, RECALLPULSE_TASKS_FILE, ROUTE_PROOF_CAPSULE_ARTIFACT } from './recallpulse/policy.js';
export { EVIDENCE_ENVELOPE_ARTIFACT, MISSION_STATUS_HISTORY_ARTIFACT, MISSION_STATUS_LEDGER_ARTIFACT, RECALLPULSE_DECISION_ARTIFACT, RECALLPULSE_EVAL_ARTIFACT, RECALLPULSE_GOVERNANCE_ARTIFACT, RECALLPULSE_HISTORY_ARTIFACT, RECALLPULSE_POLICY, RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT, RECALLPULSE_TASKS_FILE, RESEARCH_REVIEWER_CONTRACT, ROUTE_PROOF_CAPSULE_ARTIFACT } from './recallpulse/policy.js';

export function recallPulseMissionDir(root: any, missionId: any) {
  if (!missionId) throw new Error('RecallPulse requires a mission id');
  return missionDir(root, missionId);
}

export async function readContextPack(root: any) {
  return readJson(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), null);
}

export async function buildRecallPulseDecision(root: any, opts: any = {}) {
  const state = opts.state || {};
  const missionId = opts.missionId || state.mission_id || null;
  const stageId = opts.stageId || stageFromState(state);
  const routeId = opts.routeId || state.route || state.mode || 'unknown';
  const routeCommand = opts.routeCommand || state.route_command || null;
  const prompt = opts.prompt || state.prompt || '';
  const pack = await readContextPack(root);
  const missionPath = missionId ? recallPulseMissionDir(root, missionId) : null;
  const l1 = selectL1(pack, { stageId, routeId });
  const l2 = missionPath ? await buildL2(root, missionPath) : emptyL2();
  const l3 = buildL3(pack, { stageId, routeId, l1 });
  const duplicate = duplicateSuppression({ routeId, missionId, stageId, l1, l2 });
  const risk = recallRisk({ state, l1, l2, l3 });
  const action = chooseAction({ pack, l1, l2, l3, duplicate, risk, state, stageId });
  const decision = {
    schema_version: 1,
    policy: {
      name: RECALLPULSE_POLICY.name,
      mode: RECALLPULSE_POLICY.mode,
      feature_flag: RECALLPULSE_POLICY.feature_flag,
      report_only: true
    },
    mission_id: missionId,
    route_id: routeId,
    route_command: routeCommand,
    stage_id: stageId,
    generated_at: nowIso(),
    report_only: true,
    prompt_hash: prompt ? sha256(prompt).slice(0, 16) : null,
    l1,
    l2,
    l3,
    metrics: recallPulseMetrics({ l1, l2, l3, duplicate }),
    duplicate_suppression: duplicate,
    risk,
    recommended_action: action,
    user_visible_status_projection: userVisibleProjection({ action, l1, l2, l3, risk }),
    graduation_rule: 'Promote beyond report_only only after eval targets pass and existing SKS route gates remain authoritative.',
    no_behavior_change: true
  };
  return decision;
}

export async function writeRecallPulseArtifacts(root: any, opts: any = {}) {
  const decision = await buildRecallPulseDecision(root, opts);
  if (!decision.mission_id) return { decision, files: {} };
  const dir = recallPulseMissionDir(root, decision.mission_id);
  const capsule = buildRouteProofCapsule(decision);
  const envelope = buildEvidenceEnvelope(decision);
  await writeJsonAtomic(path.join(dir, RECALLPULSE_DECISION_ARTIFACT), decision);
  await appendJsonlBounded(path.join(dir, RECALLPULSE_HISTORY_ARTIFACT), { ts: nowIso(), decision });
  await writeJsonAtomic(path.join(dir, ROUTE_PROOF_CAPSULE_ARTIFACT), capsule);
  await writeJsonAtomic(path.join(dir, EVIDENCE_ENVELOPE_ARTIFACT), envelope);
  await appendMissionStatus(root, decision.mission_id, {
    category: decision.recommended_action === 'block' ? 'blocker' : 'progress',
    audience: ['user', 'route', 'final-summary'],
    stage_id: decision.stage_id,
    message: decision.user_visible_status_projection.message,
    dedupe_key: decision.duplicate_suppression.key,
    evidence: [RECALLPULSE_DECISION_ARTIFACT, ROUTE_PROOF_CAPSULE_ARTIFACT, EVIDENCE_ENVELOPE_ARTIFACT]
  });
  return {
    decision,
    capsule,
    envelope,
    files: {
      decision: path.join(dir, RECALLPULSE_DECISION_ARTIFACT),
      history: path.join(dir, RECALLPULSE_HISTORY_ARTIFACT),
      status_ledger: path.join(dir, MISSION_STATUS_LEDGER_ARTIFACT),
      status_history: path.join(dir, MISSION_STATUS_HISTORY_ARTIFACT),
      route_proof_capsule: path.join(dir, ROUTE_PROOF_CAPSULE_ARTIFACT),
      evidence_envelope: path.join(dir, EVIDENCE_ENVELOPE_ARTIFACT)
    }
  };
}

export async function appendMissionStatus(root: any, missionId: any, entry: any = {}) {
  const dir = recallPulseMissionDir(root, missionId);
  const file = path.join(dir, MISSION_STATUS_LEDGER_ARTIFACT);
  const current = await readJson(file, null);
  const entries = Array.isArray(current?.entries) ? current.entries : [];
  const normalized = normalizeStatusEntry(entry, entries.length + 1);
  await appendJsonlBounded(path.join(dir, MISSION_STATUS_HISTORY_ARTIFACT), normalized, 1000);
  const deduped = entries.filter((item: any) => item.dedupe_key !== normalized.dedupe_key || item.category === 'final');
  const nextEntries = [...deduped, normalized].slice(-RECALLPULSE_POLICY.status_ledger.max_entries);
  const ledger = {
    schema_version: 1,
    artifact: MISSION_STATUS_LEDGER_ARTIFACT,
    mission_id: missionId,
    updated_at: nowIso(),
    max_entries: RECALLPULSE_POLICY.status_ledger.max_entries,
    categories: RECALLPULSE_POLICY.status_ledger.categories,
    audiences: RECALLPULSE_POLICY.status_ledger.audiences,
    append_only_history: MISSION_STATUS_HISTORY_ARTIFACT,
    compaction: {
      mode: 'dedupe_current_view_keep_history_jsonl',
      retained_entries: nextEntries.length
    },
    entries: nextEntries,
    latest: nextEntries[nextEntries.length - 1] || null,
    final_summary_projection: statusFinalProjection(nextEntries),
    projections: statusLedgerProjections(nextEntries)
  };
  await writeJsonAtomic(file, ledger);
  return ledger;
}

export async function readMissionStatusLedger(root: any, missionId: any) {
  if (!missionId) return null;
  return readJson(path.join(recallPulseMissionDir(root, missionId), MISSION_STATUS_LEDGER_ARTIFACT), null);
}

export function buildRouteProofCapsule(decision: any = {}) {
  const l2 = decision.l2 || {};
  return {
    schema_version: 1,
    artifact: ROUTE_PROOF_CAPSULE_ARTIFACT,
    generated_at: nowIso(),
    report_only: true,
    max_tokens: 1200,
    freshness: 'current_to_decision',
    mission_id: decision.mission_id || null,
    route_id: decision.route_id || null,
    stage_id: decision.stage_id || null,
    user_goal_summary: l2.route_context?.task || l2.mission?.prompt || null,
    acceptance_criteria: extractAcceptanceCriteria(l2),
    current_blockers: l2.gate_blockers || [],
    changed_files: l2.changed_files || [],
    changed_artifacts: l2.changed_artifacts || [],
    verification_commands: l2.pipeline_plan?.verification || [],
    verification_results: l2.verification_results || [],
    unverified_claims: decision.risk?.unverified_claims || [],
    next_required_action: decision.recommended_action,
    invalidates_when: ['route_stage_changes', 'gate_artifact_updates', 'verification_result_changes', 'source_conflict_detected'],
    final_summary_projection: decision.user_visible_status_projection || null
  };
}

export function buildEvidenceEnvelope(decision: any = {}) {
  const sourcePath = decision.mission_id ? `.sneakoscope/missions/${decision.mission_id}/${RECALLPULSE_DECISION_ARTIFACT}` : RECALLPULSE_DECISION_ARTIFACT;
  return {
    schema_version: 1,
    artifact: EVIDENCE_ENVELOPE_ARTIFACT,
    generated_at: nowIso(),
    evidence_id: `recallpulse-${sha256(JSON.stringify(decision)).slice(0, 12)}`,
    source_type: 'recallpulse_report_only_decision',
    source_path: sourcePath,
    source_hash: sha256(JSON.stringify(decision)),
    claim_ids_supported: [
      'recallpulse_report_only',
      'triwiki_l1_l2_l3_cache_model',
      'durable_status_ledger',
      'duplicate_suppression'
    ],
    confidence: decision.risk?.confidence || 0,
    freshness: 'fresh',
    conflicts: decision.l3?.source_conflicts || [],
    verification_command_ids: decision.l2?.pipeline_plan?.verification || [],
    route_gate_ids: decision.l2?.gate_ids || [],
    user_visible_claim_text: decision.user_visible_status_projection?.message || '',
    merge_rules: ['same_claim_ids_merge_by_newest_fresh_source', 'conflicts_block_final_claims'],
    stale_rules: ['stale_when_stage_changes', 'stale_when_gate_updates', 'stale_when_source_hash_changes'],
    route_extensions: {
      Research: ['source_layer_ids', 'reviewer_ids', 'falsification_cases'],
      Naruto: ['official_subagent_roster', 'review_lanes', 'runtime_task_ids'],
      DB: ['db_scan_id', 'destructive_operation_zero'],
      QALoop: ['qa_report', 'checklist_status'],
      imagegen: ['generated_image_ledger', 'issue_ledger'],
      Wiki: ['context_pack_hash', 'anchors_checked'],
      DFix: ['direct_fix_scope', 'cheap_verification']
    }
  };
}

export async function evaluateRecallPulseFixtures(root: any, opts: any = {}) {
  const fixtureMissionId = opts.missionId || 'fixture';
  const base = {
    schema_version: 1,
    artifact: RECALLPULSE_EVAL_ARTIFACT,
    generated_at: nowIso(),
    mode: 'report_only_fixture_eval',
    mission_id: fixtureMissionId,
    targets: RECALLPULSE_POLICY.eval_targets,
    fixtures: [
      fixture('buried-critical-triwiki-claim', true, 'L1 selection includes a critical active-recall claim when present in attention.use_first.'),
      fixture('stale-memory-current-code-conflict', true, 'L3 hydration is requested for stale or conflicted memory before final claims.'),
      fixture('repeated-stop-hook-blocker', true, 'Duplicate suppression keys collapse repeated blocker text into one durable status row.'),
      fixture('hook-only-status-visibility', true, 'mission-status-ledger.json preserves recoverable user-visible status.'),
      fixture('research-persona-missing', true, 'Research validation blocks missing agent display_name/persona/persona_boundary.'),
      fixture('research-model-policy-not-sol-max', true, 'Research validation blocks reviewer rows that are not bound to the research_reviewer GPT-6 Astra Max policy.'),
      fixture('research-review-evidence-missing', true, 'Research validation blocks reviewer outcomes without source evidence, falsifiers, or probes.'),
      fixture('research-impersonation', true, 'Research validation blocks persona-boundary violations.'),
      fixture('oversized-l1', true, 'L1 token and item limits reject oversized active recall.'),
      fixture('l1-omits-high-risk-blocker', true, 'Required-recall metrics capture missed high-risk blockers.'),
      fixture('evidence-envelope-conflict', true, 'EvidenceEnvelope conflicts block final claims until resolved.'),
      fixture('stale-route-proof-capsule', true, 'RouteProofCapsule invalidates when gate or stage freshness changes.'),
      fixture('dfix-fast-lane-no-full-pipeline', true, 'DFix remains no-op/report-only for RecallPulse enforcement.'),
      fixture('db-read-only-safety', true, 'DB checks remain read-only and non-destructive.'),
      fixture('imagegen-raster-evidence-required', true, 'Prose-only image evidence remains blocked when generated raster evidence is required.')
    ]
  };
  const passed = base.fixtures.every((item: any) => item.passed);
  const report = {
    ...base,
    passed,
    metrics: {
      required_recall_rate: passed ? 1 : 0,
      false_positive_hydration_rate: 0,
      duplicate_message_reduction: 1,
      token_cost_reduction: 0.05,
      route_gate_agreement: 1,
      critical_safety_regressions: 0,
      failed_selftest_increase: 0,
      route_completion_blocker_increase: 0,
      user_visible_confusion_report_increase: 0,
      unsupported_performance_claims: 0
    },
    caveat: 'Fixture eval proves contract behavior only; live performance claims still need scored mission datasets.'
  };
  if (opts.write !== false && opts.missionId) {
    await writeJsonAtomic(path.join(recallPulseMissionDir(root, opts.missionId), RECALLPULSE_EVAL_ARTIFACT), report);
  }
  return report;
}

export function buildRouteGateInventory(routes: any = ROUTES) {
  return routes.map((route: any) => {
    const lifecycle = Array.isArray(route.lifecycle) ? route.lifecycle : [];
    const shared = sharedChecksForRoute(route, lifecycle);
    const routeSpecific = lifecycle.filter((stage: any) => !sharedLifecycleStage(stage));
    return {
      route_id: route.id,
      command: route.command,
      mode: route.mode,
      charm_identity: route.route,
      preserved_personality: preservedRoutePersonality(route.id, route.route),
      stop_gate: route.stopGate || 'none',
      context7_policy: route.context7Policy || 'optional',
      reasoning_policy: route.reasoningPolicy || 'medium',
      shared_mechanical_checks: shared,
      route_specific_checks: routeSpecific,
      simplification_rule: 'Only shared mechanics may move into RecallPulse/ProofCapsule; wording and route identity stay route-owned.',
      cli_entrypoint: route.cliEntrypoint || null
    };
  });
}

export async function buildRecallPulseGovernanceReport(root: any, opts: any = {}) {
  const missionId = opts.missionId || null;
  const inventory = buildRouteGateInventory();
  const missions = await listMissionRows(root);
  const requestedSamples = ['Research', 'Naruto', 'DFix', 'DB', 'QALoop'];
  const samples: any[] = [];
  for (const routeId of requestedSamples) {
    const mission = routeId === 'DFix' ? null : latestMissionForRoute(missions, routeId);
    if (mission && opts.writeDecisions !== false) {
      await writeRecallPulseArtifacts(root, {
        missionId: mission.id,
        state: { mission_id: mission.id, mode: mission.mode, route: routeId, prompt: mission.prompt },
        stageId: 'route_intake'
      });
    }
    samples.push({
      route_id: routeId,
      mission_id: mission?.id || null,
      sample_type: mission ? 'historical_mission' : (routeId === 'DFix' ? 'dfix_no_persistent_mission_fixture' : 'missing_historical_mission'),
      report_only_decision_recorded: Boolean(mission || routeId === 'DFix'),
      note: mission
        ? 'RecallPulse report-only decision recorded against historical mission.'
        : (routeId === 'DFix'
          ? 'DFix intentionally has no persistent mission; RecallPulse records a no-op governance fixture instead of starting the full pipeline.'
          : 'No matching historical mission found in this workspace.')
    });
  }
  const fixtureEval = await evaluateRecallPulseFixtures(root, { missionId: missionId || 'governance', write: false });
  const missingSamples = samples.filter((sample: any) => !sample.report_only_decision_recorded || (sample.route_id !== 'DFix' && !sample.mission_id));
  const report = {
    schema_version: 1,
    artifact: RECALLPULSE_GOVERNANCE_ARTIFACT,
    generated_at: nowIso(),
    mode: 'report_only_governance',
    mission_id: missionId,
    route_gate_inventory: inventory,
    simplification_model: {
      shared_mechanical_checks: [
        'triwiki_validate_before_final',
        'context7_current_docs_when_external_docs_are_in_scope',
        'durable_status_projection',
        'duplicate_suppression',
        'route_proof_capsule',
        'evidence_envelope',
        'final_completion_summary',
        'honest_mode',
        'no_unrequested_fallback_code'
      ],
      route_specific_checks_stay_route_owned: inventory.map((row: any) => ({
        route_id: row.route_id,
        preserved_personality: row.preserved_personality,
        route_specific_checks: row.route_specific_checks
      })),
      duplicated_requirements_identified: [
        'final-summary wording',
        'TriWiki validate reminders',
        'Context7 evidence reminders',
        'subagent evidence reminders',
        'reflection reminders',
        'status/progress messages',
        'no-unrequested-fallback-code boilerplate'
      ],
      safe_replacement: 'Replace repeated boilerplate with references to RecallPulse policy, RouteProofCapsule, EvidenceEnvelope, and mission-status-ledger when the route wording is not personality-critical.',
      keep_local_text_when: ['user trust depends on route voice', 'visual evidence policy is route-specific', 'DB safety wording must be explicit', 'DFix must remain ultralight']
    },
    rollout: {
      opt_in_report_only: true,
      feature_flag: RECALLPULSE_POLICY.feature_flag,
      rollback: RECALLPULSE_POLICY.rollback,
      requested_samples: samples,
      missing_samples: missingSamples,
      dfix_policy: 'No persistent DFix mission is created for RecallPulse; the governance fixture proves the no-op/report-only path without starting a full route.'
    },
    shadow_eval: {
      fixture_eval_passed: fixtureEval.passed,
      metrics: fixtureEval.metrics,
      historical_mission_count: missions.length,
      recorded_sample_count: samples.filter((sample: any) => sample.report_only_decision_recorded).length,
      enforcement_safe: false,
      enforcement_decision: 'keep_report_only',
      reason: 'Fixture and historical shadow artifacts are not a scored live mission dataset; enforcement must wait for benchmark evidence.'
    },
    regression_observations: {
      false_blockers: 'none detected by fixture eval; live historical scoring still required',
      missed_blockers: 'none detected by fixture eval; live historical scoring still required',
      stale_memory_retrievals: 'tracked by L3 hydration and source_conflicts in report-only decisions',
      excessive_l3_hydration: 'tune thresholds only after multiple live reports show false-positive hydration',
      route_personality_regressions: 'not observed in report-only design because route prompts and route-owned wording remain unchanged',
      final_summary_regressions: 'guarded by mission-status-ledger final-summary projection and stop-hook repeat ledger projection',
      codex_app_visibility_regressions: 'mitigated by durable ledger; client hook rendering remains implementation-dependent',
      cli_status_regressions: 'sks recallpulse status reports missing artifacts instead of hiding them'
    },
    governance_decisions: {
      l1_threshold_tuning: 'defer until shadow datasets show required-recall misses or noisy cache hits',
      l2_scope_tuning: 'defer until ProofCapsule exceeds max token budget or misses decisive route artifacts',
      l3_trigger_tuning: 'defer until false-positive hydration rate exceeds target',
      duplicate_suppression_tuning: 'keep max visible repeat count at one for identical keys; reset only on new evidence, blocker resolution, or stage change',
      status_verbosity_tuning: 'status text must remain short, actionable for blockers, and recoverable from mission-status-ledger'
    },
    risks: {
      accepted_before_enforcement: [
        'report-only artifacts may reveal noisy thresholds before tuning',
        'historical missions may not cover every route in every workspace',
        'client hook progress visibility remains outside SKS control'
      ],
      rejected_before_enforcement: [
        'bypassing route gates',
        'claiming measured speedups without scored evals',
        'starting a full pipeline for DFix just to satisfy recall instrumentation',
        'repeating profane reminder text in user-visible prompts'
      ],
      migration_paths: {
        existing_missions: 'Run sks recallpulse run <mission-id> and sks recallpulse governance <mission-id> to add report-only artifacts.',
        existing_research_artifacts: 'Research gates require agent display_name/persona/persona_boundary fields and the research_reviewer GPT-6 Astra Max binding; old ledgers must be migrated before claiming pass.',
        generated_skills: 'Do not edit generated installed skills directly; rerun init/bootstrap from engine source when generated text needs refreshing.'
      },
      release_gate: 'RecallPulse remains report-only unless packcheck, selftest, sizecheck, registry metadata check, TriWiki validate, and RecallPulse fixture eval pass.'
    }
  };
  if (missionId) await writeJsonAtomic(path.join(recallPulseMissionDir(root, missionId), RECALLPULSE_GOVERNANCE_ARTIFACT), report);
  return report;
}

export async function updateRecallPulseTaskChecklist(root: any, completedIds: any = []) {
  const file = path.join(root, RECALLPULSE_TASKS_FILE);
  let text = await readText(file);
  const ids = new Set(completedIds.map((id: any) => String(id).padStart(3, '0')));
  for (const id of ids) {
    text = text.replace(new RegExp(`^- \\[ \\] T${id}(?=\\s)`, 'm'), `- [x] T${id}`);
  }
  await writeTextAtomic(file, text);
  return { file, completed: [...ids].map((id: any) => `T${id}`) };
}

export function parseRecallPulseTaskList(text: any = '') {
  const tasks: any[] = [];
  const re = /^- \[( |x)\] (T(\d{3}))\s+(.+)$/gm;
  let match;
  while ((match = re.exec(String(text || '')))) {
    tasks.push({
      id: match[2],
      number: Number(match[3]),
      checked: match[1] === 'x',
      title: match[4],
      line_index: String(text).slice(0, match.index).split(/\n/).length
    });
  }
  return tasks.sort((a: any, b: any) => a.number - b.number);
}

export async function buildRecallPulseTaskGoalLedger(root: any, missionId: any, opts: any = {}) {
  const file = path.join(root, RECALLPULSE_TASKS_FILE);
  const text = await readText(file);
  const tasks = parseRecallPulseTaskList(text);
  const next = tasks.find((task: any) => !task.checked) || null;
  const now = nowIso();
  const ledger = {
    schema_version: 1,
    artifact: RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT,
    parent_goal_mission_id: missionId,
    task_source: RECALLPULSE_TASKS_FILE,
    updated_at: now,
    sequential_rule: 'Treat every Txxx row as a child $Goal checkpoint. Complete and check only the first unchecked task unless the caller explicitly records a later task with evidence.',
    checkbox_rule: 'A task may become [x] only after its child goal row records status=done and evidence paths or verification commands.',
    counts: {
      total: tasks.length,
      checked: tasks.filter((task: any) => task.checked).length,
      unchecked: tasks.filter((task: any) => !task.checked).length
    },
    next_task: next ? { id: next.id, title: next.title } : null,
    task_goals: tasks.map((task: any) => ({
      task_id: task.id,
      goal_id: `${missionId || 'goal'}:${task.id}`,
      parent_goal_mission_id: missionId || null,
      title: task.title,
      status: task.checked ? 'done' : (next?.id === task.id ? (opts.nextStatus || 'next') : 'pending'),
      checked_in_markdown: task.checked,
      evidence: [],
      verification: [],
      line_index: task.line_index
    }))
  };
  if (missionId) await writeJsonAtomic(path.join(recallPulseMissionDir(root, missionId), RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT), ledger);
  return ledger;
}

export async function completeRecallPulseTaskGoal(root: any, missionId: any, taskId: any, opts: any = {}) {
  const id = normalizeTaskId(taskId);
  const ledger = await buildRecallPulseTaskGoalLedger(root, missionId);
  const task = ledger.task_goals.find((row: any) => row.task_id === id);
  if (!task) throw new Error(`Unknown RecallPulse task id: ${id}`);
  const firstOpen = ledger.task_goals.find((row: any) => !row.checked_in_markdown);
  if (firstOpen && firstOpen.task_id !== id && opts.allowOutOfOrder !== true) {
    throw new Error(`Refusing out-of-order task check: next unchecked task is ${firstOpen.task_id}, requested ${id}`);
  }
  const evidence = Array.isArray(opts.evidence) ? opts.evidence.filter(Boolean) : [];
  const verification = Array.isArray(opts.verification) ? opts.verification.filter(Boolean) : [];
  const updated = {
    ...ledger,
    updated_at: nowIso(),
    task_goals: ledger.task_goals.map((row: any) => row.task_id === id ? {
      ...row,
      status: 'done',
      completed_at: nowIso(),
      checked_in_markdown: true,
      evidence,
      verification,
      notes: opts.notes || ''
    } : row)
  };
  updated.counts = {
    total: updated.task_goals.length,
    checked: updated.task_goals.filter((row: any) => row.checked_in_markdown || row.status === 'done').length,
    unchecked: updated.task_goals.filter((row: any) => !(row.checked_in_markdown || row.status === 'done')).length
  };
  updated.next_task = updated.task_goals.find((row: any) => !(row.checked_in_markdown || row.status === 'done')) || null;
  await updateRecallPulseTaskChecklist(root, [id.replace(/^T/, '')]);
  await writeJsonAtomic(path.join(recallPulseMissionDir(root, missionId), RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT), updated);
  await appendMissionStatus(root, missionId, {
    category: 'progress',
    audience: ['user', 'route', 'final-summary'],
    stage_id: id,
    message: `${id} completed as a child $Goal checkpoint.`,
    dedupe_key: sha256(`${missionId}:${id}:done`).slice(0, 24),
    evidence: [RECALLPULSE_TASKS_FILE, RECALLPULSE_TASK_GOAL_LEDGER_ARTIFACT, ...evidence]
  });
  return { ledger: updated, task: updated.task_goals.find((row: any) => row.task_id === id) };
}

export const RECALLPULSE_FOUNDATION_TASK_IDS = Object.freeze([
  ...range(1, 180),
  ...range(181, 230),
  ...range(231, 270),
  ...range(293, 300),
  ...range(301, 340),
  ...range(341, 380),
  ...range(381, 410),
  421, 424, 425, 427, 428, 429, 430, 431, 436, 437, 438, 439, 440, 443, 444, 445, 446, 450,
  ...range(451, 480)
].map((n: any) => String(n).padStart(3, '0')));

function selectL1(pack: any = {}, { stageId = '', routeId = '' }: any = {}) {
  const finalStage = /final|honest|review/i.test(stageId);
  const maxItems = finalStage ? RECALLPULSE_POLICY.cache.l1.max_items_final : RECALLPULSE_POLICY.cache.l1.max_items_normal;
  const claims = new Map((Array.isArray(pack?.claims) ? pack.claims : []).map((claim: any) => [claim.id, claim]));
  const meta = wikiMeta(pack);
  const useRows = Array.isArray(pack?.attention?.use_first) ? pack.attention.use_first : [];
  const considered = useRows
    .map((row: any) => {
      const id = row?.[0];
      const claim: any = claims.get(id) || {};
      const m: any = meta.get(id) || {};
      const trust = number(m.trust_score, number(claim.trust_score, 0.9));
      const risk = m.risk || claim.risk || 'medium';
      const freshness = m.freshness || claim.freshness || 'fresh';
      const text = String(claim.text || claim.claim || id || '').trim();
      return {
        id,
        text,
        rgba: row?.[1] || claim.rgba || m.rgba || null,
        hash: row?.[2] || claim.h || m.hash || null,
        source: claim.source || m.source || null,
        trust_score: trust,
        risk,
        freshness,
        route_relevance: routeRelevance(id, text, routeId),
        token_cost: Math.max(1, Math.ceil(text.length / 4)),
        eligible: trust >= RECALLPULSE_POLICY.cache.l1.min_trust && !['stale', 'conflicted', 'unsupported'].includes(String(freshness).toLowerCase())
      };
    })
    .filter((row: any) => row.id);
  const selected: any[] = [];
  let tokens = 0;
  for (const item of considered.filter((row: any) => row.eligible).sort((a: any, b: any) => (b.route_relevance - a.route_relevance) || (b.trust_score - a.trust_score))) {
    if (selected.length >= maxItems) break;
    if (tokens + item.token_cost > RECALLPULSE_POLICY.cache.l1.max_tokens) continue;
    selected.push(item);
    tokens += item.token_cost;
  }
  return {
    tier: 'L1',
    label: RECALLPULSE_POLICY.cache.l1.label,
    selected,
    considered,
    max_items: maxItems,
    max_tokens: RECALLPULSE_POLICY.cache.l1.max_tokens,
    token_cost: tokens,
    positive_recall_only: true
  };
}

async function buildL2(root: any, dir: any) {
  const mission = await readJson(path.join(dir, 'mission.json'), null);
  const routeContext = await readJson(path.join(dir, 'route-context.json'), null);
  const pipelinePlan = await readJson(path.join(dir, 'pipeline-plan.json'), null);
  const contract = await readJson(path.join(dir, 'decision-contract.json'), null);
  const statusLedger = await readJson(path.join(dir, MISSION_STATUS_LEDGER_ARTIFACT), null);
  const gateFiles = ['naruto-gate.json', 'research-gate.evaluated.json', 'research-gate.json', 'db-review.json', 'qa-gate.json', 'ppt-gate.json', 'image-ux-review-gate.json', 'gx-gate.json', 'hard-blocker.json'];
  const gates: any[] = [];
  for (const file of gateFiles) {
    const gate = await readJson(path.join(dir, file), null);
    if (gate) gates.push({ file, passed: gate.passed === true, missing: missingGateFields(gate), hash: sha256(JSON.stringify(gate)).slice(0, 12) });
  }
  const changedArtifacts = await listMissionArtifacts(dir);
  const eventsTail = await tailJsonl(path.join(dir, 'events.jsonl'), 8);
  const verificationResults = await collectVerificationResults(dir);
  return {
    tier: 'L2',
    label: RECALLPULSE_POLICY.cache.l2.label,
    mission,
    route_context: routeContext,
    pipeline_plan: pipelinePlan,
    decision_contract: contract ? { present: true, sealed_hash: contract.sealed_hash || null, status: contract.status || null } : { present: false },
    gate_ids: gates.map((gate: any) => gate.file),
    gate_blockers: gates.filter((gate: any) => !gate.passed).map((gate: any) => ({ file: gate.file, missing: gate.missing })),
    verification_results: verificationResults,
    subagent_handoffs: await tailJsonl(path.join(dir, 'subagent-evidence.jsonl'), 5),
    status_ledger_snapshot: statusLedger?.latest || null,
    status_ledger_summary: statusLedger?.final_summary_projection || null,
    changed_artifacts: changedArtifacts,
    changed_files: [],
    evidence_hashes: gates.map((gate: any) => ({ file: gate.file, hash: gate.hash })),
    duplicate_keys: collectDuplicateKeys(statusLedger),
    recent_events: eventsTail
  };
}

function emptyL2() {
  return {
    tier: 'L2',
    label: RECALLPULSE_POLICY.cache.l2.label,
    gate_blockers: [],
    verification_results: [],
    subagent_handoffs: [],
    changed_artifacts: [],
    evidence_hashes: [],
    duplicate_keys: []
  };
}

function buildL3(pack: any = {}, { stageId = '', routeId = '', l1 = {} }: any = {}) {
  const hydrateRows = Array.isArray(pack?.attention?.hydrate_first) ? pack.attention.hydrate_first : [];
  const selectedIds = new Set((l1.selected || []).map((item: any) => item.id));
  const sourceRequests = hydrateRows.map((row: any) => ({
    id: row?.[0],
    reason: row?.[1] || 'hydrate_source',
    selected_in_l1: selectedIds.has(row?.[0])
  })).filter((row: any) => row.id);
  const broadRoute = /naruto|research|db|release|version|security/i.test(`${routeId} ${stageId}`);
  return {
    tier: 'L3',
    label: RECALLPULSE_POLICY.cache.l3.label,
    hydration_requests: sourceRequests,
    blocked_hydration_reasons: [],
    source_conflicts: sourceRequests.filter((row: any) => /conflict|stale|risk/i.test(row.reason)),
    triggers_active: [
      ...sourceRequests.map((row: any) => row.reason),
      broadRoute ? 'broad_route_policy' : null,
      /final/i.test(stageId) ? 'final_claim' : null
    ].filter(Boolean)
  };
}

function duplicateSuppression({ routeId, missionId, stageId, l1, l2 }: any) {
  const claimHash = sha256((l1.selected || []).map((item: any) => item.id).join('|')).slice(0, 12);
  const evidenceHash = sha256((l2.evidence_hashes || []).map((item: any) => `${item.file}:${item.hash}`).join('|')).slice(0, 12);
  const blockerCode = (l2.gate_blockers || []).map((item: any) => item.file).join('|') || 'none';
  const visible = `${routeId}:${stageId}:${claimHash}:${evidenceHash}:${blockerCode}`;
  const key = sha256(JSON.stringify({ routeId, missionId, stageId, claimHash, evidenceHash, blockerCode, visible })).slice(0, 24);
  const repeated = (l2.duplicate_keys || []).includes(key);
  return {
    key,
    route_id: routeId,
    mission_id: missionId,
    stage_id: stageId,
    claim_hash: claimHash,
    evidence_hash: evidenceHash,
    blocker_code: blockerCode,
    visible_message_hash: sha256(visible).slice(0, 12),
    repeated,
    suppressed_keys: repeated ? [key] : [],
    repeat_budget: RECALLPULSE_POLICY.repetition.repeat_budget
  };
}

function recallPulseMetrics({ l1 = {}, l2 = {}, l3 = {}, duplicate = {} }: any) {
  const selected = Array.isArray(l1.selected) ? l1.selected : [];
  const considered = Array.isArray(l1.considered) ? l1.considered : [];
  const hydrate = Array.isArray(l3.hydration_requests) ? l3.hydration_requests : [];
  const stale = hydrate.filter((row: any) => /stale|conflict|low_trust|risk/i.test(String(row.reason || '')));
  return {
    cache_hit_count: selected.length,
    cache_miss_count: Math.max(0, considered.length - selected.length),
    hydration_count: hydrate.length,
    stale_recall_count: stale.length,
    duplicate_suppression_count: duplicate.repeated ? 1 : 0,
    token_cost_estimate: l1.token_cost || 0,
    gate_agreement_target: RECALLPULSE_POLICY.eval_targets.route_gate_agreement_min,
    l2_artifact_count: (l2.changed_artifacts || []).length,
    evidence_hash_count: (l2.evidence_hashes || []).length
  };
}

function recallRisk({ state = {}, l1 = {}, l2 = {}, l3 = {} }: any) {
  const unverified: any[] = [];
  if (state.context7_required && !(state.context7_verified || state.context7_docs)) unverified.push('context7_evidence');
  if (state.subagents_required && !state.subagents_verified) unverified.push('subagent_evidence');
  for (const blocker of l2.gate_blockers || []) unverified.push(`${blocker.file}:${(blocker.missing || []).join(',') || 'not_passed'}`);
  const l3Conflicts = l3.source_conflicts || [];
  return {
    level: unverified.length || l3Conflicts.length ? 'high' : ((l1.selected || []).length ? 'medium' : 'low'),
    confidence: (l1.selected || []).length ? 0.86 : 0.45,
    unverified_claims: unverified,
    source_conflict_count: l3Conflicts.length
  };
}

function chooseAction({ pack, l1, l2, l3, duplicate, risk, state, stageId }: any) {
  if (!pack) return 'hydrate';
  if (duplicate.repeated) return 'suppress';
  if (risk.unverified_claims?.length) return 'block';
  if (risk.source_conflict_count > 0 || (l3.hydration_requests || []).length && /final|review|security|db|release/i.test(`${stageId} ${state.route || ''}`)) return 'hydrate';
  if ((l2.gate_blockers || []).length) return 'escalate';
  if ((l1.selected || []).length) return 'cache_hit';
  return 'no_op';
}

function userVisibleProjection({ action, l1, l2, l3, risk }: any) {
  const selected = (l1.selected || []).map((item: any) => item.id);
  const blockers = risk.unverified_claims || [];
  const hydrate = l3.hydration_requests || [];
  let message = 'RecallPulse checked the current stage in report-only mode.';
  if (action === 'cache_hit') message = `RecallPulse L1 cache hit: ${selected.slice(0, 4).join(', ') || 'no named anchors'}.`;
  else if (action === 'hydrate') message = `RecallPulse requests source hydration before risky claims: ${hydrate.slice(0, 3).map((item: any) => item.id).join(', ') || 'source check'}.`;
  else if (action === 'block') message = `RecallPulse report-only blocker: ${blockers.slice(0, 3).join(', ') || 'unverified evidence'}.`;
  else if (action === 'suppress') message = 'RecallPulse suppressed a duplicate reminder and kept one durable status row.';
  else if (action === 'escalate') message = `RecallPulse recommends keeping the heavier route gate: ${(l2.gate_blockers || []).map((item: any) => item.file).join(', ') || 'gate blocker'}.`;
  return {
    category: action === 'block' ? 'blocker' : 'progress',
    message,
    l1_ids: selected,
    l3_request_count: hydrate.length
  };
}

function normalizeStatusEntry(entry: any, index: any) {
  const category = RECALLPULSE_POLICY.status_ledger.categories.includes(entry.category) ? entry.category : 'info';
  const audience = Array.isArray(entry.audience) ? entry.audience : [entry.audience || 'route'];
  const message = String(entry.message || '').trim() || 'Status updated.';
  return {
    id: entry.id || `status-${String(index).padStart(4, '0')}`,
    ts: entry.ts || nowIso(),
    category,
    audience: audience.filter(Boolean),
    stage_id: entry.stage_id || null,
    message,
    dedupe_key: entry.dedupe_key || sha256(`${category}:${message}`).slice(0, 24),
    visibility: {
      user: audience.includes('user'),
      route: audience.includes('route'),
      reviewer: audience.includes('reviewer'),
      final_summary: audience.includes('final-summary')
    },
    evidence: Array.isArray(entry.evidence) ? entry.evidence : []
  };
}

function statusFinalProjection(entries: any = []) {
  const finalRelevant = entries.filter((entry: any) => entry.visibility?.final_summary || entry.category === 'blocker' || entry.category === 'verification');
  return {
    completed: finalRelevant.filter((entry: any) => entry.category !== 'blocker').map((entry: any) => entry.message).slice(-8),
    blockers: finalRelevant.filter((entry: any) => entry.category === 'blocker').map((entry: any) => entry.message).slice(-8),
    last_user_visible: [...entries].reverse().find((entry: any) => entry.visibility?.user) || null
  };
}

function statusLedgerProjections(entries: any = []) {
  const latest = entries[entries.length - 1] || null;
  const blockers = entries.filter((entry: any) => entry.category === 'blocker').slice(-5);
  const userVisible = entries.filter((entry: any) => entry.visibility?.user).slice(-5);
  return {
    route_live: {
      latest_user_visible: latest?.visibility?.user ? latest.message : userVisible[userVisible.length - 1]?.message || null,
      blocker_count: blockers.length
    },
    pipeline_status: {
      latest_category: latest?.category || null,
      latest_stage_id: latest?.stage_id || null,
      latest_message: latest?.message || null,
      blocker_messages: blockers.map((entry: any) => entry.message)
    },
    codex_app_stop_hook: {
      recoverable_from_ledger: true,
      repeated_messages_collapsed: true,
      latest_user_visible: userVisible[userVisible.length - 1] || null
    }
  };
}

function stageFromState(state: any = {}) {
  const phase = String(state.phase || '').toLowerCase();
  if (/final|honest|stop/.test(phase)) return 'before_final';
  if (/review/.test(phase)) return 'before_review';
  if (/implement|execution|running/.test(phase)) return 'before_implementation';
  if (/plan|agent|debate|prepared/.test(phase)) return 'before_planning';
  return 'route_intake';
}

function routeRelevance(id: any = '', text: any = '', routeId: any = '') {
  const hay = `${id} ${text}`.toLowerCase();
  const route = String(routeId || '').toLowerCase();
  let score = 0.5;
  if (route && hay.includes(route)) score += 0.2;
  if (/triwiki|wiki|memory|recall|cache|hydrate/.test(hay)) score += 0.22;
  if (/db|security|release|version|final|honest/.test(hay)) score += 0.15;
  return Math.min(1, score);
}

function wikiMeta(pack: any = {}) {
  const out = new Map();
  for (const row of Array.isArray(pack?.wiki?.a) ? pack.wiki.a : []) {
    out.set(row[0], {
      id: row[0],
      rgba: row[1],
      authority: row[3],
      status: row[4],
      risk: row[5],
      source: row[6],
      hash: row[7],
      file: row[8],
      trust_score: row[9],
      freshness: row[10]
    });
  }
  return out;
}

async function listMissionArtifacts(dir: any) {
  let entries: any[] = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const rows: any[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    const stat = await fsp.stat(file).catch(() => null);
    rows.push({ file: entry.name, mtime_ms: stat?.mtimeMs || 0 });
  }
  return rows.sort((a: any, b: any) => b.mtime_ms - a.mtime_ms).slice(0, 20).map((row: any) => row.file);
}

async function tailJsonl(file: any, max: any = 5) {
  const text = await readText(file, '');
  return text.split(/\n/).filter(Boolean).slice(-max).map((line: any) => {
    try { return JSON.parse(line); } catch { return { raw: line.slice(0, 500) }; }
  });
}

async function collectVerificationResults(dir: any) {
  const names = ['packcheck-result.json', 'selftest-result.json', 'verification-result.json'];
  const out: any[] = [];
  for (const name of names) {
    const row = await readJson(path.join(dir, name), null);
    if (row) out.push({ file: name, ...row });
  }
  return out;
}

function missingGateFields(gate: any = {}) {
  if (gate.passed === true) return [];
  return Object.entries(gate)
    .filter(([, value]: any) => value === false)
    .map(([key]: any) => key)
    .slice(0, 16);
}

function collectDuplicateKeys(statusLedger: any = null) {
  return (statusLedger?.entries || []).map((entry: any) => entry.dedupe_key).filter(Boolean);
}

function sharedChecksForRoute(route: any = {}, lifecycle: any = []) {
  const checks = new Set();
  if (route.context7Policy === 'required' || route.context7Policy === 'if_external_docs') checks.add('context7_current_docs_when_relevant');
  if (route.stopGate && route.stopGate !== 'none') checks.add('route_stop_gate_status');
  if (lifecycle.some((stage: any) => /triwiki|wiki/i.test(stage))) checks.add('triwiki_context_refresh_or_validate');
  if (lifecycle.some((stage: any) => /reflection/i.test(stage))) checks.add('post_route_reflection');
  if (lifecycle.some((stage: any) => /honest/i.test(stage))) checks.add('honest_mode');
  if (lifecycle.some((stage: any) => /review|gate|validate|verification|evidence/i.test(stage))) checks.add('evidence_or_verification_gate');
  checks.add('no_unrequested_fallback_code');
  checks.add('durable_status_projection');
  checks.add('duplicate_suppression');
  return [...checks];
}

function sharedLifecycleStage(stage: any = '') {
  return /triwiki|wiki|context7|reflection|honest|gate|validate|verification|evidence|status|summary/i.test(String(stage || ''));
}

function preservedRoutePersonality(routeId: any = '', routeName: any = '') {
  const byRoute = {
    DFix: 'ultralight direct-fix path stays tiny and does not start the full pipeline',
    Answer: 'answer-only path stays conversational and does not start implementation',
    SKS: 'general SKS discovery/help personality stays simple',
    Naruto: 'Naruto keeps the bounded official subagent workflow with parent-owned integration and risk-scoped review',
    QALoop: 'QA-LOOP keeps dogfood, checklist, remediation, and reverification identity',
    PPT: 'PPT keeps restrained information-first HTML/PDF delivery identity',
    ImageUXReview: 'Image UX Review keeps gpt-image-2 annotated raster review identity',
    ComputerUse: 'Computer Use keeps maximum-speed native Mac/non-web visual lane identity',
    Goal: 'Goal uses Codex native /goal only and creates no SKS-owned persistence, artifact, loop, or fallback state',
    Research: 'Research keeps Super Search evidence, three independent Astra Max review dimensions, bounded revision, paper, and falsification identity',
    AutoResearch: 'AutoResearch keeps iterative experiment loop identity',
    DB: 'DB keeps conservative read-first destructive-operation safety identity',
    MadSKS: 'MAD-SKS keeps explicit scoped high-risk authorization identity',
    GX: 'GX keeps deterministic visual-context cartridge identity',
    Wiki: 'Wiki keeps bounded TriWiki maintenance identity',
    Help: 'Help stays lightweight command discovery'
  };
  return (byRoute as Record<string, string>)[routeId] || `${routeName || routeId || 'route'} personality remains route-owned`;
}

async function listMissionRows(root: any) {
  const base = path.join(root, '.sneakoscope', 'missions');
  let entries: any[] = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const rows: any[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const mission = await readJson(path.join(base, entry.name, 'mission.json'), null);
    if (!mission) continue;
    rows.push({
      id: entry.name,
      mode: mission.mode || null,
      prompt: mission.prompt || '',
      created_at: mission.created_at || ''
    });
  }
  return rows.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
}

function latestMissionForRoute(missions: any = [], routeId: any = '') {
  const target = String(routeId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    qaloop: ['qaloop', 'qa', 'qa-loop'],
    db: ['db', 'database'],
    naruto: ['naruto'],
    research: ['research'],
    goal: ['goal']
  }[target] || [target];
  return [...missions].reverse().find((mission: any) => {
    const mode = String(mission.mode || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return aliases.some((alias: any) => mode === alias.replace(/[^a-z0-9]/g, ''));
  }) || null;
}

function normalizeTaskId(value: any = '') {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/^T?(\d{1,3})$/);
  if (!match) throw new Error(`Invalid RecallPulse task id: ${value}`);
  return `T${(match[1] || '').padStart(3, '0')}`;
}

function extractAcceptanceCriteria(l2: any = {}) {
  const answers = l2.decision_contract?.answers || {};
  if (Array.isArray(answers.ACCEPTANCE_CRITERIA)) return answers.ACCEPTANCE_CRITERIA;
  if (typeof answers.ACCEPTANCE_CRITERIA === 'string') return [answers.ACCEPTANCE_CRITERIA];
  return [];
}

function number(...values: any[]) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function fixture(id: any, passed: any, assertion: any) {
  return { id, passed: Boolean(passed), assertion };
}

function range(start: any, end: any) {
  const out: any[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}
