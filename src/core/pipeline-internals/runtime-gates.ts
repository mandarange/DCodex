import path from 'node:path';
import fsp from 'node:fs/promises';
import { appendJsonl, exists, nowIso, readJson, readText, sha256, writeJsonAtomic } from '../fsx.js';
import { containsUserQuestion, noQuestionContinuationReason } from '../no-question-guard.js';
import { missionDir, setCurrent } from '../mission.js';
import { evaluateResearchGate } from '../research.js';
import { evaluateQaGate } from '../qa-loop.js';
import { PPT_REQUIRED_GATE_FIELDS } from '../ppt.js';
import { validateFinalHonestModeReport } from '../artifact-schemas.js';
import { IMAGE_UX_REVIEW_GATE_ARTIFACT, IMAGE_UX_REVIEW_POLICY_ARTIFACT, IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT, IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT, IMAGE_UX_REVIEW_REQUIRED_GATE_FIELDS, IMAGE_UX_REVIEW_REFERENCE_GATE_FIELDS, IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT, imageUxReviewGateAllowsReferenceCloseout } from '../image-ux-review.js';
import { CODEX_WEB_VERIFICATION_EVIDENCE_SOURCE, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, evidenceMentionsForbiddenBrowserAutomation, reflectionRequiredForRoute, routeById } from '../routes.js';
import { validateRouteCompletionProof } from '../proof/route-proof-gate.js';
import { routeFromState, routeRequiresCompletionProof } from '../proof/route-proof-policy.js';
import { MISTAKE_RECALL_ARTIFACT, mistakeRecallGateStatus } from '../mistake-recall.js';
import { SSOT_GUARD_ARTIFACT, validateSsotGuardArtifact } from '../safety/ssot-guard.js';
import { checkStopGate } from '../stop-gate/stop-gate-check.js';
import { readWorkOrderLedger, evaluateWorkOrderCoverage } from '../work-order-ledger.js';
import {
  DB_ACCESS_REVIEW_ARTIFACT,
  DB_REVIEW_ARTIFACT,
  validateDbAccessReviewArtifact,
  validateDbReview,
  validateMadSksSqlPlaneCompletion
} from '../db-review.js';
import {
  ENGINEERING_SANITY_REVIEW_ARTIFACT,
  validateEngineeringSanityReviewArtifact
} from '../engineering-sanity-review.js';
import {
  clarificationStopReason,
  context7Evidence,
  hasContext7DocsEvidence,
  hasSubagentEvidence,
  subagentEvidence,
  PIPELINE_PLAN_ARTIFACT,
} from './runtime-core.js';
import { projectTriwikiToAgentsMd } from '../triwiki/agents-md-projector.js';
import {
  effectiveSubagentTarget,
  normalizeLegacySubagentCountFields,
  subagentCountContractBlockers
} from '../subagents/wave-lifecycle.js';

const REFLECTION_ARTIFACT = 'reflection.md';
const REFLECTION_GATE = 'reflection-gate.json';
const REFLECTION_MEMORY_PATH = '.sneakoscope/memory/q2_facts/post-route-reflection.md';
const COMPLIANCE_LOOP_GUARD_ARTIFACT = 'compliance-loop-guard.json';
const HARD_BLOCKER_ARTIFACT = 'hard-blocker.json';
const DEFAULT_COMPLIANCE_LOOP_LIMIT = 3;

function reflectionRequiredForState(state: any = {}) {
  if (state.reflection_required === false) return false;
  if (state.reflection_required === true) return true;
  return reflectionRequiredForRoute(state.route || state.mode || state.route_command);
}

async function reflectionGateStatus(root: any, state: any = {}, jsonCache?: Map<string, Promise<any>>) {
  if (!reflectionRequiredForState(state)) return { ok: true, missing: [] };
  const id = state?.mission_id;
  if (!id) return { ok: false, missing: ['mission_id'] };
  const dir = missionDir(root, id);
  const gate = await readJsonCached(jsonCache, path.join(dir, REFLECTION_GATE), null);
  if (!gate) return { ok: false, missing: [REFLECTION_GATE] };
  const hasArtifact = gate.reflection_artifact === true && await exists(path.join(dir, REFLECTION_ARTIFACT));
  const hasLesson = gate.lessons_recorded === true || (Array.isArray(gate.lessons) && gate.lessons.length > 0);
  const noIssue = gate.no_issue_acknowledged === true;
  const hasMemory = gate.triwiki_recorded === true || gate.memory_recorded === true;
  const missing: any[] = [];
  if (gate.passed !== true) missing.push('passed');
  if (!hasArtifact) missing.push(REFLECTION_ARTIFACT);
  if (!hasLesson && !noIssue) missing.push('lessons_recorded_or_no_issue_acknowledged');
  if (hasLesson && !hasMemory) missing.push('triwiki_recorded');
  if (hasMemory && !(await exists(path.join(root, REFLECTION_MEMORY_PATH)))) missing.push(REFLECTION_MEMORY_PATH);
  if (gate.wiki_refreshed_or_packed !== true && gate.triwiki_refreshed !== true) missing.push('wiki_refreshed_or_packed');
  if (gate.wiki_validated !== true) missing.push('wiki_validated');
  missing.push(...await staleReflectionReasons(root, state, gate));
  const ok = missing.length === 0;
  if (ok && state.reflection_invalidation_required === true) {
    await setCurrent(root, {
      reflection_invalidation_required: false,
      reflection_invalidated_at: null,
      reflection_invalidation_reason: null,
      reflection_revalidated_at: nowIso()
    }, { sessionKey: state._session_key });
  }
  return { ok, missing };
}

// The single choke point every route's stop decision passes through
// (hookStop -> evaluateStop). A work-order-ledger.json here means SOME
// code already committed to tracking this mission's work items; once that
// commitment exists, stop must not be allowed while items remain
// unresolved (neither verified nor honestly blocked), or an omission can
// reach "done" silently. Missions with no ledger are unaffected (routes
// that haven't adopted per-item tracking yet, or non-work routes).
async function workOrderCoverageGateStatus(root: any, state: any = {}) {
  const id = state?.mission_id;
  if (!id) return { ok: true, blockers: [] };
  const ledger = await readWorkOrderLedger(missionDir(root, id));
  if (!ledger) {
    const route = routeById(routeFromState(state));
    if (route?.coverage_required) return { ok: false, blockers: ['work_order_ledger_missing'] };
    return { ok: true, blockers: [] };
  }
  const coverage = evaluateWorkOrderCoverage(ledger);
  return { ok: coverage.ok, blockers: coverage.blockers };
}

async function dbAccessReviewGateStatus(root: any, state: any = {}, jsonCache?: Map<string, Promise<any>>) {
  if (state?.db_access_review_required !== true) return { ok: true, blockers: [] };
  const id = state?.mission_id;
  if (!id) return { ok: false, blockers: ['mission_id'] };
  const review = await readJsonCached(jsonCache, path.join(missionDir(root, id), DB_ACCESS_REVIEW_ARTIFACT), null);
  return validateDbAccessReviewArtifact(root, id, review);
}

async function engineeringSanityGateStatus(root: any, state: any = {}, jsonCache?: Map<string, Promise<any>>) {
  if (state?.engineering_sanity_required !== true) return { ok: true, blockers: [] };
  const id = state?.mission_id;
  if (!id) return { ok: false, blockers: ['mission_id'] };
  const dir = missionDir(root, id);
  const reviewFile = path.join(dir, ENGINEERING_SANITY_REVIEW_ARTIFACT);
  if (!(await exists(reviewFile))) {
    // Route state written before the plan owned this decision can carry the
    // flag with nothing ever seeded. Blocking on it is unsatisfiable — no
    // command regenerates the artifact — and repeating the same reason trips
    // the compliance loop guard into a false hard blocker. A plan that did
    // declare the binding still blocks: that case is a deleted artifact.
    const plan = await readJsonCached(jsonCache, path.join(dir, PIPELINE_PLAN_ARTIFACT), null);
    if (!plan?.engineering_sanity_review) return { ok: true, blockers: [], not_applicable: true };
  }
  const review = await readJsonCached(jsonCache, reviewFile, null);
  return validateEngineeringSanityReviewArtifact(root, id, review, {
    base: typeof state?.engineering_sanity_scope_base === 'string' ? state.engineering_sanity_scope_base : null
  });
}

async function staleReflectionReasons(root: any, state: any = {}, gate: any = {}) {
  const created = Date.parse(gate.created_at || gate.updated_at || '');
  if (!Number.isFinite(created)) return ['reflection-gate:created_at'];
  const id = state?.mission_id;
  if (!id) return [];
  if (state.reflection_invalidation_required !== true) return [];
  const invalidatedAt = Date.parse(String(state.reflection_invalidated_at || ''));
  if (Number.isFinite(invalidatedAt) && created >= invalidatedAt) return [];
  return ['reflection_invalidation_required'];
}

function reflectionStopReason(state: any = {}, status: any = {}) {
  const id = state?.mission_id || 'latest';
  const route = String(state.route_command || state.route || state.mode || 'route');
  const missing = status.missing?.length ? ` Missing: ${status.missing.join(', ')}.` : '';
  return `SKS ${route} must run reflection before final. Write .sneakoscope/missions/${id}/${REFLECTION_ARTIFACT}, record real lessons in ${REFLECTION_MEMORY_PATH} when present, refresh/pack and validate TriWiki, then pass .sneakoscope/missions/${id}/${REFLECTION_GATE}.${missing}`;
}

export async function projectGateStatus(root: any, state: any = {}) {
  const gates: any[] = [];
  const id = state?.mission_id || null;
  const hasActiveGate = Boolean(id && state?.stop_gate && !['none', 'honest_mode', 'clarification-gate'].includes(state.stop_gate));
  const activeGate: any = hasActiveGate ? await passedActiveGate(root, state) : null;
  const activeGateNotApplicable = activeGate?.not_applicable === true;
  if (clarificationGatePending(state)) {
    gates.push({
      id: 'clarification-gate',
      ok: false,
      missing: ['explicit_user_answers', 'pipeline_answer'],
      source: id ? `.sneakoscope/missions/${id}/questions.md` : null
    });
  }
  if (state?.db_access_review_required === true) {
    const dbAccess = await dbAccessReviewGateStatus(root, state);
    gates.push({
      id: DB_ACCESS_REVIEW_ARTIFACT,
      ok: dbAccess.ok,
      missing: dbAccess.blockers || [],
      source: id ? `.sneakoscope/missions/${id}/${DB_ACCESS_REVIEW_ARTIFACT}` : null
    });
  }
  if (state?.engineering_sanity_required === true) {
    const sanity = await engineeringSanityGateStatus(root, state);
    gates.push({
      id: ENGINEERING_SANITY_REVIEW_ARTIFACT,
      ok: sanity.ok,
      missing: sanity.blockers || [],
      source: id ? `.sneakoscope/missions/${id}/${ENGINEERING_SANITY_REVIEW_ARTIFACT}` : null
    });
  }
  if (state?.context7_required) {
    const evidence = await context7Evidence(root, state);
    gates.push({
      id: 'context7-evidence',
      ok: evidence.ok,
      missing: evidence.ok ? [] : ['resolve-library-id', 'query-docs'],
      source: id ? `.sneakoscope/missions/${id}/context7-evidence.jsonl` : '.sneakoscope/state/context7-evidence.jsonl'
    });
  }
  if (state?.subagents_required && !activeGateNotApplicable) {
    const evidence = await subagentEvidence(root, state);
    gates.push({
      id: 'official-subagent-evidence',
      ok: evidence.ok,
      missing: evidence.ok ? [] : (evidence.blockers || ['official_subagent_events_and_parent_summary']),
      source: id ? `.sneakoscope/missions/${id}/subagent-evidence.json` : '.sneakoscope/state/subagents/subagent-evidence.json'
    });
  }
  if (hasActiveGate) {
    const active: any = activeGate;
    gates.push({
      id: active.file || state.stop_gate,
      ok: active.ok,
      missing: active.missing || (active.ok ? [] : ['passed']),
      source: active.file ? `.sneakoscope/missions/${id}/${active.file}` : null
    });
  }
  const mistakeRecall = await mistakeRecallGateStatus(root, state);
  if (id && (!mistakeRecall.ok || mistakeRecall.source)) {
    gates.push({
      id: MISTAKE_RECALL_ARTIFACT,
      ok: mistakeRecall.ok,
      missing: mistakeRecall.missing || [],
      source: `.sneakoscope/missions/${id}/${MISTAKE_RECALL_ARTIFACT}`
    });
  }
  const reflection = await reflectionGateStatus(root, state);
  if (reflectionRequiredForState(state)) {
    gates.push({
      id: REFLECTION_GATE,
      ok: reflection.ok,
      missing: reflection.missing || [],
      source: id ? `.sneakoscope/missions/${id}/${REFLECTION_GATE}` : null
    });
  }
  const blockers = gates.filter((gate: any) => !gate.ok).flatMap((gate: any) => gate.missing.map((item: any) => `${gate.id}:${item}`));
  return {
    schema_version: 1,
    generated_at: nowIso(),
    mission_id: id,
    mode: state?.mode || null,
    report_only: true,
    ok: blockers.length === 0,
    blockers,
    gates
  };
}

export async function evaluateStop(root: any, state: any, payload: any, opts: any = {}) {
  // `sks route close` is the explicit terminal control for abandoning or
  // superseding a route. Once it has closed the route, stale requirements
  // from that route must not re-open native-agent, reflection, or proof gates
  // on the next Stop hook invocation.
  if (state?.route_closed === true) {
    return {
      continue: true,
      action: 'route_closed',
      systemMessage: `SKS: explicitly closed route accepted${state?.mission_id ? ` (${state.mission_id})` : ''}.`
    };
  }
  const last = extractLastMessage(payload);
  const jsonCache = new Map<string, Promise<any>>();
  if (clarificationGatePending(state)) {
    if (await hasVisibleClarificationQuestionBlock(root, state, last)) return { continue: true };
    return {
      decision: 'block',
      reason: await clarificationStopReason(root, state, 'route'),
      gate: 'clarification',
      missing: ['explicit_user_answers', 'pipeline_answer']
    };
  }
  const route = routeFromState(state);
  const stopGate = String(state?.stop_gate || '');
  const completionProofRequired = state.proof_required === true || routeRequiresCompletionProof(route);
  const reflectionRequired = reflectionRequiredForState(state);
  // engineering_sanity_required / db_access_review_required must be honoured
  // even on routes whose stopGate is 'none' or 'honest_mode' ($SKS, $Fast-Mode,
  // $with-local-llm-on, $Commit, $Commit-And-Push): they carry real
  // code-changing work. Both flags are now set only by pipelinePlanState(),
  // from a plan that actually seeded the artifact, so requiring them here can
  // never demand a file the product did not write.
  if (!opts.noQuestion
    && (stopGate === 'none' || stopGate === 'honest_mode')
    && !state?.context7_required
    && !state?.subagents_required
    && !completionProofRequired
    && !reflectionRequired
    && state?.engineering_sanity_required !== true
    && state?.db_access_review_required !== true) {
    return null;
  }
  const activeGatePreview: any = state?.subagents_required
    ? await passedActiveGate(root, state, jsonCache)
    : null;
  const activeGateNotApplicable = activeGatePreview?.not_applicable === true;
  const subagentEvidenceHardBlocked = activeGatePreview?.hard_blocked === true
    && activeGatePreview?.covered_gate === 'official-subagent-evidence';
  const dbAccessPromise = dbAccessReviewGateStatus(root, state, jsonCache);
  const engineeringSanityPromise = engineeringSanityGateStatus(root, state, jsonCache);
  const context7Promise = state?.context7_required ? hasContext7DocsEvidence(root, state) : Promise.resolve(true);
  const subagentPromise = state?.subagents_required && !activeGateNotApplicable ? hasSubagentEvidence(root, state) : Promise.resolve(true);
  const mistakeRecallPromise = mistakeRecallGateStatus(root, state);
  const [dbAccess, engineeringSanity, context7Ok, subagentOk, mistakeRecall] = await Promise.all([
    dbAccessPromise,
    engineeringSanityPromise,
    context7Promise,
    subagentPromise,
    mistakeRecallPromise
  ]);
  await resolveRecoveredComplianceBlocker(root, state, {
    [DB_ACCESS_REVIEW_ARTIFACT]: dbAccess.ok,
    [ENGINEERING_SANITY_REVIEW_ARTIFACT]: engineeringSanity.ok,
    'context7-evidence': context7Ok,
    'official-subagent-evidence': subagentOk
  });
  if (!dbAccess.ok) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} must verify the existing canonical DB access path before completion. Complete ${DB_ACCESS_REVIEW_ARTIFACT} with actual entry points/callers, canonical adapter or query helper, pool ownership/acquire/release/shutdown/exhaustion evidence, N+1 review, and transaction integrity for sensitive or multi-step mutations. Missing: ${(dbAccess.blockers || []).join(', ')}.`, { gate: DB_ACCESS_REVIEW_ARTIFACT, missing: dbAccess.blockers });
  }
  if (!engineeringSanity.ok) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} must complete the engineering sanity review before completion. Static candidates are advisory only; inspect added hunks and real callers for SOLID boundaries, N+1/repeated I/O, bounded render/recursion/event/retry/polling behavior, and verification bypasses. Missing: ${(engineeringSanity.blockers || []).join(', ')}.`, { gate: ENGINEERING_SANITY_REVIEW_ARTIFACT, missing: engineeringSanity.blockers });
  }
  if (state?.context7_required && !context7Ok) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} requires Context7 evidence before completion. Use Context7 resolve-library-id, then query-docs, so SKS can record context7-evidence.jsonl.`, { gate: 'context7-evidence' });
  }
  if (state?.subagents_required && !activeGateNotApplicable && !subagentOk && !subagentEvidenceHardBlocked) {
    const evidence = await subagentEvidence(root, state);
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} requires official Codex subagent evidence before completion. Record matched SubagentStart/SubagentStop events for every requested agent thread, wait for all threads, and provide the parent integration summary. Missing: ${(evidence.blockers || ['official_subagent_events_and_parent_summary']).join(', ')}.`, { gate: 'official-subagent-evidence', missing: evidence.blockers });
  }
  if (!mistakeRecall.ok) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} found relevant TriWiki mistake memory that is not bound to the decision contract. Re-run pipeline answer or seal the contract so ${MISTAKE_RECALL_ARTIFACT} is consumed before finishing.`, { gate: MISTAKE_RECALL_ARTIFACT, missing: mistakeRecall.missing });
  }
  if (opts.noQuestion) {
    if (containsUserQuestion(last)) return complianceBlock(root, state, noQuestionContinuationReason(), { gate: 'no-question' });
    const gate: any = await passedActiveGate(root, state, jsonCache);
    if (gate.hard_blocked) {
      return {
        continue: true,
        action: 'hard_blocked',
        gate: gate.file || HARD_BLOCKER_ARTIFACT,
        systemMessage: `SKS ${state.route_command || state.mode || 'route'} route hard-blocked: ${gate.reason || 'hard blocker recorded'}`
      };
    }
    if (gate.ok) {
      const proofGate = await routeProofGateStatus(root, state);
      if (!proofGate.ok) {
        return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route cannot finalize without a valid Completion Proof. Missing or invalid proof issues: ${proofGate.issues.join(', ')}.`, { gate: 'completion-proof', missing: proofGate.issues });
      }
      const coverage = await workOrderCoverageGateStatus(root, state);
      if (!coverage.ok) return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route has unresolved work-order-ledger items (neither verified nor honestly blocked): ${coverage.blockers.join(', ')}.`, { gate: 'work-order-ledger', missing: coverage.blockers });
      const reflection = await reflectionGateStatus(root, state, jsonCache);
      if (!reflection.ok) {
        return complianceBlock(root, state, reflectionStopReason(state, reflection), { gate: 'reflection', missing: reflection.missing });
      }
      return { continue: true };
    }
    const missing = gate.missing?.length ? ` Missing gate fields: ${gate.missing.join(', ')}.` : '';
    return complianceBlock(root, state, `SKS no-question run is not done. Continue autonomously, fix failing checks, update ${gate.file || 'the active gate file'}, and do not ask the user.${missing}`, { gate: gate.file || 'active-gate', missing: gate.missing });
  }
  if (state?.mission_id && state?.stop_gate && !['none', 'honest_mode', 'clarification-gate'].includes(state.stop_gate)) {
    // 4.0.9: Use canonical stop-gate resolver first for NARUTO/GLM_NARUTO routes.
    const modeUpper = String(state?.mode || '').toUpperCase();
    const routeUpper = String(state?.route || state?.route_command || '').replace(/^\$/, '').toUpperCase();
    const narutoFamily = modeUpper === 'NARUTO' || routeUpper === 'NARUTO' || routeUpper === 'GLM_NARUTO';
    if (narutoFamily || state.stop_gate === 'stop-gate.json' || state.stop_gate === 'naruto-gate.json') {
      const stopCheck = await checkStopGate({
        root,
        route: state.route || state.mode,
        missionId: state.mission_id,
        explicitGatePath: typeof state.stop_gate_abs_path === 'string' && state.stop_gate_abs_path ? state.stop_gate_abs_path : undefined,
        allowLatestFallback: opts.allowLatestFallback !== true ? false : true,
      });
      if (stopCheck.action === 'allow_stop') {
        if (narutoFamily) {
          const activeGateNotApplicable = stopCheck.diagnostics.reason === 'gate_not_applicable';
          if (!activeGateNotApplicable) {
            const nativeGate = await readJson(path.join(missionDir(root, state.mission_id), 'naruto-gate.json'), null);
            const officialMissing = nativeGate
              ? [
                  ...missingRequiredGateFields('naruto-gate.json', state, nativeGate),
                  ...await missingNarutoArtifacts(root, state, nativeGate)
                ]
              : ['naruto-gate.json'];
            if (officialMissing.length) {
              return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route cannot stop yet. Official subagent evidence, SSOT guard, and the parent integration summary are incomplete. Missing: ${officialMissing.join(', ')}.`, { gate: 'official-subagent-evidence', missing: officialMissing });
            }
          }
          const coverage = await workOrderCoverageGateStatus(root, state);
          if (!coverage.ok) return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route has unresolved work-order-ledger items (neither verified nor honestly blocked): ${coverage.blockers.join(', ')}.`, { gate: 'work-order-ledger', missing: coverage.blockers });
          const proofGate = await routeProofGateStatus(root, state);
          if (!proofGate.ok) {
            return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route cannot finalize without a valid Completion Proof. Missing or invalid proof issues: ${proofGate.issues.join(', ')}.`, { gate: 'completion-proof', missing: proofGate.issues });
          }
          const reflection = await reflectionGateStatus(root, state, jsonCache);
          if (!reflection.ok) return complianceBlock(root, state, reflectionStopReason(state, reflection), { gate: 'reflection', missing: reflection.missing });
          return { continue: true, systemMessage: `SKS: canonical stop-gate ${activeGateNotApplicable ? 'was not applicable and independent gates passed' : 'passed'} at ${stopCheck.gate_path}` };
        }
      } else if (stopCheck.action === 'hard_blocked') {
        return { continue: true, systemMessage: stopCheck.feedback, action: 'hard_blocked', gate: stopCheck.gate_path };
      } else {
        const missing = stopCheck.diagnostics.missing_fields?.length ? ` Missing gate fields: ${stopCheck.diagnostics.missing_fields.join(', ')}.` : '';
        const checkedPaths = stopCheck.diagnostics.checked_paths?.length ? ` Checked: ${stopCheck.diagnostics.checked_paths.join(', ')}.` : '';
        return complianceBlock(root, state, `SKS ${state.route_command || state.mode} route cannot stop yet. Pass ${stopCheck.gate_path || state.stop_gate} or record a hard blocker with evidence before finishing.${missing}${checkedPaths}`, { gate: stopCheck.gate_path || state.stop_gate, missing: stopCheck.diagnostics.missing_fields });
      }
    } else {
      const gate: any = await passedActiveGate(root, state, jsonCache);
      if (gate.hard_blocked) {
        return {
          continue: true,
          action: 'hard_blocked',
          gate: gate.file || HARD_BLOCKER_ARTIFACT,
          systemMessage: `SKS ${state.route_command || state.mode || 'route'} route hard-blocked: ${gate.reason || 'hard blocker recorded'}`
        };
      }
      if (!gate.ok) {
        const missing = gate.missing?.length ? ` Missing gate fields: ${gate.missing.join(', ')}.` : '';
        return complianceBlock(root, state, `SKS ${state.route_command || state.mode} route cannot stop yet. Pass ${gate.file || state.stop_gate} or record a hard blocker with evidence before finishing.${missing}`, { gate: gate.file || state.stop_gate, missing: gate.missing });
      }
    }
  }
  const proofGate = await routeProofGateStatus(root, state);
  if (!proofGate.ok) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route cannot finalize without a valid Completion Proof. Missing or invalid proof issues: ${proofGate.issues.join(', ')}.`, { gate: 'completion-proof', missing: proofGate.issues });
  }
  const reflection = await reflectionGateStatus(root, state, jsonCache);
  if (!reflection.ok) return complianceBlock(root, state, reflectionStopReason(state, reflection), { gate: 'reflection', missing: reflection.missing });
  const coverage = await workOrderCoverageGateStatus(root, state);
  if (!coverage.ok) return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} route has unresolved work-order-ledger items (neither verified nor honestly blocked): ${coverage.blockers.join(', ')}.`, { gate: 'work-order-ledger', missing: coverage.blockers });
  fireAndForgetProjectMemory(root, state);
  return null;
}

function fireAndForgetProjectMemory(root: any, state: any = {}) {
  if (!state?.mission_id) return;
  void projectTriwikiToAgentsMd(String(root)).then((report) => {
    const id = state.mission_id;
    if (!id) return null;
    return appendJsonl(path.join(missionDir(root, id), 'events.jsonl'), {
      ts: nowIso(),
      type: 'triwiki.agents_md_projected',
      proof_invalidating: false,
      ok: report.ok,
      reason: report.reason,
      written: report.written
    });
  }).catch((err: any) => {
    const id = state.mission_id;
    if (!id) return null;
    return appendJsonl(path.join(missionDir(root, id), 'events.jsonl'), {
      ts: nowIso(),
      type: 'triwiki.agents_md_project_failed',
      proof_invalidating: false,
      error: err?.message || String(err)
    }).catch(() => undefined);
  });
}

async function routeProofGateStatus(root: any, state: any = {}) {
  const route = routeFromState(state);
  const required = state.proof_required === true || routeRequiresCompletionProof(route);
  if (!required || !state?.mission_id) return { ok: true, required: false, issues: [] };
  return validateRouteCompletionProof(root, {
    missionId: state.mission_id,
    route,
    state,
    visualClaim: state.visual_claim === true ? true : (state.visual_claim === false ? false : undefined)
  });
}

function clarificationGatePending(state: any = {}) {
  const phase = String(state.phase || '');
  return Boolean(state?.clarification_required && phase.includes('CLARIFICATION_AWAITING_ANSWERS'))
    || Boolean(
      state?.mission_id
      && state.implementation_allowed === false
      && state.ambiguity_gate_required === true
      && state.ambiguity_gate_passed !== true
      && (phase.includes('CLARIFICATION_AWAITING_ANSWERS') || state.stop_gate === 'clarification-gate')
    );
}

async function complianceBlock(root: any, state: any = {}, reason: any = '', detail: any = {}) {
  if (!state?.mission_id) return { decision: 'block', reason };
  const dir = missionDir(root, state.mission_id);
  await markReflectionInvalidatedForGateFailure(root, state, detail);
  const guardPath = path.join(dir, COMPLIANCE_LOOP_GUARD_ARTIFACT);
  const normalized = normalizeComplianceReason(reason);
  const previous = await readJson(guardPath, {});
  const count = previous.normalized_reason === normalized ? Number(previous.repeat_count || 0) + 1 : 1;
  const limit = complianceLoopLimit(detail.gate || state.stop_gate || '');
  const record = {
    schema_version: 1,
    updated_at: nowIso(),
    mission_id: state.mission_id,
    route: state.route_command || state.route || state.mode || null,
    gate: detail.gate || state.stop_gate || null,
    normalized_reason: normalized,
    repeat_count: count,
    limit,
    tripped: count >= limit,
    last_reason: reason,
    missing: Array.isArray(detail.missing) ? detail.missing : []
  };
  await writeJsonAtomic(guardPath, record);
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.compliance_loop_guard', proof_invalidating: false, gate: record.gate, repeat_count: count, limit, tripped: record.tripped, missing: record.missing });
  if (!record.tripped) return { decision: 'block', reason, gate: detail.gate || state.stop_gate || null, missing: Array.isArray(detail.missing) ? detail.missing : [] };
  await writeJsonAtomic(path.join(dir, HARD_BLOCKER_ARTIFACT), {
    schema: 'sks.hard-blocker.v1',
    passed: false,
    status: 'hard_blocked',
    created_at: nowIso(),
    reason: 'compliance_loop_guard_tripped',
    route: record.route,
    gate: record.gate,
    repeat_count: count,
    limit,
    original_reason: reason,
    evidence: [
      `${COMPLIANCE_LOOP_GUARD_ARTIFACT}: repeated identical compliance stop reason ${count} time(s)`,
      'Pipeline stopped as a hard blocker instead of looping indefinitely; no completion success is claimed.'
    ]
  });
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.compliance_loop_guard.tripped', proof_invalidating: false, gate: record.gate, repeat_count: count, limit });
  return { decision: 'escalate', reason, gate: detail.gate || state.stop_gate || null, repeat_count: count, message: '동일 사유가 반복됩니다. 사용자 개입이 필요합니다.', systemMessage: '동일 사유가 반복됩니다. 사용자 개입이 필요합니다.' };
}

async function markReflectionInvalidatedForGateFailure(root: any, state: any = {}, detail: any = {}) {
  const gate = String(detail.gate || state.stop_gate || '');
  if (!reflectionRequiredForState(state)) return;
  // Do not invalidate reflection for Naruto/runtime evidence gates — that
  // creates verify→rewrite-reflection→re-verify loops on the same structural miss.
  if (!gate) return;
  if (/^(reflection|context7-evidence|official-subagent-evidence|native-session-evidence|no-question|clarification)$/i.test(gate)) return;
  if (/(^|[\\/])?(naruto-gate|stop-gate|work-order-ledger|completion-proof|compliance-loop-guard)(\.json)?$/i.test(gate)) return;
  if (/^work-order-ledger$/i.test(gate) || /^completion-proof$/i.test(gate)) return;
  await setCurrent(root, {
    mission_id: state.mission_id,
    reflection_invalidation_required: true,
    reflection_invalidated_at: nowIso(),
    reflection_invalidation_reason: `gate_failed:${gate}`
  }, { sessionKey: state._session_key });
}

function complianceLoopLimit(gate: any = '') {
  const gateKey = String(gate || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const raw = Number.parseInt(String((gateKey && process.env[`SKS_COMPLIANCE_LOOP_LIMIT_${gateKey}`]) || process.env.SKS_COMPLIANCE_LOOP_LIMIT || ''), 10);
  if (!Number.isFinite(raw)) return DEFAULT_COMPLIANCE_LOOP_LIMIT;
  return Math.max(1, Math.min(20, raw));
}

function normalizeComplianceReason(reason: any = '') {
  return String(reason || '')
    .replace(/\bM-\d{8}-\d{6}-[a-z0-9]+\b/gi, 'M-*')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'TIMESTAMP')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

async function resolveRecoveredComplianceBlocker(root: any, state: any = {}, recovered: Record<string, boolean>) {
  if (!state?.mission_id) return false;
  const dir = missionDir(root, state.mission_id);
  const blockerFile = path.join(dir, HARD_BLOCKER_ARTIFACT);
  const guardFile = path.join(dir, COMPLIANCE_LOOP_GUARD_ARTIFACT);
  const [blockerText, guardText] = await Promise.all([
    readText(blockerFile, ''),
    readText(guardFile, '')
  ]);
  if (!blockerText || !guardText) return false;

  let blocker: any;
  let guard: any;
  try {
    blocker = JSON.parse(blockerText);
    guard = JSON.parse(guardText);
  } catch {
    return false;
  }
  const gate = String(blocker?.gate || guard?.gate || '');
  if (
    blocker?.schema !== 'sks.hard-blocker.v1'
    || blocker?.status !== 'hard_blocked'
    || blocker?.reason !== 'compliance_loop_guard_tripped'
    || guard?.schema_version !== 1
    || guard?.mission_id !== state.mission_id
    || guard?.tripped !== true
    || guard?.gate !== gate
    || recovered[gate] !== true
  ) return false;

  const artifactName = gate === 'context7-evidence'
    ? 'context7-evidence.jsonl'
    : gate === 'official-subagent-evidence'
      ? 'subagent-evidence.json'
      : gate;
  if (!artifactName || path.isAbsolute(artifactName) || artifactName.includes('..')) return false;
  const artifactFile = path.join(dir, artifactName);
  const artifactStat = await fsp.stat(artifactFile).catch(() => null);
  const blockerAt = Date.parse(String(blocker.created_at || ''));
  const guardAt = Date.parse(String(guard.updated_at || ''));
  if (
    !artifactStat?.isFile()
    || !Number.isFinite(blockerAt)
    || !Number.isFinite(guardAt)
    || artifactStat.mtimeMs <= Math.max(blockerAt, guardAt)
  ) return false;

  const blockerSha256 = `sha256:${sha256(blockerText)}`;
  const guardSha256 = `sha256:${sha256(guardText)}`;
  await writeJsonAtomic(path.join(dir, 'hard-blocker.resolved.json'), {
    schema: 'sks.hard-blocker-resolution.v1',
    status: 'resolved',
    passed: true,
    mission_id: state.mission_id,
    resolved_at: nowIso(),
    resolution_reason: `newer_${gate}_evidence_resolved_compliance_loop`,
    hard_blocker_sha256: blockerSha256,
    compliance_loop_guard_sha256: guardSha256,
    recovery_artifact: artifactName,
    recovery_artifact_mtime: artifactStat.mtime.toISOString(),
    original_hard_blocker: blocker,
    original_compliance_loop_guard: guard
  });
  const [currentBlockerText, currentGuardText] = await Promise.all([
    readText(blockerFile, ''),
    readText(guardFile, '')
  ]);
  if (currentBlockerText !== blockerText || currentGuardText !== guardText) return false;
  await Promise.all([
    fsp.unlink(blockerFile).catch((err: any) => {
      if (err?.code !== 'ENOENT') throw err;
    }),
    fsp.unlink(guardFile).catch((err: any) => {
      if (err?.code !== 'ENOENT') throw err;
    })
  ]);
  await appendJsonl(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'pipeline.compliance_loop_guard.resolved',
    proof_invalidating: false,
    gate,
    recovery_artifact: artifactName,
    hard_blocker_sha256: blockerSha256,
    compliance_loop_guard_sha256: guardSha256
  });
  return true;
}

function readJsonCached<T>(cache: Map<string, Promise<T>> | undefined, file: string, fallback: T): Promise<T> {
  if (!cache) return readJson(file, fallback) as Promise<T>;
  const key = path.resolve(file);
  if (!cache.has(key)) cache.set(key, readJson(file, fallback) as Promise<T>);
  return cache.get(key) as Promise<T>;
}

async function passedActiveGate(root: any, state: any, jsonCache?: Map<string, Promise<any>>) {
  const id = state?.mission_id;
  if (!id) return { ok: false, file: null };
  const hardBlocker = await passedHardBlocker(root, state, jsonCache);
  if (hardBlocker.ok) return hardBlocker;
  const files = gateFilesForState(state);
  for (const file of files) {
    const p = path.join(missionDir(root, id), file);
    const gate = await readJsonCached(jsonCache, p, null);
    if (gate) {
      if (String(gate.status || '').trim().toLowerCase() === 'not_applicable') {
        const reason = String(gate.reason || '').trim();
        const missing: string[] = [];
        if (!reason) missing.push('reason');
        if (gate.blockers !== undefined && !Array.isArray(gate.blockers)) missing.push('blockers_invalid');
        else if (Array.isArray(gate.blockers) && gate.blockers.length > 0) missing.push('blockers');
        if (gate.missing_fields !== undefined && !Array.isArray(gate.missing_fields)) missing.push('missing_fields_invalid');
        else if (Array.isArray(gate.missing_fields) && gate.missing_fields.length > 0) missing.push('missing_fields');
        return missing.length
          ? { ok: false, file, missing }
          : { ok: true, file, not_applicable: true, reason };
      }
      const missing = [
        ...missingRequiredGateFields(file, state, gate),
        ...await missingRequiredGateArtifacts(root, file, state, gate)
      ];
      if (gate.passed === true && !missing.length) return { ok: true, file };
      if (missing.length) return { ok: false, file, missing };
      return { ok: false, file };
    }
  }
  return { ok: false, file: files[0] || null };
}

async function passedHardBlocker(root: any, state: any, jsonCache?: Map<string, Promise<any>>) {
  if (!state?.mission_id) return { ok: false };
  const file = 'hard-blocker.json';
  const blocker = await readJsonCached(jsonCache, path.join(missionDir(root, state.mission_id), file), null);
  if (!blocker) return { ok: false };
  const hasReason = String(blocker.reason || '').trim().length > 0;
  const hasEvidence = Array.isArray(blocker.evidence) && blocker.evidence.length > 0;
  if (String(blocker.status || '') === 'hard_blocked') {
    const missing = [];
    if (blocker.passed === true) missing.push('passed_false');
    if (!hasReason) missing.push('reason');
    if (!hasEvidence) missing.push('evidence');
    return missing.length
      ? { ok: false, file, missing }
      : {
          ok: true,
          file,
          hard_blocked: true,
          covered_gate: String(blocker.gate || '').trim(),
          reason: String(blocker.reason || '').trim()
        };
  }
  return { ok: blocker.passed === true && hasReason && hasEvidence, file };
}

function missingRequiredGateFields(file: any, state: any, gate: any = {}) {
  const mode = String(state?.mode || '').toUpperCase();
  if (file === 'naruto-gate.json' || mode === 'NARUTO') {
    const required = ['subagent_plan_ready', 'official_subagent_evidence', 'parent_summary_present', 'ssot_guard', 'session_cleanup'];
    if (gate.workflow !== 'official_codex_subagent') required.push('workflow');
    // parent_model_match is advisory LOD routing evidence — never a hard
    // stop field. Treating false as required:true made Codex App sessions
    // (uncontrollable parent model string) loop forever on an unfixable miss.
    if (Array.isArray(gate.config_blockers) && gate.config_blockers.length) required.push(...gate.config_blockers.map((item: any) => `config:${String(item)}`));
    if (fromChatImgCoverageRequired(state, gate)) required.push('from_chat_img_request_coverage');
    return required.filter((key: any) => key.includes(':') || gate[key] !== true);
  }
  if (file === 'qa-gate.json' || mode === 'QALOOP') {
    const required = ['clarification_contract_sealed', 'qa_report_written', 'qa_ledger_complete', 'checklist_completed', 'safety_reviewed', 'deployed_destructive_tests_blocked', 'credentials_not_persisted', 'honest_mode_complete'];
    if (gate.ui_e2e_required === true) required.push('chrome_extension_preflight_passed', 'ui_chrome_extension_evidence', 'ui_chrome_extension_screenshot_captured');
    if (gate.gpt_image_2_annotated_review_required === true) required.push('gpt_image_2_annotated_review_generated');
    return required.filter((key: any) => gate[key] !== true);
  }
  if (file === 'ppt-gate.json' || mode === 'PPT') {
    const required = [...PPT_REQUIRED_GATE_FIELDS];
    if (Number(gate.painpoint_count || 0) < 3) required.push('painpoint_count>=3');
    return required.filter((key: any) => {
      if (key === 'painpoint_count>=3') return Number(gate.painpoint_count || 0) < 3;
      return gate[key] !== true;
    });
  }
  if (file === IMAGE_UX_REVIEW_GATE_ARTIFACT || mode === 'IMAGE_UX_REVIEW') {
    const required = imageUxReviewGateAllowsReferenceCloseout(gate)
      ? IMAGE_UX_REVIEW_REFERENCE_GATE_FIELDS
      : IMAGE_UX_REVIEW_REQUIRED_GATE_FIELDS;
    return required.filter((key: any) => gate[key] !== true);
  }
  return [];
}

async function missingRequiredGateArtifacts(root: any, file: any, state: any, gate: any = {}) {
  const mode = String(state?.mode || '').toUpperCase();
  if (file === DB_REVIEW_ARTIFACT || mode === 'DB') {
    const evaluated = await validateDbReview(root, String(state.mission_id || ''), gate);
    if (evaluated.ok) return [];
    return evaluated.blockers.map((reason) => `${DB_REVIEW_ARTIFACT}:${reason}`);
  }
  if (file === 'mad-sks-gate.json' || mode === 'MADSKS') {
    const evaluated = await validateMadSksSqlPlaneCompletion(root, String(state.mission_id || ''), {
      capability_schema: 'sks.mad-sks-sql-plane-capability.v2',
      result_file: 'mad-sks/sql-plane/result.json',
      cycle_id: gate?.cycle_id || gate?.sql_plane?.cycle_id || null,
      read_back_passed: gate?.sql_plane?.read_back_passed === true,
      capability_closed: gate?.sql_plane?.profile_closed === true,
      read_only_restored: gate?.read_only_restoration?.ok === true
    });
    const missing: string[] = [];
    if (gate?.permissions_deactivated !== true) missing.push('permissions_deactivated');
    if (gate?.mad_sks_permission_active !== false) missing.push('mad_sks_permission_active_false');
    if (gate?.sql_plane?.requested !== true) missing.push('sql_plane_requested');
    if (gate?.control_plane_denied !== true) missing.push('control_plane_denied');
    if (!Array.isArray(gate?.blockers) || gate.blockers.length > 0) missing.push('blockers_empty');
    missing.push(...evaluated.blockers);
    return [...new Set(missing.map((reason) => `mad-sks-gate:${reason}`))];
  }
  if (file === 'research-gate.json' || mode === 'RESEARCH') {
    const evaluated = await evaluateResearchGate(missionDir(root, state.mission_id));
    if (evaluated.passed === true) return [];
    return (evaluated.reasons || ['research_gate_blocked']).map((reason: any) => `research-gate:${reason}`);
  }
  if (file === 'qa-gate.json' || mode === 'QALOOP') {
    const evaluated = await evaluateQaGate(missionDir(root, state.mission_id));
    if (evaluated.passed === true) return [];
    return (evaluated.reasons || ['qa_gate_blocked']).map((reason: any) => `qa-gate:${reason}`);
  }
  if (file === IMAGE_UX_REVIEW_GATE_ARTIFACT || mode === 'IMAGE_UX_REVIEW') return missingImageUxReviewArtifacts(root, state, gate);
  if (file === 'naruto-gate.json' || mode === 'NARUTO') return missingNarutoArtifacts(root, state, gate);
  return [];
}

async function missingImageUxReviewArtifacts(root: any, state: any = {}, gate: any = {}) {
  const missing: any[] = [];
  const id = state?.mission_id;
  if (!id) return [`${IMAGE_UX_REVIEW_GATE_ARTIFACT}:mission_id`];
  const dir = missionDir(root, id);
  const referenceOnly = imageUxReviewGateAllowsReferenceCloseout(gate);
  const required = referenceOnly
    ? [
        [IMAGE_UX_REVIEW_POLICY_ARTIFACT, true],
        [IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT, true],
        [IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT, true],
        [IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT, true],
        [IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT, true],
        [IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT, true]
      ]
    : [
        [IMAGE_UX_REVIEW_POLICY_ARTIFACT, gate.policy_created === true || gate.real_source_screenshot_present === true],
        [IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT, gate.screen_inventory_created === true || gate.real_source_screenshot_present === true],
        [IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT, gate.imagegen_review_images_generated === true || gate.gpt_image_2_callout_generated === true || gate.generated_image_ingested === true],
        [IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT, gate.issue_ledger_created === true || gate.callout_extraction_schema_valid === true],
        [IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT, gate.bounded_iteration_complete === true || gate.fix_loop_executed_or_not_needed === true || gate.changed_screens_rechecked === true],
        [IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT, gate.honest_mode_complete === true]
      ];
  for (const [artifact, field] of required as Array<[string, string | true]>) {
    if ((field === true || gate[field] === true) && !(await exists(path.join(dir, artifact)))) missing.push(artifact);
  }
  const generated = await readJson(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), null);
  if (gate.imagegen_review_images_generated === true || gate.gpt_image_2_callout_generated === true || gate.generated_image_ingested === true) {
    if (!generated) missing.push(IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT);
    else {
      if (generated.passed !== true) missing.push(`${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}:passed`);
      if (!Array.isArray(generated.generated_review_images) || generated.generated_review_images.length === 0) missing.push(`${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}:generated_review_images`);
      if (String(generated.provider?.model || '') !== 'gpt-image-2') missing.push(`${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}:gpt-image-2`);
    }
  }
  if (referenceOnly) {
    if (!generated) missing.push(IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT);
    else {
      if (String(generated.provider?.model || '') !== 'gpt-image-2') missing.push(`${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}:gpt-image-2`);
      if (Number(generated.real_generated_count || 0) !== 0) missing.push(`${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}:real_generated_count`);
      if (!Array.isArray(generated.blockers) || !generated.blockers.includes('missing_generated_annotated_review_images')) missing.push(`${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}:missing_generated_blocker`);
    }
  }
  const issues = await readJson(path.join(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT), null);
  if (gate.generated_review_images_analyzed === true || gate.p0_p1_zero === true || gate.callout_extraction_schema_valid === true || gate.p0_p1_zero_after_fix === true) {
    if (!issues) missing.push(IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT);
    else {
      if (issues.passed !== true && gate.p0_p1_zero === true && !referenceOnly) missing.push(`${IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT}:passed`);
      if (issues.validation?.ok !== true && gate.callout_extraction_schema_valid === true) missing.push(`${IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT}:validation`);
      if (issues.extraction_source !== IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT) missing.push(`${IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT}:extraction_source`);
      if (Number(issues.blocking_issue_count || 0) !== 0 && (gate.p0_p1_zero === true || gate.p0_p1_zero_after_fix === true)) missing.push(`${IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT}:blocking_issue_count`);
    }
  }
  if (gate.honest_mode_complete === true) {
    const honest = await readJson(path.join(dir, IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT), null);
    const validation = honest ? validateFinalHonestModeReport(honest) : { ok: false, errors: ['missing'] };
    if (!validation.ok) missing.push(`${IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT}:invalid`);
  }
  return missing;
}

function fromChatImgCoverageRequired(state: any = {}, gate: any = {}) {
  return state?.from_chat_img_required === true || gate?.from_chat_img_required === true;
}

async function missingFromChatImgCoverageArtifacts(root: any, state: any = {}) {
  const missing: any[] = [];
  const id = state?.mission_id;
  if (!id) return [`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:mission_id`];
  const ledger = await readJson(path.join(missionDir(root, id), FROM_CHAT_IMG_COVERAGE_ARTIFACT), null);
  if (!ledger) return [FROM_CHAT_IMG_COVERAGE_ARTIFACT];
  if (ledger.passed !== true) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:passed`);
  for (const key of ['all_chat_requirements_listed', 'all_requirements_mapped_to_work_order', 'all_screenshot_regions_accounted', 'all_attachments_accounted', 'image_analysis_complete', 'verbatim_customer_requests_preserved', 'checklist_updated', 'temp_triwiki_recorded', 'scoped_qa_loop_completed']) {
    if (ledger[key] !== true) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:${key}`);
  }
  if (!Array.isArray(ledger.unresolved_items)) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:unresolved_items`);
  else if (ledger.unresolved_items.length > 0) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:unresolved_items`);
  if (!Array.isArray(ledger.chat_requirements) || ledger.chat_requirements.length === 0) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:chat_requirements`);
  if (!Array.isArray(ledger.work_order_items) || ledger.work_order_items.length === 0) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:work_order_items`);
  if (!Array.isArray(ledger.attachment_matches)) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:attachment_matches`);
  const checklistName = typeof ledger.checklist_file === 'string' && ledger.checklist_file.trim() ? ledger.checklist_file.trim() : FROM_CHAT_IMG_CHECKLIST_ARTIFACT;
  const checklistPath = path.join(missionDir(root, id), checklistName);
  const checklist = await readText(checklistPath, null).catch(() => null);
  if (typeof checklist !== 'string') missing.push(FROM_CHAT_IMG_CHECKLIST_ARTIFACT);
  else {
    if (!/- \[[ xX]\]\s+\S/.test(checklist)) missing.push(`${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}:checkboxes`);
    if (/- \[ \]\s+\S/.test(checklist)) missing.push(`${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}:unchecked_items`);
    for (const section of ['Customer Requests', 'Image Analysis', 'Work Items', 'QA Loop', 'Verification']) {
      if (!checklist.includes(section)) missing.push(`${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}:${section.toLowerCase().replaceAll(' ', '_')}`);
    }
  }
  const tempWikiName = typeof ledger.temp_triwiki_file === 'string' && ledger.temp_triwiki_file.trim() ? ledger.temp_triwiki_file.trim() : FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT;
  const tempWiki = await readJson(path.join(missionDir(root, id), tempWikiName), null);
  if (!tempWiki) missing.push(FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT);
  else {
    const ttl = Number(tempWiki.expires_after_sessions);
    if (tempWiki.scope !== 'temporary' || tempWiki.storage !== 'triwiki') missing.push(`${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}:scope`);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS) missing.push(`${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}:expires_after_sessions`);
    if (!Array.isArray(tempWiki.claims) || tempWiki.claims.length === 0) missing.push(`${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}:claims`);
  }
  const qaLoopName = typeof ledger.qa_loop_file === 'string' && ledger.qa_loop_file.trim() ? ledger.qa_loop_file.trim() : FROM_CHAT_IMG_QA_LOOP_ARTIFACT;
  const qaLoop = await readJson(path.join(missionDir(root, id), qaLoopName), null);
  if (!qaLoop) missing.push(FROM_CHAT_IMG_QA_LOOP_ARTIFACT);
  else {
    if (qaLoop.passed !== true) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:passed`);
    if (qaLoop.scope !== 'from-chat-img-work-order') missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:scope`);
    if (qaLoop.all_work_order_items_qa_checked !== true) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:all_work_order_items_qa_checked`);
    if (qaLoop.post_fix_verification_complete !== true) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:post_fix_verification_complete`);
    if (Number(qaLoop.unresolved_findings) !== 0) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:unresolved_findings`);
    if (Number(qaLoop.unresolved_fixable_findings) !== 0) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:unresolved_fixable_findings`);
    if (!Array.isArray(qaLoop.evidence) || qaLoop.evidence.length === 0) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:evidence`);
    const source = qaLoop.web_verification_evidence_source || qaLoop.ui_evidence_source;
    if (source !== CODEX_WEB_VERIFICATION_EVIDENCE_SOURCE) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:web_verification_evidence_source`);
    if (evidenceMentionsForbiddenBrowserAutomation({ evidence: qaLoop.evidence, notes: qaLoop.notes, tool: qaLoop.tool, evidence_source: source })) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:forbidden_browser_automation_evidence`);
    const coveredWorkItems = new Set(Array.isArray(qaLoop.work_order_item_ids_covered) ? qaLoop.work_order_item_ids_covered.map(String) : []);
    for (const item of Array.isArray(ledger.work_order_items) ? ledger.work_order_items : []) {
      const workId = String(item?.id || '');
      if (workId && !coveredWorkItems.has(workId)) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:work_order_item_ids_covered`);
    }
  }
  return missing;
}

function gateFilesForState(state: any) {
  if (state.stop_gate) return [state.stop_gate];
  if (state.mode === 'GOAL') return [];
  if (state.mode === 'RESEARCH') return ['research-gate.json', 'research-gate.evaluated.json'];
  if (state.mode === 'NARUTO') return ['naruto-gate.json'];
  if (state.mode === 'AUTORESEARCH') return ['autoresearch-gate.json'];
  if (state.mode === 'DB') return ['db-review.json'];
  if (state.mode === 'GX') return ['gx-gate.json'];
  if (state.mode === 'QALOOP') return ['qa-gate.json'];
  if (state.mode === 'PPT') return ['ppt-gate.json'];
  if (state.mode === 'IMAGE_UX_REVIEW') return [IMAGE_UX_REVIEW_GATE_ARTIFACT];
  return ['done-gate.json'];
}

async function missingNarutoArtifacts(root: any, state: any = {}, gate: any = {}) {
  const id = state?.mission_id;
  if (!id) return ['mission_id'];
  const dir = missionDir(root, id);
  const required = [
    'naruto-gate.json',
    'subagent-plan.json',
    'subagent-events.jsonl',
    'subagent-parent-summary.json',
    'subagent-evidence.json',
    'naruto-summary.json'
  ];
  const missing: any[] = [];
  for (const file of required) {
    if (!(await exists(path.join(dir, file)))) missing.push(file);
  }
  if (gate?.ssot_guard === true) {
    const ssotGuard = await readJson(path.join(dir, SSOT_GUARD_ARTIFACT), null);
    const validation = validateSsotGuardArtifact(ssotGuard);
    if (!validation.ok) missing.push(...validation.issues.map((issue) => `${SSOT_GUARD_ARTIFACT}:${issue}`));
  }
  const [plan, rawEvidenceFile, rawSummary, recomputedEvidence] = await Promise.all([
    readJson(path.join(dir, 'subagent-plan.json'), null),
    readJson(path.join(dir, 'subagent-evidence.json'), null),
    readJson(path.join(dir, 'naruto-summary.json'), null),
    subagentEvidence(root, state)
  ]);
  const normalizedGate: any = normalizeLegacySubagentCountFields(gate, plan);
  const evidenceFile = normalizeLegacySubagentCountFields(rawEvidenceFile, plan);
  const summary = normalizeLegacySubagentCountFields(rawSummary, plan);
  if (plan?.schema !== 'sks.subagent-plan.v1') missing.push('subagent-plan.json:schema');
  if (plan?.workflow !== 'official_codex_subagent') missing.push('subagent-plan.json:workflow');
  if (Number(plan?.requested_subagents || 0) < 1) missing.push('subagent-plan.json:requested_subagents');
  if (Number(plan?.max_threads || 0) < 1) missing.push('subagent-plan.json:max_threads');
  if (Number(plan?.max_depth || 0) !== 1) missing.push('subagent-plan.json:max_depth');
  if (!String(plan?.delegation_prompt || '').trim()) missing.push('subagent-plan.json:delegation_prompt');
  // parent_model_match on the plan is advisory (routing LOD), not a hard stop condition.
  missing.push(...subagentCountContractBlockers(plan, Number(recomputedEvidence?.started_threads || 0)).map((item) => `subagent-plan.json:${item}`));
  if (evidenceFile?.schema !== 'sks.subagent-evidence.v1') missing.push('subagent-evidence.json:schema');
  if (evidenceFile?.workflow !== 'official_codex_subagent') missing.push('subagent-evidence.json:workflow');
  if (recomputedEvidence?.ok !== true) missing.push(...(Array.isArray(recomputedEvidence?.blockers) && recomputedEvidence.blockers.length ? recomputedEvidence.blockers.map((item: any) => `subagent-evidence.json:${String(item)}`) : ['subagent-evidence.json:ok']));
  if (recomputedEvidence?.parent_summary_present !== true || recomputedEvidence?.parent_summary_trustworthy !== true) missing.push('subagent-evidence.json:parent_summary_trustworthy');
  const countTarget = effectiveSubagentTarget(plan, Number(recomputedEvidence?.started_threads || 0));
  const legacyCountContract = !plan?.wave_lifecycle?.count_policy;
  if (Number(recomputedEvidence?.requested_subagents || 0) !== countTarget.requestedSubagents) missing.push('subagent-evidence.json:requested_subagents');
  if (recomputedEvidence?.count_policy !== countTarget.countPolicy) missing.push('subagent-evidence.json:count_policy');
  if (Number(recomputedEvidence?.target_subagents || 0) !== countTarget.targetSubagents) missing.push('subagent-evidence.json:target_subagents');
  if (Number(recomputedEvidence?.failed_threads || 0) !== 0) missing.push('subagent-evidence.json:failed_threads');
  if (Number(recomputedEvidence?.completed_threads || 0) !== countTarget.targetSubagents) missing.push('subagent-evidence.json:completed_threads');
  if (summary?.schema !== 'sks.naruto-subagent-workflow.v1') missing.push('naruto-summary.json:schema');
  if (summary?.workflow !== 'official_codex_subagent') missing.push('naruto-summary.json:workflow');
  if (summary?.count_policy !== countTarget.countPolicy) missing.push('naruto-summary.json:count_policy');
  if (Number(summary?.target_subagents || 0) !== countTarget.targetSubagents) missing.push('naruto-summary.json:target_subagents');
  if (!legacyCountContract && normalizedGate?.count_policy !== countTarget.countPolicy) missing.push('naruto-gate.json:count_policy');
  if (!legacyCountContract && Number(normalizedGate?.target_subagents || 0) !== countTarget.targetSubagents) missing.push('naruto-gate.json:target_subagents');
  if (summary?.ok !== true || summary?.status !== 'completed') missing.push('naruto-summary.json:completed');
  if (summary?.parent_summary_present !== true || !String(summary?.parent_summary || '').trim()) missing.push('naruto-summary.json:parent_summary');
  if (!String(summary?.verification?.budget || '').trim()) missing.push('naruto-summary.json:verification.budget');
  // observed_model_match is advisory LOD evidence; do not hard-stop on mismatch.
  if (fromChatImgCoverageRequired(state, normalizedGate) && normalizedGate.from_chat_img_request_coverage === true) {
    missing.push(...await missingFromChatImgCoverageArtifacts(root, state));
  }
  return missing;
}


function extractLastMessage(payload: any) {
  return payload.last_assistant_message || payload.assistant_message || payload.message || payload.response || payload.raw || '';
}

async function hasVisibleClarificationQuestionBlock(root: any, state: any = {}, text: any = '') {
  const body = String(text || '');
  if (!/Required questions|필수 질문|질문지|답변할 항목/i.test(body)) return false;
  const schema = state.mission_id ? await readJson(path.join(missionDir(root, state.mission_id), 'required-answers.schema.json'), null) : null;
  const slots = Array.isArray(schema?.slots) ? schema.slots : [];
  if (!slots.length) return /sks pipeline answer|answers\.json/i.test(body);
  const requiredIds = slots.slice(0, Math.min(3, slots.length)).map((slot: any) => slot.id).filter(Boolean);
  return requiredIds.every((id: any) => body.includes(id)) && /sks pipeline answer|answers\.json|slot id|슬롯|항목/i.test(body);
}
