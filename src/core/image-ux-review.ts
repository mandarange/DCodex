import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { nowIso, sha256, writeJsonAtomic } from './fsx.js';
import { imageDimensions, sha256File } from './wiki-image/image-hash.js';
import { CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_CHROME_EXTENSION_DOC_URL, CODEX_IMAGEGEN_REQUIRED_POLICY, CODEX_WEB_VERIFICATION_POLICY } from './routes.js';
import { codex0133Matrix } from './codex-compat/codex-0-133.js';
import { detectCodexExecResumeOutputSchema } from './codex-exec-output-schema.js';
import { buildCalloutPrompt, imagegenCapabilityBlocker } from './image-ux-review/imagegen-adapter.js';
import { buildIssueLedgerFromGeneratedCallouts } from './image-ux-review/callout-extraction.js';
import { planImageUxFixTasks } from './image-ux-review/fix-task-planner.js';
import { runImageUxFixLoop } from './image-ux-review/fix-loop.js';
import { buildRecapturePlan } from './image-ux-review/recapture.js';
import { addImageRelation, addVisualAnchor, ingestImage } from './wiki-image/image-voxel-ledger.js';
import { validateFinalHonestModeReport } from './artifact-schemas.js';
import { imagegenEvidenceClassBlockers, isFullImagegenOutputSource } from './imagegen/imagegen-evidence.js';

export const IMAGE_UX_REVIEW_GATE_ARTIFACT = 'image-ux-review-gate.json';
export const IMAGE_UX_REVIEW_POLICY_ARTIFACT = 'image-ux-review-policy.json';
export const IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT = 'image-ux-screen-inventory.json';
export const IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT = 'image-ux-generated-review-ledger.json';
export const IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT = 'image-ux-issue-ledger.json';
export const IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT = 'image-ux-callout-extraction-report.json';
export const IMAGE_UX_REVIEW_FIX_TASK_PLAN_ARTIFACT = 'image-ux-fix-task-plan.json';
export const IMAGE_UX_REVIEW_FIX_LOOP_ARTIFACT = 'image-ux-fix-loop.json';
export const IMAGE_UX_REVIEW_RECAPTURE_ARTIFACT = 'image-ux-recapture-plan.json';
export const IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT = 'final-honest-mode-report.json';
export const IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT = 'image-ux-iteration-report.json';
export const IMAGE_UX_REVIEW_IMAGEGEN_REQUEST_ARTIFACT = 'image-ux-imagegen-request.json';
export const IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT = 'image-ux-gpt-image-2-request.json';
export const IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT = 'image-ux-gpt-image-2-response.json';
export const IMAGE_UX_REVIEW_API_DOC_URL = 'https://developers.openai.com/api/docs/guides/image-generation';
export const GPT_IMAGE_2_MODEL_DOC_URL = 'https://developers.openai.com/api/docs/models/gpt-image-2';
export const STRUCTURED_OUTPUTS_DOC_URL = 'https://developers.openai.com/api/docs/guides/structured-outputs';

export const IMAGE_UX_REVIEW_REQUIRED_GATE_FIELDS = Object.freeze([
  'real_source_screenshot_present',
  'computer_use_or_user_screenshot_source',
  'gpt_image_2_callout_generated',
  'generated_image_ingested',
  'callout_extraction_schema_valid',
  'issue_ledger_from_generated_callout',
  'p0_p1_zero_after_fix',
  'fix_loop_executed_or_not_needed',
  'changed_screens_rechecked',
  'image_voxel_relations_created',
  'wrongness_checked',
  'honest_mode_complete'
]);

export const IMAGE_UX_REVIEW_REFERENCE_GATE_FIELDS = Object.freeze([
  'real_source_screenshot_present',
  'computer_use_or_user_screenshot_source',
  'callout_extraction_schema_valid',
  'p0_p1_zero_after_fix',
  'fix_loop_executed_or_not_needed',
  'changed_screens_rechecked',
  'image_voxel_reference_anchor_created',
  'wrongness_checked',
  'honest_mode_complete'
]);

const IMAGE_UX_REVIEW_REFERENCE_CLOSABLE_BLOCKERS = new Set([
  'missing_generated_annotated_review_images',
  'imagegen_capability_missing',
  'codex_app_imagegen_output_missing',
  'generated_review_image_missing'
]);

export function imageUxReviewGateAllowsReferenceCloseout(gate: any = {}) {
  return gate?.passed === true
    && gate?.reference_only === true
    && gate?.verified_level === 'verified_partial'
    && gate?.full_review_passed !== true;
}

export function imageUxReviewCommandOutcome(gate: any = {}, proofOk = false, opts: any = {}) {
  const reviewReportCompleted = gate?.review_report_completed === true;
  const reviewOnlyCompletionAllowed = opts.allowReviewOnlyCompletion === true;
  const reviewOnlyCompleted = reviewOnlyCompletionAllowed && reviewReportCompleted;
  const gateAndProofPassed = gate?.passed === true && proofOk === true;
  const fullReviewPassed = gate?.full_review_passed === true && gateAndProofPassed;
  return {
    ok: gateAndProofPassed || reviewOnlyCompleted,
    status: fullReviewPassed
      ? 'passed'
      : reviewOnlyCompleted
        ? 'review_completed'
        : gateAndProofPassed
          ? gate?.status || 'passed'
          : 'blocked',
    completion_scope: fullReviewPassed
      ? 'full_review_and_optional_fix_verification'
      : reviewOnlyCompleted
        ? 'capture_imagegen_ocr_and_ux_report'
        : null,
    review_report_completed: reviewReportCompleted,
    review_only_completion_allowed: reviewOnlyCompletionAllowed,
    full_review_passed: gate?.full_review_passed === true,
    requires_human_review: gate?.requires_human_review === true,
    unresolved_p0_p1_count: Number(gate?.unresolved_p0_p1_count || 0),
    safety_blockers: Array.isArray(gate?.blockers) ? gate.blockers : [],
    proof_ok: proofOk === true
  };
}

function cleanText(value: any, fallback: any = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function contractText(contract: any = {}) {
  return cleanText(`${contract.prompt || ''} ${JSON.stringify(contract.answers || {})}`);
}

function compactId(prefix: any, text: any) {
  return `${prefix}-${sha256(cleanText(text, prefix)).slice(0, 10)}`;
}

export function buildImageUxReviewPolicy(contract: any = {}) {
  const outputSchema = {
    preferred_for_codex_0_133: true,
    preferred_for_codex_0_132: true,
    schemas: [
      'schemas/codex/ux-review-callout-extraction.schema.json',
      'schemas/codex/image-ux-issue-ledger.schema.json',
      'schemas/codex/completion-proof.schema.json',
      'schemas/codex/wrongness-record.schema.json',
      'schemas/codex/agent-result.schema.json',
      'schemas/codex/computer-use-live-evidence.schema.json'
    ]
  };
  return {
    schema: 'sks.image-ux-review-policy.v2',
    schema_version: 2,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    policy: 'real_gpt_image_2_callout_fix_loop',
    score_threshold: 0.88,
    minimum_delta_to_continue: 0.03,
    max_full_surface_passes: 2,
    max_screen_retries: 2,
    codex_compatibility: codex0133Matrix(),
    output_schema: outputSchema,
    source_capture: {
      required: true,
      original_resolution_required: true,
      local_only_default: true,
      accepted_sources: ['codex_chrome_extension_screenshot', 'codex_native_computer_use_screenshot', 'user_provided_screenshot', 'exported_static_artifact_image'],
      web_capture_doc: CODEX_CHROME_EXTENSION_DOC_URL,
      web_verification_policy: CODEX_WEB_VERIFICATION_POLICY,
      privacy: 'Chrome Extension screenshots, native Computer Use screenshots, and gpt-image-2 outputs are local-only by default; shared TriWiki publishes metadata only unless explicitly opted in.'
    },
    image_generation_review: {
      required_for_gate: 'full_verification',
      missing_generated_image_closeout: 'A route may close as verified_partial/reference_only when source screenshots are captured but gpt-image-2 output is unavailable; it must not claim annotated-image review, callout extraction, or full UX verification.',
      model: 'gpt-image-2',
      preferred_surface: 'Codex App built-in image generation via $imagegen',
      codex_app_imagegen_doc: CODEX_APP_IMAGE_GENERATION_DOC_URL,
      api_image_generation_doc: IMAGE_UX_REVIEW_API_DOC_URL,
      gpt_image_2_model_doc: GPT_IMAGE_2_MODEL_DOC_URL,
      image_input_fidelity_note: 'high_fidelity_automatic',
      unsupported_parameters_omitted: ['input_fidelity'],
      required_policy: CODEX_IMAGEGEN_REQUIRED_POLICY,
      output_artifact: IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT,
      anti_substitution_rule: 'A text-only visual review cannot satisfy this route. Missing generated annotated review images block full verification instead of being simulated; source-only closure is capped at verified_partial/reference_only.',
      prompt_contract: [
        'numbered callouts',
        'P0/P1/P2/P3 severity labels',
        'concrete UI region overlays',
        'visual hierarchy markers',
        'contrast markers',
        'alignment markers',
        'density markers',
        'affordance markers',
        'eye-flow arrows',
        'corrected mini-comp or before/after strip',
        'visible evidence only',
        'no invented product requirements',
        'screenshot source id',
        'output must be image artifact',
        'text-only response invalid'
      ],
      review_prompt_template: buildCalloutPrompt('{{source_screen_id}}', { target: contract.answers?.TARGET_SURFACE || contract.prompt })
    },
    extraction_policy: {
      input_artifact: IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT,
      output_artifact: IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT,
      preferred_path: 'codex exec resume --output-schema schemas/codex/image-ux-issue-ledger.schema.json',
      fallback_path: 'OpenAI Responses Structured Outputs text.format json_schema strict true',
      structured_outputs_doc: STRUCTURED_OUTPUTS_DOC_URL,
      fallback_cap: 'verified_partial',
      required_issue_fields: ['id', 'severity', 'source_screen_id', 'generated_review_image_id', 'callout_id', 'bbox', 'region', 'title', 'detail', 'likely_cause', 'fix_action', 'target_surface', 'status', 'confidence', 'source', 'extraction_provider', 'generated_image_sha256', 'bbox_coordinate_space', 'bbox_confidence']
    },
    remediation_policy: {
      code_changes_allowed: 'only_when_user_or_route_contract_requests_fixing',
      priority_order: ['P0', 'P1', 'P2', 'P3'],
      patch_rule: 'Patch P0/P1 first, then cheap local P2. Re-run only changed, failed, or high-risk screens.',
      no_fallback: 'Do not replace the image-generation review with a hand-written fallback review.',
      repeated_blocker_stop_threshold: 2,
      db_destructive_operations_allowed: false
    },
    evidence_artifacts: [
      IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT,
      IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT,
      IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT,
      IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT,
      IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT,
      IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT,
      IMAGE_UX_REVIEW_FIX_TASK_PLAN_ARTIFACT,
      IMAGE_UX_REVIEW_FIX_LOOP_ARTIFACT,
      IMAGE_UX_REVIEW_RECAPTURE_ARTIFACT,
      IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT,
      IMAGE_UX_REVIEW_GATE_ARTIFACT
    ]
  };
}

export function buildImageUxScreenInventory(contract: any = {}) {
  const text = contractText(contract);
  const suppliedImages = [
    ...(Array.isArray(contract.answers?.IMAGE_UX_REVIEW_SOURCE_IMAGES) ? contract.answers.IMAGE_UX_REVIEW_SOURCE_IMAGES : []),
    ...(Array.isArray(contract.answers?.SOURCE_SCREENSHOTS) ? contract.answers.SOURCE_SCREENSHOTS : []),
    ...(contract.answers?.IMAGE_UX_REVIEW_SOURCE_IMAGE ? [contract.answers.IMAGE_UX_REVIEW_SOURCE_IMAGE] : [])
  ].map((item: any) => cleanText(item)).filter(Boolean);
  const target = cleanText(contract.answers?.TARGET_URL || contract.answers?.TARGET_SURFACE || contract.prompt, 'UI surface to review');
  return {
    schema: 'sks.image-ux-screen-inventory.v2',
    schema_version: 2,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    target,
    task_signature: compactId('image-ux-target', text),
    capture_required: suppliedImages.length === 0,
    source_screens: suppliedImages.map((source: any, index: number) => ({
      id: `screen-${index + 1}`,
      source,
      source_type: /^https?:\/\//i.test(source) ? 'url_or_remote_image' : 'local_or_named_image',
      capture_source: contract.answers?.CHROME_EXTENSION_SCREENSHOT ? 'codex_chrome_extension_screenshot' : contract.answers?.COMPUTER_USE_SCREENSHOT ? 'codex_native_computer_use_screenshot' : 'user_provided_screenshot',
      status: 'provided_unverified',
      original_resolution: true,
      width: null,
      height: null,
      sha256: null,
      exif_orientation_normalized: 'not_applicable_or_pending',
      privacy: 'local-only'
    })),
    capture_policy: 'Capture web/browser/webapp screens with Codex Chrome Extension first, native Mac/non-web surfaces with Codex Computer Use when live, or user-provided screenshots for static review. Preserve original image resolution metadata.',
    passed: suppliedImages.length > 0,
    blockers: suppliedImages.length > 0 ? [] : ['screenshot_required']
  };
}

export async function hydrateImageUxScreenInventory(root: string, inventory: any) {
  const sourceScreens = [];
  for (const screen of inventory.source_screens || []) {
    const file = resolveImagePath(root, screen.source);
    let next = { ...screen };
    try {
      const dims = await imageDimensions(file);
      next = {
        ...next,
        source: path.relative(root, file).split(path.sep).join('/'),
        width: dims.width,
        height: dims.height,
        format: dims.format,
        sha256: await sha256File(file),
        status: 'captured',
        original_resolution: {
          preserved: true,
          width: dims.width,
          height: dims.height
        },
        exif_orientation_normalized: 'recorded_not_rotated'
      };
    } catch (err) {
      next = {
        ...next,
        status: 'missing_or_unreadable',
        blocker: err instanceof Error ? err.message : String(err)
      };
    }
    sourceScreens.push(next);
  }
  const blockers = [
    ...(inventory.blockers || []),
    ...sourceScreens.filter((screen: any) => screen.status !== 'captured').map((screen: any) => `source_screenshot_unreadable:${screen.id}`)
  ];
  return {
    ...inventory,
    source_screens: sourceScreens,
    passed: sourceScreens.length > 0 && blockers.length === 0,
    blockers: [...new Set(blockers)]
  };
}

export function buildImageUxGeneratedReviewLedger(contract: any = {}, inventory: any = buildImageUxScreenInventory(contract), existing: any = null, opts: any = {}) {
  const existingImages = Array.isArray(existing?.generated_review_images) ? existing.generated_review_images : [];
  const sourceScreens = inventory.source_screens || [];
  const normalizedImages = existingImages.map((image: any, index: number) => normalizeGeneratedReviewImage(image, sourceScreens[index] || {}, opts));
  const realGeneratedCount = normalizedImages.filter((image: any) => image.real_generated === true && image.mock !== true).length;
  const missingRealGeneratedScreens = sourceScreens.filter((screen: any) => !normalizedImages.some((image: any) => image.source_screen_id === screen.id && image.real_generated === true && image.mock !== true));
  const nonRealGeneratedCount = normalizedImages.filter((image: any) => image.real_generated !== true || image.mock === true).length;
  const textOnlyCount = normalizedImages.filter((image: any) => image.text_only === true).length;
  const evidenceBlockers: string[] = Array.from(new Set<string>(
    normalizedImages.flatMap((image: any) => image.evidence_blockers || []).map((blocker: any) => String(blocker))
  ));
  const blockers: string[] = [];
  if (sourceScreens.length === 0) blockers.push('no_source_screenshots_for_imagegen_review');
  if (missingRealGeneratedScreens.length > 0) blockers.push('missing_generated_annotated_review_images', 'generated_review_image_missing');
  blockers.push(...evidenceBlockers);
  if (textOnlyCount > 0) blockers.push('ux_review_text_only_fallback');
  if (normalizedImages.some((image: any) => image.mock === true && image.real_generated === true)) blockers.push('mock_fixture_marked_real');
  const uniqueBlockers = [...new Set(blockers)];
  return {
    schema: 'sks.image-ux-generated-review-ledger.v2',
    schema_version: 2,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    provider: {
      model: 'gpt-image-2',
      preferred_surface: 'Codex App $imagegen',
      codex_app_imagegen_doc: CODEX_APP_IMAGE_GENERATION_DOC_URL,
      api_image_generation_doc: IMAGE_UX_REVIEW_API_DOC_URL,
      gpt_image_2_model_doc: GPT_IMAGE_2_MODEL_DOC_URL
    },
    required: true,
    required_for_full_verification: true,
    reference_closeout_allowed_when_unavailable: true,
    generated_review_images: normalizedImages,
    planned_reviews: sourceScreens.map((screen: any) => ({
      id: compactId('image-ux-review', `${screen.id}:${screen.source || screen.id}`),
      source_screen_id: screen.id,
      source_sha256: screen.sha256 || null,
      prompt: buildCalloutPrompt(screen.id, { target: inventory.target }),
      status: normalizedImages.some((image: any) => image.source_screen_id === screen.id) ? 'generated_or_attached' : 'pending_imagegen',
      required_output: 'annotated_review_image_with_numbered_callouts_severity_labels_markers_arrows_and_mini_comp',
      requested_fidelity: 'high_fidelity_automatic',
      image_input_fidelity_note: 'gpt-image-2 processes image inputs at high fidelity automatically; SKS omits unsupported input_fidelity.',
      privacy: 'local-only'
    })),
    generated_count: normalizedImages.length,
    real_generated_count: realGeneratedCount,
    non_real_generated_count: nonRealGeneratedCount,
    required_count: sourceScreens.length,
    text_only_count: textOnlyCount,
    generated_image_file_evidence_checked: Boolean(opts.root),
    evidence_verified: normalizedImages.length > 0 && evidenceBlockers.length === 0 && realGeneratedCount === normalizedImages.length,
    reference_closeout_eligible: sourceScreens.length > 0
      && realGeneratedCount === 0
      && textOnlyCount === 0
      && missingRealGeneratedScreens.length > 0,
    blockers: uniqueBlockers,
    passed: sourceScreens.length > 0 && blockers.length === 0 && realGeneratedCount === sourceScreens.length,
    imagegen_blocker: uniqueBlockers.includes('imagegen_capability_missing')
      ? imagegenCapabilityBlocker()
      : uniqueBlockers.includes('generated_review_image_missing')
        ? generatedReviewImageMissingBlocker()
        : null,
    notes: [
      'This ledger records real generated review images. It must not be marked passed from prose-only critique.',
      CODEX_IMAGEGEN_REQUIRED_POLICY
    ]
  };
}

export function buildImageUxIssueLedger(contract: any = {}, generatedReviewLedger: any = buildImageUxGeneratedReviewLedger(contract), existing: any = null) {
  const ledger = buildIssueLedgerFromGeneratedCallouts(generatedReviewLedger, existing);
  return {
    ...ledger,
    contract_hash: contract.sealed_hash || null,
    output_schema: 'schemas/codex/image-ux-issue-ledger.schema.json',
    scorecard: {
      visual_review_completion: generatedReviewLedger.passed ? 0.92 : 0.25,
      issue_extraction_integrity: ledger.validation.ok && ledger.issues.length > 0 ? 0.9 : 0.35,
      p0_p1_resolution: ledger.p0_p1_zero ? 0.9 : 0.4,
      overall_score: Number((generatedReviewLedger.passed && ledger.validation.ok && ledger.p0_p1_zero ? 0.9 : 0.42).toFixed(3))
    }
  };
}

export function buildImageUxIterationReport(
  contract: any = {},
  policy: any = buildImageUxReviewPolicy(contract),
  generatedReviewLedger: any = buildImageUxGeneratedReviewLedger(contract),
  issueLedger: any = buildImageUxIssueLedger(contract, generatedReviewLedger),
  fixTaskPlan: any = planImageUxFixTasks(issueLedger),
  fixLoop: any = runImageUxFixLoop(issueLedger, fixTaskPlan),
  recapturePlan: any = buildRecapturePlan(fixLoop)
) {
  const generatedImage = (generatedReviewLedger.generated_review_images || [])[0] || null;
  const issues = Array.isArray(issueLedger.issues) ? issueLedger.issues : [];
  const basedOnGeneratedImage = issueLedger.extracted_from_generated_callout === true
    && issues.length > 0
    && issues.every((issue: any) => issue.extracted_from_generated_image === true
      && issue.generated_image_sha256 === generatedImage?.sha256);
  const requiresHumanReview = (fixTaskPlan.tasks || []).some((task: any) => task.requires_human_review === true);
  const severityCounts = Object.fromEntries(['P0', 'P1', 'P2', 'P3'].map((severity) => [
    severity,
    issues.filter((issue: any) => issue.severity === severity).length
  ]));
  const passed = generatedReviewLedger.passed === true
    && issueLedger.passed === true
    && fixLoop.passed === true
    && recapturePlan.passed === true
    && Number(issueLedger.scorecard?.overall_score || 0) >= Number(policy.score_threshold || 0.88);
  const referenceOnly = passed !== true && generatedReviewLedger.reference_closeout_eligible === true;
  return {
    schema: 'sks.image-ux-iteration-report.v2',
    schema_version: 2,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    report_type: 'ux_ui_change_report',
    review_report_completed: generatedReviewLedger.passed === true
      && issueLedger.validation?.ok === true
      && basedOnGeneratedImage,
    full_review_passed: passed,
    requires_human_review: requiresHumanReview,
    unresolved_p0_p1_count: Number(issueLedger.blocking_issue_count || 0),
    analysis_basis: {
      primary_evidence: 'generated_annotated_review_image',
      generated_image_path: generatedImage?.path || null,
      generated_image_sha256: generatedImage?.sha256 || null,
      generated_image_id: generatedImage?.id || null,
      source_screen_id: generatedImage?.source_screen_id || 'screen-1',
      issue_extraction_source: issueLedger.extraction_source || IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT,
      based_on_generated_image: basedOnGeneratedImage
    },
    executive_summary: {
      issue_count: issues.length,
      severity_counts: severityCounts,
      highest_priority: issues.find((issue: any) => ['P0', 'P1'].includes(issue.severity))?.severity
        || issues[0]?.severity
        || null
    },
    recommendations: issues.map((issue: any) => ({
      issue_id: issue.id,
      callout_id: issue.callout_id,
      severity: issue.severity,
      title: issue.title,
      observed_problem: issue.detail,
      likely_cause: issue.likely_cause,
      recommended_ux_ui_change: issue.fix_action,
      target_surface: issue.target_surface,
      generated_image_bbox: issue.bbox,
      generated_image_sha256: issue.generated_image_sha256,
      confidence: issue.confidence,
      verification_status: issue.fix_verification_status
    })),
    loop_policy: {
      max_full_surface_passes: policy.max_full_surface_passes,
      max_screen_retries: policy.max_screen_retries,
      score_threshold: policy.score_threshold,
      minimum_delta_to_continue: policy.minimum_delta_to_continue,
      repeated_blocker_stop_threshold: policy.remediation_policy?.repeated_blocker_stop_threshold || 2
    },
    passes: [
      {
        pass: 1,
        type: generatedReviewLedger.passed ? 'real_gpt_image_2_callout_extraction' : 'waiting_for_gpt_image_2_callout_image',
        generated_review_images: generatedReviewLedger.generated_count || 0,
        real_generated_review_images: generatedReviewLedger.real_generated_count || 0,
        blocking_issue_count: issueLedger.blocking_issue_count || 0,
        fix_tasks: fixTaskPlan.tasks?.length || 0,
        score: issueLedger.scorecard?.overall_score || 0,
        status: passed ? 'passed' : referenceOnly ? 'verified_partial_reference' : 'blocked'
      }
    ],
    stopped: true,
    stop_reason: passed ? 'score_threshold_met_and_no_p0_p1_issues'
      : referenceOnly ? 'generated_review_image_unavailable_reference_only_closeout'
      : 'imagegen_review_evidence_or_issue_resolution_required',
    reference_only: referenceOnly,
    passed
  };
}

export function defaultImageUxReviewGate(contract: any = {}, parts: any = {}) {
  const policy = parts.policy || buildImageUxReviewPolicy(contract);
  const inventory = parts.inventory || buildImageUxScreenInventory(contract);
  const generatedReviewLedger = parts.generatedReviewLedger || buildImageUxGeneratedReviewLedger(contract, inventory);
  const issueLedger = parts.issueLedger || buildImageUxIssueLedger(contract, generatedReviewLedger);
  const fixTaskPlan = parts.fixTaskPlan || planImageUxFixTasks(issueLedger);
  const fixLoop = parts.fixLoop || runImageUxFixLoop(issueLedger, fixTaskPlan);
  const recapturePlan = parts.recapturePlan || buildRecapturePlan(fixLoop);
  const iterationReport = parts.iterationReport || buildImageUxIterationReport(contract, policy, generatedReviewLedger, issueLedger, fixTaskPlan, fixLoop, recapturePlan);
  const realGeneratedCount = Number(generatedReviewLedger.real_generated_count || 0);
  const realGeneratedImages = (generatedReviewLedger.generated_review_images || []).filter((image: any) => image.real_generated === true && image.mock !== true);
  const rawBlockers = [
    ...(inventory.blockers || []),
    ...(generatedReviewLedger.blockers || []),
    ...(issueLedger.blockers || []),
    ...(fixTaskPlan.blockers || []).filter((blocker: any) => blocker !== 'no_fixable_issues' || (issueLedger.issues || []).some((issue: any) => ['P0', 'P1'].includes(issue.severity) && !['fixed', 'accepted_not_applicable'].includes(issue.status))),
    ...(fixLoop.blockers || []),
    ...(recapturePlan.blockers || [])
  ];
  const nonReferenceBlockers = rawBlockers.filter((blocker: any) => !IMAGE_UX_REVIEW_REFERENCE_CLOSABLE_BLOCKERS.has(String(blocker)));
  const generatedImageUnavailable = realGeneratedCount === 0
    && Number(generatedReviewLedger.required_count || 0) > 0;
  const realSourceScreenshotPresent = inventory.passed === true;
  const officialOrUserScreenshotSource = (inventory.source_screens || []).some((screen: any) => [
    'codex_chrome_extension_screenshot',
    'codex_native_computer_use_screenshot',
    'codex_computer_use_screenshot',
    'user_provided_screenshot',
    'exported_static_artifact_image'
  ].includes(screen.capture_source || screen.source_type));
  const calloutExtractionSchemaValid = issueLedger.validation?.ok === true;
  const p0P1ZeroAfterFix = issueLedger.p0_p1_zero === true && (fixLoop.passed === true || fixTaskPlan.tasks?.length === 0);
  const fixLoopExecutedOrNotNeeded = fixLoop.passed === true || fixTaskPlan.tasks?.length === 0;
  const changedScreensRechecked = recapturePlan.changed_screens_rechecked_or_not_applicable === true;
  const imageVoxelReferenceAnchorCreated = parts.imageVoxelReferenceAnchorCreated === true;
  const wrongnessChecked = parts.wrongnessChecked === true || generatedReviewLedger.blockers?.length === 0;
  const honestModeEvidence = parts.honestModeEvidence || null;
  const honestModeComplete = parts.honestModeComplete === true && (honestModeEvidence?.ok === true || parts.honestModeEvidenceRequired !== true);
  const requiresHumanReview = (fixTaskPlan.tasks || []).some((task: any) => task.requires_human_review === true);
  const reviewReportCompleted = realSourceScreenshotPresent
    && officialOrUserScreenshotSource
    && generatedReviewLedger.passed === true
    && realGeneratedCount > 0
    && calloutExtractionSchemaValid
    && issueLedger.extracted_from_generated_callout === true
    && iterationReport.review_report_completed === true
    && iterationReport.analysis_basis?.based_on_generated_image === true;
  const referenceCloseoutPassed = generatedImageUnavailable
    && realSourceScreenshotPresent
    && officialOrUserScreenshotSource
    && calloutExtractionSchemaValid
    && p0P1ZeroAfterFix
    && fixLoopExecutedOrNotNeeded
    && changedScreensRechecked
    && imageVoxelReferenceAnchorCreated
    && wrongnessChecked
    && honestModeComplete
    && nonReferenceBlockers.length === 0;
  const gate = {
    schema: 'sks.image-ux-review-gate.v2',
    schema_version: 2,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    passed: false,
    status: 'blocked',
    verified_level: 'blocked',
    full_review_passed: false,
    review_report_completed: reviewReportCompleted,
    completion_scope: reviewReportCompleted ? 'capture_imagegen_ocr_and_ux_report' : null,
    requires_human_review: requiresHumanReview,
    unresolved_p0_p1_count: Number(issueLedger.blocking_issue_count || 0),
    reference_only: false,
    real_source_screenshot_present: realSourceScreenshotPresent,
    computer_use_or_user_screenshot_source: officialOrUserScreenshotSource,
    official_or_user_screenshot_source: officialOrUserScreenshotSource,
    gpt_image_2_callout_generated: generatedReviewLedger.passed === true && realGeneratedCount > 0,
    generated_image_ingested: realGeneratedCount > 0,
    callout_extraction_schema_valid: calloutExtractionSchemaValid,
    issue_ledger_from_generated_callout: issueLedger.extracted_from_generated_callout === true && realGeneratedCount > 0,
    p0_p1_zero_after_fix: p0P1ZeroAfterFix,
    fix_loop_executed_or_not_needed: fixLoopExecutedOrNotNeeded,
    changed_screens_rechecked: changedScreensRechecked,
    image_voxel_reference_anchor_created: imageVoxelReferenceAnchorCreated,
    image_voxel_relations_created: parts.imageVoxelRelationsCreated === true,
    image_voxel_relation_evidence: parts.imageVoxelRelationEvidence || null,
    wrongness_checked: wrongnessChecked,
    honest_mode_complete: honestModeComplete,
    required_artifacts: [
      IMAGE_UX_REVIEW_POLICY_ARTIFACT,
      IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT,
      IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT,
      IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT,
      IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT,
      IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT,
      IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT,
      IMAGE_UX_REVIEW_FIX_TASK_PLAN_ARTIFACT,
      IMAGE_UX_REVIEW_FIX_LOOP_ARTIFACT,
      IMAGE_UX_REVIEW_RECAPTURE_ARTIFACT,
      IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT
    ],
    blockers: referenceCloseoutPassed ? [] : rawBlockers,
    full_verification_blockers: rawBlockers,
    reference_closeout: {
      eligible: referenceCloseoutPassed,
      reason: referenceCloseoutPassed ? 'generated_review_image_unavailable_source_screenshot_captured' : null,
      cap: 'verified_partial',
      cannot_claim: [
        'gpt_image_2_callout_generated',
        'generated_image_ingested',
        'issue_ledger_from_generated_callout',
        'full_ux_review_passed'
      ]
    },
    source_reference_evidence: parts.sourceReferenceEvidence || null,
    honest_mode_evidence: honestModeEvidence,
    verification_caps: {
      text_only_review: 'blocked',
      mock_fixture: 'verified_partial_or_lower',
      codex_less_than_0_132_fallback: 'verified_partial_or_lower',
      missing_generated_image_reference_closeout: 'verified_partial_only'
    },
    notes: [
      'Do not pass this gate from direct text-only screenshot critique.',
      'Full verification passes only after source screenshots have real generated gpt-image-2 annotated review images and those generated images are extracted into issue rows.',
      'If generated annotated images are unavailable, a source-screenshot-only reference closeout may pass only as verified_partial and must preserve the missing generated-image facts.'
    ]
  };
  const required = IMAGE_UX_REVIEW_REQUIRED_GATE_FIELDS.filter((field) => field !== 'honest_mode_complete');
  const corePassed = required.every((field) => (gate as any)[field] === true);
  const fullPassed = corePassed && gate.honest_mode_complete === true && rawBlockers.length === 0;
  return {
    ...gate,
    passed: fullPassed || referenceCloseoutPassed,
    status: fullPassed
      ? 'passed'
      : referenceCloseoutPassed
        ? 'verified_partial_reference'
        : reviewReportCompleted
          ? 'review_completed'
          : 'blocked',
    verified_level: fullPassed
      ? 'verified'
      : referenceCloseoutPassed || reviewReportCompleted
        ? 'verified_partial'
        : 'blocked',
    full_review_passed: fullPassed,
    reference_only: referenceCloseoutPassed
  };
}

export async function writeImageUxReviewRouteArtifacts(dir: any, contract: any = {}, opts: any = {}) {
  const root = opts.root || rootFromMissionDir(String(dir));
  const policy = buildImageUxReviewPolicy(contract);
  let inventory = buildImageUxScreenInventory(contract);
  inventory = await hydrateImageUxScreenInventory(root, inventory);
  const existingGenerated = await readExistingJson(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT);
  const existingIssues = await readExistingJson(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT);
  const extractionReport = await readExistingJson(dir, IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT);
  const existingImagegenRequest = await readExistingJson(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT);
  const existingImagegenResponse = await readExistingJson(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT);
  const generatedReviewLedger = buildImageUxGeneratedReviewLedger(contract, inventory, existingGenerated, { root });
  const sourceReferenceEvidence = await ensureImageUxSourceReferenceEvidence(root, dir, inventory);
  const imageVoxelRelationEvidence = await ensureImageUxGeneratedRelationEvidence(
    root,
    dir,
    inventory,
    generatedReviewLedger,
    sourceReferenceEvidence
  );
  const issueLedger = buildImageUxIssueLedger(contract, generatedReviewLedger, existingIssues);
  const fixTaskPlan = planImageUxFixTasks(issueLedger);
  const fixLoop = runImageUxFixLoop(issueLedger, fixTaskPlan, opts.fixLoop || {});
  const recapturePlan = buildRecapturePlan(fixLoop, opts.recapture || {});
  const iterationReport = buildImageUxIterationReport(contract, policy, generatedReviewLedger, issueLedger, fixTaskPlan, fixLoop, recapturePlan);
  const outputSchema = await detectCodexExecResumeOutputSchema().catch((err: any) => ({ ok: true, status: 'integration_optional', warnings: [err.message] }));
  const honestModeEvidence = await ensureImageUxHonestModeEvidence(dir, {
    contract,
    inventory,
    generatedReviewLedger,
    issueLedger,
    fixLoop,
    recapturePlan,
    sourceReferenceEvidence
  }, { write: opts.honestModeComplete === true });
  const gate = defaultImageUxReviewGate(contract, {
    policy,
    inventory,
    generatedReviewLedger,
    issueLedger,
    fixTaskPlan,
    fixLoop,
    recapturePlan,
    iterationReport,
    imageVoxelReferenceAnchorCreated: sourceReferenceEvidence.ok === true,
    imageVoxelRelationsCreated: opts.imageVoxelRelationsCreated === true || imageVoxelRelationEvidence.ok === true,
    imageVoxelRelationEvidence,
    wrongnessChecked: opts.wrongnessChecked === true,
    honestModeComplete: honestModeEvidence.ok === true,
    honestModeEvidenceRequired: true,
    honestModeEvidence,
    sourceReferenceEvidence
  });
  const imagegenRequest = existingImagegenRequest || buildImagegenRequestArtifact(contract, inventory);
  const imagegenResponse = existingImagegenResponse || buildImagegenResponseArtifact(generatedReviewLedger);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_POLICY_ARTIFACT), policy);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT), inventory);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_IMAGEGEN_REQUEST_ARTIFACT), imagegenRequest);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT), imagegenRequest);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT), imagegenResponse);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), generatedReviewLedger);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT), issueLedger);
  if (extractionReport) await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT), extractionReport);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_FIX_TASK_PLAN_ARTIFACT), fixTaskPlan);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_FIX_LOOP_ARTIFACT), fixLoop);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_RECAPTURE_ARTIFACT), recapturePlan);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT), iterationReport);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GATE_ARTIFACT), gate);
  return {
    policy,
    inventory,
    imagegen_request: imagegenRequest,
    imagegen_response: imagegenResponse,
    generated_review_ledger: generatedReviewLedger,
    issue_ledger: issueLedger,
    callout_extraction_report: extractionReport,
    fix_task_plan: fixTaskPlan,
    fix_loop: fixLoop,
    recapture_plan: recapturePlan,
    iteration_report: iterationReport,
    output_schema: outputSchema,
    honest_mode_evidence: honestModeEvidence,
    gate
  };
}

export function imageUxReviewProofEvidence(gate: any = {}, artifacts: any = {}) {
  const issueLedger = artifacts.issue_ledger || {};
  const generated = artifacts.generated_review_ledger || {};
  const referenceOnly = gate.reference_only === true;
  const realGeneratedImages = (generated.generated_review_images || []).filter((image: any) => image.real_generated === true && image.mock !== true);
  return {
    schema: 'sks.image-ux-review-proof-evidence.v1',
    status: referenceOnly ? 'verified_partial' : gate.passed ? 'verified' : generated.generated_count ? 'verified_partial' : artifacts.inventory?.passed ? 'verified_partial' : 'blocked',
    reference_only: referenceOnly,
    reference_closeout_status: referenceOnly ? 'source_screenshot_only_real_generated_image_unavailable' : null,
    source_screenshots_count: artifacts.inventory?.source_screens?.length || 0,
    generated_gpt_image_2_callout_images_count: generated.real_generated_count || 0,
    generated_images_total: generated.generated_count || 0,
    non_real_generated_images_total: generated.non_real_generated_count || 0,
    callout_extraction_schema_status: issueLedger.validation?.ok ? 'valid' : 'blocked',
    callout_extraction_report_status: artifacts.callout_extraction_report?.validation_status || (issueLedger.validation?.ok ? 'valid' : 'missing_or_blocked'),
    open_p0_p1_count: issueLedger.blocking_issue_count || 0,
    fixed_p0_p1_count: (issueLedger.issues || []).filter((issue: any) => ['P0', 'P1'].includes(issue.severity) && issue.status === 'fixed').length,
    recapture_re_review_status: artifacts.recapture_plan?.changed_screens_rechecked_or_not_applicable ? 'complete_or_not_applicable' : 'blocked',
    image_voxel_relation_count: referenceOnly
      ? 0
      : gate.image_voxel_relations_created === true ? realGeneratedImages.length : 0,
    computer_use_evidence_mode: artifacts.inventory?.source_screens?.some((screen: any) => screen.capture_source === 'codex_native_computer_use_screenshot' || screen.capture_source === 'codex_computer_use_screenshot') ? 'native_computer_use_source_screenshot' : artifacts.inventory?.source_screens?.some((screen: any) => screen.capture_source === 'codex_chrome_extension_screenshot') ? 'chrome_extension_source_screenshot' : 'user_or_static_screenshot',
    claims: {
      ux_review_source_screenshot_verified: artifacts.inventory?.passed === true,
      ux_review_gpt_image_2_callouts_generated: (generated.real_generated_count || 0) > 0,
      ux_review_issues_extracted_from_callout_image: referenceOnly ? false : issueLedger.extracted_from_generated_callout === true,
      ux_review_p0_p1_fixed_or_blocked: (issueLedger.blocking_issue_count || 0) === 0 || (gate.blockers || []).length > 0,
      ux_review_changed_screens_rechecked: artifacts.recapture_plan?.changed_screens_rechecked_or_not_applicable === true,
      ux_review_image_voxel_relations_verified: referenceOnly
        ? gate.source_reference_evidence?.ok === true
        : gate.image_voxel_relations_created === true
    },
    full_verification_blockers: gate.full_verification_blockers || gate.blockers || [],
    blockers: gate.blockers || []
  };
}

async function ensureImageUxSourceReferenceEvidence(root: string, dir: string, inventory: any = {}) {
  const missionId = path.basename(String(dir));
  const capturedScreens = (inventory.source_screens || []).filter((screen: any) => screen.status === 'captured' && screen.source);
  if (!missionId || !capturedScreens.length) {
    return {
      schema: 'sks.image-ux-source-reference-evidence.v1',
      ok: false,
      reason: capturedScreens.length ? 'mission_id_missing' : 'captured_source_screenshot_missing',
      anchors: 0
    };
  }
  const anchors: string[] = [];
  const issues: string[] = [];
  for (const screen of capturedScreens) {
    const imageId = `${missionId}-${screen.id}-source`;
    try {
      await ingestImage(root, screen.source, {
        missionId,
        source: 'image-ux-review:source-screenshot-reference',
        id: imageId
      });
      const width = Math.max(1, Number(screen.width || screen.original_resolution?.width || 1));
      const height = Math.max(1, Number(screen.height || screen.original_resolution?.height || 1));
      const anchorId = `${imageId}-reference-anchor`;
      const anchor = await addVisualAnchor(root, {
        id: anchorId,
        missionId,
        imageId,
        bbox: [0, 0, width, height],
        label: `Source screenshot ${screen.id} reference-only UX review`,
        source: 'image-ux-review:reference-only-closeout',
        evidencePath: IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT,
        route: '$Image-UX-Review',
        trustScore: 0.62
      });
      if (anchor.ok) anchors.push(anchorId);
      else issues.push(...(anchor.validation?.issues || [`anchor_failed:${screen.id}`]));
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    schema: 'sks.image-ux-source-reference-evidence.v1',
    ok: anchors.length > 0 && issues.length === 0,
    mode: 'source_screenshot_reference_only',
    anchors: anchors.length,
    anchor_ids: anchors,
    issues
  };
}

async function ensureImageUxGeneratedRelationEvidence(
  root: string,
  dir: string,
  inventory: any = {},
  generatedReviewLedger: any = {},
  sourceReferenceEvidence: any = {}
) {
  const missionId = path.basename(String(dir));
  const sourceScreen = (inventory.source_screens || []).find((screen: any) => screen.status === 'captured' && screen.source);
  const generatedImages = (generatedReviewLedger.generated_review_images || [])
    .filter((image: any) => image.real_generated === true && image.mock !== true && image.path);
  if (!missionId || !sourceScreen || !generatedImages.length || sourceReferenceEvidence.ok !== true) {
    return {
      schema: 'sks.image-ux-generated-relation-evidence.v1',
      ok: false,
      reason: !missionId
        ? 'mission_id_missing'
        : !sourceScreen
          ? 'captured_source_screenshot_missing'
          : !generatedImages.length
            ? 'real_generated_image_missing'
            : 'source_reference_anchor_missing',
      relations: 0,
      issues: []
    };
  }
  const sourceImageId = `${missionId}-${sourceScreen.id}-source`;
  const anchorIds = Array.isArray(sourceReferenceEvidence.anchor_ids) ? sourceReferenceEvidence.anchor_ids : [];
  const relationIds: string[] = [];
  const issues: string[] = [];
  for (const image of generatedImages) {
    const generatedImageId = `${missionId}-${image.id}`;
    try {
      const ingested = await ingestImage(root, image.path, {
        missionId,
        source: 'image-ux-review:gpt-image-2-generated-callout',
        id: generatedImageId
      });
      if (!ingested.ok) {
        issues.push(...(ingested.validation?.issues || [`generated_image_ingest_failed:${image.id}`]));
        continue;
      }
      const relation = await addImageRelation(root, {
        missionId,
        route: '$Image-UX-Review',
        type: 'generated_callout_review_of',
        beforeImageId: sourceImageId,
        afterImageId: generatedImageId,
        sourceImageId,
        generatedImageId,
        anchors: anchorIds,
        status: 'verified_partial',
        verification: 'gpt-image-2-generated-callout-bound-to-source'
      });
      if (relation.ok) relationIds.push(`${sourceImageId}->${generatedImageId}`);
      else issues.push(...(relation.validation?.issues || [`generated_image_relation_failed:${image.id}`]));
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    schema: 'sks.image-ux-generated-relation-evidence.v1',
    ok: relationIds.length === generatedImages.length && issues.length === 0,
    relations: relationIds.length,
    relation_ids: relationIds,
    anchor_ids: anchorIds,
    issues
  };
}

async function ensureImageUxHonestModeEvidence(dir: string, parts: any = {}, opts: any = {}) {
  const missionId = path.basename(String(dir));
  const existing = await readExistingJson(dir, IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT);
  let report = existing;
  if (!report && opts.write === true) {
    const inventory = parts.inventory || {};
    const generated = parts.generatedReviewLedger || {};
    const issues = parts.issueLedger || {};
    const sourceEvidence = parts.sourceReferenceEvidence || {};
    const sourceCaptured = inventory.passed === true && Number(inventory.source_screens?.length || 0) > 0;
    const generatedMissing = Number(generated.real_generated_count || 0) === 0 && Number(generated.required_count || 0) > 0;
    report = {
      schema: 'sks.final-honest-mode-report.v1',
      created_at: nowIso(),
      mission_id: missionId,
      route: '$Image-UX-Review',
      verified: [
        ...(sourceCaptured ? [{
          claim: 'Source screenshot was captured or provided with hash/dimensions in the Image UX inventory.',
          evidence: [IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT]
        }] : []),
        ...(sourceEvidence.ok === true ? [{
          claim: 'Source screenshot has a mission-scoped Image Voxel anchor for reference-only evidence.',
          evidence: ['image-voxel-ledger.json', 'visual-anchors.json', IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT]
        }] : []),
        ...(generatedMissing ? [{
          claim: 'No real generated gpt-image-2 annotated review image is recorded; fake/mock generated images are not counted as full UX evidence.',
          evidence: [IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT]
        }] : []),
        ...(issues.validation?.ok === true ? [{
          claim: 'Issue ledger schema validation ran; no generated-callout issue extraction is claimed for reference-only closeout.',
          evidence: [IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT]
        }] : [])
      ],
      unverified: [
        ...(generatedMissing ? ['No real generated gpt-image-2 annotated review image exists, so annotated-image callouts and full UX verification remain unverified.'] : []),
        ...(issues.extracted_from_generated_callout !== true ? ['No issue row was extracted from a generated annotated callout image.'] : [])
      ],
      blocked: [
        ...(generatedMissing ? [{
          item: 'full_image_ux_review_verification',
          reason: 'real_generated_gpt_image_2_annotated_review_image_unavailable'
        }] : [])
      ],
      risks: [
        'Reference-only closeout is useful for stopping compliance loops, but it must not be presented as a full generated-image UX review.'
      ]
    };
    await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT), report);
  }
  const validation = report ? validateFinalHonestModeReport(report) : validateFinalHonestModeReport({});
  return {
    schema: 'sks.image-ux-honest-mode-evidence.v1',
    ok: validation.ok,
    artifact: IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT,
    validation
  };
}

export async function buildImageUxCalloutExtractionReport(root: string, extraction: any = {}, opts: any = {}) {
  const generatedPath = opts.generatedImagePath || null;
  const sourcePath = opts.sourceImagePath || null;
  const generatedSha = extraction.generated_image_sha256 || (generatedPath ? await sha256File(resolveImagePath(root, generatedPath)).catch(() => null) : null);
  const sourceSha = sourcePath ? await sha256File(resolveImagePath(root, sourcePath)).catch(() => null) : null;
  const ledger = extraction.issue_ledger || {};
  const validationIssues = Array.isArray(ledger.validation?.issues) ? ledger.validation.issues : [];
  const bboxIssues = validationIssues.filter((item: any) => /bbox|bounds|coordinate/i.test(String(item)));
  const issues = Array.isArray(ledger.issues) ? ledger.issues : [];
  const confidences = issues.map((issue: any) => Number(issue.confidence)).filter(Number.isFinite);
  const averageConfidence = confidences.length
    ? Number((confidences.reduce((sum: number, value: number) => sum + value, 0) / confidences.length).toFixed(3))
    : null;
  const blocker = extraction.blocker?.reason || extraction.blocker || (extraction.ok ? null : 'callout_extraction_unavailable');
  return {
    schema: 'sks.image-ux-callout-extraction-report.v1',
    created_at: nowIso(),
    provider: extraction.provider || opts.provider || 'unknown',
    analysis_input: 'generated_annotated_review_image',
    generated_image_is_primary_evidence: true,
    source_screenshot_used_for_extraction: false,
    generated_image_id: opts.generatedImageId || ledger.generated_image_id || issues[0]?.generated_review_image_id || null,
    generated_image_path: generatedPath,
    generated_image_sha256: generatedSha,
    source_screenshot_sha256: sourceSha,
    output_schema_path: 'schemas/codex/image-ux-issue-ledger.schema.json',
    parsed_json_present: Boolean(extraction.ok && ledger.schema),
    validation_status: ledger.validation?.ok ? 'valid' : 'blocked',
    issue_count: issues.length,
    bbox_validation_issues: bboxIssues,
    extraction_confidence_summary: {
      issue_count: issues.length,
      average_confidence: averageConfidence,
      min_confidence: confidences.length ? Math.min(...confidences) : null,
      max_confidence: confidences.length ? Math.max(...confidences) : null
    },
    blocker,
    fallback_used: extraction.provider === 'openai_structured_outputs',
    verified_cap: extraction.ok ? 'verified' : 'blocked',
    passed: extraction.ok === true && ledger.validation?.ok === true && issues.length > 0
  };
}

function buildImagegenRequestArtifact(contract: any, inventory: any) {
  return {
    schema: 'sks.image-ux-gpt-image-2-request.v1',
    created_at: nowIso(),
    model: 'gpt-image-2',
    surface: 'Codex App $imagegen',
    endpoint: 'Codex App $imagegen or OpenAI /v1/images/edits fallback',
    api_docs: IMAGE_UX_REVIEW_API_DOC_URL,
    privacy: 'local-only',
    requests: (inventory.source_screens || []).map((screen: any) => ({
      source_screen_id: screen.id,
      source_image_path: screen.source,
      source_sha256: screen.sha256 || null,
      requested_fidelity: 'high_fidelity_automatic',
      image_input_fidelity_note: 'gpt-image-2 high-fidelity image input is automatic; do not send input_fidelity.',
      output_dir: 'mission',
      prompt: buildCalloutPrompt(screen.id, { target: inventory.target || contract.prompt })
    })),
    blocker_if_unavailable: imagegenCapabilityBlocker()
  };
}

function buildImagegenResponseArtifact(generatedReviewLedger: any = {}) {
  const image = (generatedReviewLedger.generated_review_images || [])[0] || null;
  return {
    schema: 'sks.image-ux-gpt-image-2-response.v1',
    created_at: nowIso(),
    provider: image?.provider_surface || generatedReviewLedger.provider?.preferred_surface || 'none',
    evidence_class: image?.evidence_class || (image?.mock ? 'mock_fixture' : image?.real_generated ? 'codex_app_imagegen' : null),
    model: 'gpt-image-2',
    ok: generatedReviewLedger.passed === true,
    status: generatedReviewLedger.passed === true ? 'generated' : 'blocked_or_pending',
    output_image_path: image?.path || null,
    output_image_sha256: image?.sha256 || null,
    output_sha256: image?.output_sha256 || image?.sha256 || null,
    output_source: image?.output_source || (image?.mock ? 'mock_fixture' : image?.real_generated ? 'manual_attach' : null),
    output_id: image?.output_id || null,
    dimensions: image ? { width: image.width || null, height: image.height || null, format: image.format || null } : null,
    latency_ms: image?.latency_ms || null,
    token_cost_metadata: image?.token_cost_metadata || null,
    local_only: true,
    blockers: generatedReviewLedger.blockers || []
  };
}

function generatedReviewImageMissingBlocker() {
  return {
    schema: 'sks.image-ux-generated-review-image-blocker.v1',
    status: 'blocked',
    blocker: 'generated_review_image_missing',
    surface: 'Codex App $imagegen',
    model: 'gpt-image-2',
    guidance: 'Attach a real generated gpt-image-2 annotated review image path with sha256 and dimensions. Without that artifact SKS may close only as verified_partial reference evidence.'
  };
}

function normalizeGeneratedReviewImage(image: any = {}, screen: any = {}, opts: any = {}) {
  const sourceScreenId = image.source_screen_id || screen.id || 'screen-1';
  const fileEvidence = generatedImageFileEvidence(opts.root, image);
  const sha256 = fileEvidence.sha256 || image.sha256 || null;
  const width = Number(image.width || 0) > 0 ? Number(image.width) : null;
  const height = Number(image.height || 0) > 0 ? Number(image.height) : null;
  const evidenceBlockers = generatedImageEvidenceBlockers(image, { ...fileEvidence, sha256, width, height });
  const realGenerated = image.real_generated === true
    && image.mock !== true
    && image.source !== 'mock_fixture'
    && evidenceBlockers.length === 0;
  return {
    ...image,
    id: image.id || compactId('generated-review', `${sourceScreenId}:${image.path || nowIso()}`),
    source_screen_id: sourceScreenId,
    path: image.path || null,
    sha256,
    width,
    height,
    provider_model: image.provider_model || image.model || 'gpt-image-2',
    provider_surface: image.provider_surface || 'Codex App $imagegen',
    requested_fidelity: image.requested_fidelity || 'high_fidelity_automatic',
    image_input_fidelity_note: image.image_input_fidelity_note || 'gpt-image-2 high-fidelity image input is automatic',
    privacy: image.privacy || 'local-only',
    real_generated: realGenerated,
    claimed_real_generated: image.real_generated === true,
    evidence_verified: realGenerated,
    evidence_blockers: evidenceBlockers,
    file_evidence_checked: fileEvidence.checked,
    file_evidence_path: fileEvidence.path || null,
    mock: image.mock === true || image.source === 'mock_fixture',
    callout_extraction_required: true,
    callout_extraction_status: Array.isArray(image.callouts) && image.callouts.length ? 'succeeded' : (image.callout_extraction_status || 'pending'),
    callouts: Array.isArray(image.callouts) ? image.callouts : [],
    image_size_relation: {
      source_width: screen.width || null,
      source_height: screen.height || null,
      generated_width: width,
      generated_height: height,
      coordinate_transform: width && screen.width && height && screen.height
        ? width === screen.width && height === screen.height ? 'identity' : 'scaled'
        : 'unknown'
    },
    image_voxel_relation: image.image_voxel_relation || (image.id && sourceScreenId ? 'generated_callout_review_of' : null)
  };
}

function generatedImageEvidenceBlockers(image: any = {}, evidence: any = {}) {
  if (image.real_generated !== true || image.mock === true || image.source === 'mock_fixture') return [];
  const blockers: string[] = [];
  const evidenceClass = String(image.evidence_class || '');
  const outputSource = String(image.output_source || '');
  const outputSha = String(image.output_sha256 || image.output_image_sha256 || '');
  blockers.push(...imagegenEvidenceClassBlockers('generated_review_image', evidenceClass));
  if (outputSource && !isFullImagegenOutputSource(outputSource)) blockers.push(`generated_review_image_output_source_invalid:${outputSource}`);
  if (!outputSha) blockers.push('generated_review_image_output_sha256_missing');
  else if (evidence.sha256 && outputSha !== evidence.sha256) blockers.push('generated_review_image_output_sha256_mismatch');
  if (!image.path) blockers.push('generated_review_image_missing');
  if (!evidence.sha256) blockers.push('generated_review_image_sha256_missing');
  if (!evidence.width || !evidence.height) blockers.push('generated_review_image_dimensions_missing');
  blockers.push(...(evidence.blockers || []));
  return [...new Set(blockers)];
}

function generatedImageFileEvidence(root: any, image: any = {}) {
  const imagePath = image.path ? String(image.path) : '';
  if (!root) {
    const blockers = image.real_generated === true ? ['generated_review_image_file_evidence_unchecked'] : [];
    return { checked: false, path: imagePath || null, sha256: null, blockers };
  }
  if (!imagePath) return { checked: true, path: null, sha256: null, blockers: [] };
  const absolute = path.isAbsolute(imagePath) ? imagePath : path.resolve(String(root), imagePath);
  if (!fs.existsSync(absolute)) {
    return { checked: true, path: absolute, sha256: null, blockers: ['generated_review_image_file_missing'] };
  }
  try {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    const blockers = image.sha256 && image.sha256 !== sha ? ['generated_review_image_sha256_mismatch'] : [];
    return { checked: true, path: absolute, sha256: sha, blockers };
  } catch {
    return { checked: true, path: absolute, sha256: null, blockers: ['generated_review_image_unreadable'] };
  }
}

function resolveImagePath(root: string, source: any) {
  const raw = String(source || '');
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

function rootFromMissionDir(dir: string) {
  const marker = `${path.sep}.sneakoscope${path.sep}missions${path.sep}`;
  const idx = dir.indexOf(marker);
  return idx >= 0 ? dir.slice(0, idx) : process.cwd();
}

async function readExistingJson(dir: any, file: any) {
  try {
    const raw = await fsp.readFile(path.join(dir, file), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
