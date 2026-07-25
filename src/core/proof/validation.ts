import { containsPlaintextSecret } from '../secret-redaction.js';
import { COMPLETION_PROOF_SCHEMA, COMPLETION_PROOF_STATUSES } from './proof-schema.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

export function validateCompletionProof(proof: unknown = {}) {
  const issues: string[] = [];
  const record = asRecord(proof);
  if (record.schema !== COMPLETION_PROOF_SCHEMA) issues.push('schema');
  if (!COMPLETION_PROOF_STATUSES.includes(String(record.status))) issues.push('status');
  if (!['real', 'mock_fixture'].includes(String(record.execution_class))) issues.push('execution_class');
  if (!record.summary || typeof record.summary !== 'object') issues.push('summary');
  if (!record.evidence || typeof record.evidence !== 'object') issues.push('evidence');
  if (!Array.isArray(record.claims)) issues.push('claims');
  if (!Array.isArray(record.unverified)) issues.push('unverified');
  if (!Array.isArray(record.blockers)) issues.push('blockers');
  if (containsPlaintextSecret(proof)) issues.push('plaintext_secret');
  if (record.status === 'failed') issues.push('proof_failed');
  return {
    ok: issues.length === 0,
    status: issues.length ? 'failed' : String(record.status || 'not_verified'),
    issues
  };
}
