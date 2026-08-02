import type { ProofLevel } from './fake-real-proof-policy.js';

export const RUNTIME_EVIDENCE_ASSESSMENT_SCHEMA = 'sks.runtime-evidence-assessment.v1';

export type RuntimeEvidenceSource = 'runtime' | 'configured' | 'fixture' | 'mock' | 'static' | 'generated' | 'unknown';
export type RuntimeEvidenceStatus = 'proven' | 'partial' | 'blocked' | 'not_applicable' | 'not_assessed';

export interface RuntimeEvidenceAssessment {
  schema: typeof RUNTIME_EVIDENCE_ASSESSMENT_SCHEMA;
  contract_status: 'valid' | 'invalid' | 'not_assessed';
  runtime_status: RuntimeEvidenceStatus;
  evidence_source: RuntimeEvidenceSource;
  proof_level: ProofLevel;
  working_claim_allowed: boolean;
  receipts: unknown[];
  blockers: string[];
}

export function assessRuntimeEvidence(report: unknown, options: {
  candidateProofLevel?: ProofLevel;
  missingProofLevel?: ProofLevel;
  required?: boolean;
  trustedRuntimeValidator?: boolean;
  trustedArtifacts?: readonly string[];
} = {}): RuntimeEvidenceAssessment {
  const row = record(report);
  const missing = options.missingProofLevel || (options.required ? 'real_required_missing' : 'integration_optional');
  if (!row) {
    return assessment({
      contract_status: 'not_assessed',
      runtime_status: 'not_assessed',
      evidence_source: 'unknown',
      proof_level: missing,
      receipts: [],
      blockers: []
    });
  }

  const candidate = options.candidateProofLevel || normalizedProofLevel(row.proof_level) || missing;
  const source = evidenceSource(row);
  const reportBlockers = stringArray(row.blockers);
  const explicit = explicitRuntimeEnvelope(row);
  const explicitEnvelopeIsDirect = row.schema === 'sks.runtime-evidence.v1';
  const explicitReceipts = array(explicit?.receipts);
  const receiptsValid = explicitReceipts.length > 0 && explicitReceipts.every(validRuntimeReceipt);
  const declaredNonRuntimeSource = ['configured', 'fixture', 'mock', 'static'].includes(source);
  const explicitProven = explicit?.schema === 'sks.runtime-evidence.v1'
    && explicit?.runtime_status === 'proven'
    && explicit?.evidence_source === 'runtime'
    && receiptsValid
    && !declaredNonRuntimeSource
    && (explicitEnvelopeIsDirect || options.trustedRuntimeValidator === true);
  const trustedProven = options.trustedRuntimeValidator === true
    && candidate === 'proven'
    && reportBlockers.length === 0
    && (options.trustedArtifacts?.length || 0) > 0;
  const receipts = explicitProven
    ? explicitReceipts
    : trustedProven
      ? (options.trustedArtifacts || []).map((artifact) => ({ artifact, validated_by: 'domain_runtime_validator' }))
      : [];

  if (reportBlockers.length > 0 || candidate === 'blocked' || reportFailed(row)) {
    return assessment({
      contract_status: 'invalid',
      runtime_status: 'blocked',
      evidence_source: source,
      proof_level: 'blocked',
      receipts,
      blockers: [...reportBlockers, ...(reportBlockers.length ? [] : ['runtime_report_blocked'])]
    });
  }
  if (explicitProven || trustedProven) {
    return assessment({
      contract_status: 'valid',
      runtime_status: 'proven',
      evidence_source: 'runtime',
      proof_level: 'proven',
      receipts,
      blockers: []
    });
  }

  const successClaimed = candidate === 'proven' || reportClaimsRuntimeSuccess(row);
  if (successClaimed) {
    return assessment({
      contract_status: 'valid',
      runtime_status: 'not_assessed',
      evidence_source: source === 'unknown' ? 'generated' : source,
      proof_level: 'blocked',
      receipts: [],
      blockers: ['runtime_success_claim_without_receipt']
    });
  }

  const partial = candidate === 'partial' || candidate === 'fixture_instrumented_real';
  return assessment({
    contract_status: 'valid',
    runtime_status: partial ? 'partial' : 'not_assessed',
    evidence_source: source,
    proof_level: partial ? candidate : missing,
    receipts: [],
    blockers: []
  });
}

export function assessFeatureFixtureDeclaration(fixture: unknown, execution: unknown = null): RuntimeEvidenceAssessment {
  const definition = record(fixture);
  const observed = record(execution);
  if (!definition) {
    return assessment({
      contract_status: 'invalid',
      runtime_status: 'not_assessed',
      evidence_source: 'unknown',
      proof_level: 'blocked',
      receipts: [],
      blockers: ['feature_fixture_contract_missing']
    });
  }
  const source: RuntimeEvidenceSource = definition.kind === 'mock'
    ? 'mock'
    : definition.kind === 'static'
      ? 'static'
      : 'fixture';
  const contractValid = definition.status !== 'missing' && definition.fallback_removed === true;
  const observedBlocked = Boolean(observed && (observed.timed_out === true || Number(observed.status) !== 0));
  return assessment({
    contract_status: contractValid ? 'valid' : 'invalid',
    runtime_status: observedBlocked ? 'blocked' : observed ? 'partial' : 'not_assessed',
    evidence_source: source,
    proof_level: observedBlocked ? 'blocked' : observed ? 'fixture_instrumented_real' : 'fixture_only',
    receipts: [],
    blockers: contractValid ? [] : ['feature_fixture_contract_invalid']
  });
}

function assessment(input: Omit<RuntimeEvidenceAssessment, 'schema' | 'working_claim_allowed'>): RuntimeEvidenceAssessment {
  const blockers = [...new Set(input.blockers.map(String).filter(Boolean))];
  const workingClaimAllowed = input.runtime_status === 'proven'
    && input.evidence_source === 'runtime'
    && input.receipts.length > 0
    && blockers.length === 0;
  return {
    schema: RUNTIME_EVIDENCE_ASSESSMENT_SCHEMA,
    ...input,
    working_claim_allowed: workingClaimAllowed,
    blockers
  };
}

function explicitRuntimeEnvelope(row: Record<string, any>): Record<string, any> | null {
  if (row.schema === 'sks.runtime-evidence.v1') return row;
  return record(row.runtime_evidence) || record(row.runtime_truth);
}

function validRuntimeReceipt(value: unknown) {
  const row = record(value);
  if (!row) return false;
  const observedAt = text(row.observed_at || row.captured_at || row.checked_at);
  const sha = text(row.sha256 || row.digest);
  const artifact = text(row.path || row.artifact);
  const command = text(row.command);
  const exitCode = Number(row.exit_code);
  const observedAtValid = Boolean(observedAt && Number.isFinite(Date.parse(observedAt)));
  const artifactReceipt = Boolean(artifact && /^sha256:[a-f0-9]{64}$|^[a-f0-9]{64}$/i.test(sha) && observedAtValid);
  const commandReceipt = Boolean(command && Number.isFinite(exitCode) && exitCode === 0 && observedAtValid);
  return artifactReceipt || commandReceipt;
}

function reportClaimsRuntimeSuccess(row: Record<string, any>) {
  const status = String(row.runtime_status || row.status || '').toLowerCase();
  return row.ok === true
    || row.passed === true
    || row.working === true
    || ['passed', 'completed', 'verified', 'proven', 'working'].includes(status)
    || row.proof_level === 'proven';
}

function reportFailed(row: Record<string, any>) {
  const status = String(row.runtime_status || row.status || '').toLowerCase();
  if (['not_required', 'not_applicable', 'integration_optional'].includes(status)) return false;
  return row.ok === false || row.passed === false || ['failed', 'blocked', 'error'].includes(status);
}

function evidenceSource(row: Record<string, any>): RuntimeEvidenceSource {
  const explicit = String(row.evidence_source || row.source || row.execution_class || '').toLowerCase();
  if (explicit.includes('mock')) return 'mock';
  if (explicit.includes('fixture')) return 'fixture';
  if (explicit.includes('static') || explicit.includes('readme') || explicit.includes('doc')) return 'static';
  if (explicit.includes('config')) return 'configured';
  if (explicit.includes('runtime') || explicit === 'real') return 'runtime';
  if (text(row.schema) || text(row.generated_at)) return 'generated';
  return 'unknown';
}

function normalizedProofLevel(value: unknown): ProofLevel | null {
  const allowed = new Set<ProofLevel>(['fixture_only', 'fixture_instrumented_real', 'proven', 'integration_optional', 'real_required_missing', 'partial', 'blocked']);
  return allowed.has(String(value) as ProofLevel) ? String(value) as ProofLevel : null;
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function text(value: unknown) {
  return String(value || '').trim();
}
