import { nowIso, randomId, sha256 } from '../fsx.js';
import { moduleIdsForPath } from '../triwiki/triwiki-module-card.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

export const WRONGNESS_RECORD_SCHEMA = 'sks.triwiki-wrongness.v1';
export const WRONGNESS_LEDGER_SCHEMA = 'sks.triwiki-wrongness-ledger.v1';
export const WRONGNESS_INDEX_SCHEMA = 'sks.triwiki-wrongness-index.v1';
export const WRONGNESS_CONTEXT_SCHEMA = 'sks.triwiki-wrongness-context.v1';

export const WRONGNESS_KINDS = Object.freeze([
  'incorrect_claim',
  'overconfident_claim',
  'stale_evidence',
  'missing_evidence',
  'test_failure',
  'route_misclassification',
  'agent_output_error',
  'visual_anchor_error',
  'image_bbox_error',
  'db_safety_false_positive',
  'db_safety_false_negative',
  'hook_policy_mismatch',
  'hook_semantic_mismatch',
  'hook_strict_subset_misclassified',
  'codex_lb_health_misread',
  'codex_lb_missing_env_raw_message',
  'codex_lb_setup_choice_drift',
  'codex_lb_env_persistence_failure',
  'computer_use_policy_misclassification',
  'computer_use_live_smoke_mismatch',
  'computer_use_external_block_overclaimed',
  'mock_real_confusion',
  'user_intent_misread',
  'artifact_schema_error',
  'trust_status_overclaim',
  'ux_review_text_only_fallback',
  'ux_generated_image_not_real',
  'ux_fake_generic_callout_detected',
  'ux_callout_ocr_uncertain',
  'gpt_image_2_callout_generation_failed',
  'callout_extraction_schema_failed',
  'callout_bbox_out_of_bounds',
  'ux_patch_applied_without_recheck',
  'ux_after_recheck_regression',
  'ux_image_fidelity_mismatch',
  'ux_output_schema_unavailable_fallback',
  'fix_loop_noop_patch',
  'visual_fix_not_rechecked',
  'post_fix_regression_detected',
  'ppt_text_only_review_fallback',
  'ppt_slide_export_failed',
  'ppt_imagegen_callout_generation_failed',
  'ppt_slide_callout_extraction_failed',
  'ppt_slide_bbox_out_of_bounds',
  'ppt_deck_patch_noop',
  'ppt_fix_not_reexported',
  'ppt_slide_not_rechecked',
  'ppt_post_fix_regression_detected',
  'dfix_diagnosis_missing',
  'dfix_root_cause_missing',
  'dfix_patch_plan_missing',
  'dfix_verification_missing',
  'dfix_noop_patch',
  'mad_sks_protected_core_write_attempt',
  'mad_sks_symlink_escape_attempt',
  'mad_sks_unapproved_system_access',
  'mad_sks_missing_rollback_plan',
  'mad_sks_secret_leak_detected',
  'mad_sks_unverified_system_change',
  'mad_sks_db_write_without_snapshot',
  'mad_sks_service_control_without_previous_state',
  'repeated_blocker_stop'
] as const);

export const WRONGNESS_ROOT_CAUSES = Object.freeze([
  'insufficient_test_coverage',
  'stale_context',
  'bad_source',
  'ambiguous_user_request',
  'missing_visual_evidence',
  'missing_db_policy',
  'mock_evidence_overweight',
  'schema_validation_gap',
  'route_policy_gap',
  'agent_reasoning_error',
  'tool_failure',
  'package_boundary_error',
  'performance_timeout',
  'human_review_required',
  'unknown'
] as const);

export const WRONGNESS_STATUSES = Object.freeze([
  'active',
  'resolved',
  'superseded',
  'ignored',
  'false_alarm'
] as const);

export const WRONGNESS_TRUTH_STATUSES = Object.freeze([
  'wrong',
  'uncertain',
  'stale',
  'superseded',
  'corrected'
] as const);

export const WRONGNESS_SEVERITIES = Object.freeze([
  'low',
  'medium',
  'high',
  'critical'
] as const);

export type WrongnessKind = typeof WRONGNESS_KINDS[number];
export type WrongnessRootCause = typeof WRONGNESS_ROOT_CAUSES[number];
export type WrongnessStatus = typeof WRONGNESS_STATUSES[number];
export type WrongnessTruthStatus = typeof WRONGNESS_TRUTH_STATUSES[number];
export type WrongnessSeverity = typeof WRONGNESS_SEVERITIES[number];

export interface WrongnessClaim {
  id: string | null;
  text: string;
  prior_status: string | null;
  linked_claim_ids: string[];
}

export interface WrongnessDetectedBy {
  source: string;
  artifact: string | null;
  command: string | null;
  detail: string | null;
}

export interface WrongnessRootCauseDetail {
  category: WrongnessRootCause;
  explanation: string;
  contributing_factors: string[];
}

export interface WrongnessCorrectiveAction {
  summary: string;
  required_evidence: string[];
  patch_status: string;
}

export interface WrongnessAvoidanceRule {
  id: string;
  text: string;
  applies_to: string[];
  severity: WrongnessSeverity;
}

export interface WrongnessCorrection {
  summary: string | null;
  corrected_anchor: unknown | null;
  corrected_claim: string | null;
}

export interface WrongnessLinks {
  proof_ids: string[];
  evidence_ids: string[];
  files: string[];
  tests: string[];
  artifacts: string[];
  supersedes: string[];
}

export interface WrongnessRecord {
  schema: typeof WRONGNESS_RECORD_SCHEMA;
  id: string;
  mission_id: string | null;
  route: string | null;
  created_at: string;
  updated_at: string;
  status: WrongnessStatus;
  memory_role: 'negative_evidence';
  truth_status: WrongnessTruthStatus;
  wrongness_kind: WrongnessKind;
  severity: WrongnessSeverity;
  claim: WrongnessClaim;
  detected_by: WrongnessDetectedBy;
  root_cause: WrongnessRootCauseDetail;
  corrective_action: WrongnessCorrectiveAction;
  avoidance_rule: WrongnessAvoidanceRule;
  correction: WrongnessCorrection;
  links: WrongnessLinks;
  /** Optional (backward-compatible): TriWiki module ids this wrongness touches,
   * derived from links.files. Lets attention surface a "frequently-wrong module"
   * signal on that module's code-pack entry. Omitted when no file maps to a known
   * module (i.e. moduleIdsForPath returns only 'unknown'). */
  module_ids?: string[];
  rule_compiled?: boolean;
  compiled_rule_id?: string | null;
}

export interface WrongnessLedger {
  schema: typeof WRONGNESS_LEDGER_SCHEMA;
  generated_at: string;
  scope: 'project' | 'mission';
  mission_id: string | null;
  records: WrongnessRecord[];
}

export function wrongnessId(kind: unknown = 'wrongness'): string {
  const slug = slugify(String(kind || 'wrongness')).toUpperCase();
  return `WRONG-${slug || 'ISSUE'}-${randomId(8)}`;
}

export function deterministicWrongnessId(parts: readonly unknown[]): string {
  const digest = sha256(JSON.stringify(parts)).slice(0, 12).toUpperCase();
  return `WRONG-${digest}`;
}

export function createWrongnessRecord(input: unknown = {}): WrongnessRecord {
  const row = asRecord(input);
  const kind = normalizeWrongnessKind(row.wrongness_kind ?? row.kind);
  const rootCause = normalizeRootCause(row.root_cause);
  const severity = normalizeSeverity(row.severity ?? asRecord(row.avoidance_rule).severity ?? severityForKind(kind));
  const timestamp = stringOrNull(row.created_at) || nowIso();
  const claim = normalizeClaim(row.claim, row);
  const avoidanceText = stringOrNull(asRecord(row.avoidance_rule).text)
    || stringOrNull(row.avoidance_rule)
    || defaultAvoidanceRule(kind, claim.text);
  const links = normalizeLinks(row.links);
  const moduleIds = moduleIdsForWrongness(links.files);
  return {
    schema: WRONGNESS_RECORD_SCHEMA,
    id: stringOrNull(row.id) || wrongnessId(kind),
    mission_id: stringOrNull(row.mission_id),
    route: stringOrNull(row.route),
    created_at: timestamp,
    updated_at: stringOrNull(row.updated_at) || timestamp,
    status: normalizeStatus(row.status),
    memory_role: 'negative_evidence',
    truth_status: normalizeTruthStatus(row.truth_status),
    wrongness_kind: kind,
    severity,
    claim,
    detected_by: normalizeDetectedBy(row.detected_by, row),
    root_cause: rootCause,
    corrective_action: normalizeCorrectiveAction(row.corrective_action),
    avoidance_rule: normalizeAvoidanceRule(row.avoidance_rule, kind, avoidanceText, severity),
    correction: normalizeCorrection(row.correction ?? row.corrected_anchor),
    links,
    ...(moduleIds.length ? { module_ids: moduleIds } : (Array.isArray((row as JsonRecord).module_ids) ? { module_ids: stringList((row as JsonRecord).module_ids) } : {})),
    ...(row.rule_compiled === undefined ? {} : { rule_compiled: Boolean(row.rule_compiled) }),
    ...(row.compiled_rule_id === undefined ? {} : { compiled_rule_id: stringOrNull(row.compiled_rule_id) })
  };
}

/** Best-effort module attribution from the wrongness's linked files. Excludes the
 * 'unknown' sentinel moduleIdsForPath returns for unmapped paths, so a record only
 * carries module_ids when at least one file maps to a real TriWiki module. */
function moduleIdsForWrongness(files: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const file of files) {
    for (const id of moduleIdsForPath(String(file || ''))) {
      if (id && id !== 'unknown') ids.add(id);
    }
  }
  return [...ids];
}

export function emptyWrongnessLedger(scope: 'project' | 'mission' = 'project', missionId: string | null = null): WrongnessLedger {
  return {
    schema: WRONGNESS_LEDGER_SCHEMA,
    generated_at: nowIso(),
    scope,
    mission_id: missionId,
    records: []
  };
}

export function validateWrongnessRecord(record: unknown): { ok: boolean; issues: string[] } {
  const row = asRecord(record);
  const issues: string[] = [];
  if (row.schema !== WRONGNESS_RECORD_SCHEMA) issues.push('schema');
  if (!stringOrNull(row.id)) issues.push('id');
  if (!isOneOf(WRONGNESS_STATUSES, row.status)) issues.push('status');
  if (row.memory_role !== 'negative_evidence') issues.push('memory_role');
  if (!isOneOf(WRONGNESS_TRUTH_STATUSES, row.truth_status)) issues.push('truth_status');
  if (!isOneOf(WRONGNESS_KINDS, row.wrongness_kind)) issues.push('wrongness_kind');
  if (!isOneOf(WRONGNESS_SEVERITIES, row.severity)) issues.push('severity');
  const claim = asRecord(row.claim);
  if (!stringOrNull(claim.text)) issues.push('claim.text');
  const rootCause = asRecord(row.root_cause);
  if (!isOneOf(WRONGNESS_ROOT_CAUSES, rootCause.category)) issues.push('root_cause.category');
  if (!stringOrNull(rootCause.explanation)) issues.push('root_cause.explanation');
  const action = asRecord(row.corrective_action);
  if (!stringOrNull(action.summary)) issues.push('corrective_action.summary');
  const rule = asRecord(row.avoidance_rule);
  if (!stringOrNull(rule.text)) issues.push('avoidance_rule.text');
  return { ok: issues.length === 0, issues };
}

export function validateWrongnessLedger(ledger: unknown): { ok: boolean; issues: string[]; checked: number } {
  const row = asRecord(ledger);
  const issues: string[] = [];
  if (row.schema !== WRONGNESS_LEDGER_SCHEMA) issues.push('schema');
  const records = asList(row.records);
  const ids = new Set<string>();
  for (const record of records) {
    const id = stringOrNull(asRecord(record).id);
    if (id && ids.has(id)) issues.push(`duplicate_id:${id}`);
    if (id) ids.add(id);
    const validation = validateWrongnessRecord(record);
    for (const issue of validation.issues) issues.push(`${id || 'unknown'}:${issue}`);
  }
  return { ok: issues.length === 0, issues, checked: records.length };
}

export function normalizeWrongnessKind(value: unknown): WrongnessKind {
  return isOneOf(WRONGNESS_KINDS, value) ? value : 'incorrect_claim';
}

export function normalizeRootCauseKind(value: unknown): WrongnessRootCause {
  return isOneOf(WRONGNESS_ROOT_CAUSES, value) ? value : 'unknown';
}

export function normalizeSeverity(value: unknown): WrongnessSeverity {
  return isOneOf(WRONGNESS_SEVERITIES, value) ? value : 'medium';
}

export function severityForRecord(record: unknown): WrongnessSeverity {
  return normalizeSeverity(asRecord(record).severity ?? asRecord(asRecord(record).avoidance_rule).severity);
}

function normalizeStatus(value: unknown): WrongnessStatus {
  return isOneOf(WRONGNESS_STATUSES, value) ? value : 'active';
}

function normalizeTruthStatus(value: unknown): WrongnessTruthStatus {
  return isOneOf(WRONGNESS_TRUTH_STATUSES, value) ? value : 'wrong';
}

function normalizeClaim(value: unknown, fallback: JsonRecord): WrongnessClaim {
  const row = asRecord(value);
  return {
    id: stringOrNull(row.id) || stringOrNull(fallback.claim_id),
    text: stringOrNull(row.text) || stringOrNull(row.claim) || stringOrNull(fallback.text) || stringOrNull(fallback.claim) || 'Unspecified wrongness claim',
    prior_status: stringOrNull(row.prior_status) || stringOrNull(fallback.prior_status),
    linked_claim_ids: stringList(row.linked_claim_ids ?? fallback.linked_claim_ids)
  };
}

function normalizeDetectedBy(value: unknown, fallback: JsonRecord): WrongnessDetectedBy {
  const row = asRecord(value);
  return {
    source: stringOrNull(row.source) || stringOrNull(fallback.source) || 'manual',
    artifact: stringOrNull(row.artifact) || stringOrNull(fallback.artifact),
    command: stringOrNull(row.command) || stringOrNull(fallback.command),
    detail: stringOrNull(row.detail) || stringOrNull(fallback.detail) || stringOrNull(fallback.reason)
  };
}

function normalizeRootCause(value: unknown): WrongnessRootCauseDetail {
  const row = asRecord(value);
  const category = normalizeRootCauseKind(row.category ?? row.kind);
  return {
    category,
    explanation: stringOrNull(row.explanation) || stringOrNull(row.reason) || category.replace(/_/g, ' '),
    contributing_factors: stringList(row.contributing_factors)
  };
}

function normalizeCorrectiveAction(value: unknown): WrongnessCorrectiveAction {
  const row = asRecord(value);
  return {
    summary: stringOrNull(row.summary) || stringOrNull(row.action) || 'Re-check the claim against current source evidence before relying on it again.',
    required_evidence: stringList(row.required_evidence),
    patch_status: stringOrNull(row.patch_status) || 'pending'
  };
}

function normalizeAvoidanceRule(value: unknown, kind: WrongnessKind, text: string, severity: WrongnessSeverity): WrongnessAvoidanceRule {
  const row = asRecord(value);
  return {
    id: stringOrNull(row.id) || `avoid-${slugify(kind)}`,
    text,
    applies_to: stringList(row.applies_to).length ? stringList(row.applies_to) : [kind],
    severity
  };
}

function normalizeLinks(value: unknown): WrongnessLinks {
  const row = asRecord(value);
  return {
    proof_ids: stringList(row.proof_ids),
    evidence_ids: stringList(row.evidence_ids),
    files: stringList(row.files),
    tests: stringList(row.tests),
    artifacts: stringList(row.artifacts),
    supersedes: stringList(row.supersedes)
  };
}

function normalizeCorrection(value: unknown): WrongnessCorrection {
  const row = asRecord(value);
  const correctedAnchor = row.corrected_anchor ?? (Object.keys(row).length ? row : null);
  return {
    summary: stringOrNull(row.summary),
    corrected_anchor: correctedAnchor || null,
    corrected_claim: stringOrNull(row.corrected_claim)
  };
}

function defaultAvoidanceRule(kind: WrongnessKind, claimText: string): string {
  if (kind === 'mock_real_confusion') return 'Do not upgrade mock, fixture, or static evidence into real verification claims.';
  if (kind === 'trust_status_overclaim') return 'Do not mark completion verified while active blockers, unsupported claims, stale evidence, or active wrongness remain.';
  if (kind === 'missing_evidence') return 'Before reusing this claim, hydrate source evidence and attach a current proof or artifact link.';
  if (kind === 'stale_evidence') return 'Treat stale evidence as negative evidence until the source artifact is refreshed and validated.';
  if (kind === 'image_bbox_error' || kind === 'visual_anchor_error') return 'Revalidate screenshot anchors, bounding boxes, image dimensions, and before/after relations before making visual claims.';
  if (kind.startsWith('db_safety_')) return 'Keep database classification conservative and bind mismatches to the DB safety report before allowing mutation claims.';
  if (kind === 'hook_policy_mismatch') return 'Treat hook policy mismatch as a blocking trust issue until hook replay output matches the configured policy.';
  if (kind === 'hook_semantic_mismatch') return 'Validate Codex hook outputs against runtime semantic parser rules after schema validation and before release.';
  if (kind === 'hook_strict_subset_misclassified') return 'Do not claim exact upstream parser mirroring when SKS intentionally enforces a stricter zero-warning subset.';
  if (kind === 'codex_lb_missing_env_raw_message') return 'Never expose raw CODEX_LB_API_KEY missing-env errors; return structured setup or repair guidance with redacted secrets.';
  if (kind === 'codex_lb_setup_choice_drift') return 'Do not ask codex-lb setup questions whose answers are ignored by the actual write/apply path.';
  if (kind === 'codex_lb_env_persistence_failure') return 'Do not write env files, shell profiles, launchctl values, or Keychain entries contrary to explicit codex-lb setup answers.';
  if (kind === 'computer_use_policy_misclassification') return 'Treat Computer Use as a Codex App/macOS capability, independent from MAD-SKS and generic safety policy.';
  if (kind === 'computer_use_live_smoke_mismatch') return 'Do not claim live Computer Use evidence without an opt-in live smoke or explicit evidence artifact.';
  if (kind === 'computer_use_external_block_overclaimed') return 'Do not upgrade external_capability_blocked Computer Use status into high-confidence visual verification.';
  if (kind === 'ux_review_text_only_fallback') return 'Do not pass UX-Review with prose-only screenshot critique; require a generated gpt-image-2 callout image.';
  if (kind === 'ux_generated_image_not_real') return 'Do not treat attached, placeholder, or mock images as real gpt-image-2 outputs without provider evidence and hashes.';
  if (kind === 'ux_fake_generic_callout_detected') return 'Do not auto-create generic callouts from generated image metadata; only schema extraction from pixels may create issue rows.';
  if (kind === 'ux_callout_ocr_uncertain') return 'Downgrade uncertain OCR/callout extraction to verified_partial and require human or re-review confirmation.';
  if (kind === 'gpt_image_2_callout_generation_failed') return 'Do not create verified UX evidence when gpt-image-2 callout image generation failed or is unavailable.';
  if (kind === 'callout_extraction_schema_failed') return 'Do not start or trust a UX fix loop until generated callouts are extracted into the schema-bound issue ledger.';
  if (kind === 'callout_bbox_out_of_bounds') return 'Revalidate generated callout bounding boxes against image dimensions before mapping issues to fixes.';
  if (kind === 'ux_patch_applied_without_recheck') return 'Do not mark patched UX issues fixed until changed screens are recaptured and re-reviewed.';
  if (kind === 'ux_after_recheck_regression') return 'Treat new after-screenshot P0/P1 findings as regression blockers.';
  if (kind === 'ux_image_fidelity_mismatch') return 'Preserve source/generated image fidelity metadata and block coordinate claims on mismatch.';
  if (kind === 'ux_output_schema_unavailable_fallback') return 'Cap output-schema fallback extraction at verified_partial and record the fallback provider.';
  if (kind === 'fix_loop_noop_patch') return 'Do not mark UX issues fixed from no-op patches or unchanged files.';
  if (kind === 'visual_fix_not_rechecked') return 'Do not claim visual fixes without post-fix recapture and re-review.';
  if (kind === 'post_fix_regression_detected') return 'Treat new post-fix P0/P1 visual issues as regression blockers until repaired or accepted.';
  if (kind === 'repeated_blocker_stop') return 'Stop repeated Goal/QA/Research/UX loops after recurring blockers instead of burning continuation budget.';
  return `Do not reuse this claim without source-backed correction: ${claimText.slice(0, 160)}`;
}

function severityForKind(kind: WrongnessKind): WrongnessSeverity {
  if (kind === 'ux_review_text_only_fallback' || kind === 'ux_generated_image_not_real' || kind === 'ux_fake_generic_callout_detected' || kind === 'ux_callout_ocr_uncertain' || kind === 'gpt_image_2_callout_generation_failed' || kind === 'callout_extraction_schema_failed' || kind === 'callout_bbox_out_of_bounds' || kind === 'ux_patch_applied_without_recheck' || kind === 'ux_after_recheck_regression' || kind === 'ux_image_fidelity_mismatch' || kind === 'ux_output_schema_unavailable_fallback' || kind === 'visual_fix_not_rechecked' || kind === 'post_fix_regression_detected' || kind === 'repeated_blocker_stop') return 'high';
  if (kind === 'db_safety_false_negative' || kind === 'hook_policy_mismatch' || kind === 'hook_semantic_mismatch' || kind === 'hook_strict_subset_misclassified' || kind === 'trust_status_overclaim') return 'high';
  if (kind === 'codex_lb_missing_env_raw_message' || kind === 'codex_lb_setup_choice_drift' || kind === 'codex_lb_env_persistence_failure' || kind === 'computer_use_policy_misclassification' || kind === 'computer_use_live_smoke_mismatch' || kind === 'computer_use_external_block_overclaimed') return 'high';
  if (kind === 'mock_real_confusion' || kind === 'artifact_schema_error' || kind === 'test_failure') return 'high';
  if (kind === 'image_bbox_error' || kind === 'visual_anchor_error' || kind === 'missing_evidence') return 'medium';
  return 'medium';
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'wrongness';
}
