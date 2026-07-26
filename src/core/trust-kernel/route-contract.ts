import path from 'node:path';
import { writeJsonAtomic } from '../fsx.js';
import { missionDir } from '../mission.js';
import { routeRequiresCompletionProof, routeRequiresImageVoxelAnchors } from '../proof/route-proof-policy.js';
import { rootCauseAnalysisRequired } from '../proof/root-cause-policy.js';
import { ROUTE_COMPLETION_CONTRACT_SCHEMA, normalizeTrustStatus, trustKernelMetadata } from './trust-kernel-schema.js';
import { validateCompletionContract } from './completion-contract.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function routeCompletionContractPath(root: string, missionId: string) {
  return path.join(missionDir(root, missionId), 'route-completion-contract.json');
}

export async function writeRouteCompletionContract(root: string, proof: unknown = {}, evidenceIndex: unknown = {}) {
  const proofRecord = asRecord(proof);
  const contract = buildRouteCompletionContract(proof, evidenceIndex);
  const validation = validateCompletionContract(contract, proof, evidenceIndex);
  const out = { ...contract, validation };
  const missionId = stringOrNull(proofRecord.mission_id);
  if (missionId) await writeJsonAtomic(routeCompletionContractPath(root, missionId), out);
  return out;
}

export function buildRouteCompletionContract(proof: unknown = {}, evidenceIndex: unknown = {}) {
  const proofRecord = asRecord(proof);
  const required = routeRequirements(proofRecord.route, proofRecord);
  const missionId = stringOrNull(proofRecord.mission_id);
  const evidencePaths = evidencePathsForContract(missionId, proof, evidenceIndex, required);
  return {
    schema: ROUTE_COMPLETION_CONTRACT_SCHEMA,
    ...trustKernelMetadata(),
    mission_id: missionId,
    route: stringOrNull(proofRecord.route),
    required,
    evidence: evidencePaths,
    status: normalizeTrustStatus(proofRecord.status)
  };
}

export function routeRequirements(route: unknown, proof: unknown = {}): RouteRequirements {
  const proofRecord = asRecord(proof);
  const evidence = asRecord(proofRecord.evidence);
  const agents = asRecord(evidence.agents);
  return {
    agents: Boolean(agents.schema || agents.ok || agents.status),
    completion_proof: routeRequiresCompletionProof(route),
    image_voxels: routeRequiresImageVoxelAnchors(route),
    db_safety: route === '$DB' || Boolean(evidence.db || evidence.db_safety),
    tests: Boolean(evidence.tests),
    blackbox: JSON.stringify(evidence).includes('blackbox'),
    root_cause_analysis: rootCauseAnalysisRequired(proofRecord)
  };
}

function evidencePathsForContract(missionId: string | null, proof: unknown, evidenceIndex: unknown, required: RouteRequirements) {
  const proofRecord = asRecord(proof);
  const proofEvidence = asRecord(proofRecord.evidence);
  const agents = asRecord(proofEvidence.agents);
  const evidenceIndexRecord = asRecord(evidenceIndex);
  const base = missionId ? `.sneakoscope/missions/${missionId}` : null;
  return {
    agents: base && required.agents ? `${base}/agents/agent-proof-evidence.json` : null,
    proof: base ? `${base}/completion-proof.json` : null,
    image_voxels: required.image_voxels && base ? `${base}/image-voxel-ledger.json` : null,
    tests: pathFromEvidence(proofEvidence.tests),
    db_safety: pathFromEvidence(proofEvidence.db || proofEvidence.db_safety),
    blackbox: pathFromEvidence(proofEvidence.blackbox),
    root_cause_analysis: required.root_cause_analysis && base ? `${base}/completion-proof.json#failure_analysis` : null,
    evidence_index: base ? `${base}/evidence-index.json` : null,
    trust_report: base ? `${base}/trust-report.json` : null,
    evidence_records: asList(evidenceIndexRecord.records).map((entry) => {
      const record = asRecord(entry);
      return { id: record.id, kind: record.kind, path: record.path, trust: record.trust };
    })
  };
}

function pathFromEvidence(value: unknown) {
  const row = Array.isArray(value) ? value.find(Boolean) : value;
  if (!row) return null;
  if (typeof row === 'string') return row;
  const record = asRecord(row);
  return stringOrNull(record.path) || stringOrNull(record.report) || stringOrNull(record.evidence);
}


export interface RouteRequirements {
  completion_proof: boolean;
  evidence_index?: boolean;
  agents?: boolean;
  image_voxels?: boolean;
  db_safety?: boolean;
  tests?: boolean;
  blackbox?: boolean;
  root_cause_analysis?: boolean;
}

export interface RouteCompletionContract {
  schema: typeof ROUTE_COMPLETION_CONTRACT_SCHEMA;
  mission_id: string | null;
  route: string | null;
  required: RouteRequirements;
  evidence: Record<string, unknown>;
  status: import('./trust-kernel-schema.js').TrustStatus;
}
