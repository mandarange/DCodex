import path from 'node:path';
import { codexSchemaPath, runCodexExecResumeWithOutputSchema, structuredOutputBlocker } from '../codex-exec-output-schema.js';
import { readJson } from '../fsx.js';
import { runOpenAIStructuredOutput } from '../structured-output-adapter.js';
import { resolveCodexLbImagegenTarget } from '../imagegen/codex-lb-imagegen-target.js';
import { generatedImageMetadata } from './imagegen-adapter.js';
import { buildIssueLedgerFromGeneratedCallouts } from './callout-extraction.js';

export interface RealCalloutExtractionInput {
  root: string;
  generatedImagePath: string;
  sourceScreenshot?: Record<string, unknown> | null;
  sessionId?: string | null;
  prompt?: string | null;
}

export async function extractRealCallouts(input: RealCalloutExtractionInput) {
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
    // Without a Codex session there is no session to resume, so extraction goes
    // over the Responses API. Under a selected codex-lb provider that is the
    // codex-lb endpoint with its own key and a served catalog model — otherwise
    // the route generates a callout image it can never read back.
    const codexLb = await resolveCodexLbImagegenTarget({}).catch(() => null);
    const useCodexLb = codexLb?.selected === true && codexLb.blocker === null;
    providerResult = await runOpenAIStructuredOutput({
      prompt,
      schemaName: 'image_ux_issue_ledger',
      jsonSchema,
      imagePath: path.resolve(input.root, input.generatedImagePath),
      ...(useCodexLb ? { baseUrl: codexLb.base_url, apiKey: codexLb.api_key } : {}),
      ...(useCodexLb && codexLb.model ? { model: codexLb.model } : {})
    });
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
    blocker: ledger.issues.length ? null : structuredOutputBlocker('callout_extraction_schema_failed', 'Generated image did not yield visible callouts.')
  };
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
