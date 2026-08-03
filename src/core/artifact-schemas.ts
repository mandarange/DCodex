import path from 'node:path';
import { exists, nowIso, readJson, writeJsonAtomic } from './fsx.js';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'forensic_vision', 'recovery']);
export const WORK_ORDER_STATUSES = new Set(['pending', 'in_progress', 'implemented', 'verified', 'blocked']);

export const ARTIFACT_FILES = {
  work_order_ledger: 'work-order-ledger.json',
  effort_decision: 'effort-decision.json',
  from_chat_img_visual_map: 'from-chat-img-visual-map.json',
  dogfood_report: 'dogfood-report.json',
  skill_candidate: 'skill-candidate.json',
  skill_injection_decision: 'skill-injection-decision.json',
  mistake_ledger: 'mistake-ledger.json',
  memory_sweep_report: 'memory-sweep-report.json',
  skill_forge_report: 'skill-forge-report.json',
  mistake_memory_report: 'mistake-memory-report.json',
  harness_growth_report: 'harness-growth-report.json',
  code_structure_report: 'code-structure-report.json',
  final_honest_mode_report: 'final-honest-mode-report.json'
};

export function validationResult(schema: any, errors: any = [], warnings: any = []) {
  return { schema, ok: errors.length === 0, errors, warnings, checked_at: nowIso() };
}

function isObj(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function arr(value: any) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value: any) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushMissing(errors: any, condition: any, id: any) {
  if (!condition) errors.push(id);
}

export function validateWorkOrderLedger(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.mission_id), 'mission_id_missing');
  pushMissing(errors, nonEmpty(data.route), 'route_missing');
  pushMissing(errors, nonEmpty(data.created_at), 'created_at_missing');
  pushMissing(errors, Array.isArray(data.items), 'items_not_array');
  const items = arr(data.items);
  pushMissing(errors, items.length > 0, 'items_empty');
  if (items.some((item: any) => !validWorkOrderSource(data, item?.source))) errors.push('customer_request_source_missing');
  if (items.some((item: any) => !WORK_ORDER_STATUSES.has(item?.status))) errors.push('invalid_item_status');
  if (items.some((item: any) => item?.status === 'verified' && arr(item.verification_evidence).length === 0)) errors.push('verified_item_missing_verification_evidence');
  if (items.some((item: any) => ['implemented', 'verified'].includes(item?.status) && arr(item.implementation_evidence).length === 0)) errors.push('completed_item_missing_implementation_evidence');
  if (items.some((item: any) => item?.status !== 'blocked' && arr(item.implementation_tasks).length === 0 && item?.blocker?.blocked !== true)) errors.push('request_not_mapped_to_work_item_or_blocker');
  if (items.some((item: any) => item?.status === 'blocked' && item?.blocker?.blocked !== true)) errors.push('blocked_item_missing_blocker');
  if (data.all_customer_requests_preserved !== true) errors.push('all_customer_requests_preserved_not_true');
  if (data.all_customer_requests_mapped !== true) errors.push('all_customer_requests_mapped_not_true');
  if (data.source_inventory_complete !== true) errors.push('source_inventory_complete_not_true');
  if (data.all_work_items_verified === true && items.some((item: any) => item.status !== 'verified')) errors.push('all_work_items_verified_contradicts_items');
  if (data.all_work_items_resolved === true && items.some((item: any) => item.status !== 'verified' && item.status !== 'blocked')) errors.push('all_work_items_resolved_contradicts_items');
  if (data.all_work_items_verified === true && data.all_work_items_resolved === false) errors.push('verified_items_not_resolved');
  return validationResult('WorkOrderLedger', errors);
}

function validWorkOrderSource(ledger: any, source: any) {
  if (nonEmpty(source?.verbatim)) return true;
  if (source?.type !== 'attachment') return false;
  const start = Number(source?.line_start);
  const end = Number(source?.line_end);
  const total = Number(ledger?.source_line_count);
  return nonEmpty(ledger?.source_path)
    && /^[a-f0-9]{64}$/i.test(String(ledger?.source_sha256 || ''))
    && Number.isInteger(start)
    && Number.isInteger(end)
    && Number.isInteger(total)
    && start >= 1
    && end >= start
    && end <= total;
}

export function validateEffortDecision(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.mission_id), 'mission_id_missing');
  pushMissing(errors, nonEmpty(data.task_id), 'task_id_missing');
  pushMissing(errors, EFFORTS.has(data.selected_effort), 'selected_effort_invalid');
  pushMissing(errors, Array.isArray(data.reason_codes) && data.reason_codes.length > 0, 'reason_codes_missing');
  if (!isObj(data.risk_scores)) errors.push('risk_scores_missing');
  for (const [key, value] of Object.entries(data.risk_scores || {})) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) errors.push(`risk_score_invalid:${key}`);
  }
  return validationResult('EffortDecision', errors);
}

export function validateFromChatImgVisualMap(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.mission_id), 'mission_id_missing');
  pushMissing(errors, Array.isArray(data.sources), 'sources_not_array');
  pushMissing(errors, Array.isArray(data.regions), 'regions_not_array');
  const sources = arr(data.sources);
  const regions = arr(data.regions);
  if (!sources.length) errors.push('source_inventory_empty');
  if (sources.some((source: any) => !nonEmpty(source.id) || !nonEmpty(source.type))) errors.push('source_missing_id_or_type');
  if (regions.some((region: any) => !nonEmpty(region.image_id) || !nonEmpty(region.region_id))) errors.push('region_missing_ids');
  if (regions.some((region: any) => !['mapped', 'irrelevant', 'uncertain', 'blocked'].includes(region.status))) errors.push('region_invalid_status');
  if (regions.some((region: any) => ['uncertain', 'blocked'].includes(region.status) && !nonEmpty(region.unresolved_reason))) errors.push('unresolved_region_missing_reason');
  if (data.source_inventory_complete !== true) errors.push('source_inventory_complete_not_true');
  if (data.visual_mapping_complete === true && regions.some((region: any) => ['uncertain', 'blocked'].includes(region.status))) errors.push('visual_mapping_complete_with_unresolved_regions');
  if (sources.some((source: any) => source.relevant !== false && source.accounted_for !== true)) errors.push('relevant_source_unaccounted');
  return validationResult('FromChatImgVisualMap', errors);
}

export function validateDogfoodReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.scenario), 'scenario_missing');
  pushMissing(errors, typeof data.computer_use_available === 'boolean', 'computer_use_available_missing');
  pushMissing(errors, typeof data.browser_available === 'boolean', 'browser_available_missing');
  pushMissing(errors, Number.isFinite(Number(data.cycles)), 'cycles_missing');
  pushMissing(errors, Array.isArray(data.findings), 'findings_not_array');
  if (Number(data.unresolved_fixable_findings) > 0) errors.push('unresolved_fixable_findings_remaining');
  if (data.passed === true && data.post_fix_verification_complete !== true) errors.push('passed_without_post_fix_verification');
  if (arr(data.findings).some((finding: any) => finding.classification === 'fixable' && finding.post_fix_verification !== 'passed')) errors.push('fixable_finding_without_passed_recheck');
  return validationResult('DogfoodReport', errors);
}

export function validateSkillCandidate(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.id), 'id_missing');
  pushMissing(errors, Number.isFinite(Number(data.version)), 'version_missing');
  pushMissing(errors, ['candidate', 'active', 'deprecated'].includes(data.status), 'status_invalid');
  pushMissing(errors, Array.isArray(data.triggers) && data.triggers.length > 0, 'triggers_missing');
  if (data.status === 'active' && Number(data.evidence?.successful_runs || 0) < 1) errors.push('active_skill_without_success_evidence');
  return validationResult('SkillCandidate', errors);
}

export function validateSkillInjectionDecision(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.route), 'route_missing');
  pushMissing(errors, Number.isFinite(Number(data.top_k)), 'top_k_missing');
  pushMissing(errors, Array.isArray(data.injected), 'injected_not_array');
  if (arr(data.injected).length > Number(data.top_k || 0)) errors.push('injected_exceeds_top_k');
  if (arr(data.injected).some((skill: any) => skill.status && skill.status !== 'active')) errors.push('non_active_skill_injected');
  return validationResult('SkillInjectionDecision', errors);
}

export function validateMistakeLedger(data: any = {}) {
  const entries = Array.isArray(data) ? data : arr(data.entries);
  const errors: any[] = [];
  pushMissing(errors, entries.length > 0, 'mistake_entries_empty');
  if (entries.some((entry: any) => !nonEmpty(entry.fingerprint) || !nonEmpty(entry.route))) errors.push('mistake_entry_missing_fingerprint_or_route');
  if (entries.some((entry: any) => Number(entry.count || 0) >= 2 && !entry.prevention?.gate && !entry.prevention?.test && !entry.prevention?.skill)) errors.push('repeated_mistake_missing_prevention');
  return validationResult('MistakeLedgerEntry', errors);
}

export function validateMemorySweepReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, Array.isArray(data.operations), 'operations_not_array');
  pushMissing(errors, isObj(data.retrieval_budget), 'retrieval_budget_missing');
  if (arr(data.operations).some((op: any) => !nonEmpty(op.claim_id) || !nonEmpty(op.operation))) errors.push('operation_missing_claim_or_type');
  if (Number(data.retrieval_budget?.actual_tokens || 0) > Number(data.retrieval_budget?.max_tokens || Infinity)) errors.push('retrieval_budget_exceeded');
  return validationResult('MemorySweepReport', errors);
}

export function validateSkillForgeReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, Array.isArray(data.candidates), 'candidates_not_array');
  pushMissing(errors, isObj(data.injection), 'injection_missing');
  if (data.injection && arr(data.injection.injected).length > Number(data.injection.top_k || 0)) errors.push('skill_injection_exceeds_top_k');
  return validationResult('SkillForgeReport', errors);
}

export function validateMistakeMemoryReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, Array.isArray(data.checked_fingerprints), 'checked_fingerprints_not_array');
  pushMissing(errors, isObj(data.validation), 'validation_missing');
  if (data.validation?.repeated_mistakes_have_prevention === false) errors.push('repeated_mistake_without_prevention');
  return validationResult('MistakeMemoryReport', errors);
}

export function validateHarnessGrowthReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, isObj(data.forgetting), 'forgetting_missing');
  pushMissing(errors, isObj(data.skills), 'skills_missing');
  pushMissing(errors, isObj(data.experiments), 'experiments_missing');
  pushMissing(errors, isObj(data.codex_native), 'codex_native_missing');
  pushMissing(errors, isObj(data.reliability), 'reliability_missing');
  if (data.forgetting?.fixture?.passed !== true) errors.push('forgetting_fixture_failed');
  if (!Array.isArray(data.reliability?.tool_error_taxonomy) || !data.reliability.tool_error_taxonomy.includes('Unknown')) errors.push('tool_error_taxonomy_missing_unknown');
  if (data.reliability?.unknown_errors_are_bugs !== true) errors.push('unknown_errors_not_marked_bug');
  return validationResult('HarnessGrowthReport', errors);
}

export function validateCodeStructureReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, isObj(data.thresholds), 'thresholds_missing');
  pushMissing(errors, Array.isArray(data.files), 'files_not_array');
  if (arr(data.files).some((file: any) => Number(file.line_count || 0) >= 3000 && !file.generated_or_vendor && !file.exception && !arr(data.actions_taken).length)) errors.push('over_3000_file_missing_split_review_or_exception');
  return validationResult('CodeStructureReport', errors);
}

export function validateFinalHonestModeReport(data: any = {}) {
  const errors: any[] = [];
  pushMissing(errors, nonEmpty(data.mission_id), 'mission_id_missing');
  for (const key of ['verified', 'unverified', 'blocked', 'risks']) pushMissing(errors, Array.isArray(data[key]), `${key}_not_array`);
  if (arr(data.verified).some((item: any) => !arr(item.evidence).length)) errors.push('verified_claim_missing_evidence');
  if (arr(data.blocked).some((item: any) => !nonEmpty(item.reason))) errors.push('blocked_item_missing_reason');
  return validationResult('FinalHonestModeReport', errors);
}

export const ARTIFACT_VALIDATORS = {
  work_order_ledger: validateWorkOrderLedger,
  effort_decision: validateEffortDecision,
  from_chat_img_visual_map: validateFromChatImgVisualMap,
  dogfood_report: validateDogfoodReport,
  skill_candidate: validateSkillCandidate,
  skill_injection_decision: validateSkillInjectionDecision,
  mistake_ledger: validateMistakeLedger,
  memory_sweep_report: validateMemorySweepReport,
  skill_forge_report: validateSkillForgeReport,
  mistake_memory_report: validateMistakeMemoryReport,
  harness_growth_report: validateHarnessGrowthReport,
  code_structure_report: validateCodeStructureReport,
  final_honest_mode_report: validateFinalHonestModeReport
};

export async function validateArtifactDirectory(dir: any, opts: any = {}) {
  const results: Record<string, any> = {};
  const missing: any[] = [];
  for (const [schema, file] of Object.entries(ARTIFACT_FILES)) {
    const filePath = path.join(dir, file);
    if (!(await exists(filePath))) {
      if (arr(opts.required).includes(schema)) missing.push(file);
      continue;
    }
    const data = await readJson(filePath, null);
    const validator = (ARTIFACT_VALIDATORS as Record<string, (data?: any) => any>)[schema];
    if (validator) results[schema] = { file, ...validator(data) };
  }
  const errors = [...missing.map((file: any) => `required_artifact_missing:${file}`)];
  for (const result of Object.values(results)) errors.push(...arr(result.errors).map((err: any) => `${result.file}:${err}`));
  return { ok: errors.length === 0, checked_at: nowIso(), dir, missing, results, errors };
}

export async function writeValidationReport(dir: any, opts: any = {}) {
  const report = await validateArtifactDirectory(dir, opts);
  await writeJsonAtomic(path.join(dir, 'artifact-validation.json'), report);
  return report;
}
