import { runGptFinalArbiter } from '../codex-control/gpt-final-arbiter.js';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import { loopGptFinalArbiterPath } from './loop-artifacts.js';
import { decideLoopFixturePolicy, writeLoopFixturePolicyDecision } from './loop-fixture-policy.js';
import type { LoopIntegrationMergeResult } from './loop-integration-merge.js';
import type { SksLoopPlan, SksLoopProof } from './loop-schema.js';
import type { LoopSideEffectReport } from './loop-side-effect-scanner.js';

export interface LoopGptFinalArbiterResult {
  schema: 'sks.loop-gpt-final-arbiter.v1';
  ok: boolean;
  mission_id: string;
  reviewed_loop_ids: string[];
  changed_files: string[];
  verdict: 'approve' | 'revise' | 'reject';
  required_revisions: string[];
  blockers: string[];
  artifact_path: string;
}

export async function runLoopGptFinalArbiter(input: {
  root: string;
  plan: SksLoopPlan;
  proofs: SksLoopProof[];
  integrationMerge: LoopIntegrationMergeResult;
  sideEffectReport?: LoopSideEffectReport;
  forceVerdict?: 'approve' | 'revise' | 'reject';
}): Promise<LoopGptFinalArbiterResult> {
  const artifactPath = loopGptFinalArbiterPath(input.root, input.plan.mission_id);
  const changedFiles = [...new Set([
    ...input.integrationMerge.changed_files,
    ...input.proofs.flatMap((proof) => proof.changed_files)
  ])];
  const reviewedLoopIds = input.proofs.map((proof) => proof.loop_id);
  const fixtureRequested = process.env.SKS_LOOP_GPT_FINAL_FIXTURE === '1' || Boolean(input.forceVerdict);
  const fixtureDecision = decideLoopFixturePolicy({
    root: input.root,
    missionId: input.plan.mission_id,
    mode: 'gpt-final',
    requested: fixtureRequested
  });
  if (fixtureRequested) await writeLoopFixturePolicyDecision(input.root, input.plan.mission_id, fixtureDecision).catch(() => undefined);
  if (fixtureRequested && !fixtureDecision.allowed) {
    const result = buildResult(input.plan.mission_id, reviewedLoopIds, changedFiles, 'reject', [], artifactPath, [...fixtureDecision.blockers, 'loop_gpt_final_fixture_forbidden_in_production']);
    await writeJsonAtomic(artifactPath, { ...result, generated_at: nowIso(), backend: 'fixture-forbidden', fixture_policy: fixtureDecision });
    return result;
  }
  if (fixtureRequested) {
    const verdict = input.forceVerdict || (process.env.SKS_LOOP_GPT_FINAL_REJECT === '1' ? 'reject' : 'approve');
    const result = buildResult(input.plan.mission_id, reviewedLoopIds, changedFiles, verdict, verdict === 'approve' ? [] : ['fixture_revision_required'], artifactPath, []);
    await writeJsonAtomic(artifactPath, { ...result, generated_at: nowIso(), backend: 'fixture', fixture_policy: fixtureDecision, fixture_allowed_reason: fixtureDecision.reason, side_effect_report: input.sideEffectReport || null });
    return result;
  }
  if (input.sideEffectReport && !input.sideEffectReport.ok) {
    const result = buildResult(input.plan.mission_id, reviewedLoopIds, changedFiles, 'reject', [], artifactPath, input.sideEffectReport.blockers);
    await writeJsonAtomic(artifactPath, { ...result, generated_at: nowIso(), backend: 'side-effect-block', side_effect_report: input.sideEffectReport });
    return result;
  }
  const arbiter = await runGptFinalArbiter({
    schema: 'sks.gpt-final-arbiter-input.v1',
    route: '$Loop',
    mission_id: input.plan.mission_id,
    candidate_outputs: input.proofs.map((proof) => ({
      id: proof.loop_id,
      backend: proof.maker_result.backend || 'loop-worker',
      status: proof.status,
      summary: proof.blockers.join(', ') || 'loop proof completed',
      changed_files: proof.changed_files,
      blockers: proof.blockers
    })),
    candidate_diff: JSON.stringify({ changed_files: changedFiles, integration_merge: input.integrationMerge, side_effect_report: input.sideEffectReport || null }),
    verification_results: input.proofs.map((proof) => ({ id: proof.loop_id, ok: proof.status === 'completed', blockers: proof.blockers })),
    side_effect_report: input.sideEffectReport || { schema: 'sks.loop-side-effect-report.v1', ok: true, changed_files: changedFiles },
    mutation_ledger: { schema: 'sks.loop-mutation-ledger.v1', proofs: input.proofs, path: input.sideEffectReport?.mutation_ledger_path || null },
    rollback_plan: { schema: 'sks.loop-rollback-plan.v1', strategy: 'git-worktree-or-human-handoff' }
  }, { cwd: input.root, mutationLedgerRoot: `${input.root}/.sneakoscope/missions/${input.plan.mission_id}/loops/gpt-final-arbiter` });
  const status = String((arbiter as any).result?.status || '');
  const verdict: LoopGptFinalArbiterResult['verdict'] = status === 'approved' || status === 'modified' ? 'approve' : status === 'needs_more_work' ? 'revise' : 'reject';
  const blockers = stringArray((arbiter as any).blockers);
  const result = buildResult(input.plan.mission_id, reviewedLoopIds, changedFiles, verdict, stringArray((arbiter as any).result?.required_followup_work), artifactPath, blockers);
  await writeJsonAtomic(artifactPath, { ...result, generated_at: nowIso(), backend: (arbiter as any).backend || null, side_effect_report: input.sideEffectReport || null, arbiter });
  return result;
}

function buildResult(missionId: string, reviewedLoopIds: string[], changedFiles: string[], verdict: LoopGptFinalArbiterResult['verdict'], revisions: string[], artifactPath: string, blockers: string[]): LoopGptFinalArbiterResult {
  return {
    schema: 'sks.loop-gpt-final-arbiter.v1',
    ok: verdict === 'approve' && blockers.length === 0,
    mission_id: missionId,
    reviewed_loop_ids: reviewedLoopIds,
    changed_files: changedFiles,
    verdict,
    required_revisions: revisions,
    blockers,
    artifact_path: artifactPath
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).filter(Boolean);
}
