import type { SksLoopProof } from './loop-schema.js';

export function loopProofCompletionIssues(value: unknown): string[] {
  const proof = asRecord(value) as Partial<SksLoopProof> | null;
  if (!proof) return ['loop_proof_missing'];

  const issues: string[] = [];
  if (proof.schema !== 'sks.loop-proof.v1') issues.push('loop_proof_schema_invalid');
  if (proof.status !== 'completed') issues.push(`loop_proof_status_${String(proof.status || 'missing')}`);
  if (proof.maker_result?.ok !== true) issues.push('loop_maker_unverified');
  if (proof.checker_result?.ok !== true) issues.push('loop_checker_unverified');
  if (proof.gate_result?.ok !== true) issues.push('loop_gate_unverified');
  if (stringArray(proof.checker_result?.blockers).length > 0) issues.push('loop_checker_blockers_present');
  if (stringArray(proof.gate_result?.failed_gates).length > 0) issues.push('loop_failed_gates_present');
  if (stringArray(proof.gate_result?.blockers).length > 0) issues.push('loop_gate_blockers_present');
  if (stringArray(proof.blockers).length > 0) issues.push('loop_proof_blockers_present');
  if (proof.handoff?.required === true) issues.push('loop_handoff_required');
  return [...new Set(issues)];
}

export function loopProofIsVerifiedComplete(value: unknown): value is SksLoopProof {
  return loopProofCompletionIssues(value).length === 0;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
