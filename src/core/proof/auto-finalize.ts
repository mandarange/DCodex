import path from 'node:path';
import { exists, readJson, writeJsonAtomic, type JsonData } from '../fsx.js';
import { finalizeRouteWithProof } from './route-finalizer.js';
import { evaluateGate } from '../stop-gate/gate-evaluator.js';
import { effectiveSubagentTarget } from '../subagents/wave-lifecycle.js';

export async function maybeFinalizeRoute(root: any, {
  missionId,
  route,
  gateFile = null,
  gate = null,
  artifacts = [],
  claims = [],
  visualEvidence = null,
  visual = false,
  fixClaim = false,
  requireRelation = false,
  mock = false,
  statusHint = null,
  reason = null,
  command = null,
  dbEvidence = null,
  testEvidence = null,
  blockers = [],
  unverified = [],
  agents = undefined,
  allowActiveWrongnessPartial = false,
  failureAnalysis = null,
  lightweightEvidence = false
}: any = {}): Promise<JsonData> {
  if (!missionId || !route) {
    return { ok: false, skipped: true, reason: 'mission_id_or_route_missing' };
  }
  const missionDir = path.join(root, '.sneakoscope', 'missions', missionId);
  const rawDiskGateObject = gateFile && await exists(path.join(missionDir, gateFile))
    ? await readJson(path.join(missionDir, gateFile), null)
    : null;
  const callerGateMismatch = Boolean(gate && rawDiskGateObject && stableJson(gate) !== stableJson(rawDiskGateObject));
  const officialSubagentBinding = await bindOfficialSubagentEvidence(
    missionDir,
    rawDiskGateObject || gate || null
  );
  const gateObject = officialSubagentBinding.gate;
  if (gateFile && rawDiskGateObject && officialSubagentBinding.applied) {
    await writeJsonAtomic(path.join(missionDir, gateFile), gateObject);
  }
  const gateVerdict = gateFile ? await evaluateGate(root, missionId, gateFile) : null;
  const passed = gateVerdict ? gateVerdict.pass && !callerGateMismatch : gateObject?.passed === true || gateObject?.ok === true || gateObject?.status === 'pass';
  const gateBlockers = gateVerdict && !gateVerdict.pass
    ? [`route_gate_${gateVerdict.verdict}`, ...gateVerdict.reasons.map((item) => `route_gate_${item}`)]
    : [];
  if (callerGateMismatch) gateBlockers.push('route_gate_caller_disk_mismatch');
  const computedStatus = computeAutoFinalizeStatus({
    mock,
    passed,
    blockers: [...blockers, ...gateBlockers, ...officialSubagentBinding.blockers]
  });
  const statusResolution = applyStatusHint(computedStatus, statusHint);
  const finalStatus = statusResolution.status;
  const proofArtifacts = officialSubagentBinding.applied
    ? appendOfficialSubagentArtifacts(artifacts)
    : artifacts;
  const proof = await finalizeRouteWithProof(root, {
    missionId,
    route,
    gateFile,
    gate: gateObject,
    artifacts: proofArtifacts,
    claims: claims.length ? claims : [{ id: String(route).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() + '-auto-finalize', status: mock ? 'verified_partial' : 'supported', evidence: gateFile || 'route-command' }],
    visualEvidence,
    dbEvidence,
    testEvidence,
    commandEvidence: command ? [{ ...command, ok: command.ok !== false }] : null,
    unverified: [
      ...unverified,
      ...(mock ? ['Route was finalized from an explicit mock/fixture command path.'] : []),
      ...(gateVerdict?.verdict === 'mock_only' ? ['Route gate is mock fixture evidence and cannot satisfy a real completion gate.'] : []),
      ...(statusResolution.rejected ? [`statusHint rejected: requested ${statusResolution.rejected.requested}, computed ${statusResolution.rejected.computed}.`] : []),
      ...(!passed && !mock ? ['Route gate did not pass' + (reason ? ': ' + reason : '') + '.'] : [])
    ],
    blockers: [
      ...blockers,
      ...gateBlockers,
      ...officialSubagentBinding.blockers,
      ...(!passed && !mock && !gateBlockers.length ? ['route_gate_not_passed'] : [])
    ],
    statusHint: finalStatus,
    statusHintRejected: statusResolution.rejected,
    mock,
    fixClaim,
    requireRelation,
    visualClaim: visual,
    agents,
    allowActiveWrongnessPartial,
    failureAnalysis,
    lightweightEvidence
  });
  return { ...proof, auto_finalized: true, gate_passed: passed, gate_verdict: gateVerdict, status_hint: finalStatus, status_hint_rejected: statusResolution.rejected };
}

const STATUS_RANK: Record<string, number> = {
  blocked: 0,
  failed: 0,
  not_verified: 0,
  mock_only: 1,
  verified_partial: 2,
  verified: 3
};

function computeAutoFinalizeStatus({ mock, passed, blockers }: { mock: boolean; passed: boolean; blockers: unknown[] }) {
  if (mock) return 'mock_only';
  if (blockers.length > 0) return 'blocked';
  return passed ? 'verified' : 'blocked';
}

function applyStatusHint(computed: string, requested: string | null) {
  if (!requested) return { status: computed, rejected: null };
  const requestedRank = STATUS_RANK[requested];
  const computedRank = STATUS_RANK[computed];
  if (requestedRank === undefined || computedRank === undefined) {
    return { status: computed, rejected: { requested, computed, reason: 'unknown_status_hint' } };
  }
  if (computed === 'mock_only' && requested !== 'mock_only') {
    return { status: computed, rejected: { requested, computed, reason: 'mock_fixture_status_cap' } };
  }
  if (requestedRank > computedRank) {
    return { status: computed, rejected: { requested, computed, reason: 'status_hint_upgrade_rejected' } };
  }
  return { status: requested, rejected: null };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function bindOfficialSubagentEvidence(missionDir: string, gate: any) {
  const plan: any = await readJson(path.join(missionDir, 'subagent-plan.json'), null).catch(() => null);
  if (plan?.workflow !== 'official_codex_subagent') {
    return { applied: false, gate, blockers: [] as string[] };
  }
  const [evidence, parentSummary]: any[] = await Promise.all([
    readJson(path.join(missionDir, 'subagent-evidence.json'), null).catch(() => null),
    readJson(path.join(missionDir, 'subagent-parent-summary.json'), null).catch(() => null)
  ]);
  const workflowRunId = String(plan.workflow_run_id || '').trim();
  const started = Number(evidence?.started_threads || 0);
  const completed = Number(evidence?.completed_threads || 0);
  const failed = Number(evidence?.failed_threads || 0);
  const target = effectiveSubagentTarget(plan, started);
  const blockers: string[] = [];
  const evidenceShapeValid = evidence?.schema === 'sks.subagent-evidence.v1'
    && evidence?.workflow === 'official_codex_subagent';
  if (!evidenceShapeValid || evidence?.ok !== true || evidence?.status !== 'completed') {
    blockers.push('official_subagent_evidence_missing');
  }
  if (!workflowRunId || String(evidence?.run_id || '').trim() !== workflowRunId) {
    blockers.push('official_subagent_workflow_run_id_mismatch');
  }
  const parentSummaryPresent = evidence?.parent_summary_present === true
    && evidence?.parent_summary_trustworthy === true
    && evidence?.parent_summary_status === 'completed'
    && parentSummary?.schema === 'sks.subagent-parent-summary.v1'
    && parentSummary?.status === 'completed'
    && String(parentSummary?.run_id || '').trim() === workflowRunId;
  if (!parentSummaryPresent) blockers.push('official_subagent_parent_summary_missing');
  if (evidence?.count_policy !== target.countPolicy) blockers.push('official_subagent_count_policy_mismatch');
  if (Number(evidence?.target_subagents || 0) !== target.targetSubagents) blockers.push('official_subagent_target_subagents_mismatch');
  if (started !== target.targetSubagents || completed !== target.targetSubagents) {
    blockers.push('official_subagent_evidence_incomplete');
  }
  if (failed !== 0) blockers.push('official_subagent_failed_threads_present');
  if (Array.isArray(evidence?.open_thread_ids) && evidence.open_thread_ids.length > 0) {
    blockers.push('official_subagent_open_threads_present');
  }
  const uniqueBlockers = [...new Set(blockers)];
  const evidenceReady = uniqueBlockers.length === 0;
  return {
    applied: true,
    gate: {
      ...(gate || {}),
      workflow: 'official_codex_subagent',
      workflow_run_id: workflowRunId || null,
      official_subagent_evidence: evidenceReady,
      subagent_evidence_ready: evidenceReady,
      parent_summary_present: parentSummaryPresent,
      requested_subagents: target.requestedSubagents,
      count_policy: target.countPolicy,
      target_subagents: target.targetSubagents,
      started_subagents: started,
      completed_subagents: completed,
      failed_subagents: failed,
      event_sources: Array.isArray(evidence?.event_sources) ? evidence.event_sources : []
    },
    blockers: uniqueBlockers
  };
}

function appendOfficialSubagentArtifacts(artifacts: any[] = []) {
  const required = [
    'subagent-plan.json',
    'subagent-events.jsonl',
    'subagent-parent-summary.json',
    'subagent-evidence.json'
  ].map((artifactPath) => ({
    path: artifactPath,
    kind: 'agent',
    source: 'real',
    ignoreStale: true
  }));
  const existing = new Set(artifacts.map((artifact: any) => (
    typeof artifact === 'string' ? artifact : artifact?.path
  )).filter(Boolean));
  return [
    ...artifacts,
    ...required.filter((artifact) => !existing.has(artifact.path))
  ];
}
