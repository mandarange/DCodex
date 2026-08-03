import path from 'node:path';
import { containsPlaintextSecret } from '../secret-redaction.js';
import { readJson } from '../fsx.js';
import { readRouteProof } from './proof-reader.js';
import { validateCompletionProof } from './validation.js';
import { normalizeProofRoute, proofStatusBlocks, routeRequiresCompletionProof, routeRequiresImageVoxelAnchors } from './route-proof-policy.js';
import { routeRequiresOfficialSubagents } from '../agents/agent-plan.js';
import { rootCauseAnalysisIssue } from './root-cause-policy.js';
import { effectiveSubagentTarget, normalizeLegacySubagentCountFields } from '../subagents/wave-lifecycle.js';
import { latestTrustReport } from '../trust-kernel/trust-report.js';
import { canonicalJson } from '../json/canonical.js';

export async function validateRouteCompletionProof(root: any, { missionId = null, route = null, state = {}, visualClaim = undefined }: any = {}) {
  const proofRequired = state.proof_required === true || routeRequiresCompletionProof(route);
  if (!proofRequired) return { ok: true, required: false, status: 'not_required', issues: [] };
  const proof: any = await readRouteProof(root, missionId);
  if (!proof) {
    return {
      ok: false,
      required: true,
      status: 'blocked',
      issues: ['completion_proof_missing']
    };
  }
  const validation = validateCompletionProof(proof);
  const issues = [...validation.issues];
  if (missionId && proof.mission_id !== missionId) issues.push('completion_proof_mission_id_mismatch');
  if (route && normalizeProofRoute(proof.route) !== normalizeProofRoute(route)) issues.push('completion_proof_route_mismatch');
  if (proofStatusBlocks(proof.status)) issues.push(`proof_status_${proof.status}`);
  if (containsPlaintextSecret(proof)) issues.push('plaintext_secret');
  if (routeRequiresImageVoxelAnchors(route || proof.route, { visualClaim })) {
    const anchors = proof.evidence?.image_voxels?.anchors ?? proof.evidence?.image_voxels?.anchor_count ?? 0;
    if (Number(anchors) <= 0) issues.push('image_voxel_anchors_missing');
  }
  const normalizedRoute = normalizeProofRoute(route || proof.route);
  const plan: any = missionId
    ? await readJson(path.join(root, '.sneakoscope', 'missions', missionId, 'subagent-plan.json'), null).catch(() => null)
    : null;
  const officialSubagentsRequired = state.subagents_required === true
    || proof.evidence?.route_gate?.workflow === 'official_codex_subagent'
    || routeRequiresOfficialSubagents(normalizedRoute || route || proof.route, { task: state.prompt });
  if (officialSubagentsRequired) {
    const routeGate: any = normalizeLegacySubagentCountFields(proof.evidence?.route_gate, plan);
    const modernRunContract = Boolean(plan?.wave_lifecycle?.count_policy && plan?.workflow_run_id);
    if (!routeGate) issues.push('official_subagent_route_gate_missing');
    else {
      if (routeGate.workflow !== 'official_codex_subagent') issues.push('official_subagent_workflow_missing');
      if (routeGate.official_subagent_evidence !== true) issues.push('official_subagent_evidence_missing');
      if (routeGate.parent_summary_present !== true) issues.push('official_subagent_parent_summary_missing');
      const expectedWorkflowRunId = String(state.official_subagent_run_id || plan?.workflow_run_id || '').trim();
      if (expectedWorkflowRunId && String(routeGate.workflow_run_id || '').trim() !== expectedWorkflowRunId) {
        issues.push('official_subagent_workflow_run_id_mismatch');
      }
      if (modernRunContract && plan?.workflow === 'official_codex_subagent') {
        const target = effectiveSubagentTarget(plan, Number(routeGate.started_subagents || routeGate.evidence?.started_threads || 0));
        if (routeGate.count_policy !== target.countPolicy) issues.push('official_subagent_count_policy_mismatch');
        if (Number(routeGate.target_subagents || 0) !== target.targetSubagents) issues.push('official_subagent_target_subagents_mismatch');
      }
      if (missionId && modernRunContract) {
        const currentGateFile = officialSubagentCurrentGateFile(normalizedRoute, state);
        const diskGate: any = normalizeLegacySubagentCountFields(
          currentGateFile
            ? await readJson(path.join(root, '.sneakoscope', 'missions', missionId, currentGateFile), null).catch(() => null)
            : null,
          plan
        );
        if (!diskGate) issues.push('official_subagent_current_gate_missing');
        else if (canonicalJson(routeGate) !== canonicalJson(diskGate)) issues.push('official_subagent_current_gate_mismatch');
      }
    }
    if (modernRunContract && (!proof.evidence?.trust_report || !proof.evidence?.route_contract || !proof.evidence?.evidence_router)) {
      issues.push('completion_proof_full_trust_missing');
    } else if (modernRunContract && missionId) {
      const trust: any = await latestTrustReport(root, missionId).catch(() => null);
      if (trust?.ok !== true || trust?.mission_id !== missionId || (Array.isArray(trust?.issues) && trust.issues.length > 0)) {
        issues.push('completion_proof_trust_invalid_or_stale');
      }
    }
  }
  const wrongness = proof.evidence?.wrongness;
  const imageUxReferenceOnlyPartial = proof.status === 'verified_partial' && proof.evidence?.image_ux_review?.reference_only === true;
  if (Number(wrongness?.high_severity_active || 0) > 0 && !imageUxReferenceOnlyPartial) issues.push('active_wrongness_high');
  if (proof.status === 'verified' && Number(wrongness?.active_count || 0) > 0) issues.push('active_wrongness_requires_partial');
  const rootCauseIssue = rootCauseAnalysisIssue(proof, issues);
  if (rootCauseIssue) issues.push(rootCauseIssue);
  return {
    ok: issues.length === 0,
    required: true,
    status: issues.length ? 'blocked' : proof.status,
    issues,
    proof
  };
}

function officialSubagentCurrentGateFile(route: any, state: any = {}): string | null {
  if (normalizeProofRoute(route) === '$Naruto') return 'naruto-gate.json';
  const candidate = String(state.stop_gate || '').trim();
  if (!candidate || path.basename(candidate) !== candidate || !/^[A-Za-z0-9._-]+\.json$/.test(candidate)) return null;
  return candidate;
}
