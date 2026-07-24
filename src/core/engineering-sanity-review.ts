import path from 'node:path';
import { scanCodeStructure } from './code-structure.js';
import { readJson, readText, sha256 } from './fsx.js';
import { missionDir } from './mission.js';

export const ENGINEERING_SANITY_REVIEW_ARTIFACT = 'engineering-sanity-review.json';
export const ENGINEERING_SANITY_REVIEW_SCHEMA = 'sks.engineering-sanity-review.v1';
export const ENGINEERING_SANITY_CODE_STRUCTURE_REPORT = 'code-structure-report.json';

export const ENGINEERING_SANITY_CHECK_IDS = Object.freeze([
  'solid_boundaries',
  'n_plus_one_and_repeated_io',
  'bounded_render_recursion_event_retry_polling',
  'verification_bypass_absent'
] as const);

const FINAL_CHECK_STATUSES = new Set(['passed', 'not_applicable']);

export function createEngineeringSanityReviewSeed(route: any = null, report: any = null, reportText = '') {
  const candidates = engineeringCandidates(report);
  return {
    schema: ENGINEERING_SANITY_REVIEW_SCHEMA,
    passed: false,
    route: route || null,
    changed_files: sortedUniqueStrings(report?.changed_scope?.source_files),
    added_hunks_reviewed: false,
    real_callers_traced: false,
    static_scan_role: 'candidate_detection_only_not_completion_proof',
    code_structure_report: ENGINEERING_SANITY_CODE_STRUCTURE_REPORT,
    code_structure_report_sha256: reportText ? `sha256:${sha256(reportText)}` : null,
    changed_scope_sha256: report ? engineeringScopeHash(report) : null,
    reviewed_candidate_ids: [],
    candidate_dispositions: [],
    checks: Object.fromEntries(ENGINEERING_SANITY_CHECK_IDS.map((id) => [id, {
      status: 'pending',
      reason: null,
      evidence: []
    }])),
    candidate_findings: candidates,
    resolved_findings: [],
    unresolved_findings: [],
    blockers: [],
    notes: []
  };
}

export function validateEngineeringSanityReview(review: any = {}) {
  const blockers: string[] = [];
  if (review?.schema !== ENGINEERING_SANITY_REVIEW_SCHEMA) blockers.push('schema');
  if (review?.passed !== true) blockers.push('passed');
  if (review?.added_hunks_reviewed !== true) blockers.push('added_hunks_reviewed');
  if (review?.real_callers_traced !== true) blockers.push('real_callers_traced');
  if (review?.static_scan_role !== 'candidate_detection_only_not_completion_proof') blockers.push('static_scan_role');
  if (!Array.isArray(review?.changed_files)) blockers.push('changed_files_invalid');
  if (!Array.isArray(review?.candidate_findings)) blockers.push('candidate_findings_invalid');
  if (!Array.isArray(review?.reviewed_candidate_ids)) blockers.push('reviewed_candidate_ids_invalid');
  if (!Array.isArray(review?.candidate_dispositions)) blockers.push('candidate_dispositions_invalid');
  if (!Array.isArray(review?.resolved_findings)) blockers.push('resolved_findings_invalid');
  if (!Array.isArray(review?.unresolved_findings)) blockers.push('unresolved_findings_invalid');
  else if (review.unresolved_findings.length > 0) blockers.push('unresolved_findings');
  if (!Array.isArray(review?.blockers)) blockers.push('blockers_invalid');
  else if (review.blockers.length > 0) blockers.push('blockers');

  for (const id of ENGINEERING_SANITY_CHECK_IDS) {
    const check = review?.checks?.[id];
    const status = String(check?.status || '');
    if (!FINAL_CHECK_STATUSES.has(status)) {
      blockers.push(`checks:${id}:status`);
      continue;
    }
    if (!Array.isArray(check?.evidence) || check.evidence.length === 0 || check.evidence.some((item: any) => typeof item !== 'string' || !item.trim())) {
      blockers.push(`checks:${id}:evidence`);
    }
    if (status === 'not_applicable' && (typeof check?.reason !== 'string' || !check.reason.trim())) {
      blockers.push(`checks:${id}:reason`);
    }
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function validateEngineeringSanityReviewArtifact(root: string, missionId: string, review: any = {}) {
  const basic = validateEngineeringSanityReview(review);
  const blockers = [...basic.blockers];
  if (review?.code_structure_report !== ENGINEERING_SANITY_CODE_STRUCTURE_REPORT) blockers.push('code_structure_report');
  const reportFile = path.join(missionDir(root, missionId), ENGINEERING_SANITY_CODE_STRUCTURE_REPORT);
  const persistedText = await readText(reportFile, '');
  const persisted = persistedText ? await readJson(reportFile, null) : null;
  if (persisted?.schema_version !== 1) blockers.push(`${ENGINEERING_SANITY_CODE_STRUCTURE_REPORT}:schema_version`);
  if (String(review?.code_structure_report_sha256 || '') !== `sha256:${sha256(persistedText)}`) blockers.push('code_structure_report_sha256');

  const fresh = await scanCodeStructure(root, { changed: true, includeOk: true });
  const freshScopeHash = engineeringScopeHash(fresh);
  if (review?.changed_scope_sha256 !== freshScopeHash) blockers.push('changed_scope_sha256');
  if (engineeringScopeHash(persisted) !== freshScopeHash) blockers.push(`${ENGINEERING_SANITY_CODE_STRUCTURE_REPORT}:stale_changed_scope`);

  const freshChangedFiles = sortedUniqueStrings(fresh?.changed_scope?.source_files);
  if (JSON.stringify(sortedUniqueStrings(review?.changed_files)) !== JSON.stringify(freshChangedFiles)) blockers.push('changed_files');
  const freshCandidates = engineeringCandidates(fresh);
  const freshCandidateIds = freshCandidates.map((candidate: any) => candidate.id).sort();
  const persistedCandidateIds = engineeringCandidates(persisted).map((candidate: any) => candidate.id).sort();
  if (JSON.stringify(persistedCandidateIds) !== JSON.stringify(freshCandidateIds)) blockers.push(`${ENGINEERING_SANITY_CODE_STRUCTURE_REPORT}:stale_candidates`);
  if (JSON.stringify(sortedUniqueStrings(review?.reviewed_candidate_ids)) !== JSON.stringify(freshCandidateIds)) blockers.push('reviewed_candidate_ids');
  if (JSON.stringify(candidateFindingIds(review?.candidate_findings)) !== JSON.stringify(freshCandidateIds)) blockers.push('candidate_findings');

  const dispositions = Array.isArray(review?.candidate_dispositions) ? review.candidate_dispositions : [];
  const dispositionIds = sortedUniqueStrings(dispositions.map((row: any) => row?.candidate_id));
  if (JSON.stringify(dispositionIds) !== JSON.stringify(freshCandidateIds)) blockers.push('candidate_dispositions');
  const freshCandidatesById = new Map(freshCandidates.map((candidate: any) => [candidate.id, candidate]));
  for (const row of dispositions) {
    if (!['resolved', 'false_positive'].includes(String(row?.status || ''))) blockers.push('candidate_dispositions:status');
    if (typeof row?.reason !== 'string' || !row.reason.trim()) blockers.push('candidate_dispositions:reason');
    if (!Array.isArray(row?.evidence) || row.evidence.length === 0 || row.evidence.some((item: any) => typeof item !== 'string' || !item.trim())) blockers.push('candidate_dispositions:evidence');
    const candidate: any = freshCandidatesById.get(String(row?.candidate_id || ''));
    if (!candidate || String(row?.source_scope || '') !== String(candidate?.source_scope || '')) blockers.push('candidate_dispositions:source_scope');
    if (JSON.stringify(normalizeLineRanges(row?.added_hunk_line_ranges)) !== JSON.stringify(normalizeLineRanges(candidate?.added_hunk_line_ranges))) {
      blockers.push('candidate_dispositions:added_hunk_line_ranges');
    }
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], report: fresh };
}

export function engineeringScopeHash(report: any = {}) {
  const scope = report?.changed_scope || {};
  return `sha256:${sha256(JSON.stringify({
    mode: scope.mode || null,
    base: scope.base || null,
    changed_files: sortedUniqueStrings(scope.changed_files),
    source_files: sortedUniqueStrings(scope.source_files),
    entries: Array.isArray(scope.entries)
      ? scope.entries
          .map((entry: any) => ({
            path: String(entry?.path || ''),
            status: String(entry?.status || ''),
            lines_added: Number(entry?.lines_added || 0),
            lines_deleted: Number(entry?.lines_deleted || 0),
            source_sha256: typeof entry?.source_sha256 === 'string' ? entry.source_sha256 : null
          }))
          .sort((left: any, right: any) => left.path.localeCompare(right.path))
      : []
  }))}`;
}

function engineeringCandidates(report: any = {}) {
  const tags = new Set(['solid', 'n-plus-one', 'unbounded-loop', 'verification-bypass', 'db-pool', 'transaction']);
  return (Array.isArray(report?.semantic_review?.findings) ? report.semantic_review.findings : [])
    .filter((finding: any) => tags.has(String(finding?.tag || '')) && typeof finding?.id === 'string' && finding.id)
    .sort((left: any, right: any) => left.id.localeCompare(right.id));
}

function candidateFindingIds(value: any) {
  return sortedUniqueStrings(Array.isArray(value) ? value.map((row: any) => row?.id || row?.candidate_id) : []);
}

function sortedUniqueStrings(value: any) {
  return [...new Set(Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [])].sort();
}

function normalizeLineRanges(value: any) {
  return (Array.isArray(value) ? value : [])
    .map((row: any) => ({ start: Number(row?.start || 0), end: Number(row?.end || 0) }))
    .filter((row: any) => Number.isInteger(row.start) && Number.isInteger(row.end) && row.start > 0 && row.end >= row.start)
    .sort((left: any, right: any) => left.start - right.start || left.end - right.end);
}
