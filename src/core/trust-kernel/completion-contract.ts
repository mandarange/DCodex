import { validateCompletionProof } from '../proof/validation.js';
import { rootCauseAnalysisIssue } from '../proof/root-cause-policy.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function validateCompletionContract(contract: unknown = {}, proof: unknown = {}, evidenceIndex: unknown = {}) {
  const issues: string[] = [];
  const contractRecord = asRecord(contract);
  const proofRecord = asRecord(proof);
  const evidenceIndexRecord = asRecord(evidenceIndex);
  const required = asRecord(contractRecord.required);
  if (contractRecord.schema !== 'sks.route-completion-contract.v1') issues.push('contract_schema');
  if (required.completion_proof && proofRecord.schema !== 'sks.completion-proof.v1') issues.push('completion_proof_missing');
  const proofValidation = validateCompletionProof(proofRecord);
  if (required.completion_proof && !proofValidation.ok) issues.push(...proofValidation.issues.map((issue) => `proof:${issue}`));
  if (required.completion_proof && proofRecord.status === 'not_verified') issues.push('completion_proof_not_verified');
  if (required.image_voxels && !imageVoxelEvidenceOk(proof, evidenceIndex)) issues.push('image_voxel_anchor_missing');
  if (required.db_safety && !dbEvidenceOk(proof, evidenceIndex)) issues.push('db_safety_evidence_missing');
  const proofEvidence = asRecord(proofRecord.evidence);
  const agents = asRecord(proofEvidence.agents);
  if (required.agents && (agents.ok !== true || agents.status !== 'passed')) issues.push('agent_gate_not_passed');
  if (evidenceIndexRecord.status === 'blocked') issues.push(...asList(evidenceIndexRecord.issues).map((issue) => `evidence:${String(issue)}`));
  if (proofRecord.status === 'verified' && mockOrStaticEvidence(evidenceIndex)) issues.push('mock_or_static_evidence_cannot_verify_real_status');
  if (runtimeRoute(proofRecord.route || contractRecord.route) && staticContractEvidence(evidenceIndex)) issues.push('static_contract_evidence_for_runtime_route');
  const wrongness = asRecord(proofEvidence.wrongness);
  const activeWrongness = Number(wrongness.active_count || 0);
  const highWrongness = Number(wrongness.high_severity_active || 0);
  const referenceOnlyPartial = imageUxReferenceOnlyPartial(proofRecord);
  if (highWrongness > 0 && !referenceOnlyPartial) issues.push('active_wrongness_high');
  if (proofRecord.status === 'verified' && activeWrongness > 0) issues.push('active_wrongness_requires_verified_partial');
  if (claimLinksActiveWrongness(proofRecord, wrongness)) issues.push('claim_linked_to_active_wrongness');
  const rootCauseIssue = rootCauseAnalysisIssue(proofRecord, issues);
  if (rootCauseIssue) issues.push(rootCauseIssue);
  const status = typeof proofRecord.status === 'string'
    ? proofRecord.status
    : typeof contractRecord.status === 'string'
      ? contractRecord.status
      : 'not_verified';
  return {
    ok: issues.length === 0,
    status: issues.length ? 'blocked' : status,
    issues: [...new Set(issues)]
  };
}

function imageUxReferenceOnlyPartial(proofRecord: JsonRecord) {
  const evidence = asRecord(proofRecord.evidence);
  const imageUxReview = asRecord(evidence.image_ux_review);
  return proofRecord.status === 'verified_partial'
    && imageUxReview.reference_only === true
    && imageUxReview.status === 'verified_partial';
}

function claimLinksActiveWrongness(proofRecord: JsonRecord, wrongness: JsonRecord) {
  const activeIds = new Set(asList(wrongness.active_ids).map((item) => String(item)));
  if (!activeIds.size) return false;
  return asList(proofRecord.claims).some((claim) => {
    const row = asRecord(claim);
    return asList(row.wrongness).some((id) => activeIds.has(String(id)));
  });
}

function imageVoxelEvidenceOk(proof: unknown = {}, evidenceIndex: unknown = {}) {
  const proofRecord = asRecord(proof);
  const proofEvidence = asRecord(proofRecord.evidence);
  const summary = asRecord(proofEvidence.image_voxels);
  const anchors = Number(summary.anchor_count ?? summary.anchors ?? 0);
  if (anchors > 0) return true;
  const evidenceIndexRecord = asRecord(evidenceIndex);
  return asList(evidenceIndexRecord.records).some((entry) => {
    const record = asRecord(entry);
    return record.kind === 'image_voxel' && record.trust !== 'blocked';
  });
}

function dbEvidenceOk(proof: unknown = {}, evidenceIndex: unknown = {}) {
  const proofRecord = asRecord(proof);
  const proofEvidence = asRecord(proofRecord.evidence);
  if (proofEvidence.db || proofEvidence.db_safety) return true;
  const evidenceIndexRecord = asRecord(evidenceIndex);
  return asList(evidenceIndexRecord.records).some((entry) => {
    const record = asRecord(entry);
    return record.kind === 'db_safety' && record.trust !== 'blocked';
  });
}

function mockOrStaticEvidence(evidenceIndex: unknown = {}) {
  const evidenceIndexRecord = asRecord(evidenceIndex);
  return asList(evidenceIndexRecord.records).some((entry) => {
    const record = asRecord(entry);
    return record.source === 'mock' || record.source === 'static_contract';
  });
}

function staticContractEvidence(evidenceIndex: unknown = {}) {
  const evidenceIndexRecord = asRecord(evidenceIndex);
  return asList(evidenceIndexRecord.records).some((entry) => asRecord(entry).source === 'static_contract');
}

function runtimeRoute(route: unknown = '') {
  return /^\$(Naruto|QA-LOOP|Research|Image-UX-Review|DB|PPT|GX|Computer-Use|CU|Wiki)$/i.test(String(route || ''));
}
