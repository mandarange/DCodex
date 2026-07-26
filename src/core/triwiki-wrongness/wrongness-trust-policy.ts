import type { TrustStatus } from '../trust-kernel/trust-kernel-schema.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

export function evaluateWrongnessTrust(input: unknown = {}): {
  ok: boolean;
  status: TrustStatus;
  issues: string[];
  summary: JsonRecord;
} {
  const row = asRecord(input);
  const proof = asRecord(row.proof ?? input);
  const evidence = asRecord(asRecord(proof.evidence).wrongness ?? row.wrongness);
  const activeCount = numberValue(evidence.active_count);
  const high = numberValue(evidence.high_severity_active);
  const medium = numberValue(evidence.medium_severity_active);
  const referenceOnlyPartial = imageUxReferenceOnlyPartial(proof);
  const issues: string[] = [];
  if (high > 0 && !referenceOnlyPartial) issues.push('wrongness:active_high_severity_negative_evidence');
  if (activeCount > 0 && missingCorrectiveAction(evidence)) issues.push('wrongness:corrective_action_missing');
  if (claimLinksActiveWrongness(proof, evidence)) issues.push('wrongness:claim_linked_to_active_wrongness');
  const status: TrustStatus = high > 0 && !referenceOnlyPartial
    ? 'blocked'
    : activeCount > 0 || medium > 0
      ? 'verified_partial'
      : 'verified';
  return {
    ok: issues.length === 0,
    status,
    issues,
    summary: {
      schema: 'sks.triwiki-wrongness-trust-impact.v1',
      active_count: activeCount,
      high_severity_active: high,
      medium_severity_active: medium,
      active_ids: asStringList(evidence.active_ids),
      avoidance_rules: Array.isArray(evidence.avoidance_rules) ? evidence.avoidance_rules : [],
      records: Array.isArray(evidence.records) ? evidence.records : []
    }
  };
}

function imageUxReferenceOnlyPartial(proof: JsonRecord): boolean {
  const imageUxReview = asRecord(asRecord(proof.evidence).image_ux_review);
  return proof.status === 'verified_partial'
    && imageUxReview.reference_only === true
    && imageUxReview.status === 'verified_partial';
}

export function applyWrongnessTrustStatus(base: TrustStatus, impact: { status?: TrustStatus; issues?: unknown[] }): TrustStatus {
  const impactStatus = impact.status || 'verified';
  if (base === 'blocked' || impactStatus === 'blocked') return 'blocked';
  if (base === 'failed' || impactStatus === 'failed') return 'failed';
  if (base === 'not_verified' || impactStatus === 'not_verified') return 'not_verified';
  if (base === 'mock_only' || impactStatus === 'mock_only') return 'mock_only';
  if (base === 'verified_partial' || impactStatus === 'verified_partial' || (impact.issues || []).length) return 'verified_partial';
  return 'verified';
}

function missingCorrectiveAction(evidence: JsonRecord): boolean {
  const records = Array.isArray(evidence.records) ? evidence.records : [];
  return records.some((record) => {
    const row = asRecord(record);
    const text = String(row.avoidance_rule || row.corrective_action || '').trim();
    return !text;
  });
}

function claimLinksActiveWrongness(proof: JsonRecord, evidence: JsonRecord): boolean {
  const activeIds = new Set(asStringList(evidence.active_ids));
  if (!activeIds.size) return false;
  const claims = Array.isArray(proof.claims) ? proof.claims : [];
  return claims.some((claim) => {
    const wrongness = asStringList(asRecord(claim).wrongness);
    return wrongness.some((id) => activeIds.has(id));
  });
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
