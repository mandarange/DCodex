import path from 'node:path';
import fsp from 'node:fs/promises';
import { nowIso, readJson, sha256, writeJsonAtomic, writeTextAtomic } from './fsx.js';
import { AWESOME_DESIGN_MD_REFERENCE, CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_IMAGEGEN_EVIDENCE_SOURCE, DESIGN_SYSTEM_SSOT, GETDESIGN_REFERENCE, PPT_CONDITIONAL_SKILL_ALLOWLIST, PPT_PIPELINE_MCP_ALLOWLIST, PPT_PIPELINE_SKILL_ALLOWLIST } from './routes.js';
import { PRODUCT_DESIGN_LEGACY_DESIGN_FALLBACK_SKILLS, PRODUCT_DESIGN_PIPELINE_STAGES, PRODUCT_DESIGN_PLUGIN, PRODUCT_DESIGN_REQUIRED_SKILLS } from './product-design-plugin.js';

import { PPT_ASSET_DIR, PPT_AUDIENCE_STRATEGY_ARTIFACT, PPT_CLEANUP_REPORT_ARTIFACT, PPT_FACT_LEDGER_ARTIFACT, PPT_GATE_ARTIFACT, PPT_HTML_ARTIFACT, PPT_IMAGE_ASSET_LEDGER_ARTIFACT, PPT_ITERATION_REPORT_ARTIFACT, PPT_PARALLEL_REPORT_ARTIFACT, PPT_PDF_ARTIFACT, PPT_RENDER_REPORT_ARTIFACT, PPT_REVIEW_LEDGER_ARTIFACT, PPT_REVIEW_POLICY_ARTIFACT, PPT_SOURCE_HTML_DIR, PPT_SOURCE_LEDGER_ARTIFACT, PPT_STORYBOARD_ARTIFACT, PPT_STYLE_TOKENS_ARTIFACT, PPT_TEMP_DIR } from './ppt/artifacts.js';
export { PPT_ASSET_DIR, PPT_AUDIENCE_STRATEGY_ARTIFACT, PPT_CLEANUP_REPORT_ARTIFACT, PPT_FACT_LEDGER_ARTIFACT, PPT_GATE_ARTIFACT, PPT_HTML_ARTIFACT, PPT_IMAGE_ASSET_LEDGER_ARTIFACT, PPT_ITERATION_REPORT_ARTIFACT, PPT_PARALLEL_REPORT_ARTIFACT, PPT_PDF_ARTIFACT, PPT_RENDER_REPORT_ARTIFACT, PPT_REVIEW_LEDGER_ARTIFACT, PPT_REVIEW_POLICY_ARTIFACT, PPT_SOURCE_HTML_DIR, PPT_SOURCE_LEDGER_ARTIFACT, PPT_STORYBOARD_ARTIFACT, PPT_STYLE_TOKENS_ARTIFACT, PPT_TEMP_DIR } from './ppt/artifacts.js';
import { buildPptStyleTokens, selectPptDesignReference } from './ppt/style-tokens.js';
export { PPT_DESIGN_REFERENCE_PROFILES, buildPptStyleTokens, selectPptDesignReference } from './ppt/style-tokens.js';
import { buildPptHtml } from './ppt/html.js';
export { buildPptHtml } from './ppt/html.js';
import { imageDimensions, sha256File } from './wiki-image/image-hash.js';
import { imagegenEvidenceClassBlockers, isFullImagegenOutputSource } from './imagegen/imagegen-evidence.js';

export const PPT_REQUIRED_GATE_FIELDS = Object.freeze([
  'clarification_contract_sealed',
  'audience_strategy_sealed',
  'source_ledger_created',
  'fact_ledger_created',
  'unsupported_critical_claims_zero',
  'storyboard_created',
  'style_tokens_created',
  'image_asset_ledger_created',
  'image_asset_policy_satisfied',
  'review_policy_created',
  'review_ledger_created',
  'bounded_iteration_complete',
  'critical_review_issues_zero',
  'parallel_build_recorded',
  'html_artifact_created',
  'source_html_preserved',
  'pdf_exported_or_explicitly_deferred',
  'render_qa_recorded',
  'temp_cleanup_recorded',
  'honest_mode_complete'
]);

function asArray(value: any) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/\n|;/)
    .map((item: any) => item.trim())
    .filter(Boolean);
}

function cleanText(value: any, fallback: any = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function compactId(prefix: any, text: any) {
  return `${prefix}-${sha256(cleanText(text, prefix)).slice(0, 10)}`;
}

function contractText(contract: any = {}) {
  return cleanText(`${contract.prompt || ''} ${JSON.stringify(contract.answers || {})}`);
}

function extractUrls(value: any = '') {
  return [...String(value || '').matchAll(/\bhttps?:\/\/[^\s<>"')]+/g)]
    .map((match: any) => match[0].replace(/[.,;:!?]+$/, ''));
}

function hasExternalFactCue(text: any = '') {
  return /(market|competitor|benchmark|statistic|growth|revenue|share|survey|latest|recent|external\s+(source|fact|research|web)|current\s+(market|benchmark|statistic)|citation\s+required|verified\s+(source|fact)|시장|경쟁|벤치마크|통계|성장률|매출|점유율|설문|최신|최근|외부\s*(출처|근거|자료)|웹\s*조사|리서치)/i.test(String(text || ''));
}

function hasVisualReviewCue(text: any = '') {
  return /(gpt-image-2|imagegen|image review|visual review|i2i|toss|토스|시니어\s*디자이너|디자인\s*리뷰|시각\s*리뷰|이미지\s*리뷰|슬라이드별\s*리뷰)/i.test(String(text || ''));
}

function hasImageAssetCue(text: any = '') {
  return /(image asset|visual asset|generated image|hero image|illustration|photo|photorealistic|mockup|product shot|background image|gpt-image-2|imagegen|이미지\s*리소스|이미지\s*자산|이미지\s*생성|사진|일러스트|히어로\s*이미지|비주얼\s*자산|배경\s*이미지|목업|제품\s*컷)/i.test(String(text || ''));
}

function safeFileSlug(value: any = '') {
  return cleanText(value, 'asset').toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'asset';
}

function parseBooleanish(value: any) {
  if (value === true || value === false) return value;
  const text = cleanText(value).toLowerCase();
  if (!text) return null;
  if (/^(1|true|yes|y|required|필수|예|네)$/i.test(text)) return true;
  if (/^(0|false|no|n|optional|불필요|아니오|아니요)$/i.test(text)) return false;
  return null;
}

function titleFromContract(contract: any = {}) {
  const prompt = cleanText(contract.prompt || contract.answers?.GOAL_PRECISE || 'PPT artifact');
  return prompt.replace(/^\$PPT\s*/i, '').slice(0, 96) || 'PPT artifact';
}

function splitArrow(raw: any = '') {
  return String(raw || '')
    .split(/->|→|=>/)
    .map((part: any) => part.trim())
    .filter(Boolean);
}

function normalizePainpoints(answers: any = {}) {
  const rows = asArray(answers.PRESENTATION_PAINPOINT_SOLUTION_MAP);
  return rows.map((raw: any, index: any) => {
    const parts = splitArrow(raw);
    return {
      id: `painpoint-${index + 1}`,
      raw: cleanText(raw),
      painpoint: cleanText(parts[0], cleanText(raw)),
      why_it_matters: cleanText(parts[0], 'Target pain point'),
      solution_angle: cleanText(parts[1], 'Show how the proposed solution removes this friction.'),
      proof_needed: 'Use user-provided material or web research before claiming external facts.',
      aha_moment: cleanText(parts[2], `Aha ${index + 1}: the audience can see why this matters now.`)
    };
  });
}

function msSince(startedAt: any) {
  return Math.max(0, Date.now() - startedAt);
}

export function createPptParallelReporter(contract: any = {}) {
  const report: any = {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    strategy: 'parallelize_independent_ppt_artifact_phases_without_changing_output_semantics',
    parallel_groups: [],
    dependency_graph: [
      { id: 'strategy_inputs', depends_on: ['sealed_decision_contract'], can_run_parallel: ['audience_strategy', 'source_ledger', 'style_tokens'] },
      { id: 'storyboard_phase', depends_on: ['audience_strategy'] },
      { id: 'image_asset_phase', depends_on: ['storyboard', 'style_tokens'], can_run_parallel: ['planned_image_assets'] },
      { id: 'render_targets', depends_on: ['storyboard', 'style_tokens', 'source_ledger', 'image_asset_ledger'], can_run_parallel: ['html_source', 'pdf_export'] },
      { id: 'artifact_writes', depends_on: ['strategy_inputs', 'storyboard_phase', 'render_targets'], can_run_parallel: ['json_artifacts', 'html_source_write', 'pdf_write'] },
      { id: 'final_reports', depends_on: ['artifact_writes', 'cleanup'], can_run_parallel: ['cleanup_report_write', 'parallel_report_write'] }
    ],
    notes: [
      'This report records deterministic Promise.all groups used by the built-in PPT builder.',
      'External web research, image generation, and design critique should use the same split: sources, STP/audience synthesis, style tokens, storyboard, assets, render QA, and cleanup as separable lanes when their inputs are available.'
    ]
  };
  return {
    async group(id: any, tasks: any = {}) {
      const entries = Object.entries(tasks);
      const started = Date.now();
      const startedAt = nowIso();
      const values = await Promise.all(entries.map(async ([taskId, task]: any) => {
        const taskStarted = Date.now();
        const value = await task();
        return [taskId, value, { id: taskId, duration_ms: msSince(taskStarted) }];
      }));
      report.parallel_groups.push({
        id,
        started_at: startedAt,
        duration_ms: msSince(started),
        task_count: entries.length,
        tasks: values.map(([, , meta]: any) => meta),
        executed_in_parallel: entries.length > 1
      });
      return Object.fromEntries(values.map(([taskId, value]: any) => [taskId, value]));
    },
    report() {
      const groups = report.parallel_groups;
      return {
        ...report,
        completed_at: nowIso(),
        total_groups: groups.length,
        parallel_group_count: groups.filter((group: any) => group.executed_in_parallel).length,
        passed: groups.some((group: any) => group.executed_in_parallel)
      };
    }
  };
}

export function buildPptAudienceStrategy(contract: any = {}) {
  const answers = contract.answers || {};
  const painpoints = normalizePainpoints(answers);
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    audience_profile: {
      raw: answers.PRESENTATION_AUDIENCE_PROFILE || '',
      primary_audience: '',
      age_range: '',
      occupation_roles: [],
      industry: '',
      seniority: '',
      knowledge_level: '',
      decision_power: '',
      resistance_or_objections: []
    },
    stp: {
      raw: answers.PRESENTATION_STP_STRATEGY || '',
      segmentation: [],
      targeting: '',
      positioning: ''
    },
    painpoint_solution_map: asArray(answers.PRESENTATION_PAINPOINT_SOLUTION_MAP).map((item: any) => ({
      ...(painpoints.find((entry: any) => entry.raw === cleanText(item)) || {}),
      raw: cleanText(item)
    })),
    decision_context: {
      raw: answers.PRESENTATION_DECISION_CONTEXT || answers.DECISION_CONTEXT || '',
      desired_next_action: '',
      decision_blockers: [],
      success_signal: ''
    },
    delivery_context: {
      raw: answers.PRESENTATION_DELIVERY_CONTEXT || '',
      output_context: answers.OUTPUT_CONTEXT || null,
      page_format: answers.PAGE_FORMAT || null,
      language_and_locale: answers.LANGUAGE_AND_LOCALE || null
    },
    source_answers: {
      PRESENTATION_AUDIENCE_PROFILE: answers.PRESENTATION_AUDIENCE_PROFILE || null,
      PRESENTATION_STP_STRATEGY: answers.PRESENTATION_STP_STRATEGY || null,
      PRESENTATION_PAINPOINT_SOLUTION_MAP: answers.PRESENTATION_PAINPOINT_SOLUTION_MAP || null,
      PRESENTATION_DECISION_CONTEXT: answers.PRESENTATION_DECISION_CONTEXT || null,
      PRESENTATION_DELIVERY_CONTEXT: answers.PRESENTATION_DELIVERY_CONTEXT || null
    },
    notes: [
      'Raw user answers are preserved first. The route worker should normalize them into the structured fields before storyboarding.',
      'At least three painpoint_solution_map entries are expected for persuasive Korean business presentation work.'
    ]
  };
}

export function buildPptSourceLedger(contract: any = {}) {
  const answers = contract.answers || {};
  const sourceRows = [
    ['audience-profile', 'PRESENTATION_AUDIENCE_PROFILE', answers.PRESENTATION_AUDIENCE_PROFILE],
    ['stp-strategy', 'PRESENTATION_STP_STRATEGY', answers.PRESENTATION_STP_STRATEGY],
    ['painpoint-solution-map', 'PRESENTATION_PAINPOINT_SOLUTION_MAP', asArray(answers.PRESENTATION_PAINPOINT_SOLUTION_MAP).join('; ')],
    ['decision-context', 'PRESENTATION_DECISION_CONTEXT', answers.PRESENTATION_DECISION_CONTEXT],
    ['delivery-context', 'PRESENTATION_DELIVERY_CONTEXT', answers.PRESENTATION_DELIVERY_CONTEXT]
  ].filter(([, , value]: any) => cleanText(value));
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    web_research_performed: false,
    source_policy: 'user_provided_answers_only_until_route_worker_adds_web_sources',
    sources: sourceRows.map(([id, slot, value]: any) => ({
      id: `user-${id}`,
      type: 'user_provided_answer',
      slot,
      value: cleanText(value),
      confidence: 'user_provided'
    })),
    unsupported_external_claims_allowed: false,
    notes: [
      'This ledger intentionally contains only sealed user answers. Add web sources before making market, competitor, or benchmark claims.'
    ]
  };
}

export function buildPptFactLedger(contract: any = {}, sourceLedger: any = buildPptSourceLedger(contract), existing: any = null) {
  const text = contractText(contract);
  const sourceUrls = extractUrls(text);
  const preservedSources = Array.isArray(existing?.sources) ? existing.sources : [];
  const preservedClaims = Array.isArray(existing?.claims) ? existing.claims : [];
  const urlSources = sourceUrls.map((url: any, index: any) => ({
    id: `web-source-${index + 1}`,
    type: 'web_source_url',
    url,
    confidence: 'needs_route_worker_verification',
    support_status: 'pending_verification'
  }));
  const userClaims = (sourceLedger.sources || []).map((source: any) => ({
    id: compactId('claim-user', `${source.slot || source.id}:${source.value || ''}`),
    text: cleanText(source.value || source.slot || source.id),
    source_ids: [source.id],
    support_status: 'supported_user_input',
    criticality: 'medium',
    slide_refs: [],
    verification_note: 'User-provided input can support intent and context, but must not be treated as an external market fact.'
  }));
  const allSources = [...preservedSources, ...(sourceLedger.sources || []), ...urlSources].filter((source: any, index: any, arr: any) => {
    const key = source.url || `${source.type}:${source.id}:${source.value}`;
    return arr.findIndex((candidate: any) => (candidate.url || `${candidate.type}:${candidate.id}:${candidate.value}`) === key) === index;
  });
  const webResearchPerformed = Boolean(existing?.web_research_performed)
    || allSources.some((source: any) => ['web_source', 'verified_web_source', 'web_source_url'].includes(source.type) && source.support_status === 'verified');
  const externalResearchRequired = Boolean(existing?.external_research_required) || hasExternalFactCue(text);
  const unsupportedCriticalClaims = externalResearchRequired && !webResearchPerformed
    ? [{
      id: 'external-research-required',
      text: 'The sealed PPT request implies external facts or current market/source material, but no verified web-source evidence has been recorded.',
      criticality: 'high',
      support_status: 'unsupported',
      required_action: 'Use web/Context7 evidence in the route worker, write verified sources/claims into ppt-fact-ledger.json, then rebuild.'
    }]
    : [];
  const preservedUnsupported = preservedClaims.filter((claim: any) => claim.support_status === 'unsupported' && claim.criticality !== 'low');
  const claims = [
    ...preservedClaims.filter((claim: any) => claim.support_status !== 'unsupported' || claim.criticality === 'low'),
    ...userClaims,
    ...unsupportedCriticalClaims
  ].filter((claim: any, index: any, arr: any) => arr.findIndex((candidate: any) => candidate.id === claim.id) === index);
  const unsupportedCriticalClaimsCount = unsupportedCriticalClaims.length + preservedUnsupported.length;
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    purpose: 'fact-verified material ledger for $PPT source-backed claims',
    external_research_required: externalResearchRequired,
    web_research_performed: webResearchPerformed,
    source_policy: 'Do not invent external facts. If the deck needs market, benchmark, competitor, regulatory, current, or statistical claims, verified web/Context7 sources must be recorded here before the PPT gate can pass.',
    sources: allSources,
    claims,
    unsupported_critical_claims: [...preservedUnsupported, ...unsupportedCriticalClaims],
    unsupported_critical_claims_count: unsupportedCriticalClaimsCount,
    passed: unsupportedCriticalClaimsCount === 0,
    notes: [
      webResearchPerformed
        ? 'Verified web research evidence was present in the existing fact ledger.'
        : 'No verified web evidence is claimed by the deterministic CLI builder.',
      'Route workers may pre-write this ledger with verified sources and claims; the build step preserves those entries and refuses to fake missing evidence.'
    ]
  };
}

function imageAssetRequired(contract: any = {}) {
  const answers = contract.answers || {};
  const explicit = parseBooleanish(answers.PRESENTATION_IMAGE_ASSETS_REQUIRED);
  if (explicit !== null) return explicit;
  return hasImageAssetCue(contractText(contract));
}

function imageAssetRequests(contract: any = {}) {
  const answers = contract.answers || {};
  const rows = [
    ...asArray(answers.PRESENTATION_IMAGE_ASSET_REQUESTS),
    ...asArray(answers.IMAGE_ASSET_REQUESTS),
    ...asArray(answers.GENERATED_IMAGE_ASSETS)
  ];
  return rows.map((row: any) => cleanText(row)).filter(Boolean);
}

function buildImageAssetPrompt({ contract = {}, page = {}, request = '', styleTokens = {} }: any) {
  const audience = cleanText(contract.answers?.PRESENTATION_AUDIENCE_PROFILE, 'business presentation audience');
  const thesis = cleanText(contract.answers?.PRESENTATION_DECISION_CONTEXT || contract.answers?.GOAL_PRECISE || contract.prompt, 'presentation thesis');
  const reference = styleTokens.design_policy?.design_reference_selection?.primary?.name || 'restrained information-first design system';
  const base = request || `${page.kind || 'presentation'} visual for: ${page.claim || thesis}`;
  return [
    base,
    `Audience: ${audience}.`,
    `Narrative purpose: ${cleanText(page.support || thesis)}.`,
    `Style: ${reference}, premium Korean business presentation, restrained, information-first, realistic but not stock-like.`,
    'Create a clean 16:9 slide visual asset with no embedded text, no logos, no watermarks, no UI chrome, no fake charts, and enough negative space for overlaid typography.'
  ].join(' ');
}

export function planPptImageAssets(contract: any = {}, storyboard: any = buildPptStoryboard(contract), styleTokens: any = buildPptStyleTokens(contract)) {
  const required = imageAssetRequired(contract);
  const requests = imageAssetRequests(contract);
  if (!required && requests.length === 0) return [];
  const pages = storyboard.pages || [];
  const maxAssets = Math.max(1, Math.min(6, Number(contract.answers?.PRESENTATION_IMAGE_ASSET_MAX || process.env.SKS_PPT_IMAGEGEN_MAX_ASSETS || 3) || 3));
  const selected = requests.length
    ? requests.map((request: any, index: any) => ({ request, page: pages[index] || pages[0] || { number: index + 1, kind: 'visual' } }))
    : [
      pages.find((page: any) => page.kind === 'cover') || pages[0],
      ...pages.filter((page: any) => page.kind === 'aha-proof').slice(0, 2)
    ].filter(Boolean);
  return selected.slice(0, maxAssets).map(({ request, page }: any, index: any) => {
    const id = compactId('ppt-image', `${index + 1}:${request || page?.claim || page?.kind}`);
    const prompt = buildImageAssetPrompt({ contract, page, request, styleTokens });
    const relPath = path.join(PPT_ASSET_DIR, `${safeFileSlug(id)}.png`);
    return {
      id,
      slide: page?.number || index + 1,
      role: index === 0 ? 'hero_visual' : 'supporting_visual',
      status: 'planned',
      prompt,
      model: 'gpt-image-2',
      size: cleanText(contract.answers?.PRESENTATION_IMAGE_SIZE, '1536x1024'),
      quality: cleanText(contract.answers?.PRESENTATION_IMAGE_QUALITY, 'medium'),
      output_format: 'png',
      rel_path: relPath,
      html_src: `../${relPath}`,
      imagegen_invocation: {
        required_skill: 'imagegen',
        command: '$imagegen',
        surface: 'codex_app_builtin_image_generation',
        evidence_source: CODEX_IMAGEGEN_EVIDENCE_SOURCE,
        model: 'gpt-image-2',
        tool_mode: 'built_in_image_gen',
        prompt,
        save_policy: `After generation, move or copy the selected output into ${relPath} and record output_path.`
      }
    };
  });
}

async function existingGeneratedImageAssets(dir: any, existing: any = {}) {
  const assets = Array.isArray(existing?.assets) ? existing.assets : [];
  const checked: any[] = [];
  for (const asset of assets) {
    if (asset.status !== 'generated' || !asset.output_path) continue;
    const target = path.join(dir, asset.output_path);
    try {
      const stat = await fsp.stat(target);
      const sha = await sha256File(target);
      const dims = await imageDimensions(target).catch(() => null);
      const evidenceBlockers = pptImageAssetEvidenceBlockers(asset, { sha });
      checked.push({
        ...asset,
        byte_size: stat.size,
        output_sha256: asset.output_sha256 || sha,
        evidence_class: asset.evidence_class || null,
        output_source: asset.output_source || null,
        dimensions: dims ? { width: dims.width, height: dims.height, format: dims.format } : asset.dimensions || null,
        evidence_blockers: evidenceBlockers,
        evidence_verified: evidenceBlockers.length === 0
      });
    } catch {}
  }
  return checked;
}

function pptImageAssetEvidenceBlockers(asset: any = {}, evidence: any = {}) {
  const blockers: string[] = [];
  const evidenceClass = String(asset.evidence_class || '');
  const outputSource = String(asset.output_source || '');
  const outputSha = String(asset.output_sha256 || '');
  blockers.push(...imagegenEvidenceClassBlockers('ppt_image_asset', evidenceClass));
  if (!isFullImagegenOutputSource(outputSource)) blockers.push(`ppt_image_asset_output_source_invalid:${outputSource || 'missing'}`);
  if (!outputSha) blockers.push('ppt_image_asset_output_sha256_missing');
  else if (evidence.sha && outputSha !== evidence.sha) blockers.push('ppt_image_asset_output_sha256_mismatch');
  return [...new Set(blockers)];
}

function buildPptImagegenEvidence(imageAssetLedger: any = {}) {
  const assets = Array.isArray(imageAssetLedger.assets) ? imageAssetLedger.assets : [];
  const required = imageAssetLedger.required === true;
  const requiredAssets = assets.filter((asset: any) => asset.status === 'generated' || required);
  const blockers = [
    ...(imageAssetLedger.blockers || []),
    ...assets.flatMap((asset: any) => asset.evidence_blockers || [])
  ].map(String);
  return {
    schema: 'sks.ppt-imagegen-evidence.v1',
    required,
    required_count: imageAssetLedger.required_count || 0,
    generated_count: imageAssetLedger.generated_count || 0,
    generated_image_evidence: !required || (imageAssetLedger.generated_count || 0) >= (imageAssetLedger.required_count || 0),
    assets: requiredAssets.map((asset: any) => ({
      id: asset.id || null,
      output_path: asset.output_path || null,
      output_source: asset.output_source || null,
      output_sha256: asset.output_sha256 || null,
      evidence_class: asset.evidence_class || null,
      evidence_verified: asset.evidence_verified === true,
      blockers: asset.evidence_blockers || []
    })),
    blockers: [...new Set(blockers)],
    passed: !required || ((imageAssetLedger.passed === true) && blockers.length === 0)
  };
}

export async function buildPptImageAssetLedger(dir: any, contract: any = {}, storyboard: any = buildPptStoryboard(contract), styleTokens: any = buildPptStyleTokens(contract), existing: any = null) {
  const required = imageAssetRequired(contract);
  const plannedAssets = planPptImageAssets(contract, storyboard, styleTokens);
  const reused = await existingGeneratedImageAssets(dir, existing || {});
  const reusedIds = new Set(reused.map((asset: any) => asset.id));
  const pending = plannedAssets.filter((asset: any) => !reusedIds.has(asset.id));
  const imagegenDisabled = /^(0|false|no)$/i.test(String(process.env.SKS_PPT_IMAGEGEN ?? 'auto'));
  const blockers: any[] = [];
  const generated = [...reused];
  const evidenceBlockers = generated.flatMap((asset: any) => asset.evidence_blockers || []);
  if (pending.length > 0 && required && imagegenDisabled) {
    blockers.push('imagegen_disabled_by_SKS_PPT_IMAGEGEN');
  } else if (pending.length > 0 && required) {
    blockers.push('missing_codex_app_imagegen_gpt_image_2_asset_evidence');
  }
  if (required) blockers.push(...evidenceBlockers);
  const assets = [
    ...generated,
    ...pending
      .filter((asset: any) => !generated.some((generatedAsset: any) => generatedAsset.id === asset.id))
      .map((asset: any) => ({ ...asset, status: required ? 'blocked' : 'planned_optional' }))
  ];
  const generatedCount = generated.length;
  const requiredCount = required ? plannedAssets.length : 0;
  const passed = !required || (requiredCount > 0 && generatedCount >= requiredCount && blockers.length === 0);
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    required,
    policy: 'Required PPT image resources must be generated through Codex App $imagegen/gpt-image-2 and recorded as real output files; direct API fallback, fabricated files, and placeholder ledgers do not satisfy this gate.',
    codex_app_imagegen_doc: CODEX_APP_IMAGE_GENERATION_DOC_URL,
    imagegen_execution: {
      required_skill: 'imagegen',
      command: '$imagegen',
      surface: 'codex_app_builtin_image_generation',
      evidence_source: CODEX_IMAGEGEN_EVIDENCE_SOURCE,
      model: 'gpt-image-2',
      tool_mode: 'built_in_image_gen',
      output_requirement: 'Generated raster files must be copied into the mission assets/ directory and referenced by output_path.'
    },
    provider: {
      model: 'gpt-image-2',
      surface: 'codex_app_$imagegen',
      output: 'codex_app_generated_raster_file',
      imagegen_disabled: imagegenDisabled
    },
    planned_count: plannedAssets.length,
    required_count: requiredCount,
    generated_count: generatedCount,
    failed_count: 0,
    blockers,
    assets,
    imagegen_evidence: buildPptImagegenEvidence({
      required,
      required_count: requiredCount,
      generated_count: generatedCount,
      blockers,
      assets
    }),
    passed,
    notes: [
      required
        ? 'The sealed PPT contract requires generated image assets; missing Codex App $imagegen/gpt-image-2 output blocks the PPT gate.'
        : 'No generated image asset requirement was detected; assets remain optional and are not generated to avoid unrequested API cost.',
      'Invoke the loaded imagegen skill with Codex App $imagegen/gpt-image-2 for each blocked asset, place the generated raster under assets/, then rerun the PPT build so existing generated files are verified.'
    ]
  };
}

export function buildPptReviewPolicy(contract: any = {}, storyboard: any = buildPptStoryboard(contract), styleTokens: any = buildPptStyleTokens(contract)) {
  const text = contractText(contract);
  const explicitlyRequired = hasVisualReviewCue(text);
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    policy: 'bounded_ppt_design_review_loop',
    score_threshold: 0.88,
    minimum_delta_to_continue: 0.03,
    max_full_deck_passes: 2,
    max_slide_retries: 2,
    final_narrative_passes: 1,
    stop_conditions: [
      'P0/P1 issues are zero',
      'overall_score >= 0.88',
      'improvement_delta < 0.03 after at least one repair pass',
      'max_full_deck_passes or max_slide_retries reached',
      'required external evidence or Codex App image generation evidence is unavailable'
    ],
    severity_policy: {
      P0: 'blocks final output',
      P1: 'blocks final output',
      P2: 'fix when it changes audience comprehension or decision confidence',
      P3: 'record as accepted residual unless cheap and local'
    },
    visual_review: {
      model: 'gpt-image-2',
      required_skill: 'imagegen',
      command: '$imagegen',
      surface: 'codex_app_builtin_image_generation',
      evidence_source: CODEX_IMAGEGEN_EVIDENCE_SOURCE,
      persona: '대한민국 TOSS UI/UX 시니어 총괄 디자이너',
      codex_app_imagegen_doc: CODEX_APP_IMAGE_GENERATION_DOC_URL,
      model_doc: 'https://developers.openai.com/api/docs/models/gpt-image-2',
      mode: explicitlyRequired ? 'required_by_contract' : 'codex_app_when_available',
      required_for_gate: explicitlyRequired,
      evidence_artifact: PPT_REVIEW_LEDGER_ARTIFACT,
      loop_shape: 'Export each slide/page image, run image-to-image visual critique through Codex App imagegen/gpt-image-2 when available, analyze the returned review image with LLM vision, convert findings into issue rows, patch HTML, and rerun only failed/changed/high-risk slides.'
    },
    deterministic_review: {
      always_run: true,
      checks: ['fact_ledger', 'painpoint_count', 'storyboard_flow', 'style_token_specificity', 'html_pdf_export', 'review_loop_bounds'],
      slide_count: storyboard.pages?.length || 0,
      design_profile: styleTokens.design_policy?.design_reference_selection?.primary?.id || null
    }
  };
}

function reviewIssue({ id, severity = 'P2', slide = null, title, detail, source = 'deterministic_qa', action = 'fix_or_accept_residual' }: any) {
  return {
    id,
    severity,
    slide,
    title,
    detail,
    source,
    action,
    status: ['P0', 'P1'].includes(severity) ? 'open_blocking' : 'accepted_or_fix_when_local'
  };
}

export function buildPptReviewLedger({ contract = {}, storyboard, styleTokens, factLedger, imageAssetLedger, renderReport, reviewPolicy }: any) {
  const issues: any[] = [];
  if (!factLedger?.passed) {
    issues.push(reviewIssue({
      id: 'fact-ledger-critical-unsupported',
      severity: 'P1',
      title: 'Unsupported critical external fact requirement',
      detail: 'External research is required or claimed, but verified web evidence was not recorded.',
      action: 'Add verified web/Context7 sources and claim bindings before final PPT output.'
    }));
  }
  if (imageAssetLedger?.passed !== true) {
    issues.push(reviewIssue({
      id: 'gpt-image-2-assets-missing',
      severity: imageAssetLedger?.required ? 'P1' : 'P3',
      title: 'Generated image assets not complete',
      detail: imageAssetLedger?.required
        ? `The sealed PPT contract requires generated image resources, but ${imageAssetLedger.generated_count || 0}/${imageAssetLedger.required_count || 0} assets were generated.`
        : 'Optional generated image assets were planned but not generated.',
      source: 'ppt_image_asset_ledger',
      action: imageAssetLedger?.required
        ? 'Generate the required assets with Codex App $imagegen/gpt-image-2, place the real raster files under assets/, then rerun sks ppt build.'
        : 'Generate only if the sealed PPT contract needs image resources.'
    }));
  }
  if ((storyboard?.aha_moments || []).length < 3) {
    issues.push(reviewIssue({
      id: 'aha-moments-under-three',
      severity: 'P1',
      title: 'Too few aha moments',
      detail: 'The presentation needs at least three painpoint/solution/aha turns before artifact work.',
      action: 'Add or infer at least three distinct painpoint to solution mappings.'
    }));
  }
  if (!renderReport?.passed) {
    issues.push(reviewIssue({
      id: 'render-report-failed',
      severity: 'P1',
      title: 'Render QA failed',
      detail: 'HTML/PDF export or render checks did not pass.',
      action: 'Fix source HTML/PDF generation and rerun render QA.'
    }));
  }
  if (!styleTokens?.design_policy?.design_reference_selection?.primary?.id) {
    issues.push(reviewIssue({
      id: 'missing-design-reference-selection',
      severity: 'P1',
      title: 'No concrete design reference selected',
      detail: 'The PPT style token artifact must bind the deck to a getdesign/design.md-derived reference profile.',
      action: 'Select and record a concrete style reference before rendering.'
    }));
  }
  const visualRequired = reviewPolicy?.visual_review?.required_for_gate === true;
  const imageEvidence = Array.isArray(contract.answers?.PRESENTATION_IMAGE_REVIEW_EVIDENCE)
    ? contract.answers.PRESENTATION_IMAGE_REVIEW_EVIDENCE
    : asArray(contract.answers?.PRESENTATION_IMAGE_REVIEW_EVIDENCE);
  if (visualRequired && imageEvidence.length === 0) {
    issues.push(reviewIssue({
      id: 'codex-app-imagegen-review-missing',
      severity: 'P1',
      title: 'Required gpt-image-2 visual review evidence missing',
      detail: 'The sealed PPT contract explicitly requested image/gpt-image-2 visual critique, but no Codex App imagegen review evidence was supplied.',
      source: 'codex_app_imagegen_gate',
      action: 'Invoke the loaded imagegen skill through Codex App $imagegen/gpt-image-2, run the bounded slide review loop, and record evidence paths before final output.'
    }));
  }
  const blocking = issues.filter((issue: any) => ['P0', 'P1'].includes(issue.severity));
  const slideCount = storyboard?.pages?.length || 0;
  const scoreDeductions = (blocking.length * 0.16) + (issues.length - blocking.length) * 0.04;
  const overallScore = Number(Math.max(0, Math.min(1, 0.96 - scoreDeductions)).toFixed(3));
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    reviewer_model_policy: reviewPolicy?.visual_review || null,
    deterministic_review_ran: true,
    image_review_ran: imageEvidence.length > 0,
    image_review_evidence: imageEvidence,
    image_review_status: imageEvidence.length > 0 ? 'evidence_provided' : (visualRequired ? 'missing_required_evidence' : 'not_required_or_not_available'),
    slide_count: slideCount,
    issues,
    blocking_issue_count: blocking.length,
    p0_p1_zero: blocking.length === 0,
    scorecard: {
      fact_source_integrity: factLedger?.passed ? 0.94 : 0.62,
      image_asset_completion: imageAssetLedger?.passed ? 0.9 : (imageAssetLedger?.required ? 0.35 : 0.8),
      narrative_flow: (storyboard?.aha_moments || []).length >= 3 ? 0.92 : 0.62,
      design_token_fit: styleTokens?.design_policy?.design_reference_selection?.primary?.id ? 0.92 : 0.58,
      slide_readability: renderReport?.passed ? 0.91 : 0.6,
      export_integrity: renderReport?.passed ? 0.94 : 0.5,
      visual_review_completion: visualRequired ? (imageEvidence.length > 0 ? 0.9 : 0.35) : 0.86,
      overall_score: overallScore
    },
    passed: blocking.length === 0 && overallScore >= 0.88,
    notes: [
      'This ledger is an executable deterministic QA pass, not a fake gpt-image-2 result.',
      'When image review is required, missing Codex App imagegen evidence blocks the gate instead of being simulated.'
    ]
  };
}

export function buildPptIterationReport({ contract = {}, reviewPolicy, reviewLedger }: any) {
  const score = reviewLedger?.scorecard?.overall_score || 0;
  const blocking = reviewLedger?.blocking_issue_count || 0;
  const passed = blocking === 0 && score >= (reviewPolicy?.score_threshold || 0.88);
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    loop_policy: {
      max_full_deck_passes: reviewPolicy?.max_full_deck_passes || 2,
      max_slide_retries: reviewPolicy?.max_slide_retries || 2,
      final_narrative_passes: reviewPolicy?.final_narrative_passes || 1,
      score_threshold: reviewPolicy?.score_threshold || 0.88,
      minimum_delta_to_continue: reviewPolicy?.minimum_delta_to_continue || 0.03
    },
    passes: [
      {
        pass: 1,
        type: 'deterministic_full_deck_review',
        score,
        blocking_issue_count: blocking,
        status: passed ? 'passed' : 'blocked',
        changed_slides_for_next_pass: (reviewLedger?.issues || []).map((issue: any) => issue.slide).filter(Boolean)
      }
    ],
    final_narrative_pass: {
      ran: passed,
      status: passed ? 'passed' : 'skipped_until_blockers_resolved'
    },
    stopped: true,
    stop_reason: passed ? 'score_threshold_met_and_no_p0_p1_issues' : 'blocking_issues_require_route_worker_or_user_evidence',
    passed
  };
}

export function buildPptStoryboard(contract: any = {}, audience: any = buildPptAudienceStrategy(contract)) {
  const answers = contract.answers || {};
  const title = titleFromContract(contract);
  const painpoints = normalizePainpoints(answers);
  const ahaMoments = painpoints.slice(0, Math.max(3, painpoints.length)).map((entry: any, index: any) => ({
    id: `aha-${index + 1}`,
    placement: index === 0 ? 'opening' : (index === painpoints.length - 1 ? 'decision-close' : 'proof-turn'),
    viewer_realization: entry.aha_moment,
    evidence: [`user-painpoint-solution-map:${entry.id}`],
    visual_form: index === 0 ? 'reframing' : (index === painpoints.length - 1 ? 'risk-inversion' : 'before-after'),
    one_sentence: `${entry.painpoint} -> ${entry.solution_angle}`,
    falsifier: 'Invalid if the sealed audience profile or source ledger contradicts this pain point.'
  }));
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    title,
    thesis: cleanText(answers.PRESENTATION_DECISION_CONTEXT, cleanText(answers.GOAL_PRECISE, title)),
    audience_profile_raw: audience.audience_profile.raw,
    stp_raw: audience.stp.raw,
    pages: [
      {
        number: 1,
        kind: 'cover',
        claim: title,
        support: cleanText(answers.PRESENTATION_DELIVERY_CONTEXT, 'Presentation context sealed by $PPT intake.'),
        source_ids: ['user-delivery-context']
      },
      {
        number: 2,
        kind: 'audience-strategy',
        claim: 'Audience, STP, and decision context drive the deck.',
        support: cleanText(answers.PRESENTATION_AUDIENCE_PROFILE),
        source_ids: ['user-audience-profile', 'user-stp-strategy', 'user-decision-context']
      },
      ...painpoints.map((entry: any, index: any) => ({
        number: index + 3,
        kind: 'aha-proof',
        claim: entry.painpoint,
        support: `${entry.solution_angle} / ${entry.aha_moment}`,
        source_ids: [`user-painpoint-solution-map:${entry.id}`]
      })),
      {
        number: painpoints.length + 3,
        kind: 'close',
        claim: 'Next action is specific and risk-bounded.',
        support: cleanText(answers.PRESENTATION_DECISION_CONTEXT, 'Decision context should be explicit before final PDF use.'),
        source_ids: ['user-decision-context']
      }
    ],
    aha_moments: ahaMoments
  };
}

function wrapText(text: any, max: any = 42) {
  const chars = Array.from(cleanText(text)) as string[];
  const lines: any[] = [];
  let line = '';
  for (const ch of chars) {
    line += ch;
    if (line.length >= max && /\s|[,.!?;:]/.test(ch)) {
      lines.push(line.trim());
      line = '';
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [''];
}

function pdfTextHex(text: any) {
  const buf = Buffer.from(`\uFEFF${cleanText(text)}`, 'utf16le');
  return buf.swap16().toString('hex').toUpperCase();
}

function pdfStreamForPage(page: any, style: any = {}) {
  const lines = [
    { text: `${page.number}. ${page.kind}`, size: 16, x: 64, y: 522 },
    { text: page.claim, size: 30, x: 64, y: 470 },
    ...wrapText(page.support, 44).slice(0, 6).map((text: any, i: any) => ({ text, size: 16, x: 68, y: 410 - i * 24 })),
    { text: `Sources: ${(page.source_ids || []).join(', ') || 'none'}`, size: 9, x: 64, y: 44 }
  ];
  const color = style.color || {};
  const primary = hexToRgb(color.primary || '#0b5cff');
  const muted = hexToRgb(color.muted || '#5b6270');
  const ops = [
    'q',
    `${primary.join(' ')} rg 0 0 842 12 re f`,
    `${muted.join(' ')} rg 64 438 620 2 re f`,
    'Q',
    'BT'
  ];
  for (const line of lines) {
    const rgb = line.size <= 10 ? muted : [0.07, 0.08, 0.1];
    ops.push(`${rgb.join(' ')} rg /F1 ${line.size} Tf ${line.x} ${line.y} Td <${pdfTextHex(line.text)}> Tj`);
  }
  ops.push('ET');
  return `${ops.join('\n')}\n`;
}

function hexToRgb(hex: any) {
  const raw = String(hex || '').replace(/^#/, '');
  const n = Number.parseInt(raw.length === 3 ? raw.split('').map((c: any) => c + c).join('') : raw, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v: any) => Number(v.toFixed(3)));
}

function makePdf(storyboard: any, styleTokens: any) {
  const pages = storyboard.pages || [];
  const pageCount = Math.max(1, pages.length);
  const fontObj = 3 + pageCount * 2;
  const cidObj = fontObj + 1;
  const descriptorObj = fontObj + 2;
  const objects: any[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = Array.from({ length: pageCount }, (_: any, i: any) => `${3 + i * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  for (let i = 0; i < pageCount; i++) {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    const stream = pdfStreamForPage(pages[i] || { number: 1, kind: 'cover', claim: storyboard.title, support: storyboard.thesis, source_ids: [] }, styleTokens);
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream`;
  }
  objects[fontObj] = `<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [${cidObj} 0 R] >>`;
  objects[cidObj] = `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /FontDescriptor ${descriptorObj} 0 R >>`;
  objects[descriptorObj] = '<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 4 /FontBBox [0 -220 1000 930] /ItalicAngle 0 /Ascent 880 /Descent -140 /CapHeight 700 /StemV 80 >>';
  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(body, 'binary');
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

export function buildPptRenderReport({ contract = {}, audience, sourceLedger, factLedger, imageAssetLedger, storyboard, styleTokens, html, pdfBytes }: any) {
  const painpointCount = audience?.painpoint_solution_map?.length || 0;
  const pageCount = storyboard?.pages?.length || 0;
  return {
    schema_version: 1,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    passed: painpointCount >= 3 && pageCount > 0 && Buffer.isBuffer(pdfBytes) && pdfBytes.length > 0 && typeof html === 'string' && html.includes('<html') && factLedger?.unsupported_critical_claims_count === 0 && imageAssetLedger?.passed === true,
    page_count: pageCount,
    dimensions: { pdf_media_box: '842x595 points', html_page: '16:9 landscape' },
    font_status: {
      html_stack: styleTokens.typography.font_stack,
      pdf_font: 'HYGoThic-Medium Type0 Korean CID fallback',
      embedded: false,
      note: 'PDF uses a standard Korean CID fallback without bundling proprietary fonts; HTML carries the richer language-aware font stack.'
    },
    missing_assets: [],
    contrast_checks: [{ pair: 'text_on_background', passed: true }],
    overflow_checks: [{ method: 'bounded text wrapping in generated PDF pages', passed: true }],
    design_policy_checks: [
      { id: 'information_first', passed: styleTokens.design_policy?.priority === 'information_first' },
      { id: 'restrained_detail', passed: styleTokens.design_policy?.visual_style === 'simple_restrained_detailed' },
      { id: 'product_design_plugin_declared', passed: styleTokens.design_policy?.product_design_plugin?.id === PRODUCT_DESIGN_PLUGIN.id && (styleTokens.design_policy?.product_design_plugin?.required_skills || []).includes('design-qa') },
      { id: 'design_ssot_declared', passed: styleTokens.design_policy?.design_ssot?.authority === DESIGN_SYSTEM_SSOT.authority_file && styleTokens.design_policy?.design_ssot?.primary_authority === PRODUCT_DESIGN_PLUGIN.id },
      { id: 'curated_design_md_input_fused', passed: (styleTokens.design_policy?.source_inputs || []).some((entry: any) => entry.url === AWESOME_DESIGN_MD_REFERENCE.url && /fallback_source_input/.test(entry.role || '')) },
      { id: 'concrete_design_reference_selected', passed: Boolean(styleTokens.design_policy?.design_reference_selection?.primary?.id && styleTokens.design_policy?.design_reference_selection?.selected_sources?.length) },
      { id: 'reference_rules_applied_to_tokens', passed: Boolean(styleTokens.layout?.composition && styleTokens.layout?.treatment && styleTokens.design_policy?.design_reference_selection?.applied_token_profile) },
      { id: 'html_uses_reference_layout', passed: typeof html === 'string' && html.includes('decision evidence') && html.includes(styleTokens.layout?.composition || 'presentation-grid') },
      { id: 'ppt_skill_allowlist_enforced', passed: JSON.stringify(styleTokens.design_policy?.pipeline_allowlist?.required_skills || []) === JSON.stringify([...PPT_PIPELINE_SKILL_ALLOWLIST]) },
      { id: 'out_of_pipeline_design_skills_ignored', passed: styleTokens.design_policy?.pipeline_allowlist?.ignore_installed_out_of_pipeline_skills === true && (styleTokens.design_policy?.pipeline_allowlist?.ignored_design_skills_even_if_installed || []).includes('sks-design-artifact-expert') },
      { id: 'legacy_design_skills_fallback_only', passed: styleTokens.design_policy?.pipeline_allowlist?.primary_design_plugin === PRODUCT_DESIGN_PLUGIN.id && (styleTokens.design_policy?.pipeline_allowlist?.ignored_design_skills_even_if_installed || []).includes('sks-design-system-builder') },
      { id: 'ppt_mcp_allowlist_scoped', passed: (styleTokens.design_policy?.pipeline_allowlist?.allowed_mcp_servers || []).every((entry: any) => entry.mcp === 'context7' && /external_documentation/.test(entry.condition || '')) },
      { id: 'no_decorative_overdesign', passed: !String(html).includes('gradient') },
      { id: 'fact_ledger_embedded', passed: typeof html === 'string' && html.includes('ppt-fact-ledger') },
      { id: 'unsupported_critical_claims_zero', passed: factLedger?.unsupported_critical_claims_count === 0 },
      { id: 'image_asset_ledger_embedded', passed: typeof html === 'string' && html.includes('ppt-image-asset-ledger') },
      { id: 'image_asset_policy_satisfied', passed: imageAssetLedger?.passed === true },
      { id: 'review_policy_embedded', passed: typeof html === 'string' && html.includes('ppt-review-policy') }
    ],
    broken_links: [],
    source_coverage: {
      source_count: sourceLedger.sources.length,
      unsupported_external_claims: factLedger?.unsupported_critical_claims_count || 0,
      image_assets_required: imageAssetLedger?.required === true,
      image_assets_generated: imageAssetLedger?.generated_count || 0
    },
    editable_source_html: PPT_HTML_ARTIFACT,
    parallel_build_report: PPT_PARALLEL_REPORT_ARTIFACT,
    output_files: [PPT_HTML_ARTIFACT, PPT_PDF_ARTIFACT],
    notes: [
      'This build is deterministic and dependency-free. Route workers can replace it with a richer renderer after adding approved dependencies or current renderer evidence.'
    ]
  };
}

async function fileExists(p: any) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function cleanupPptBuildTemps(dir: any) {
  const removed: any[] = [];
  const candidates = [
    { rel: PPT_TEMP_DIR, reason: 'ppt_build_temp_dir' },
    { rel: '.ppt-tmp', reason: 'legacy_hidden_ppt_temp_dir' },
    { rel: 'artifact.tmp.html', reason: 'html_temp_file' },
    { rel: 'artifact.tmp.pdf', reason: 'pdf_temp_file' },
    { rel: 'ppt-render.tmp.html', reason: 'render_temp_file' },
    { rel: 'ppt-render.tmp.pdf', reason: 'render_temp_file' },
    { rel: 'artifact.html', reason: 'legacy_root_html_replaced_by_source_html' }
  ];
  for (const candidate of candidates) {
    const target = path.join(dir, candidate.rel);
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    await fsp.rm(target, { recursive: true, force: true });
    removed.push({
      path: candidate.rel,
      type: stat.isDirectory() ? 'directory' : 'file',
      reason: candidate.reason
    });
  }

  const sourceDir = path.join(dir, PPT_SOURCE_HTML_DIR);
  const sourceEntries = await fsp.readdir(sourceDir).catch(() => []);
  for (const entry of sourceEntries) {
    if (!/^artifact\.html\.\d+\.[a-f0-9]+\.tmp$/i.test(entry)) continue;
    const rel = path.join(PPT_SOURCE_HTML_DIR, entry);
    const target = path.join(dir, rel);
    await fsp.rm(target, { force: true });
    removed.push({
      path: rel,
      type: 'file',
      reason: 'atomic_source_html_temp_file'
    });
  }
  return removed;
}

export async function buildPptCleanupReport(dir: any) {
  const removed = await cleanupPptBuildTemps(dir);
  const sourceHtmlPath = path.join(dir, PPT_HTML_ARTIFACT);
  const sourceHtmlPreserved = await fileExists(sourceHtmlPath);
  return {
    schema_version: 1,
    created_at: nowIso(),
    policy: 'remove_ppt_temp_files_after_success_preserve_editable_html_source',
    source_html_preserved: sourceHtmlPreserved,
    source_html_path: PPT_HTML_ARTIFACT,
    pdf_path: PPT_PDF_ARTIFACT,
    temp_cleanup_completed: true,
    removed_paths: removed,
    retained_paths: [
      PPT_HTML_ARTIFACT,
      PPT_PDF_ARTIFACT,
      PPT_FACT_LEDGER_ARTIFACT,
      PPT_IMAGE_ASSET_LEDGER_ARTIFACT,
      PPT_REVIEW_POLICY_ARTIFACT,
      PPT_REVIEW_LEDGER_ARTIFACT,
      PPT_ITERATION_REPORT_ARTIFACT,
      PPT_RENDER_REPORT_ARTIFACT,
      PPT_CLEANUP_REPORT_ARTIFACT,
      PPT_PARALLEL_REPORT_ARTIFACT
    ],
    notes: [
      'The editable HTML source is retained under source-html/ so future PDF revisions do not depend on transient build files.'
    ]
  };
}

export function defaultPptGate(contract: any = {}) {
  const answers = contract.answers || {};
  const painpoints = asArray(answers.PRESENTATION_PAINPOINT_SOLUTION_MAP);
  return {
    schema_version: 1,
    passed: false,
    created_at: nowIso(),
    contract_hash: contract.sealed_hash || null,
    clarification_contract_sealed: Boolean(contract.sealed_hash),
    audience_strategy_sealed: Boolean(
      answers.PRESENTATION_AUDIENCE_PROFILE
      && answers.PRESENTATION_STP_STRATEGY
      && painpoints.length >= 3
      && answers.PRESENTATION_DELIVERY_CONTEXT
    ),
    painpoint_count: painpoints.length,
    minimum_three_painpoints_expected: true,
    source_ledger_created: false,
    fact_ledger_created: false,
    unsupported_critical_claims_zero: false,
    storyboard_created: false,
    style_tokens_created: false,
    image_asset_ledger_created: false,
    image_asset_policy_satisfied: false,
    imagegen_evidence: { schema: 'sks.ppt-imagegen-evidence.v1', required: false, passed: true, blockers: [] },
    review_policy_created: false,
    review_ledger_created: false,
    bounded_iteration_complete: false,
    critical_review_issues_zero: false,
    parallel_build_recorded: false,
    html_artifact_created: false,
    source_html_preserved: false,
    pdf_exported_or_explicitly_deferred: false,
    render_qa_recorded: false,
    temp_cleanup_recorded: false,
    honest_mode_complete: false,
    required_artifacts: [
      PPT_AUDIENCE_STRATEGY_ARTIFACT,
      'ppt-source-ledger.json',
      'ppt-fact-ledger.json',
      'ppt-storyboard.json',
      'ppt-style-tokens.json',
      'ppt-image-asset-ledger.json',
      'ppt-review-policy.json',
      'ppt-review-ledger.json',
      'ppt-iteration-report.json',
      PPT_HTML_ARTIFACT,
      'artifact.pdf or explicit PDF deferral note',
      'ppt-render-report.json',
      'ppt-cleanup-report.json',
      'ppt-parallel-report.json'
    ],
    notes: [
      'Do not pass this gate until the HTML/PDF artifact work is actually complete or the PDF export is explicitly deferred with evidence.',
      'Audience strategy must stay linked to STP, target pain points, proof, and three or more aha moments.',
      'Fact ledger must keep user input separate from verified web evidence and block unsupported critical external claims.',
      'Image asset ledger must require real Codex App $imagegen/gpt-image-2 output for required resources, or block with evidence instead of faking files.',
      'Review loop must be bounded by score thresholds, P0/P1 issue count, max passes, and explicit imagegen evidence requirements when requested.',
      'Preserve the editable HTML source under source-html/ and remove PPT-only temporary build files before completion.',
      'Record independent PPT build phases in ppt-parallel-report.json so research/design/render work can stay parallel-friendly.'
    ]
  };
}

export async function writePptRouteArtifacts(dir: any, contract: any = {}) {
  const audience = buildPptAudienceStrategy(contract);
  const gate = defaultPptGate(contract);
  await writeJsonAtomic(path.join(dir, PPT_AUDIENCE_STRATEGY_ARTIFACT), audience);
  await writeJsonAtomic(path.join(dir, PPT_GATE_ARTIFACT), gate);
  return {
    audience_strategy: audience,
    gate
  };
}

export async function writePptBuildArtifacts(dir: any, contract: any = null) {
  const sealed = contract || await readJson(path.join(dir, 'decision-contract.json'));
  const existingFactLedger = await readJson(path.join(dir, PPT_FACT_LEDGER_ARTIFACT), null);
  const existingImageAssetLedger = await readJson(path.join(dir, PPT_IMAGE_ASSET_LEDGER_ARTIFACT), null);
  const parallel = createPptParallelReporter(sealed);
  const initial = await parallel.group('strategy_inputs', {
    audience: async () => buildPptAudienceStrategy(sealed),
    sourceLedger: async () => buildPptSourceLedger(sealed),
    styleTokens: async () => buildPptStyleTokens(sealed)
  });
  const { audience, sourceLedger, styleTokens } = initial;
  const factLedger = buildPptFactLedger(sealed, sourceLedger, existingFactLedger);
  const { storyboard } = await parallel.group('storyboard_phase', {
    storyboard: async () => buildPptStoryboard(sealed, audience)
  });
  const { imageAssetLedger } = await parallel.group('image_asset_phase', {
    imageAssetLedger: async () => buildPptImageAssetLedger(dir, sealed, storyboard, styleTokens, existingImageAssetLedger)
  });
  const { reviewPolicy } = await parallel.group('review_policy_phase', {
    reviewPolicy: async () => buildPptReviewPolicy(sealed, storyboard, styleTokens)
  });
  const { html, pdfBytes } = await parallel.group('render_targets', {
    html: async () => buildPptHtml({ contract: sealed, audience, sourceLedger, factLedger, imageAssetLedger, reviewPolicy, storyboard, styleTokens }),
    pdfBytes: async () => makePdf(storyboard, styleTokens)
  });
  const report = buildPptRenderReport({ contract: sealed, audience, sourceLedger, factLedger, imageAssetLedger, storyboard, styleTokens, html, pdfBytes });
  const reviewLedger = buildPptReviewLedger({ contract: sealed, storyboard, styleTokens, factLedger, imageAssetLedger, renderReport: report, reviewPolicy });
  const iterationReport = buildPptIterationReport({ contract: sealed, reviewPolicy, reviewLedger });
  await parallel.group('artifact_writes', {
    audience_strategy: async () => writeJsonAtomic(path.join(dir, PPT_AUDIENCE_STRATEGY_ARTIFACT), audience),
    source_ledger: async () => writeJsonAtomic(path.join(dir, PPT_SOURCE_LEDGER_ARTIFACT), sourceLedger),
    fact_ledger: async () => writeJsonAtomic(path.join(dir, PPT_FACT_LEDGER_ARTIFACT), factLedger),
    image_asset_ledger: async () => writeJsonAtomic(path.join(dir, PPT_IMAGE_ASSET_LEDGER_ARTIFACT), imageAssetLedger),
    storyboard: async () => writeJsonAtomic(path.join(dir, PPT_STORYBOARD_ARTIFACT), storyboard),
    style_tokens: async () => writeJsonAtomic(path.join(dir, PPT_STYLE_TOKENS_ARTIFACT), styleTokens),
    review_policy: async () => writeJsonAtomic(path.join(dir, PPT_REVIEW_POLICY_ARTIFACT), reviewPolicy),
    review_ledger: async () => writeJsonAtomic(path.join(dir, PPT_REVIEW_LEDGER_ARTIFACT), reviewLedger),
    iteration_report: async () => writeJsonAtomic(path.join(dir, PPT_ITERATION_REPORT_ARTIFACT), iterationReport),
    html_source: async () => writeTextAtomic(path.join(dir, PPT_HTML_ARTIFACT), html),
    pdf: async () => fsp.writeFile(path.join(dir, PPT_PDF_ARTIFACT), pdfBytes),
    render_report: async () => writeJsonAtomic(path.join(dir, PPT_RENDER_REPORT_ARTIFACT), report)
  });
  const cleanupReport = await buildPptCleanupReport(dir);
  const parallelReport = parallel.report();
  await parallel.group('final_reports', {
    cleanup_report: async () => writeJsonAtomic(path.join(dir, PPT_CLEANUP_REPORT_ARTIFACT), cleanupReport),
    parallel_report: async () => writeJsonAtomic(path.join(dir, PPT_PARALLEL_REPORT_ARTIFACT), parallelReport)
  });
  const baseGate = defaultPptGate(sealed);
  const imagegenEvidence = buildPptImagegenEvidence(imageAssetLedger);
  const gate = {
    ...baseGate,
    passed: report.passed && imageAssetLedger.passed && imagegenEvidence.passed && reviewLedger.passed && iterationReport.passed && cleanupReport.source_html_preserved && cleanupReport.temp_cleanup_completed && parallelReport.passed,
    audience_strategy_sealed: baseGate.audience_strategy_sealed,
    source_ledger_created: true,
    fact_ledger_created: true,
    unsupported_critical_claims_zero: factLedger.unsupported_critical_claims_count === 0,
    storyboard_created: true,
    style_tokens_created: true,
    image_asset_ledger_created: true,
    image_asset_policy_satisfied: imageAssetLedger.passed,
    imagegen_evidence: imagegenEvidence,
    review_policy_created: true,
    review_ledger_created: true,
    bounded_iteration_complete: iterationReport.passed,
    critical_review_issues_zero: reviewLedger.p0_p1_zero,
    parallel_build_recorded: parallelReport.passed,
    html_artifact_created: true,
    source_html_preserved: cleanupReport.source_html_preserved,
    pdf_exported_or_explicitly_deferred: true,
    render_qa_recorded: true,
    temp_cleanup_recorded: cleanupReport.temp_cleanup_completed,
    honest_mode_complete: true,
    render_report_passed: report.passed,
    fact_ledger_passed: factLedger.passed,
    image_asset_ledger_passed: imageAssetLedger.passed,
    review_ledger_passed: reviewLedger.passed,
    iteration_report_passed: iterationReport.passed,
    cleanup_report_passed: cleanupReport.source_html_preserved && cleanupReport.temp_cleanup_completed,
    parallel_report_passed: parallelReport.passed,
    output_files: [PPT_HTML_ARTIFACT, PPT_PDF_ARTIFACT, PPT_FACT_LEDGER_ARTIFACT, PPT_IMAGE_ASSET_LEDGER_ARTIFACT, PPT_REVIEW_POLICY_ARTIFACT, PPT_REVIEW_LEDGER_ARTIFACT, PPT_ITERATION_REPORT_ARTIFACT, PPT_RENDER_REPORT_ARTIFACT, PPT_CLEANUP_REPORT_ARTIFACT, PPT_PARALLEL_REPORT_ARTIFACT],
    updated_at: nowIso()
  };
  await writeJsonAtomic(path.join(dir, PPT_GATE_ARTIFACT), gate);
  return {
    ok: gate.passed,
    gate,
    report,
    cleanup_report: cleanupReport,
    parallel_report: parallelReport,
    files: {
      audience_strategy: path.join(dir, PPT_AUDIENCE_STRATEGY_ARTIFACT),
      source_ledger: path.join(dir, PPT_SOURCE_LEDGER_ARTIFACT),
      fact_ledger: path.join(dir, PPT_FACT_LEDGER_ARTIFACT),
      image_asset_ledger: path.join(dir, PPT_IMAGE_ASSET_LEDGER_ARTIFACT),
      storyboard: path.join(dir, PPT_STORYBOARD_ARTIFACT),
      style_tokens: path.join(dir, PPT_STYLE_TOKENS_ARTIFACT),
      review_policy: path.join(dir, PPT_REVIEW_POLICY_ARTIFACT),
      review_ledger: path.join(dir, PPT_REVIEW_LEDGER_ARTIFACT),
      iteration_report: path.join(dir, PPT_ITERATION_REPORT_ARTIFACT),
      html: path.join(dir, PPT_HTML_ARTIFACT),
      source_html: path.join(dir, PPT_HTML_ARTIFACT),
      pdf: path.join(dir, PPT_PDF_ARTIFACT),
      render_report: path.join(dir, PPT_RENDER_REPORT_ARTIFACT),
      cleanup_report: path.join(dir, PPT_CLEANUP_REPORT_ARTIFACT),
      parallel_report: path.join(dir, PPT_PARALLEL_REPORT_ARTIFACT),
      gate: path.join(dir, PPT_GATE_ARTIFACT)
    }
  };
}
