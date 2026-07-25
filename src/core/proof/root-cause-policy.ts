import { asRecordOrEmpty as asRecord } from '../json/records.js';
type JsonRecord = Record<string, unknown>;

const PROBLEM_PATTERN = /\b(fallback|workaround|bypass|temporary|synthetic|stale|missing|failed|failure|error|blocked|not_ok|not ok|fixture_child_missing|native_agent_proof_false)\b/i;
const COMPLETE_STATUSES = new Set(['complete', 'completed', 'corrected', 'resolved', 'fixed']);
const BLOCKING_STATUSES = new Set(['blocked', 'failed', 'not_verified']);

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function meaningfulString(value: unknown, minLength = 12): boolean {
  return typeof value === 'string' && value.trim().length >= minLength;
}

function hasEvidence(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length >= 6;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

export function rootCauseAnalysisRequired(proof: unknown = {}, validationIssues: unknown[] = []): boolean {
  const proofRecord = asRecord(proof);
  if (!Object.keys(proofRecord).length) return false;
  const evidence = asRecord(proofRecord.evidence);
  const agents = asRecord(evidence.agents);
  const routeGate = asRecord(evidence.route_gate);
  if (BLOCKING_STATUSES.has(String(proofRecord.status || ''))) return true;
  if (asList(proofRecord.blockers).length > 0) return true;
  if (validationIssues.some((issue) => String(issue) !== 'root_cause_analysis_missing')) return true;
  const problemSurface = {
    status: proofRecord.status,
    unverified: proofRecord.unverified,
    blockers: proofRecord.blockers,
    claims: proofRecord.claims,
    route_gate: routeGate,
    agents: {
      ok: agents.ok,
      status: agents.status,
      blockers: agents.blockers,
      issues: agents.issues
    },
    wrongness: evidence.wrongness,
    trust_report: evidence.trust_report
  };
  return PROBLEM_PATTERN.test(JSON.stringify(problemSurface));
}

export function rootCauseAnalysisComplete(proof: unknown = {}): boolean {
  const proofRecord = asRecord(proof);
  const analysis = asRecord(proofRecord.failure_analysis || asRecord(proofRecord.evidence).root_cause_analysis);
  if (!Object.keys(analysis).length) return false;
  const status = String(analysis.status || '').toLowerCase();
  if (!COMPLETE_STATUSES.has(status)) return false;
  const rootCause = analysis.root_cause ?? analysis.cause;
  const correctiveAction = analysis.corrective_action ?? analysis.fix ?? analysis.correction;
  const evidence = analysis.evidence ?? analysis.proof ?? analysis.references;
  return meaningfulString(rootCause) && meaningfulString(correctiveAction) && hasEvidence(evidence);
}

export function rootCauseAnalysisIssue(proof: unknown = {}, validationIssues: unknown[] = []): string | null {
  if (!rootCauseAnalysisRequired(proof, validationIssues)) return null;
  return rootCauseAnalysisComplete(proof) ? null : 'root_cause_analysis_missing';
}
