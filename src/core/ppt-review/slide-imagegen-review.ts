import path from 'node:path';
import fsp from 'node:fs/promises';
import { nowIso, readJson } from '../fsx.js';
import { CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_IMAGEGEN_REQUIRED_POLICY } from '../routes.js';
import { sha256File, imageDimensions } from '../wiki-image/image-hash.js';
import { generateGptImage2CalloutReview } from '../image-ux-review/imagegen-adapter.js';
import { imagegenEvidenceClassBlockers, isFullImagegenEvidenceClass, isFullImagegenOutputSource } from '../imagegen/imagegen-evidence.js';

export const PPT_SLIDE_CALLOUT_LEDGER_ARTIFACT = 'ppt-slide-callout-ledger.json';
export const PPT_SLIDE_IMAGEGEN_REQUEST_ARTIFACT = 'ppt-slide-imagegen-request.json';
export const PPT_SLIDE_IMAGEGEN_RESPONSE_ARTIFACT = 'ppt-slide-imagegen-response.json';

export function buildSlideCalloutPrompt(slide: any = {}, opts: any = {}) {
  return [
    `Review PPT slide ${slide.slide_index || slide.slide_id || 'unknown'} as a presentation design lead.`,
    'Use the slide image as the only visual source of truth.',
    'Mark numbered slide-level callouts with P0/P1/P2/P3 severity labels.',
    'Evaluate layout, visual hierarchy, contrast, typography, content density, data-ink ratio, narrative flow, accessibility, and brand consistency.',
    'Show speaker attention-flow arrows.',
    'Include a corrected mini-comp or before/after strip when useful.',
    'Do not invent product, market, brand, or business requirements that are not visible in the slide or supplied deck context.',
    `Deck context: ${String(opts.deckContext || 'not supplied').replace(/\s+/g, ' ').slice(0, 500)}`
  ].join('\n');
}

export async function generateSlideCalloutReviews({ root, dir, slideExportLedger = null, exportLedger = null, mock = false, generatedSlideImage = null, deckContext = '' }: any = {}) {
  const ledger = slideExportLedger || exportLedger || {};
  const slides = Array.isArray(ledger?.slides) ? ledger.slides : [];
  const planned = slides.map((slide: any) => ({
    id: `ppt-slide-callout-request-${slide.slide_index}`,
    slide_id: slide.slide_id,
    slide_index: slide.slide_index,
    source_slide_image_id: `ppt-source-${slide.slide_id}`,
    source_slide_image_path: slide.image_path,
    prompt: buildSlideCalloutPrompt(slide, { deckContext }),
    model: 'gpt-image-2',
    preferred_surface: 'Codex App $imagegen',
    required_output: 'generated_annotated_slide_review_image_with_numbered_callouts_severity_labels_flow_arrows_and_corrected_mini_comp',
    codex_app_imagegen_doc: CODEX_APP_IMAGE_GENERATION_DOC_URL
  }));
  const generatedReviewImages: any[] = [];
  const blockers: string[] = [];
  if (mock && slides.length > 0) {
    for (const slide of slides) {
      const source = path.resolve(root, slide.image_path);
      const generatedPath = await stageGeneratedSlideReview(root, dir, source, `slide-${slide.slide_index}-generated-review.png`);
      const metadata = await generatedSlideMetadata(root, generatedPath, slide, { mock: true, realGenerated: false });
      generatedReviewImages.push({
        ...metadata,
        status: 'generated',
        source: 'mock_fixture',
        evidence_class: 'mock_fixture',
        output_source: 'mock_fixture',
        output_sha256: metadata.sha256,
        callout_extraction_status: 'succeeded',
        callouts: [{
          callout_id: 'callout-1',
          severity: 'P2',
          bbox: [0, 0, Math.max(1, Number(metadata.width || 1)), Math.max(1, Number(metadata.height || 1))],
          category: 'visual_hierarchy',
          target_element: 'fixture slide canvas',
          fix_action: 'No-op fixture recheck',
          confidence: 0.5,
          source: 'mock_fixture'
        }]
      });
    }
  } else if (generatedSlideImage && slides.length > 0) {
    const slide = slides[0];
    const generatedPath = await stageGeneratedSlideReview(root, dir, path.resolve(root, generatedSlideImage), path.basename(generatedSlideImage));
    const metadata = await generatedSlideMetadata(root, generatedPath, slide, {
      mock: false,
      realGenerated: true,
      providerSurface: 'codex_app_imagegen',
      evidenceClass: 'codex_app_imagegen',
      outputSource: 'manual_attach'
    });
    generatedReviewImages.push({
      ...metadata,
      status: 'attached_generated_review',
      source: 'user_attached_generated_slide_review',
      callout_extraction_status: 'pending',
      callouts: []
    });
  } else if (slides.length > 0) {
    for (const slide of slides) {
      const generated = await generateGptImage2CalloutReview({
        mission_id: null,
        source_screen_id: slide.slide_id || `slide-${slide.slide_index}`,
        source_image_path: path.resolve(root, slide.image_path),
        output_dir: path.join(dir, 'generated-slide-reviews'),
        prompt: buildSlideCalloutPrompt(slide, { deckContext }),
        requested_fidelity: 'original',
        privacy: 'local-only'
      });
      if (!generated.ok || !generated.generated_image_path) {
        blockers.push(generated.blocker || 'ppt_imagegen_callouts_missing');
        continue;
      }
      const response = generated.response_artifact ? await readJson(generated.response_artifact, null).catch(() => null) : null;
      const evidenceClass = String(response?.evidence_class || '');
      const fakeGenerated = evidenceClass === 'mock_fixture' || generated.provider === 'fake_imagegen_adapter';
      const codexGenerated = isFullImagegenEvidenceClass(evidenceClass);
      blockers.push(...imagegenEvidenceClassBlockers('ppt_imagegen', evidenceClass));
      generatedReviewImages.push({
        ...await generatedSlideMetadata(root, generated.generated_image_path, slide, {
          mock: fakeGenerated,
          realGenerated: codexGenerated,
          providerSurface: generated.provider || 'gpt-image-2',
          evidenceClass,
          outputSource: response?.output_source || null,
          outputSha256: response?.output_sha256 || response?.output_image_sha256 || null
        }),
        status: 'generated',
        source: fakeGenerated ? 'mock_fixture' : codexGenerated ? 'real_gpt_image_2_callout' : 'non_codex_api_fallback',
        callout_extraction_status: fakeGenerated ? 'succeeded' : 'pending',
        callouts: fakeGenerated ? [{
          callout_id: 'fake-slide-callout-1',
          severity: 'P2',
          bbox: [0, 0, 1, 1],
          category: 'visual_hierarchy',
          target_element: 'fake slide canvas',
          fix_action: 'No-op fixture recheck',
          confidence: 0.5,
          source: 'mock_fixture'
        }] : [],
        imagegen_request_artifact: generated.request_artifact || null,
        imagegen_response_artifact: generated.response_artifact || null
      });
    }
  }
  if (ledger?.passed !== true) blockers.push(...(ledger?.blockers || []));
  const textOnlyCount = generatedReviewImages.filter((image: any) => image.text_only === true).length;
  if (textOnlyCount > 0) blockers.push('ppt_text_only_review_fallback');
  if (generatedReviewImages.some((image: any) => image.mock === true && image.real_generated === true)) blockers.push('ppt_mock_as_real');
  const normalizedImages = generatedReviewImages.map((image: any) => ({ ...image, path: image.image_path }));
  return {
    schema: 'sks.ppt-slide-callout-ledger.v1',
    schema_version: 1,
    created_at: nowIso(),
    provider: {
      model: 'gpt-image-2',
      preferred_surface: 'Codex App $imagegen',
      codex_app_imagegen_doc: CODEX_APP_IMAGE_GENERATION_DOC_URL,
      required_policy: CODEX_IMAGEGEN_REQUIRED_POLICY
    },
    requests: planned,
    generated_review_images: generatedReviewImages,
    generated_slide_callout_images: normalizedImages,
    generated_slide_callout_images_count: normalizedImages.length,
    required_count: slides.length,
    generated_count: generatedReviewImages.length,
    real_generated_count: generatedReviewImages.filter((image: any) => image.real_generated === true && image.mock !== true).length,
    mock_generated_count: generatedReviewImages.filter((image: any) => image.mock === true).length,
    extraction_ready_count: generatedReviewImages.filter((image: any) => image.callout_extraction_status === 'succeeded').length,
    extraction_pending_count: generatedReviewImages.filter((image: any) => image.callout_extraction_status === 'pending').length,
    blockers: [...new Set(blockers)],
    passed: slides.length > 0 && generatedReviewImages.length === slides.length && blockers.length === 0 && generatedReviewImages.every((image: any) => image.callout_extraction_status === 'succeeded'),
    verified_level: mock ? 'mock_only' : generatedReviewImages.length ? 'verified_partial' : 'blocked',
    next_action: blockers.includes('imagegen_capability_missing')
      ? 'Generate slide callout review images with Codex App $imagegen/gpt-image-2, then attach them or rerun extraction.'
      : null
  };
}

export function buildSlideImagegenRequestArtifact(calloutLedger: any = {}) {
  return {
    schema: 'sks.ppt-slide-imagegen-request.v1',
    created_at: nowIso(),
    requests: calloutLedger.requests || [],
    required_policy: CODEX_IMAGEGEN_REQUIRED_POLICY
  };
}

export function buildSlideImagegenResponseArtifact(calloutLedger: any = {}) {
  return {
    schema: 'sks.ppt-slide-imagegen-response.v1',
    created_at: nowIso(),
    generated_review_images: calloutLedger.generated_review_images || [],
    imagegen_evidence: buildSlideImagegenEvidence(calloutLedger),
    blockers: calloutLedger.blockers || []
  };
}

export function buildSlideImagegenEvidence(calloutLedger: any = {}) {
  const images = Array.isArray(calloutLedger.generated_review_images) ? calloutLedger.generated_review_images : [];
  const requiredCount = Number(calloutLedger.required_count || images.length || 0);
  const blockers: string[] = [];
  for (const image of images) {
    const evidenceClass = String(image.evidence_class || '');
    const outputSource = String(image.output_source || '');
    const outputSha = String(image.output_sha256 || '');
    blockers.push(...imagegenEvidenceClassBlockers('ppt_slide_imagegen', evidenceClass));
    if (!isFullImagegenOutputSource(outputSource)) blockers.push(`ppt_slide_imagegen_output_source_invalid:${outputSource || 'missing'}`);
    if (!outputSha) blockers.push('ppt_slide_imagegen_output_sha256_missing');
    else if (image.sha256 && image.sha256 !== outputSha) blockers.push('ppt_slide_imagegen_output_sha256_mismatch');
    if (image.real_generated !== true) blockers.push('ppt_slide_imagegen_not_real_codex_app_output');
  }
  if (requiredCount > 0 && images.length < requiredCount) blockers.push('ppt_slide_imagegen_required_outputs_missing');
  return {
    schema: 'sks.ppt-slide-imagegen-evidence.v1',
    required: requiredCount > 0,
    required_count: requiredCount,
    generated_count: images.length,
    codex_app_generated_count: images.filter((image: any) => image.evidence_class === 'codex_app_imagegen' && image.real_generated === true).length,
    images: images.map((image: any) => ({
      image_path: image.image_path || image.path || null,
      output_source: image.output_source || null,
      output_sha256: image.output_sha256 || null,
      sha256: image.sha256 || null,
      evidence_class: image.evidence_class || null,
      real_generated: image.real_generated === true,
      mock: image.mock === true,
      response_artifact: image.imagegen_response_artifact || null
    })),
    blockers: [...new Set(blockers)],
    passed: requiredCount > 0 && images.length >= requiredCount && blockers.length === 0
  };
}

async function stageGeneratedSlideReview(root: string, dir: string, source: string, preferredName: string) {
  const dest = path.join(dir, 'generated-slide-reviews', preferredName);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (source !== dest) await fsp.copyFile(source, dest);
  return path.relative(root, dest).split(path.sep).join('/');
}

async function generatedSlideMetadata(root: string, relPath: string, slide: any, opts: any = {}) {
  const absolute = path.isAbsolute(relPath) ? relPath : path.resolve(root, relPath);
  const dims = await imageDimensions(absolute);
  const normalizedPath = path.relative(root, absolute).split(path.sep).join('/');
  const sha = await sha256File(absolute);
  return {
    id: opts.mock ? `ppt-generated-review-fixture-${slide.slide_index || 1}` : `ppt-generated-review-${slide.slide_index || 1}`,
    generated_review_image_id: opts.mock ? `ppt-generated-review-fixture-${slide.slide_index || 1}` : `ppt-generated-review-${slide.slide_index || 1}`,
    slide_id: slide.slide_id,
    slide_index: slide.slide_index,
    source_slide_image_path: slide.image_path,
    image_path: normalizedPath,
    sha256: sha,
    output_sha256: opts.outputSha256 || sha,
    output_source: opts.outputSource || (opts.mock ? 'mock_fixture' : 'manual_attach'),
    evidence_class: opts.evidenceClass || (opts.mock ? 'mock_fixture' : opts.realGenerated ? 'codex_app_imagegen' : 'non_codex_api_fallback'),
    width: dims.width,
    height: dims.height,
    format: dims.format,
    provider_surface: opts.mock ? 'mock_fixture' : (opts.providerSurface || 'Codex App $imagegen'),
    real_generated: opts.realGenerated === true
      && isFullImagegenEvidenceClass(opts.evidenceClass || (opts.mock ? 'mock_fixture' : 'codex_app_imagegen')),
    mock: opts.mock === true,
    local_only: true
  };
}
