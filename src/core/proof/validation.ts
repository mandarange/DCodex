import { containsPlaintextSecret } from '../secret-redaction.js';
import { COMPLETION_PROOF_SCHEMA, COMPLETION_PROOF_STATUSES } from './proof-schema.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

export function validateCompletionProof(proof: unknown = {}) {
  const structuralIssues: string[] = [];
  const record = asRecord(proof);
  if (record.schema !== COMPLETION_PROOF_SCHEMA) structuralIssues.push('schema');
  if (!COMPLETION_PROOF_STATUSES.includes(String(record.status))) structuralIssues.push('status');
  if (!['real', 'mock_fixture'].includes(String(record.execution_class))) structuralIssues.push('execution_class');
  if (!record.summary || typeof record.summary !== 'object') structuralIssues.push('summary');
  if (!record.evidence || typeof record.evidence !== 'object') structuralIssues.push('evidence');
  if (!Array.isArray(record.claims)) structuralIssues.push('claims');
  if (!Array.isArray(record.unverified)) structuralIssues.push('unverified');
  if (!Array.isArray(record.blockers)) structuralIssues.push('blockers');
  if (containsPlaintextSecret(proof)) structuralIssues.push('plaintext_secret');
  const semanticIssues: string[] = [];
  if (record.status === 'failed') semanticIssues.push('proof_failed');
  if (record.status === 'verified' && record.execution_class !== 'real') semanticIssues.push('verified_execution_not_real');
  if (record.status === 'verified' && Array.isArray(record.unverified) && record.unverified.length > 0) semanticIssues.push('verified_with_unverified_claims');
  if (record.status === 'verified' && Array.isArray(record.blockers) && record.blockers.length > 0) semanticIssues.push('verified_with_blockers');
  if (record.status === 'verified' && Number(asRecord(record.summary).tests_failed || 0) > 0) semanticIssues.push('verified_with_failed_tests');
  if (record.status === 'mock_only' && record.execution_class !== 'mock_fixture') semanticIssues.push('mock_status_execution_class_mismatch');
  const issues = [...structuralIssues, ...semanticIssues];
  const schemaOk = structuralIssues.length === 0;
  const completionOk = issues.length === 0 && record.execution_class === 'real' && record.status === 'verified';
  return {
    ok: issues.length === 0,
    schema_ok: schemaOk,
    completion_ok: completionOk,
    status: issues.length ? 'failed' : String(record.status || 'not_verified'),
    issues
  };
}
