import path from 'node:path';
import { appendJsonl, nowIso, readJson, readText, sha256, writeJsonAtomic } from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';
import { updateCurrentIfMissionAndRun } from '../mission.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { validateRouteCompletionProof } from '../proof/route-proof-gate.js';
import {
  officialSubagentPreparationInProgress,
  withOfficialSubagentLifecycleLock
} from '../subagents/official-subagent-preparation.js';
import {
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME
} from '../subagents/subagent-evidence.js';
import { terminalBlockedNarutoGate } from '../subagents/terminal-subagent-state.js';
import { closeWorkOrderLedgerForRouteResult } from '../work-order-ledger.js';
import { guardContextForRoute, guardedRm } from '../safety/mutation-guard.js';
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js';

const HARD_BLOCKER_ARTIFACT = 'hard-blocker.json';
const RESOLVED_HARD_BLOCKER_ARTIFACT = 'hard-blocker.resolved.json';
const COMPLIANCE_LOOP_GUARD_ARTIFACT = 'compliance-loop-guard.json';

export async function finalizeNarutoTerminalProof(
  root: any,
  state: any,
  sessionKey: any,
  dir: string,
  terminal: any
) {
  // Lock order is finalization -> lifecycle -> session state. Preparation starts
  // at lifecycle -> session state and never acquires the finalization lock.
  await withFileLock({
    lockPath: path.join(dir, '.naruto-finalize.lock'),
    timeoutMs: 5_000,
    staleMs: 30_000
  }, () => withOfficialSubagentLifecycleLock(dir, async () => {
    if (await officialSubagentPreparationInProgress(dir)) return;
    const [currentPlan, currentGate] = await Promise.all([
      readJson(path.join(dir, 'subagent-plan.json'), null).catch(() => null),
      readJson(path.join(dir, 'naruto-gate.json'), null).catch(() => null)
    ]);
    const terminalBlocked = terminalBlockedNarutoGate(currentGate);
    if (String(currentPlan?.workflow_run_id || '').trim() !== terminal.workflowRunId
      || String(currentGate?.workflow_run_id || '').trim() !== terminal.workflowRunId
      || (currentGate?.passed !== true && !terminalBlocked)
      || currentGate?.terminal !== true) return;
    let proofStatus = await currentNarutoProofStatus(root, terminal.missionId, terminal.workflowRunId, state);
    if (!proofStatus.valid) {
      const finalized: any = await maybeFinalizeRoute(root, {
        missionId: terminal.missionId,
        route: '$Naruto',
        gateFile: 'naruto-gate.json',
        gate: currentGate,
        artifacts: [
          { path: 'subagent-plan.json', kind: 'agent', source: 'real', ignoreStale: true },
          { path: 'subagent-events.jsonl', kind: 'agent', source: 'real', ignoreStale: true },
          { path: SUBAGENT_PARENT_SUMMARY_FILENAME, kind: 'agent', source: 'real', ignoreStale: true },
          { path: SUBAGENT_EVIDENCE_FILENAME, kind: 'agent', source: 'real', ignoreStale: true },
          { path: 'naruto-summary.json', kind: 'agent', source: 'real', ignoreStale: true },
          { path: 'naruto-gate.json', kind: 'agent', source: 'real', ignoreStale: true }
        ],
        claims: [{ id: 'naruto-official-subagent-completion', status: 'supported', evidence: 'naruto-gate.json' }],
        agents: true
      });
      if (finalized?.ok !== true) {
        throw new Error(`naruto_terminal_proof_finalize_failed:${String(finalized?.validation?.issues?.join(',') || finalized?.status || 'unknown')}`);
      }
      proofStatus = await currentNarutoProofStatus(root, terminal.missionId, terminal.workflowRunId, state);
    }
    if (!proofStatus.valid) throw new Error('naruto_terminal_proof_invalid_after_finalize');
    if (currentGate?.passed === true) {
      await resolveStaleOfficialSubagentComplianceBlocker({
        root,
        dir,
        missionId: terminal.missionId,
        workflowRunId: terminal.workflowRunId,
        gate: currentGate,
        proof: proofStatus.proof
      });
    }
    await closeWorkOrderLedgerForRouteResult(dir, {
      ok: currentGate?.passed === true,
      blockers: Array.isArray(currentGate?.blockers) ? currentGate.blockers : []
    });
    await invalidateReflectionForNarutoProofOnce(
      root,
      state,
      sessionKey,
      terminal.workflowRunId,
      proofStatus.digest
    );
  }));
}

async function resolveStaleOfficialSubagentComplianceBlocker(input: {
  root: string;
  dir: string;
  missionId: string;
  workflowRunId: string;
  gate: any;
  proof: any;
}) {
  const hardBlockerPath = path.join(input.dir, HARD_BLOCKER_ARTIFACT);
  const guardPath = path.join(input.dir, COMPLIANCE_LOOP_GUARD_ARTIFACT);
  const resolvedPath = path.join(input.dir, RESOLVED_HARD_BLOCKER_ARTIFACT);
  const [hardBlockerText, guardText] = await Promise.all([
    readText(hardBlockerPath, ''),
    readText(guardPath, '')
  ]);
  if (!hardBlockerText || !guardText) return false;

  let hardBlocker: any;
  let guard: any;
  try {
    hardBlocker = JSON.parse(hardBlockerText);
    guard = JSON.parse(guardText);
  } catch {
    return false;
  }

  const sameRunTerminalProof = input.gate?.workflow_run_id === input.workflowRunId
    && input.gate?.mission_id === input.missionId
    && input.gate?.passed === true
    && input.gate?.terminal === true
    && input.gate?.official_subagent_evidence === true
    && input.gate?.parent_summary_present === true
    && input.gate?.session_cleanup === true
    && Array.isArray(input.gate?.blockers)
    && input.gate.blockers.length === 0
    && input.proof?.mission_id === input.missionId
    && input.proof?.evidence?.route_gate?.workflow_run_id === input.workflowRunId;
  const staleOfficialEvidenceBlocker = hardBlocker?.schema === 'sks.hard-blocker.v1'
    && hardBlocker?.status === 'hard_blocked'
    && hardBlocker?.passed !== true
    && hardBlocker?.reason === 'compliance_loop_guard_tripped'
    && hardBlocker?.gate === 'official-subagent-evidence'
    && guard?.schema_version === 1
    && guard?.mission_id === input.missionId
    && guard?.gate === 'official-subagent-evidence'
    && guard?.tripped === true;
  if (!sameRunTerminalProof || !staleOfficialEvidenceBlocker) return false;

  const proofAt = Date.parse(String(input.proof?.generated_at || ''));
  const blockerAt = Date.parse(String(hardBlocker?.created_at || ''));
  const guardAt = Date.parse(String(guard?.updated_at || ''));
  if (!Number.isFinite(proofAt)
    || !Number.isFinite(blockerAt)
    || !Number.isFinite(guardAt)
    || proofAt <= Math.max(blockerAt, guardAt)) return false;

  const hardBlockerSha256 = `sha256:${sha256(hardBlockerText)}`;
  const guardSha256 = `sha256:${sha256(guardText)}`;
  const existingResolution: any = await readJson(resolvedPath, null).catch(() => null);
  if (existingResolution && (
    existingResolution.status !== 'resolved'
    || existingResolution.hard_blocker_sha256 !== hardBlockerSha256
    || existingResolution.compliance_loop_guard_sha256 !== guardSha256
    || existingResolution.workflow_run_id !== input.workflowRunId
  )) return false;

  if (!existingResolution) {
    await writeJsonAtomic(resolvedPath, {
      schema: 'sks.hard-blocker-resolution.v1',
      status: 'resolved',
      passed: true,
      mission_id: input.missionId,
      workflow_run_id: input.workflowRunId,
      resolved_at: nowIso(),
      resolution_reason: 'newer_same_run_terminal_naruto_proof_resolved_official_subagent_evidence_loop',
      hard_blocker_sha256: hardBlockerSha256,
      compliance_loop_guard_sha256: guardSha256,
      original_hard_blocker: hardBlocker,
      original_compliance_loop_guard: guard,
      resolution_evidence: {
        naruto_gate: 'naruto-gate.json',
        completion_proof: 'completion-proof.json',
        proof_generated_at: input.proof.generated_at
      }
    });
  }

  const [currentHardBlockerText, currentGuardText] = await Promise.all([
    readText(hardBlockerPath, ''),
    readText(guardPath, '')
  ]);
  if (currentHardBlockerText !== hardBlockerText || currentGuardText !== guardText) return false;
  const contract = createRequestedScopeContract({
    route: 'Naruto',
    userRequest: 'Resolve only stale SKS official-subagent compliance artifacts after a newer same-run terminal proof.',
    projectRoot: input.root
  });
  const guardContext = guardContextForRoute(input.root, contract, 'resolve stale Naruto official-subagent compliance blocker');
  await guardedRm(guardContext, hardBlockerPath, { force: true });
  await guardedRm(guardContext, guardPath, { force: true });
  await appendJsonl(path.join(input.dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'pipeline.compliance_loop_guard.resolved',
    proof_invalidating: false,
    gate: 'official-subagent-evidence',
    workflow_run_id: input.workflowRunId,
    resolution_artifact: RESOLVED_HARD_BLOCKER_ARTIFACT
  });
  return true;
}

async function currentNarutoProofStatus(root: any, missionId: string, workflowRunId: string, state: any) {
  const validation = await validateRouteCompletionProof(root, {
    missionId,
    route: '$Naruto',
    state: {
      ...state,
      mission_id: missionId,
      subagents_required: true,
      official_subagent_run_id: workflowRunId
    }
  }).catch(() => null);
  const proofRunId = String(validation?.proof?.evidence?.route_gate?.workflow_run_id || '').trim();
  const proofText = await readText(
    path.join(root, '.sneakoscope', 'missions', missionId, 'completion-proof.json'),
    ''
  ).catch(() => '');
  return {
    valid: validation?.ok === true && proofRunId === workflowRunId,
    proof: validation?.proof || null,
    digest: proofText ? `sha256:${sha256(proofText)}` : null
  };
}

async function invalidateReflectionForNarutoProofOnce(
  root: any,
  state: any,
  sessionKey: any,
  workflowRunId: string,
  proofDigest: string | null
) {
  if (!workflowRunId || !proofDigest) return;
  const resolvedSessionKey = sessionKey || state?._session_key;
  await updateCurrentIfMissionAndRun(root, state?.mission_id, workflowRunId, (current: any) => {
    if (current?.reflection_invalidated_for_workflow_run_id === workflowRunId
      && current?.reflection_invalidated_for_proof_digest === proofDigest) return null;
    return {
      reflection_invalidation_required: true,
      reflection_invalidated_at: nowIso(),
      reflection_invalidation_reason: 'naruto_terminal_proof_committed',
      reflection_invalidated_for_workflow_run_id: workflowRunId,
      reflection_invalidated_for_proof_digest: proofDigest
    };
  }, { sessionKey: resolvedSessionKey });
}
