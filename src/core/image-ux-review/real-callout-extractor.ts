import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  codexSchemaPath,
  runCodexExecResumeWithOutputSchema,
  structuredOutputBlocker,
  validateStructuredOutput
} from '../codex-exec-output-schema.js';
import { readJson } from '../fsx.js';
import { strictJsonSchemaFormat } from '../structured-output-adapter.js';
import { parseResponsesSsePayload } from '../responses-stream.js';
import {
  DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE,
  resolveDesktopBridgeImagegenTarget,
  type DesktopBridgeImagegenTarget
} from '../imagegen/desktop-bridge-imagegen-target.js';
import { generatedImageMetadata } from './imagegen-adapter.js';
import { buildIssueLedgerFromGeneratedCallouts } from './callout-extraction.js';

export interface RealCalloutExtractionInput {
  root: string;
  generatedImagePath: string;
  sourceScreenshot?: Record<string, unknown> | null;
  sessionId?: string | null;
  prompt?: string | null;
  model?: string | null;
}

export async function extractRealCallouts(input: RealCalloutExtractionInput, opts: any = {}) {
  const schemaPath = await codexSchemaPath('image-ux-issue-ledger');
  const jsonSchema = await readJson<Record<string, unknown>>(schemaPath);
  const prompt = input.prompt || buildRealCalloutExtractionPrompt(input);
  const fakeMode = process.env.SKS_TEST_FAKE_IMAGEGEN === '1' || process.env.SKS_TEST_FAKE_EXTRACTOR === '1';
  const generated = await generatedImageMetadata(input.root, input.generatedImagePath, {
    real_generated: !fakeMode,
    mock: fakeMode,
    source_screen_id: input.sourceScreenshot?.id || 'screen-1'
  });

  if (fakeMode) {
    const ledger = buildIssueLedgerFromGeneratedCallouts({
      schema: 'sks.image-ux-generated-review-ledger.v2',
      generated_review_images: [{
        ...generated,
        extraction_provider: 'fake_structured_extractor',
        callout_extraction_status: 'succeeded',
        callouts: [{
          id: 'fake-callout-1',
          callout_id: 'fake-callout-1',
          severity: 'P2',
          bbox: [0, 0, Math.max(1, Number(generated.width || 1)), Math.max(1, Number(generated.height || 1))],
          region: 'fake adapter fixture region',
          title: 'Fake adapter fixture callout',
          detail: 'Hermetic fake extractor issue from generated callout fixture.',
          likely_cause: 'fixture',
          fix_action: 'No-op fixture recheck',
          target_surface: 'fixture',
          status: 'fixed',
          confidence: 0.5,
          source: 'mock_fixture',
          extraction_provider: 'fake_structured_extractor',
          extraction_schema: 'sks.image-ux-issue-ledger.v3',
          generated_image_sha256: generated.sha256,
          bbox_coordinate_space: 'generated_image',
          bbox_confidence: 0.5,
          severity_visible: true,
          callout_number_visible: true,
          text_ocr_confidence: 0.5,
          fix_verification_status: 'recheck_verified',
          post_fix_recheck_issue_id: null
        }]
      }],
      passed: true
    });
    return {
      schema: 'sks.image-ux-real-callout-extraction.v1',
      ok: ledger.validation.ok && ledger.issues.length > 0,
      status: ledger.validation.ok && ledger.issues.length > 0 ? 'extracted' : 'blocked',
      provider: 'fake_structured_extractor',
      generated_image_sha256: generated.sha256,
      parsed_json_present: true,
      validation_status: ledger.validation.ok ? 'valid' : 'blocked',
      issue_ledger: ledger,
      fake_adapter: true,
      source: 'mock_fixture',
      blocker: ledger.issues.length ? null : structuredOutputBlocker('callout_extraction_schema_failed', 'Fake generated image did not yield fixture callouts.')
    };
  }

  let providerResult: any = null;
  if (input.sessionId) {
    providerResult = await runCodexExecResumeWithOutputSchema({
      sessionId: input.sessionId,
      prompt,
      outputSchemaPath: schemaPath,
      outputFile: path.join(input.root, '.sneakoscope', 'tmp', `ux-callout-extraction-${Date.now()}.json`)
    });
  } else {
    const suppliedTarget = opts.desktopBridgeTarget
      ? fixtureDesktopBridgeTarget(opts.desktopBridgeTarget)
      : null;
    const target = suppliedTarget || await resolveDesktopBridgeImagegenTarget({
      explicitModel: input.model
        || process.env.OPENAI_STRUCTURED_OUTPUT_MODEL
        || process.env.SKS_IMAGEGEN_RESPONSES_MODEL
        || null,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.desktopBridgeStatus !== undefined ? { desktopBridgeStatus: opts.desktopBridgeStatus } : {}),
      ...(opts.desktopBridgeStatusImpl ? { desktopBridgeStatusImpl: opts.desktopBridgeStatusImpl } : {})
    }).catch(() => null);
    if (!target || target.blocker || !target.endpoint || !target.model) {
      const reason = target?.blocker || 'desktop_bridge_status_unavailable';
      providerResult = {
        ok: false,
        status: 'blocked',
        provider: 'desktop_bridge_structured_extractor',
        parsed_json: null,
        blocker: structuredOutputBlocker(reason, DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE),
        fixture: target?.status_source === 'injected_fixture'
      };
    } else {
      providerResult = await runDesktopBridgeStructuredOutput({
        target,
        prompt,
        schemaName: 'image_ux_issue_ledger',
        jsonSchema,
        imagePath: path.resolve(input.root, input.generatedImagePath)
      });
    }
  }

  if (!providerResult.ok || !providerResult.parsed_json) {
    return {
      schema: 'sks.image-ux-real-callout-extraction.v1',
      ok: false,
      status: providerResult.status || 'blocked',
      provider: providerResult.provider || 'codex_exec_resume_output_schema',
      blocker: providerResult.blocker || structuredOutputBlocker('callout_extraction_schema_failed', 'Callout extraction did not return schema-valid JSON.'),
      generated_image_sha256: generated.sha256,
      parsed_json_present: false,
      validation_status: 'blocked',
      ...(providerResult.fixture ? { fake_adapter: true, source: 'mock_fixture' } : {}),
      issue_ledger: buildIssueLedgerFromGeneratedCallouts({
        schema: 'sks.image-ux-generated-review-ledger.v2',
        generated_review_images: [{ ...generated, callout_extraction_status: 'pending', callouts: [] }],
        passed: true
      })
    };
  }

  const parsed = providerResult.parsed_json as any;
  const rows = Array.isArray(parsed.issues) ? parsed.issues : [];
  const ledger = buildIssueLedgerFromGeneratedCallouts({
    schema: 'sks.image-ux-generated-review-ledger.v2',
    generated_review_images: [{
      ...generated,
      extraction_provider: providerResult.provider || 'codex_exec_resume_output_schema',
      callout_extraction_status: 'succeeded',
      callouts: rows
    }],
    passed: true
  });
  return {
    schema: 'sks.image-ux-real-callout-extraction.v1',
    ok: ledger.validation.ok && ledger.issues.length > 0,
    status: ledger.validation.ok && ledger.issues.length > 0 ? 'extracted' : 'blocked',
    provider: providerResult.provider || 'codex_exec_resume_output_schema',
    generated_image_sha256: generated.sha256,
    parsed_json_present: true,
    validation_status: ledger.validation.ok ? 'valid' : 'blocked',
    issue_ledger: ledger,
    ...(providerResult.fixture ? { fake_adapter: true, source: 'mock_fixture' } : {}),
    blocker: ledger.issues.length ? null : structuredOutputBlocker('callout_extraction_schema_failed', 'Generated image did not yield visible callouts.')
  };
}

async function runDesktopBridgeStructuredOutput(request: {
  target: DesktopBridgeImagegenTarget;
  prompt: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  imagePath: string;
}) {
  const imageBytes = await fsp.readFile(request.imagePath);
  const imageUrl = `data:${mimeForPath(request.imagePath)};base64,${imageBytes.toString('base64')}`;
  const fixture = request.target.status_source === 'injected_fixture'
    || request.target.live_evidence_allowed !== true;
  try {
    const response = await fetch(request.target.endpoint!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sks-model': request.target.model!
      },
      body: JSON.stringify({
        model: request.target.model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: request.prompt },
            { type: 'input_image', image_url: imageUrl }
          ]
        }],
        text: { format: strictJsonSchemaFormat(request.schemaName, request.jsonSchema) }
      })
    });
    const text = await response.text();
    if (!response.ok) {
      return bridgeStructuredOutputBlocked('desktop_bridge_structured_output_api_error', text, fixture);
    }
    const payload = parseStructuredOutputBody(text);
    if (!payload) return bridgeStructuredOutputBlocked('json_parse_failed', 'Desktop Bridge returned no readable JSON.', fixture);
    if (payload.status && payload.status !== 'completed') return bridgeStructuredOutputBlocked('response_not_completed', String(payload.status), fixture);
    const parsed = (payload as any).output_parsed || parseStructuredOutputPayload(payload);
    if (!parsed || typeof parsed !== 'object') {
      return bridgeStructuredOutputBlocked('json_parse_failed', 'Desktop Bridge output did not contain parsed JSON.', fixture);
    }
    const validation = validateStructuredOutput(
      parsed,
      strictJsonSchemaFormat(request.schemaName, request.jsonSchema).schema
    );
    return {
      ok: validation.ok,
      status: validation.ok ? 'parsed' : 'blocked',
      provider: fixture ? 'desktop_bridge_fixture_structured_extractor' : 'desktop_bridge_structured_extractor',
      parsed_json: validation.ok ? parsed : null,
      blocker: validation.ok
        ? null
        : structuredOutputBlocker('schema_validation_failed', validation.issues.join(', ')),
      fixture
    };
  } catch (error) {
    return bridgeStructuredOutputBlocked(
      'desktop_bridge_structured_output_api_error',
      error instanceof Error ? error.message : String(error),
      fixture
    );
  }
}

function bridgeStructuredOutputBlocked(reason: string, detail: string, fixture: boolean) {
  return {
    ok: false,
    status: 'blocked',
    provider: fixture ? 'desktop_bridge_fixture_structured_extractor' : 'desktop_bridge_structured_extractor',
    parsed_json: null,
    blocker: structuredOutputBlocker(reason, String(detail || '').slice(0, 2000)),
    fixture
  };
}

function fixtureDesktopBridgeTarget(value: unknown): DesktopBridgeImagegenTarget | null {
  if (!value || typeof value !== 'object') return null;
  return {
    ...(value as DesktopBridgeImagegenTarget),
    status_source: 'injected_fixture',
    live_evidence_allowed: false
  };
}

function parseStructuredOutputBody(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return parseResponsesSsePayload(text) as Record<string, unknown> | null;
  }
}

function parseStructuredOutputPayload(payload: Record<string, unknown>) {
  const output = Array.isArray((payload as any).output) ? (payload as any).output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.parsed) return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

function mimeForPath(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

export function buildRealCalloutExtractionPrompt(input: RealCalloutExtractionInput) {
  const source = input.sourceScreenshot || {};
  return [
    'Analyze the generated UX review image pixels directly.',
    'The source screenshot is context only; do not analyze it instead of the generated annotated image.',
    'Return only visible numbered callouts from the generated image.',
    'Do not invent issues, requirements, or invisible callouts.',
    'Return bbox coordinates in the generated image coordinate system as [x,y,width,height].',
    'If severity text is not visible, set severity_visible=false and choose the closest severity with low confidence.',
    'Set callout_number_visible=false when the number is unclear.',
    'Include bbox_confidence and text_ocr_confidence from 0 to 1.',
    `Generated image path: ${input.generatedImagePath}.`,
    source.id ? `Source screenshot id: ${source.id}.` : '',
    source.sha256 ? `Source screenshot sha256: ${source.sha256}.` : ''
  ].filter(Boolean).join('\n');
}
