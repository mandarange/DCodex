import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists, nowIso, projectRoot, readJson, writeJsonAtomic } from '../fsx.js';
import { sha256File, imageDimensions } from '../wiki-image/image-hash.js';
import { detectImagegenCapability } from '../imagegen/imagegen-capability.js';
import { resolveCodexLbImagegenTarget } from '../imagegen/codex-lb-imagegen-target.js';
import {
  CODEX_LB_PROVIDER_IMAGEGEN_EVIDENCE_CLASS,
  CODEX_LB_PROVIDER_OUTPUT_SOURCE,
  NON_CODEX_API_FALLBACK_EVIDENCE_CLASS
} from '../imagegen/imagegen-evidence.js';
import { validateGptImage2Request } from '../imagegen/gpt-image-2-request-validator.js';
import { parseResponsesSsePayload } from '../responses-stream.js';
import { withResponsesRetry } from '../responses-retry-policy.js';
import { discoverCodexAppGeneratedImage } from './codex-app-generated-image-discovery.js';
import { writeImageArtifactPathContract } from '../image/image-artifact-path-contract.js';
import { registerImageArtifact } from '../image/image-artifact-registry.js';

const DEFAULT_OPENAI_IMAGE_EDITS_ENDPOINT = 'https://api.openai.com/v1/images/edits';
export const DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS = 180000;
const responseDeadlines = new WeakMap<Response, {
  controller: AbortController;
  startedAt: number;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
}>();

export interface ImageUxReviewImagegenAdapter {
  surface: 'codex_app_imagegen' | 'openai_images_api' | 'fake_imagegen_adapter';
  model: 'gpt-image-2';
  available: boolean;
  generateCalloutReview(input: ImageUxReviewImagegenRequest): Promise<ImageUxReviewImagegenResult>;
}

export interface ImageUxReviewImagegenRequest {
  mission_id: string | null;
  source_screen_id: string;
  source_image_path: string;
  output_dir: string;
  prompt: string;
  requested_fidelity: 'original';
  privacy: 'local-only';
}

export interface ImageUxReviewImagegenResult {
  ok: boolean;
  status: 'generated' | 'blocked';
  generated_image_path: string | null;
  output_id: string | null;
  blocker: string | null;
  provider?: string;
  output_source?: 'manual_attach' | 'auto_discovered_generated_images' | null;
  request_artifact?: string | null;
  response_artifact?: string | null;
  latency_ms?: number | null;
  image_artifact_path_contract?: string | null;
}

export function buildCalloutPrompt(sourceScreenId: string, context: any = {}) {
  return [
    'Review this UI screenshot as a senior Toss UI/UX product designer.',
    `Screenshot source id: ${sourceScreenId}.`,
    'Output must be a new image artifact, not prose.',
    'Text-only response is invalid.',
    'Use the screenshot as the reference image input and preserve original-resolution visual evidence as much as the host allows.',
    'Overlay numbered callouts on concrete visible UI regions.',
    'Each callout must include P0/P1/P2/P3 severity labels.',
    'Mark visual hierarchy, contrast, alignment, density, affordance, and eye-flow arrows.',
    'Include a compact corrected mini-comp or before/after strip for the highest-impact fix.',
    'Use only visible evidence and the provided route context.',
    'Do not invent product requirements.',
    context?.target ? `Target surface: ${context.target}.` : ''
  ].filter(Boolean).join(' ');
}

export async function detectCodexAppImagegenCapability(opts: any = {}) {
  const capability = await detectImagegenCapability(opts).catch(() => null);
  const codexApp = capability?.codex_app || {
    available: false,
    detector: 'capability_detection_failed',
    raw: null
  };
  const available = codexApp.available === true;
  return {
    schema: 'sks.codex-app-imagegen-capability.v1',
    ok: true,
    available,
    status: available ? 'available' : 'integration_optional',
    detector: codexApp.detector || 'codex_features_list',
    raw: codexApp.raw || null
  };
}

export function createCodexAppImagegenAdapter(opts: any = {}): ImageUxReviewImagegenAdapter {
  const available = opts.available === true || process.env.SKS_CODEX_APP_IMAGEGEN_AVAILABLE === '1';
  return {
    surface: 'codex_app_imagegen',
    model: 'gpt-image-2',
    available,
    async generateCalloutReview(input: ImageUxReviewImagegenRequest) {
      // Manual attach wins; otherwise auto-discover the most recent Codex App
      // GUI $imagegen output from ~/.codex/generated_images so the route does not
      // require the user to pass SKS_CODEX_APP_IMAGEGEN_OUTPUT by hand.
      const manualOutput = opts.outputImagePath || process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT || null;
      const discovery = !manualOutput && opts.autoDiscoverGeneratedImage !== false
        ? await discoverCodexAppGeneratedImage({
            codexHome: opts.codexHome,
            env: opts.env,
            sinceMs: typeof opts.generatedImageSinceMs === 'number' ? opts.generatedImageSinceMs : null,
            maxAgeMs: opts.generatedImageMaxAgeMs,
            nowMs: typeof opts.nowMs === 'number' ? opts.nowMs : Date.now()
          }).catch(() => null)
        : null;
      const suppliedOutput = manualOutput || discovery?.selected?.path || null;
      if (!input?.output_dir && !suppliedOutput) {
        const blocker = available ? 'imagegen_request_output_dir_missing' : 'imagegen_capability_missing';
        return {
          ok: false,
          status: 'blocked',
          generated_image_path: null,
          output_id: null,
          blocker,
          provider: 'codex_app_imagegen',
          latency_ms: null
        };
      }
      await ensureDir(input.output_dir);
      const requestArtifact = path.join(input.output_dir, 'image-ux-gpt-image-2-request.json');
      const responseArtifact = path.join(input.output_dir, 'image-ux-gpt-image-2-response.json');
      const validation = await validateGptImage2Request({
        provider: 'codex_app_imagegen',
        endpoint: 'Codex App $imagegen',
        model: 'gpt-image-2',
        prompt: input.prompt,
        source_image_path: input.source_image_path,
        output_dir: input.output_dir,
        params: { size: 'auto' },
        privacy: input.privacy
      });
      await writeJsonAtomic(requestArtifact, {
        schema: 'sks.image-ux-gpt-image-2-request.v1',
        created_at: nowIso(),
        provider: 'codex_app_imagegen',
        endpoint: 'Codex App $imagegen',
        model: 'gpt-image-2',
        source_screen_id: input.source_screen_id,
        source_image_path: path.resolve(input.source_image_path),
        prompt: input.prompt,
        validation,
        unsupported_parameters_omitted: ['input_fidelity'],
        privacy: input.privacy
      });
      if (!validation.ok) {
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'codex_app_imagegen',
          evidence_class: 'codex_app_imagegen',
          model: 'gpt-image-2',
          ok: false,
          status: 'blocked',
          blocker: 'gpt_image_2_request_validation_failed',
          validation_blockers: validation.blockers,
          local_only: true
        });
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: 'gpt_image_2_request_validation_failed', provider: 'codex_app_imagegen', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: null };
      }
      if (suppliedOutput && await exists(path.resolve(suppliedOutput))) {
        const dest = path.join(input.output_dir, path.basename(String(suppliedOutput)));
        await fsp.copyFile(path.resolve(suppliedOutput), dest);
        const meta = await generatedImageMetadata(process.cwd(), dest, {
          source_screen_id: input.source_screen_id,
          provider_surface: 'codex_app_imagegen',
          output_id: opts.outputId || null,
          real_generated: true
        });
        const outputSource = manualOutput ? 'manual_attach' : 'auto_discovered_generated_images';
        const imageContract = await writeGeneratedImagePathContract(input, dest, 'codex_app_imagegen').catch(() => null);
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'codex_app_imagegen',
          evidence_class: 'codex_app_imagegen',
          model: 'gpt-image-2',
          ok: true,
          status: 'generated',
          output_image_path: dest,
          output_image_sha256: meta.sha256,
          output_sha256: meta.sha256,
          output_id: meta.output_id,
          output_source: outputSource,
          image_artifact_path_contract: imageContract?.artifact_path || null,
          discovered_from: discovery?.selected?.path || null,
          discovery: discovery ? { candidates_considered: discovery.candidates_considered, since_ms: discovery.since_ms, max_age_ms: discovery.max_age_ms } : null,
          local_only: true
        });
        return {
          ok: true,
          status: 'generated',
          generated_image_path: dest,
          output_id: opts.outputId || null,
          blocker: null,
          provider: 'codex_app_imagegen',
          output_source: outputSource,
          request_artifact: requestArtifact,
          response_artifact: responseArtifact,
          image_artifact_path_contract: imageContract?.artifact_path || null,
          latency_ms: null
        };
      }
      await writeJsonAtomic(responseArtifact, {
        schema: 'sks.image-ux-gpt-image-2-response.v1',
        created_at: nowIso(),
        provider: 'codex_app_imagegen',
        evidence_class: 'codex_app_imagegen',
        model: 'gpt-image-2',
        ok: false,
        status: 'blocked',
        blocker: available ? 'codex_app_imagegen_output_missing' : 'imagegen_capability_missing',
        setup_guidance: available
          ? 'Codex App image generation is available, but SKS found no fresh generated image. In Codex App run $imagegen/gpt-image-2 to generate the annotated review image (SKS auto-discovers the newest output from ~/.codex/generated_images), or attach it explicitly with SKS_CODEX_APP_IMAGEGEN_OUTPUT.'
          : 'Codex App image generation was not detected. Run in Codex App with $imagegen/gpt-image-2. For a separate non-Codex API task, explicitly enable the OpenAI Images API fallback and set OPENAI_API_KEY.',
        generated_images_dir: discovery?.generated_images_dir || null,
        discovery_rejected_reason: discovery?.rejected_reason || null,
        local_only: true
      });
      return {
        ok: false,
        status: 'blocked',
        generated_image_path: null,
        output_id: null,
        blocker: available ? 'codex_app_imagegen_output_missing' : 'imagegen_capability_missing',
        provider: 'codex_app_imagegen',
        request_artifact: requestArtifact,
        response_artifact: responseArtifact,
        latency_ms: null
      };
    }
  };
}

export function createFakeImagegenAdapter(opts: any = {}): ImageUxReviewImagegenAdapter {
  return {
    surface: 'fake_imagegen_adapter',
    model: 'gpt-image-2',
    available: opts.available !== false,
    async generateCalloutReview(input: ImageUxReviewImagegenRequest) {
      const started = Date.now();
      await ensureDir(input.output_dir);
      const requestArtifact = path.join(input.output_dir, 'image-ux-gpt-image-2-request.json');
      const responseArtifact = path.join(input.output_dir, 'image-ux-gpt-image-2-response.json');
      if (!imagegenMockContext(opts)) {
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'fake_imagegen_adapter',
          fake_adapter: true,
          execution_class: 'mock_fixture',
          evidence_class: 'mock_fixture',
          model: 'gpt-image-2',
          ok: false,
          status: 'blocked',
          blocker: 'fake_imagegen_requires_test_or_mock_context',
          local_only: true
        });
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: 'fake_imagegen_requires_test_or_mock_context', provider: 'fake_imagegen_adapter', request_artifact: null, response_artifact: responseArtifact, latency_ms: Date.now() - started };
      }
      const validation = await validateGptImage2Request({
        provider: 'fake_imagegen_adapter',
        endpoint: 'local hermetic fixture',
        model: 'gpt-image-2',
        prompt: input.prompt,
        source_image_path: input.source_image_path,
        output_dir: input.output_dir,
        params: { size: 'auto' },
        privacy: input.privacy
      });
      await writeJsonAtomic(requestArtifact, {
        schema: 'sks.image-ux-gpt-image-2-request.v1',
        created_at: nowIso(),
        provider: 'fake_imagegen_adapter',
        endpoint: 'local hermetic fixture',
        model: 'gpt-image-2',
        source_screen_id: input.source_screen_id,
        source_image_path: path.resolve(input.source_image_path),
        prompt: input.prompt,
        validation,
        fake_adapter: true,
        source: 'mock_like_fixture',
        real_generation_claim_allowed: false,
        unsupported_parameters_omitted: ['input_fidelity'],
        privacy: input.privacy
      });
      if (!validation.ok) {
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'fake_imagegen_adapter',
          fake_adapter: true,
          execution_class: 'mock_fixture',
          evidence_class: 'mock_fixture',
          model: 'gpt-image-2',
          ok: false,
          status: 'blocked',
          blocker: 'gpt_image_2_request_validation_failed',
          validation_blockers: validation.blockers,
          local_only: true
        });
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: 'gpt_image_2_request_validation_failed', provider: 'fake_imagegen_adapter', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
      }
      const sourcePath = path.resolve(input.source_image_path);
      const out = path.join(input.output_dir, `fake-gpt-image-2-callout-${input.source_screen_id || 'screen'}.png`);
      await fsp.copyFile(sourcePath, out);
      const meta = await generatedImageMetadata(process.cwd(), out, {
        source_screen_id: input.source_screen_id,
        provider_surface: 'fake_imagegen_adapter',
        output_id: `fake-${Date.now()}`,
        real_generated: false,
        mock: true
      });
      const imageContract = await writeGeneratedImagePathContract(input, out, 'fake_imagegen_adapter').catch(() => null);
      await writeJsonAtomic(responseArtifact, {
        schema: 'sks.image-ux-gpt-image-2-response.v1',
        created_at: nowIso(),
        provider: 'fake_imagegen_adapter',
        fake_adapter: true,
        execution_class: 'mock_fixture',
        evidence_class: 'mock_fixture',
        model: 'gpt-image-2',
        ok: true,
        status: 'generated',
        output_image_path: out,
        output_image_sha256: meta.sha256,
        output_sha256: meta.sha256,
        output_id: meta.output_id,
        output_source: 'mock_fixture',
        image_artifact_path_contract: imageContract?.artifact_path || null,
        dimensions: { width: meta.width, height: meta.height, format: meta.format },
        latency_ms: Date.now() - started,
        source: 'mock_like_fixture',
        real_generated: false,
        mock: true,
        local_only: true
      });
      return { ok: true, status: 'generated', generated_image_path: out, output_id: meta.output_id, blocker: null, provider: 'fake_imagegen_adapter', request_artifact: requestArtifact, response_artifact: responseArtifact, image_artifact_path_contract: imageContract?.artifact_path || null, latency_ms: Date.now() - started };
    }
  };
}

export function createOpenAIImagesApiAdapter(opts: any = {}): ImageUxReviewImagegenAdapter {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY || null;
  const allowCodexLbApiFallback = opts.allowCodexLbApiFallback === true || process.env.SKS_IMAGEGEN_ALLOW_CODEX_LB_API_FALLBACK === '1';
  const codexLb = allowCodexLbApiFallback && opts.codexLb?.available === true ? opts.codexLb : null;
  return {
    surface: 'openai_images_api',
    model: 'gpt-image-2',
    available: Boolean(apiKey || codexLb),
    async generateCalloutReview(input: ImageUxReviewImagegenRequest) {
      const started = Date.now();
      await ensureDir(input.output_dir);
      const requestArtifact = path.join(input.output_dir, 'image-ux-gpt-image-2-request.json');
      const responseArtifact = path.join(input.output_dir, 'image-ux-gpt-image-2-response.json');
      const sourcePath = path.resolve(input.source_image_path);
      const sourceSha = await sha256File(sourcePath);
      const auth = await resolveImagesApiAuth({ ...opts, apiKey, codexLb });
      const useResponsesImageTool = auth.auth_source === 'CODEX_LB_API_KEY' && Boolean(auth.responses_endpoint);
      const effectiveEndpoint = useResponsesImageTool ? auth.responses_endpoint : auth.endpoint;
      const responsesModel = String(auth.responses_model || '');
      // Only a *selected* codex-lb provider earns the codex-lb evidence class.
      // codex-lb enabled as a fallback while another provider is active is a
      // detour and stays classified as one.
      const codexLbProviderSelected = useResponsesImageTool && (opts.codexLbTarget?.selected === true || codexLb?.selected === true);
      const responsesEvidenceClass = codexLbProviderSelected
        ? CODEX_LB_PROVIDER_IMAGEGEN_EVIDENCE_CLASS
        : NON_CODEX_API_FALLBACK_EVIDENCE_CLASS;
      const responsesOutputSource = codexLbProviderSelected ? CODEX_LB_PROVIDER_OUTPUT_SOURCE : null;
      const validation = await validateGptImage2Request({
        provider: 'openai_images_api',
        endpoint: String(effectiveEndpoint || ''),
        model: 'gpt-image-2',
        prompt: input.prompt,
        source_image_path: sourcePath,
        output_dir: input.output_dir,
        params: { size: 'auto' },
        privacy: input.privacy
      });
      await writeJsonAtomic(requestArtifact, {
        schema: 'sks.image-ux-gpt-image-2-request.v1',
        created_at: nowIso(),
        provider: useResponsesImageTool ? 'openai_responses_image_generation' : 'openai_images_api',
        endpoint: effectiveEndpoint,
        auth_source: auth.auth_source,
        model: 'gpt-image-2',
        responses_model: useResponsesImageTool ? responsesModel : null,
        source_screen_id: input.source_screen_id,
        source_image_path: sourcePath,
        source_screenshot_sha256: sourceSha,
        prompt: input.prompt,
        validation,
        image_input_fidelity_note: 'high_fidelity_automatic',
        unsupported_parameters_omitted: ['input_fidelity'],
        privacy: input.privacy
      });
      if (!validation.ok) {
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'openai_images_api',
          evidence_class: 'non_codex_api_fallback',
          model: 'gpt-image-2',
          ok: false,
          status: 'blocked',
          blocker: 'gpt_image_2_request_validation_failed',
          validation_blockers: validation.blockers,
          local_only: true
        });
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: 'gpt_image_2_request_validation_failed', provider: 'openai_images_api', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
      }
      if (auth.blocker || !auth.apiKey) {
        const blocked = {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'openai_images_api',
          evidence_class: 'non_codex_api_fallback',
          model: 'gpt-image-2',
          ok: false,
          status: 'blocked',
          blocker: auth.blocker,
          setup_guidance: auth.auth_source === 'CODEX_LB_API_KEY'
            ? 'Repair the selected codex-lb credential binding. Completed output from a selected provider can satisfy full evidence; codex-lb used only as a fallback while another provider is selected cannot.'
            : 'Set OPENAI_API_KEY only for an explicit non-Codex Images API fallback, or attach a real Codex App $imagegen output image for full SKS verification.',
          local_only: true
        };
        await writeJsonAtomic(responseArtifact, blocked);
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: auth.blocker, provider: 'openai_images_api', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
      }
      if (useResponsesImageTool && !responsesModel) {
        const blocker = 'imagegen_responses_model_missing';
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'openai_responses_image_generation',
          evidence_class: 'non_codex_api_fallback',
          model: 'gpt-image-2',
          ok: false,
          status: 'blocked',
          blocker,
          setup_guidance: 'Set SKS_IMAGEGEN_RESPONSES_MODEL to a model available through the configured Responses provider; SKS does not hardcode a text model.',
          local_only: true
        });
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker, provider: 'openai_responses_image_generation', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
      }
      try {
        if (useResponsesImageTool) {
          const imageDataUrl = `data:${mimeForPath(sourcePath)};base64,${await fsp.readFile(sourcePath, 'base64')}`;
          const { result: attemptResult, attempts, retry_log } = await withResponsesRetry(async () => {
            const response = await fetchWithTimeout(effectiveEndpoint, {
              method: 'POST',
              headers: { authorization: `Bearer ${auth.apiKey}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                model: responsesModel,
                input: [{
                  role: 'user',
                  content: [
                    { type: 'input_text', text: input.prompt },
                    { type: 'input_image', image_url: imageDataUrl }
                  ]
                }],
                tools: [{ type: 'image_generation', action: 'edit', size: 'auto', ...imagegenQualityParam(opts) }],
                tool_choice: { type: 'image_generation' }
              })
            }, imagegenFetchTimeoutMs(opts));
            const payload = await readResponsePayload(response, imagegenFetchTimeoutMs(opts));
            // Retry on transient HTTP status OR an SSE/JSON server_error/rate_limit payload.
            return { value: { response, payload }, status: response.ok ? null : response.status, code: payloadRetryCode(payload) };
          }, imagegenRetryOptions(opts));
          const { response, payload } = attemptResult;
          if (!response.ok) {
            await writeJsonAtomic(responseArtifact, redactedImagegenResponse(payload, false, Date.now() - started, 'openai_responses_image_generation', { attempts, retry_log }));
            return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: imagegenErrorKind(payload), provider: 'openai_responses_image_generation', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
          }
          if (payload?.error) {
            await writeJsonAtomic(responseArtifact, redactedImagegenResponse(payload, false, Date.now() - started, 'openai_responses_image_generation'));
            return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: imagegenErrorKind(payload), provider: 'openai_responses_image_generation', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
          }
          const generated = findResponsesImageGenerationOutput(payload);
          if (!generated?.b64) {
            await writeJsonAtomic(responseArtifact, redactedImagegenResponse({ ...payload, blocker: 'missing_b64_image_output' }, false, Date.now() - started, 'openai_responses_image_generation'));
            return { ok: false, status: 'blocked', generated_image_path: null, output_id: generated?.id || null, blocker: 'missing_b64_image_output', provider: 'openai_responses_image_generation', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
          }
          const out = path.join(input.output_dir, `gpt-image-2-callout-${Date.now()}.png`);
          await fsp.writeFile(out, Buffer.from(String(generated.b64), 'base64'));
          const meta = await generatedImageMetadata(process.cwd(), out, {
            source_screen_id: input.source_screen_id,
            provider_surface: 'openai_responses_image_generation',
            output_id: generated.id || payload?.id || null,
            evidence_class: responsesEvidenceClass,
            output_source: responsesOutputSource,
            real_generated: true
          });
          const imageContract = await writeGeneratedImagePathContract(input, out, 'openai_responses_image_generation').catch(() => null);
          await writeJsonAtomic(responseArtifact, {
            schema: 'sks.image-ux-gpt-image-2-response.v1',
            created_at: nowIso(),
            provider: 'openai_responses_image_generation',
            evidence_class: responsesEvidenceClass,
            model: 'gpt-image-2',
            responses_model: responsesModel,
            responses_model_source: auth.responses_model_source || null,
            auth_source: auth.auth_source,
            api_key_source: auth.api_key_source || null,
            codex_lb_provider_selected: codexLbProviderSelected,
            ok: true,
            status: 'generated',
            output_image_path: out,
            output_image_sha256: meta.sha256,
            output_sha256: meta.sha256,
            output_id: meta.output_id,
            output_source: responsesOutputSource,
            image_output_recovered_from_stream: payload?.image_output_recovered_from_stream === true,
            image_output_provenance: payload?.image_output_provenance || 'response.output',
            image_output_partial_frame: false,
            image_artifact_path_contract: imageContract?.artifact_path || null,
            dimensions: { width: meta.width, height: meta.height, format: meta.format },
            latency_ms: Date.now() - started,
            token_cost_metadata: payload?.usage || null,
            local_only: true
          });
          return { ok: true, status: 'generated', generated_image_path: out, output_id: meta.output_id, blocker: null, provider: 'openai_responses_image_generation', request_artifact: requestArtifact, response_artifact: responseArtifact, image_artifact_path_contract: imageContract?.artifact_path || null, latency_ms: Date.now() - started };
        }
        const sourceBytes = await fsp.readFile(sourcePath);
        const qualityParam = imagegenQualityParam(opts);
        const { result: attemptResult, attempts, retry_log } = await withResponsesRetry(async () => {
          const form = new FormData();
          form.append('model', 'gpt-image-2');
          form.append('prompt', input.prompt);
          if (qualityParam.quality) form.append('quality', String(qualityParam.quality));
          form.append('image', new Blob([sourceBytes], { type: mimeForPath(sourcePath) }), path.basename(sourcePath));
          const response = await fetchWithTimeout(auth.endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${auth.apiKey}` },
            body: form
          }, imagegenFetchTimeoutMs(opts));
          const payload = await readResponsePayload(response, imagegenFetchTimeoutMs(opts));
          return { value: { response, payload }, status: response.ok ? null : response.status, code: payloadRetryCode(payload) };
        }, imagegenRetryOptions(opts));
        const { response, payload } = attemptResult;
        if (!response.ok) {
          await writeJsonAtomic(responseArtifact, redactedImagegenResponse(payload, false, Date.now() - started, 'openai_images_api', { attempts, retry_log }));
          return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: imagegenErrorKind(payload), provider: 'openai_images_api', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
        }
        const image = Array.isArray(payload?.data) ? payload.data[0] : null;
        const b64 = image?.b64_json || image?.b64 || null;
        if (!b64) {
          await writeJsonAtomic(responseArtifact, redactedImagegenResponse({ ...payload, blocker: 'missing_b64_image_output' }, false, Date.now() - started));
          return { ok: false, status: 'blocked', generated_image_path: null, output_id: image?.id || null, blocker: 'missing_b64_image_output', provider: 'openai_images_api', request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
        }
        const out = path.join(input.output_dir, `gpt-image-2-callout-${Date.now()}.png`);
        await fsp.writeFile(out, Buffer.from(String(b64), 'base64'));
        const meta = await generatedImageMetadata(process.cwd(), out, {
          source_screen_id: input.source_screen_id,
          provider_surface: 'openai_images_api',
          output_id: image?.id || payload?.id || null,
          real_generated: true
        });
        const imageContract = await writeGeneratedImagePathContract(input, out, 'openai_images_api').catch(() => null);
        await writeJsonAtomic(responseArtifact, {
          schema: 'sks.image-ux-gpt-image-2-response.v1',
          created_at: nowIso(),
          provider: 'openai_images_api',
          evidence_class: 'non_codex_api_fallback',
          model: 'gpt-image-2',
          auth_source: auth.auth_source,
          ok: true,
          status: 'generated',
          output_image_path: out,
          output_image_sha256: meta.sha256,
          output_sha256: meta.sha256,
          output_id: meta.output_id,
          image_artifact_path_contract: imageContract?.artifact_path || null,
          dimensions: { width: meta.width, height: meta.height, format: meta.format },
          latency_ms: Date.now() - started,
          token_cost_metadata: payload?.usage || null,
          local_only: true
        });
        return { ok: true, status: 'generated', generated_image_path: out, output_id: meta.output_id, blocker: null, provider: 'openai_images_api', request_artifact: requestArtifact, response_artifact: responseArtifact, image_artifact_path_contract: imageContract?.artifact_path || null, latency_ms: Date.now() - started };
      } catch (err: unknown) {
        const provider = useResponsesImageTool ? 'openai_responses_image_generation' : 'openai_images_api';
        const payload = { error: { message: err instanceof Error ? err.message : String(err) } };
        const response = redactedImagegenResponse(payload, false, Date.now() - started, provider);
        await writeJsonAtomic(responseArtifact, response);
        return { ok: false, status: 'blocked', generated_image_path: null, output_id: null, blocker: imagegenErrorKind(payload), provider, request_artifact: requestArtifact, response_artifact: responseArtifact, latency_ms: Date.now() - started };
      }
    }
  };
}

async function writeGeneratedImagePathContract(input: ImageUxReviewImagegenRequest, outputPath: string, provider: string) {
  const root = await resolveImageArtifactRoot(input);
  const skipNativeInvocationPlan = provider !== 'codex_app_imagegen';
  if (input.mission_id) {
    await registerImageArtifact(root, {
      missionId: input.mission_id,
      id: `${provider}-${input.source_screen_id || 'screen'}`,
      kind: 'generated_image',
      filePath: outputPath,
      route: '$Image-UX-Review',
      stage: provider,
      skipNativeInvocationPlan
    });
  }
  return writeImageArtifactPathContract(root, {
    missionId: input.mission_id || 'unassigned',
    images: [{
      id: `${provider}-${input.source_screen_id || 'screen'}`,
      kind: 'generated_image',
      filePath: outputPath,
      route: '$Image-UX-Review',
      stage: provider
    }],
    artifactPath: path.join(input.output_dir, 'image-artifact-path-contract.json'),
    skipNativeInvocationPlan
  });
}

async function resolveImageArtifactRoot(input: ImageUxReviewImagegenRequest): Promise<string> {
  const cwdRoot = await projectRoot(process.cwd()).catch(() => process.cwd());
  const resolvedCwd = path.resolve(process.cwd());
  if (path.resolve(cwdRoot) !== resolvedCwd) return cwdRoot;
  return projectRoot(input.output_dir || process.cwd()).catch(() => cwdRoot);
}

export async function generateGptImage2CalloutReview(input: ImageUxReviewImagegenRequest, opts: any = {}) {
  if ((opts.fake === true || process.env.SKS_TEST_FAKE_IMAGEGEN === '1') && imagegenMockContext(opts)) {
    return createFakeImagegenAdapter({ ...(opts.fakeAdapter || {}), mockContext: true }).generateCalloutReview(input);
  }
  const capability = await detectImagegenCapability(opts.capability || {}).catch(() => null);
  // Resolve the provider from the same home/env the capability probe used, so a
  // caller that supplies a hermetic root is never answered from the operator's
  // real ~/.codex/config.toml.
  const codexLbTarget = opts.codexLbTarget || await resolveCodexLbImagegenTarget(codexLbTargetInputs(opts.capability)).catch(() => null);
  // codex-lb output is still classified as a non-Codex-App fallback, but when
  // codex-lb is the *selected* provider there is no other route to reach: the
  // Codex App surface answers through this same proxy. Requiring an opt-in flag
  // there left the only working path unreachable, so selection enables it and an
  // explicit `0`/false still switches it off.
  const explicitDisableCodexLbFallback = opts.allowCodexLbApiFallback === false || process.env.SKS_IMAGEGEN_ALLOW_CODEX_LB_API_FALLBACK === '0';
  const allowCodexLbApiFallback = !explicitDisableCodexLbFallback && (
    opts.allowCodexLbApiFallback === true
    || process.env.SKS_IMAGEGEN_ALLOW_CODEX_LB_API_FALLBACK === '1'
    || codexLbTarget?.selected === true
  );
  const allowApiFallback = (
    opts.allowApiFallback === true
    || process.env.SKS_IMAGEGEN_ALLOW_API_FALLBACK === '1'
    || allowCodexLbApiFallback
  );
  const openaiOptions = {
    ...(opts.openai || {}),
    codexLb: allowCodexLbApiFallback ? opts.openai?.codexLb || capability?.codex_lb || null : null,
    codexLbTarget,
    allowCodexLbApiFallback
  };
  const codexAdapter = createCodexAppImagegenAdapter({
    ...(opts.codexApp || {}),
    available: opts.codexApp?.available === true || capability?.codex_app?.available === true
  });
  const codexResult = await codexAdapter.generateCalloutReview(input);
  if (codexResult.ok || !allowApiFallback) return codexResult;
  return createOpenAIImagesApiAdapter(openaiOptions).generateCalloutReview(input);
}

function codexLbTargetInputs(source: any = {}) {
  const inputs: { home?: string; codexHome?: string; env?: NodeJS.ProcessEnv; configText?: string } = {};
  if (source?.home) inputs.home = source.home;
  if (source?.codexHome) inputs.codexHome = source.codexHome;
  if (source?.env) inputs.env = source.env;
  if (typeof source?.configText === 'string') inputs.configText = source.configText;
  return inputs;
}

function imagegenMockContext(opts: any = {}) {
  return opts.mockContext === true
    || opts.testContext === true
    || process.env.NODE_ENV === 'test'
    || process.env.SKS_SELFTEST_MOCK === '1'
    || process.env.SKS_MOCK === '1';
}

export function imagegenCapabilityBlocker(surface = 'Codex App $imagegen') {
  return {
    schema: 'sks.image-ux-imagegen-blocker.v1',
    status: 'blocked',
    blocker: 'imagegen_capability_missing',
    surface,
    model: 'gpt-image-2',
    guidance: 'Run the request with gpt-image-2 through Codex App $imagegen or a selected, ready codex-lb provider and bind the completed generated image path. OPENAI_API_KEY, or codex-lb used while another provider is selected, remains non-Codex fallback evidence. SKS must not fabricate or substitute a text-only review.'
  };
}

async function resolveImagesApiAuth(opts: any = {}) {
  const codexLb = opts.codexLb?.available === true ? opts.codexLb : null;
  const target = opts.codexLbTarget || (codexLb
    ? await resolveCodexLbImagegenTarget(codexLbTargetInputs(opts)).catch(() => null)
    : null);
  // Provider selection is authoritative. A separately exported OPENAI_API_KEY
  // must not reroute a codex-lb session to api.openai.com, change the evidence
  // class, and leave the selected proxy unused.
  if (target?.selected === true) return codexLbImagesApiAuth(opts, codexLb, target);

  const openAiKey = String(opts.apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (openAiKey) {
    return {
      apiKey: openAiKey,
      auth_source: 'OPENAI_API_KEY',
      api_key_source: null,
      responses_model: responsesImagegenModel(opts),
      responses_model_source: responsesImagegenModel(opts) ? 'explicit' : null,
      endpoint: imageEditsEndpoint(opts.baseUrl || 'https://api.openai.com/v1'),
      responses_endpoint: responsesEndpoint(opts.baseUrl || 'https://api.openai.com/v1'),
      blocker: null
    };
  }
  if (!codexLb) {
    return {
      apiKey: null,
      auth_source: null,
      api_key_source: null,
      responses_model: responsesImagegenModel(opts),
      responses_model_source: null,
      endpoint: imageEditsEndpoint(opts.baseUrl || 'https://api.openai.com/v1'),
      responses_endpoint: responsesEndpoint(opts.baseUrl || 'https://api.openai.com/v1'),
      blocker: 'openai_api_key_missing'
    };
  }
  // The fingerprint-bound loader, not raw process.env: a stale exported
  // CODEX_LB_API_KEY otherwise shadows the SKS-managed env file and the proxy
  // answers 401 while every capability probe still reports "ready".
  return codexLbImagesApiAuth(opts, codexLb, target);
}

function codexLbImagesApiAuth(opts: any, codexLb: any, target: any) {
  const envKey = codexLb?.env_key || 'CODEX_LB_API_KEY';
  const codexLbKey = String(opts.codexLbApiKey || target?.api_key || '').trim();
  const baseUrl = target?.base_url || codexLb?.base_url || opts.baseUrl || '';
  const blocker = !baseUrl
    ? 'codex_lb_base_url_missing'
    : codexLbKey
      ? null
      : target?.blocker || 'codex_lb_api_key_missing';
  return {
    apiKey: codexLbKey || null,
    auth_source: envKey,
    api_key_source: target?.api_key_source || null,
    // config.toml's `model` is often a slug this key cannot use; the served
    // catalog is the only source that is safe to default to.
    responses_model: responsesImagegenModel(opts) || target?.model || '',
    responses_model_source: responsesImagegenModel(opts) ? 'explicit' : target?.model_source || null,
    endpoint: baseUrl ? imageEditsEndpoint(baseUrl) : null,
    responses_endpoint: baseUrl ? responsesEndpoint(baseUrl) : null,
    blocker
  };
}

function imageEditsEndpoint(baseUrl: any = '') {
  const base = String(baseUrl || DEFAULT_OPENAI_IMAGE_EDITS_ENDPOINT).trim().replace(/\/+$/, '');
  return /\/images\/edits$/i.test(base) ? base : `${base}/images/edits`;
}

function responsesEndpoint(baseUrl: any = '') {
  const base = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return /\/responses$/i.test(base) ? base : `${base}/responses`;
}

function responsesImagegenModel(opts: any = {}) {
  return String(opts.responsesModel || process.env.SKS_IMAGEGEN_RESPONSES_MODEL || '').trim();
}

function imagegenFetchTimeoutMs(opts: any = {}) {
  const value = Number(opts.fetchTimeoutMs || process.env.SKS_IMAGEGEN_FETCH_TIMEOUT_MS || DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS;
}

async function fetchWithTimeout(url: any, init: any, timeoutMs: number) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(new Error(`imagegen_fetch_timeout_${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    responseDeadlines.set(response, { controller, startedAt, timeoutMs, timer: timeout });
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function readResponsePayload(response: Response, timeoutMs = DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS) {
  const text = await textWithTimeout(response, timeoutMs);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const sse = parseResponsesSsePayload(text);
    if (sse) return sse;
    return { error: { message: text.slice(0, 2000) } };
  }
}

async function textWithTimeout(response: Response, timeoutMs: number) {
  const deadline = responseDeadlines.get(response);
  if (deadline) clearTimeout(deadline.timer);
  const remainingMs = deadline
    ? Math.max(1, deadline.timeoutMs - (Date.now() - deadline.startedAt))
    : timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`imagegen_response_read_timeout_${timeoutMs}ms`);
          deadline?.controller.abort(error);
          void response.body?.cancel(error).catch(() => {});
          reject(error);
        }, remainingMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    responseDeadlines.delete(response);
  }
}


function findResponsesImageGenerationOutput(payload: any): { b64: string | null, id: string | null } | null {
  if (payload?.image_output_partial_frame === true) return null;
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    if (String(output?.type || '') === 'image_generation_call') {
      if (String(output?.status || '') === 'partial') continue;
      const b64 = typeof output?.result === 'string' ? output.result : output?.result?.b64_json || output?.b64_json || null;
      if (b64) return { b64: String(b64), id: output?.id || payload?.id || null };
    }
  }
  return null;
}

export async function generatedImageMetadata(root: string, imagePath: string, opts: any = {}) {
  const absolute = path.resolve(root, imagePath);
  const dims = await imageDimensions(absolute);
  return {
    id: opts.id || `generated-review-${(await sha256File(absolute)).slice(0, 10)}`,
    path: path.relative(root, absolute).split(path.sep).join('/'),
    sha256: await sha256File(absolute),
    width: dims.width,
    height: dims.height,
    format: dims.format,
    source_screen_id: opts.source_screen_id || null,
    provider_model: 'gpt-image-2',
    provider_surface: opts.provider_surface || 'codex_app_imagegen',
    evidence_class: opts.evidence_class || (opts.mock ? 'mock_fixture' : 'codex_app_imagegen'),
    output_source: opts.output_source || (opts.mock ? 'mock_fixture' : 'manual_attach'),
    output_sha256: opts.output_sha256 || await sha256File(absolute),
    requested_fidelity: 'high_fidelity_automatic',
    image_input_fidelity_note: 'high_fidelity_automatic',
    privacy: 'local-only',
    output_id: opts.output_id || null,
    created_at: opts.created_at || nowIso(),
    real_generated: opts.real_generated === true,
    mock: opts.mock === true,
    callout_extraction_required: true,
    source: opts.mock ? 'mock_fixture' : 'real_gpt_image_2_callout'
  };
}

function mimeForPath(file: string) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function redactedImagegenResponse(payload: any, ok: boolean, latencyMs: number, provider = 'openai_images_api', retry: { attempts?: number; retry_log?: any[] } = {}) {
  return {
    schema: 'sks.image-ux-gpt-image-2-response.v1',
    created_at: nowIso(),
    provider,
    evidence_class: provider === 'codex_app_imagegen' ? 'codex_app_imagegen' : 'non_codex_api_fallback',
    model: 'gpt-image-2',
    ok,
    status: ok ? 'generated' : 'blocked',
    blocker: ok ? null : imagegenErrorKind(payload),
    redacted_error: payload?.error?.message ? String(payload.error.message).replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_OPENAI_KEY]') : null,
    payload_summary: summarizeImagegenPayload(payload),
    latency_ms: latencyMs,
    attempts: retry.attempts ?? null,
    retry_log: retry.retry_log ?? null,
    local_only: true
  };
}

// Classify a parsed image-API/Responses payload into a retryable error code so a
// 200-with-server_error SSE body or an `error.code` of rate_limit/overloaded is
// retried, not just non-2xx HTTP statuses. Returns null when not retryable.
function payloadRetryCode(payload: any): string | null {
  if (!payload) return null;
  const status = String(payload?.status || '');
  const errorType = String(payload?.error?.type || payload?.error?.code || '');
  const haystack = `${status} ${errorType} ${JSON.stringify(payload?.error || '')}`.toLowerCase();
  if (/rate[_ -]?limit|too many requests|429/.test(haystack)) return 'rate_limit_exceeded';
  if (/overloaded|proxy_overloaded|server[_ -]?error|temporarily unavailable|unavailable|5\d\d/.test(haystack)) return 'server_error';
  if (/timeout|timed out|aborted/.test(haystack)) return 'ETIMEDOUT';
  if (status === 'failed' && /server|overload|unavailable|rate/.test(haystack)) return 'server_error';
  // A stream that ended without a terminal event and without a single output
  // item was cut short server-side, which is transient — observed against
  // codex-lb mid-generation. Retry rather than reporting a missing image.
  if (status === 'unknown' && String(payload?.object || '') === 'response.sse') return 'server_error';
  return null;
}

// gpt-image-2 supports an optional `quality` (low|medium|high|auto). Default to
// 'high' for review callouts so legibility holds; allow override/disable.
function imagegenQualityParam(opts: any = {}): { quality?: string } {
  const raw = String(opts.quality || process.env.SKS_IMAGEGEN_QUALITY || 'high').trim().toLowerCase();
  if (raw === 'none' || raw === 'off' || raw === '') return {};
  return ['low', 'medium', 'high', 'auto'].includes(raw) ? { quality: raw } : { quality: 'high' };
}

// Wire imagegen fetches into the centralized responses retry policy: exponential
// backoff on 429/5xx/timeout and transient network errors, classifying a thrown
// fetch error (abort/timeout/network) into a retryable code.
function imagegenRetryOptions(opts: any = {}) {
  return {
    sleep: opts.retrySleep,
    classifyError: (err: unknown) => {
      const row = err as { code?: string; name?: string; message?: string } | null;
      const code = [row?.code, row?.name, row?.message].filter(Boolean).join(' ');
      if (/AbortError|timeout|abort/i.test(code)) return { code: 'ETIMEDOUT', status: null };
      if (/ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(code)) return { code: 'ECONNRESET', status: null };
      return { code: 'request_failed', status: null };
    }
  };
}

function summarizeImagegenPayload(payload: any) {
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  return {
    id: payload?.id || null,
    object: payload?.object || null,
    status: payload?.status || null,
    model: payload?.model || null,
    error_type: payload?.error?.type || null,
    error_code: payload?.error?.code || null,
    image_output_partial_frame: payload?.image_output_partial_frame === true,
    partial_image_output_present: payload?.partial_image_output_present === true,
    image_output_provenance: payload?.image_output_provenance || null,
    output_count: outputs.length,
    output: outputs.slice(0, 8).map((output: any) => ({
      id: output?.id || null,
      type: output?.type || null,
      status: output?.status || null,
      action: output?.action || null,
      role: output?.role || null,
      result_present: typeof output?.result === 'string' || Boolean(output?.result?.b64_json || output?.b64_json),
      result_kind: typeof output?.result,
      result_chars: typeof output?.result === 'string' ? output.result.length : null,
      content_types: Array.isArray(output?.content) ? output.content.map((item: any) => item?.type || null) : []
    })),
    output_text: outputs.flatMap((output: any) => Array.isArray(output?.content) ? output.content : [])
      .filter((item: any) => typeof item?.text === 'string')
      .map((item: any) => item.text.slice(0, 500))
      .slice(0, 3)
  };
}

function imagegenErrorKind(payload: any) {
  const text = JSON.stringify(payload || {});
  if (/moderation|safety|policy/i.test(text)) return 'imagegen_moderation_blocked';
  if (/rate_limit|overloaded|proxy_overloaded|429/i.test(text)) return 'imagegen_remote_rate_limited';
  if (/timeout|AbortError|aborted/i.test(text)) return 'imagegen_remote_timeout';
  if (/api[_ -]?key|auth|401/i.test(text)) return 'openai_api_key_missing_or_invalid';
  return payload?.blocker || 'openai_images_api_error';
}
