import path from 'node:path';
import fsp from 'node:fs/promises';
import { registerPathImageReference, upsertImageReferenceRegistry } from '../image/reference-evidence/reference-registry.js';
import { ensureDir, nowIso, projectRoot, readJson, writeJsonAtomic } from '../fsx.js';
import { createMission, findLatestMission, loadMission, missionDir } from '../mission.js';
import { flag, readOption } from './command-utils.js';
import { printJson } from '../../cli/output.js';
import {
  IMAGE_UX_REVIEW_FIX_LOOP_ARTIFACT,
  IMAGE_UX_REVIEW_FIX_TASK_PLAN_ARTIFACT,
  IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT,
  IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT,
  IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT,
  IMAGE_UX_REVIEW_GATE_ARTIFACT,
  IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT,
  IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT,
  IMAGE_UX_REVIEW_IMAGEGEN_REQUEST_ARTIFACT,
  IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT,
  IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT,
  IMAGE_UX_REVIEW_POLICY_ARTIFACT,
  IMAGE_UX_REVIEW_RECAPTURE_ARTIFACT,
  IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT,
  imageUxReviewProofEvidence,
  imageUxReviewCommandOutcome,
  buildImageUxCalloutExtractionReport,
  writeImageUxReviewRouteArtifacts
} from '../image-ux-review.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { buildCalloutPrompt, generatedImageMetadata, generateGptImage2CalloutReview } from '../image-ux-review/imagegen-adapter.js';
import { extractRealCallouts } from '../image-ux-review/real-callout-extractor.js';
import { addImageRelation, ingestImage } from '../wiki-image/image-voxel-ledger.js';
import { sha256File, imageDimensions } from '../wiki-image/image-hash.js';
import { writeRouteCollaborationArtifacts } from '../agents/route-collaboration-ledger.js';
import { codexChromeExtensionStatus } from '../codex-app.js';
import { requireCodexImagegen } from '../imagegen/require-imagegen.js';
import { imagegenEvidenceClassBlockers, isFullImagegenEvidenceClass, isFullImagegenOutputSource } from '../imagegen/imagegen-evidence.js';
import { evaluateGate } from '../stop-gate/gate-evaluator.js';
import { closeWorkOrderLedgerForRouteResult } from '../work-order-ledger.js';

const ONE_BY_ONE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axX7V8AAAAASUVORK5CYII=';
const stableImageUxArtifact = (artifactPath: string) => ({
  path: artifactPath,
  source: 'real',
  ignoreStale: true
});
const IMAGE_UX_REVIEW_ARTIFACT_PATHS: Record<string, string | Record<string, any>> = {
  policy: stableImageUxArtifact(IMAGE_UX_REVIEW_POLICY_ARTIFACT),
  inventory: stableImageUxArtifact(IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT),
  imagegen_request: stableImageUxArtifact(IMAGE_UX_REVIEW_IMAGEGEN_REQUEST_ARTIFACT),
  gpt_image_2_request: stableImageUxArtifact(IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT),
  imagegen_response: stableImageUxArtifact(IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT),
  generated_review_ledger: stableImageUxArtifact(IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT),
  issue_ledger: stableImageUxArtifact(IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT),
  callout_extraction_report: stableImageUxArtifact(IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT),
  fix_task_plan: stableImageUxArtifact(IMAGE_UX_REVIEW_FIX_TASK_PLAN_ARTIFACT),
  fix_loop: stableImageUxArtifact(IMAGE_UX_REVIEW_FIX_LOOP_ARTIFACT),
  recapture_plan: stableImageUxArtifact(IMAGE_UX_REVIEW_RECAPTURE_ARTIFACT),
  iteration_report: stableImageUxArtifact(IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT),
  output_schema: {
    path: 'schemas/codex/image-ux-issue-ledger.schema.json',
    kind: 'schema',
    source: 'real',
    ignoreStale: true
  },
  honest_mode_evidence: stableImageUxArtifact(IMAGE_UX_REVIEW_HONEST_MODE_ARTIFACT),
  gate: stableImageUxArtifact(IMAGE_UX_REVIEW_GATE_ARTIFACT)
};

export async function imageUxReviewCommand(command: any, args: any = []) {
  const root = await projectRoot();
  const action = args[0] || 'status';
  if (action === 'fixture') return imageUxFixture(root, command, args);
  if (action === 'run') return runImageUxReview(root, command, args.slice(1));
  if (action === 'callouts') return calloutsImageUxReview(root, command, args.slice(1));
  if (action === 'extract-issues') return extractIssuesImageUxReview(root, command, args.slice(1));
  if (action === 'attach-generated') return attachGeneratedImageCommand(root, command, args.slice(1));
  if (action === 'attach-after') return attachAfterImageCommand(root, command, args.slice(1));
  if (action === 'fix') return rebuildExistingMission(root, command, args.slice(1), { fixRequested: true });
  if (action === 'recapture' || action === 'recheck') return rebuildExistingMission(root, command, args.slice(1), { recaptureRequested: true });
  if (action === 'proof') return rebuildExistingMission(root, command, args.slice(1), { proofRequested: true });
  if (action === 'explain') return explainImageUxReview(root, args.slice(1));
  return statusImageUxReview(root, args.slice(action === 'status' ? 1 : 0));
}

async function runImageUxReview(root: string, command: string, args: any[] = []) {
  const missionRequested = readOption(args, '--mission', null);
  const missionId = missionRequested
    ? missionRequested === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review' }) : missionRequested
    : null;
  const imagePath = readOption(args, '--image', null) || readOption(args, '--screenshot', null);
  const generatedImage = readOption(args, '--generated-image', null);
  const shouldGenerateCallouts = !generatedImage;
  if (missionId) {
    if (generatedImage) {
      return continueExistingMissionWithGeneratedImage(root, command, missionId, generatedImage, args, 'sks.image-ux-review-run.v1');
    }
    return rebuildExistingMission(root, command, [missionId, ...args], { fixRequested: flag(args, '--fix') });
  }
  const sourcePreflight = await imageUxReviewSourcePreflight(args);
  const { fromChromeExtension, fromComputerUse, chromePreflight } = sourcePreflight;
  if (sourcePreflight.result) {
    const result = sourcePreflight.result;
    process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    printImageUxReviewSourcePreflightBlock(result);
    return result;
  }
  if (!imagePath && !fromChromeExtension && !fromComputerUse) {
    const result = { schema: 'sks.image-ux-review-run.v1', ok: false, status: 'blocked', blocker: 'screenshot_required' };
    process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.error('UX Review blocked: screenshot_required');
    return result;
  }
  if (!flag(args, '--mock') && !generatedImage) {
    const imagegenRequired = await requireCodexImagegen(root, { autoRepair: true, applyRepair: true });
    if (!imagegenRequired.ok) {
      const result = {
        schema: 'sks.image-ux-review-run.v1',
        ok: false,
        status: 'blocked',
        blocker: 'codex_imagegen_unavailable',
        imagegen_required: imagegenRequired,
        gate: {
          schema: 'sks.image-ux-review-gate.v2',
          passed: false,
          status: 'blocked',
          blockers: ['codex_imagegen_unavailable'],
          generated_image_evidence: false
        }
      };
      process.exitCode = 1;
      if (flag(args, '--json')) return printJson(result);
      console.error('UX Review blocked: no selected Codex imagegen/gpt-image-2 provider is ready.');
      for (const action of imagegenRequired.blocker?.next_actions || []) console.error(`- ${action}`);
      return result;
    }
  }
  const { id, dir, mission } = await createMission(root, { mode: 'image-ux-review', prompt: promptForRun(command, args) });
  const sourceRel = imagePath ? await stageSourceImage(root, dir, imagePath) : null;
  const contract = {
    prompt: mission.prompt,
    sealed_hash: `image-ux-${id}`,
    answers: {
      IMAGE_UX_REVIEW_SOURCE_IMAGES: sourceRel ? [sourceRel] : [],
      CHROME_EXTENSION_SCREENSHOT: fromChromeExtension,
      CHROME_EXTENSION_PREFLIGHT_PASSED: chromePreflight?.ok === true,
      CHROME_EXTENSION_PREFLIGHT: chromePreflight,
      COMPUTER_USE_SCREENSHOT: fromComputerUse,
      TARGET_SURFACE: readOption(args, '--target', mission.prompt),
      REMEDIATION_REQUESTED: flag(args, '--fix')
    }
  };
  await writeJsonAtomic(path.join(dir, 'decision-contract.json'), contract);
  if (generatedImage) {
    await attachGeneratedReviewImage(root, dir, contract, generatedImage, { realGenerated: !flag(args, '--mock'), mock: flag(args, '--mock') });
    if (!flag(args, '--mock')) {
      await extractAndWriteGeneratedReview(root, dir, {
        generatedImagePath: generatedImage,
        sourceImagePath: sourceRel || imagePath,
        sessionId: readOption(args, '--session', null) || readOption(args, '--session-id', null)
      });
    }
  }
  if (!generatedImage && shouldGenerateCallouts) {
    const outputDir = path.join(dir, 'generated-callouts');
    // Auto-discover the Codex App GUI $imagegen output from ~/.codex/generated_images.
    // --strict-generated-since limits discovery to images created at/after this run
    // started (use when an old GUI image could be mistaken for this run's output);
    // otherwise a max-age window guards against stale reuse.
    const missionStartMs = Date.parse(mission.created_at || '') || undefined;
    const maxAgeOverride = readOption(args, '--generated-image-max-age-min', null);
    const result = await generateGptImage2CalloutReview({
      mission_id: id,
      source_screen_id: 'screen-1',
      source_image_path: path.resolve(root, sourceRel || imagePath),
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1', {
        target: contract.answers.TARGET_SURFACE
      }),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      codexApp: {
        generatedImageSinceMs: flag(args, '--strict-generated-since') ? missionStartMs : null,
        generatedImageMaxAgeMs: maxAgeOverride ? Number(maxAgeOverride) * 60 * 1000 : 30 * 60 * 1000
      }
    });
    // Preserve provider diagnostics even when generation fails and no image can
    // be attached. Route artifact rebuilding must not replace the real request
    // or response with a generic missing-image placeholder.
    if (result.request_artifact) await fsp.copyFile(result.request_artifact, path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_REQUEST_ARTIFACT));
    if (result.response_artifact) await fsp.copyFile(result.response_artifact, path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT));
    if (result.generated_image_path) {
      const response = await readImagegenResponse(dir);
      const evidenceClass = String(response?.evidence_class || '');
      const fakeGenerated = evidenceClass === 'mock_fixture' || result.provider === 'fake_imagegen_adapter';
      const realGenerated = isFullImagegenEvidenceClass(evidenceClass);
      await attachGeneratedReviewImage(root, dir, contract, result.generated_image_path, {
        realGenerated,
        mock: fakeGenerated,
        providerSurface: result.provider,
        evidenceClass,
        outputSource: response?.output_source || null,
        outputSha256: response?.output_sha256 || response?.output_image_sha256 || null,
        responseArtifact: result.response_artifact || null
      });
      await extractAndWriteGeneratedReview(root, dir, {
        generatedImagePath: result.generated_image_path,
        sourceImagePath: sourceRel || imagePath,
        sessionId: readOption(args, '--session', null) || readOption(args, '--session-id', null)
      });
    }
  }
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract, { root, wrongnessChecked: true, honestModeComplete: true });
  artifacts.gate = await enforceImageUxRuntimeGate(dir, artifacts.gate, { mock: flag(args, '--mock') });
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GATE_ARTIFACT), artifacts.gate);
  const proof = await finalizeImageUx(root, id, command, artifacts, { mock: flag(args, '--mock'), cmd: `sks ${command} run` });
  const outcome = imageUxReviewCommandOutcome(artifacts.gate, proof.ok, {
    allowReviewOnlyCompletion: !flag(args, '--fix')
  });
  const result = { schema: 'sks.image-ux-review-run.v1', ...outcome, mission_id: id, artifacts, proof: proof.validation };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`Image UX review: ${result.ok ? 'ok' : 'blocked'} ${id}`);
  return result;
}

async function extractAndWriteGeneratedReview(
  root: string,
  dir: string,
  input: { generatedImagePath: string; sourceImagePath?: string | null; sessionId?: string | null }
) {
  const extraction = await extractRealCallouts({
    root,
    generatedImagePath: input.generatedImagePath,
    sourceScreenshot: { id: 'screen-1' },
    sessionId: input.sessionId || null
  });
  const generatedLedger = await readJson(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), null).catch(() => null);
  const generatedImages = Array.isArray(generatedLedger?.generated_review_images) ? generatedLedger.generated_review_images : [];
  const localImage = generatedImages.find((image: any) => image.sha256 && image.sha256 === extraction.generated_image_sha256)
    || generatedImages[0]
    || null;
  const localImageId = localImage?.id || null;
  const generatedSha = localImage?.sha256 || extraction.generated_image_sha256 || null;
  const extractedIssues = Array.isArray(extraction.issue_ledger?.issues) ? extraction.issue_ledger.issues : [];
  const boundIssues = extractedIssues.map((issue: any) => ({
    ...issue,
    generated_review_image_id: localImageId || issue.generated_review_image_id,
    evidence_image_id: localImageId || issue.evidence_image_id,
    generated_image_sha256: generatedSha || issue.generated_image_sha256
  }));
  const boundIssueLedger = {
    ...extraction.issue_ledger,
    generated_image_id: localImageId,
    generated_image_sha256: generatedSha,
    issues: boundIssues
  };
  const extractionSucceeded = extraction.ok === true
    && boundIssueLedger.validation?.ok === true
    && boundIssues.length > 0;
  if (localImage && generatedLedger) {
    await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), {
      ...generatedLedger,
      status: extractionSucceeded ? 'generated_and_extracted' : 'generated_extraction_blocked',
      generated_review_images: generatedImages.map((image: any) => image.id === localImage.id ? {
        // The attach row is the provenance SSOT. Merge only extraction facts;
        // never replace codex-lb evidence class, output source, or output id
        // with defaults synthesized by the extractor.
        ...image,
        generated_image_sha256: generatedSha,
        extraction_provider: extraction.provider || null,
        extraction_status: extraction.status || (extractionSucceeded ? 'extracted' : 'blocked'),
        callout_extraction_status: extractionSucceeded ? 'succeeded' : 'failed',
        callout_extraction_blocker: extractionSucceeded ? null : extraction.blocker || 'callout_extraction_failed',
        callouts: boundIssues
      } : image)
    });
  }
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT), boundIssueLedger);
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT), await buildImageUxCalloutExtractionReport(root, extraction, {
    generatedImagePath: input.generatedImagePath,
    generatedImageId: localImageId,
    sourceImagePath: input.sourceImagePath || null,
    provider: extraction.provider
  }));
  return extraction;
}

/**
 * Read-only source validation shared with the active-route dispatcher. A
 * blocked result is terminal and guarantees that the run cannot create a
 * mission or write route evidence.
 */
export async function imageUxReviewSourcePreflight(args: any[] = [], opts: any = {}) {
  const fromChromeExtension = flag(args, '--from-chrome-extension') || Boolean(readOption(args, '--from-chrome-extension', null));
  const fromComputerUse = flag(args, '--from-computer-use') || Boolean(readOption(args, '--from-computer-use', null));
  const imagePath = readOption(args, '--image', null) || readOption(args, '--screenshot', null);
  const chromePreflight = fromChromeExtension
    ? await (opts.chromeStatus ? opts.chromeStatus() : codexChromeExtensionStatus())
    : null;
  if (chromePreflight && !chromePreflight.ok) {
    return {
      fromChromeExtension,
      fromComputerUse,
      chromePreflight,
      result: {
        schema: 'sks.image-ux-review-run.v1',
        ok: false,
        status: 'blocked',
        blocker: 'codex_chrome_extension_setup_required',
        chrome_extension: chromePreflight,
        guidance: [
          'Install/enable the Codex Chrome Extension first, then tell SKS installation is complete before resuming web UX review.'
        ]
      }
    };
  }
  if (fromComputerUse && !flag(args, '--native') && !flag(args, '--non-web')) {
    return {
      fromChromeExtension,
      fromComputerUse,
      chromePreflight,
      result: {
        schema: 'sks.image-ux-review-run.v1',
        ok: false,
        status: 'blocked',
        blocker: 'web_ux_review_requires_codex_chrome_extension_not_computer_use'
      }
    };
  }
  if ((fromChromeExtension || fromComputerUse) && !imagePath) {
    return {
      fromChromeExtension,
      fromComputerUse,
      chromePreflight,
      result: {
        schema: 'sks.image-ux-review-run.v1',
        ok: false,
        status: 'blocked',
        blocker: 'captured_screenshot_path_required',
        guidance: [
          'Capture the real page or native-app screen first, then pass its local artifact path with --image <captured-path>.'
        ]
      }
    };
  }
  return { fromChromeExtension, fromComputerUse, chromePreflight, result: null };
}

function printImageUxReviewSourcePreflightBlock(result: any) {
  if (result.blocker === 'codex_chrome_extension_setup_required') {
    console.error('UX Review blocked: install/enable the Codex Chrome Extension first, then tell SKS installation is complete before resuming.');
    if (result.chrome_extension?.docs_url) console.error(result.chrome_extension.docs_url);
    return;
  }
  if (result.blocker === 'captured_screenshot_path_required') {
    console.error('UX Review blocked: capture completed without a bound screenshot artifact. Pass --image <captured-path>.');
    return;
  }
  console.error('UX Review blocked: web/browser UX review requires Codex Chrome Extension, not Computer Use. Use --from-chrome-extension after setup, or provide a screenshot with --image.');
}

async function calloutsImageUxReview(root: string, command: string, args: any[] = []) {
  const imagePath = readOption(args, '--image', null) || readOption(args, '--screenshot', null);
  if (!imagePath) {
    const result = { schema: 'sks.image-ux-review-callouts.v1', ok: false, status: 'blocked', blocker: 'screenshot_required' };
    process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.error('Usage: sks ux-review callouts --image <path> --json');
    return result;
  }
  return runImageUxReview(root, command, ['--image', imagePath, '--generate-callouts', '--json', ...(flag(args, '--mock') ? ['--mock'] : [])]);
}

async function extractIssuesImageUxReview(root: string, command: string, args: any[] = []) {
  const missionRequested = readOption(args, '--mission', null);
  const missionId = missionRequested
    ? missionRequested === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review' }) : missionRequested
    : null;
  const generatedImage = readOption(args, '--generated-image', null);
  const sourceImage = readOption(args, '--image', null) || readOption(args, '--screenshot', null);
  if (!generatedImage) {
    const result = { schema: 'sks.image-ux-review-extract-issues.v1', ok: false, status: 'blocked', blocker: 'generated_image_required' };
    process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.error('Usage: sks ux-review extract-issues --generated-image <path> --json');
    return result;
  }
  if (missionId) {
    return continueExistingMissionWithGeneratedImage(
      root,
      command,
      missionId,
      generatedImage,
      args,
      'sks.image-ux-review-extract-issues.v1'
    );
  }
  const { id, dir, mission } = await createMission(root, { mode: 'image-ux-review', prompt: `Extract UX issues from ${generatedImage}` });
  const sourceRel = sourceImage ? await stageSourceImage(root, dir, sourceImage) : null;
  const contract = {
    prompt: mission.prompt,
    sealed_hash: `image-ux-extract-${id}`,
    answers: { IMAGE_UX_REVIEW_SOURCE_IMAGES: sourceRel ? [sourceRel] : [] }
  };
  await writeJsonAtomic(path.join(dir, 'decision-contract.json'), contract);
  await attachGeneratedReviewImage(root, dir, contract, generatedImage, { realGenerated: !flag(args, '--mock'), mock: flag(args, '--mock') });
  if (!flag(args, '--mock')) {
    await extractAndWriteGeneratedReview(root, dir, {
      generatedImagePath: generatedImage,
      sourceImagePath: sourceRel || sourceImage,
      sessionId: readOption(args, '--session', null) || readOption(args, '--session-id', null)
    });
  }
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract, { root, wrongnessChecked: true, honestModeComplete: true });
  const proof = await finalizeImageUx(root, id, command, artifacts, { mock: flag(args, '--mock'), cmd: `sks ${command} extract-issues` });
  const result = { schema: 'sks.image-ux-review-extract-issues.v1', ok: proof.ok && artifacts.gate?.passed === true, status: artifacts.gate?.status || (artifacts.gate?.passed ? 'passed' : 'blocked'), mission_id: id, issue_ledger: artifacts.issue_ledger, proof: proof.validation };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`Image UX issue extraction: ${result.ok ? 'ok' : 'blocked'} ${id}`);
  return result;
}

async function continueExistingMissionWithGeneratedImage(
  root: string,
  command: string,
  missionId: string,
  generatedImage: string,
  args: any[],
  schema: string
) {
  const { dir, mission } = await loadMission(root, missionId);
  const contract = await readJson(path.join(dir, 'decision-contract.json'), { prompt: mission.prompt, answers: {}, sealed_hash: null });
  const mock = flag(args, '--mock');
  const ledger = await attachGeneratedReviewImage(root, dir, contract, generatedImage, {
    realGenerated: !mock,
    mock
  });
  if (!mock) {
    await extractAndWriteGeneratedReview(root, dir, {
      generatedImagePath: generatedImage,
      sourceImagePath: sourceImageFromContract(contract),
      sessionId: readOption(args, '--session', null) || readOption(args, '--session-id', null)
    });
  }
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract, {
    root,
    wrongnessChecked: true,
    honestModeComplete: true
  });
  artifacts.gate = await enforceImageUxRuntimeGate(dir, artifacts.gate, { mock });
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GATE_ARTIFACT), artifacts.gate);
  const proof = await finalizeImageUx(root, missionId, command, artifacts, {
    mock,
    cmd: `sks ${command} ${schema.endsWith('extract-issues.v1') ? 'extract-issues' : 'attach-generated'}`
  });
  const outcome = imageUxReviewCommandOutcome(artifacts.gate, proof.ok, {
    allowReviewOnlyCompletion: !flag(args, '--fix')
  });
  const result = {
    schema,
    ...outcome,
    mission_id: missionId,
    generated_review_ledger: ledger,
    issue_ledger: artifacts.issue_ledger,
    gate: artifacts.gate,
    proof: proof.validation
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`Image UX review continued: ${result.ok ? 'ok' : 'blocked'} ${missionId}`);
  return result;
}

async function attachGeneratedImageCommand(root: string, command: string, args: any[] = []) {
  const missionArg = readOption(args, '--mission', null)
    || args.find((arg: any, index: number) => !String(arg).startsWith('--') && !String(args[index - 1] || '').startsWith('--'))
    || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review' }) : missionArg;
  const imagePath = readOption(args, '--image', null) || readOption(args, '--generated-image', null);
  if (!missionId || !imagePath) {
    const result = { schema: 'sks.image-ux-review-attach-generated.v1', ok: false, status: 'blocked', blocker: !missionId ? 'mission_required' : 'generated_image_required' };
    process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    return result;
  }
  return continueExistingMissionWithGeneratedImage(
    root,
    command,
    missionId,
    imagePath,
    args,
    'sks.image-ux-review-attach-generated.v1'
  );
}

async function attachAfterImageCommand(root: string, command: string, args: any[] = []) {
  const missionArg = args.find((arg: any) => !String(arg).startsWith('--')) || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review', route: '$Image-UX-Review', gateFile: IMAGE_UX_REVIEW_GATE_ARTIFACT }) : missionArg;
  const imagePath = readOption(args, '--image', null) || readOption(args, '--screenshot', null);
  if (!missionId || !imagePath) {
    const result = { schema: 'sks.image-ux-review-attach-after.v1', ok: false, status: 'blocked', blocker: !missionId ? 'mission_required' : 'after_image_required' };
    process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    return result;
  }
  const { dir, mission } = await loadMission(root, missionId);
  const contract = await readJson(path.join(dir, 'decision-contract.json'), { prompt: mission.prompt, answers: {}, sealed_hash: null });
  const staged = await stageImageReference(root, dir, imagePath, 'after-screens');
  const absolute = path.resolve(root, staged);
  const dims = await imageDimensions(absolute);
  const sha = await sha256File(absolute);
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract, {
    root,
    wrongnessChecked: true,
    honestModeComplete: true,
    recapture: { userScreenshot: staged, recapturedSha256: sha, recapturedDimensions: dims }
  });
  const result = { schema: 'sks.image-ux-review-attach-after.v1', ok: true, mission_id: missionId, after_screenshot: { path: staged, sha256: sha, dimensions: dims, privacy: 'local-only' }, recapture_plan: artifacts.recapture_plan };
  if (flag(args, '--json')) return printJson(result);
  console.log(`After screenshot attached: ${missionId}`);
  return result;
}

async function rebuildExistingMission(root: string, command: string, args: any[] = [], opts: any = {}) {
  const missionArg = args.find((arg: any) => !String(arg).startsWith('--')) || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review', route: '$Image-UX-Review', gateFile: IMAGE_UX_REVIEW_GATE_ARTIFACT }) : missionArg;
  if (!missionId) return missingMission(args);
  const { dir, mission } = await loadMission(root, missionId);
  const contract = await readJson(path.join(dir, 'decision-contract.json'), { prompt: mission.prompt, answers: {}, sealed_hash: null });
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract, {
    root,
    wrongnessChecked: true,
    fixLoop: { requirePatch: opts.fixRequested === true },
    recapture: opts.proofRequested === true ? undefined : { computerUseAvailable: false },
    preserveExistingRecapture: opts.proofRequested === true,
    honestModeComplete: opts.proofRequested === true
  });
  artifacts.gate = await enforceImageUxRuntimeGate(dir, artifacts.gate, { mock: flag(args, '--mock') });
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GATE_ARTIFACT), artifacts.gate);
  const proofAction = opts.proofRequested ? 'proof' : opts.fixRequested ? 'fix' : opts.recaptureRequested ? 'recapture' : 'build';
  const proof = await finalizeImageUx(root, missionId, command, artifacts, { mock: flag(args, '--mock'), cmd: `sks ${command} ${proofAction}` });
  const outcome = imageUxReviewCommandOutcome(artifacts.gate, proof.ok, {
    allowReviewOnlyCompletion: false
  });
  const result = { schema: 'sks.image-ux-review-build.v2', ...outcome, mission_id: missionId, artifacts, proof: proof.validation };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`Image UX review: ${result.ok ? 'ok' : 'blocked'} ${missionId}`);
  return result;
}

async function statusImageUxReview(root: string, args: any[] = []) {
  const missionArg = args.find((arg: any) => !String(arg).startsWith('--')) || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review', route: '$Image-UX-Review', gateFile: IMAGE_UX_REVIEW_GATE_ARTIFACT }) : missionArg;
  if (!missionId) return missingMission(args);
  const { dir } = await loadMission(root, missionId);
  const gate = await readJson(path.join(dir, 'image-ux-review-gate.json'), null);
  const issueLedger = await readJson(path.join(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT), null);
  const generatedLedger = await readJson(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), null);
  const gateVerdict = await evaluateGate(root, missionId, 'image-ux-review-gate.json');
  const result = { schema: 'sks.image-ux-review-status.v2', ok: true, mission_id: missionId, gate, gate_verdict: gateVerdict, issue_ledger: issueLedger, generated_review_ledger: generatedLedger };
  if (flag(args, '--json')) return printJson(result);
  console.log(gateVerdict.verdict);
  console.log(`Image UX Review mission: ${missionId}`);
  console.log(`Gate: ${gate?.status || (gate?.passed ? 'passed' : gate ? 'present' : 'missing')}`);
  if (gate?.verified_level) console.log(`Verified level: ${gate.verified_level}`);
  return result;
}

async function explainImageUxReview(root: string, args: any[] = []) {
  const missionArg = args.find((arg: any) => !String(arg).startsWith('--')) || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'image-ux-review', route: '$Image-UX-Review', gateFile: IMAGE_UX_REVIEW_GATE_ARTIFACT }) : missionArg;
  if (!missionId) return missingMission(args);
  const { dir } = await loadMission(root, missionId);
  const gate = await readJson(path.join(dir, IMAGE_UX_REVIEW_GATE_ARTIFACT), null);
  const result = {
    schema: 'sks.image-ux-review-explain.v1',
    ok: Boolean(gate),
    mission_id: missionId,
    status: gate?.status || (gate?.passed ? 'passed' : 'blocked'),
    verified_level: gate?.verified_level || null,
    reference_only: gate?.reference_only === true,
    blockers: gate?.blockers || [],
    next_action: nextActionForGate(gate)
  };
  if (flag(args, '--json')) return printJson(result);
  console.log(`Status: ${result.status}`);
  console.log(`Next: ${result.next_action}`);
  return result;
}

async function imageUxFixture(root: string, command: string, args: any[]) {
  const { id, dir, mission } = await createMission(root, { mode: 'image-ux-review', prompt: 'Image UX Review fixture' });
  const sourceImage = path.join(dir, 'image-ux-source-fixture.png');
  await ensureDir(path.dirname(sourceImage));
  await fsp.writeFile(sourceImage, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'));
  const relImage = path.relative(root, sourceImage).split(path.sep).join('/');
  const contract = {
    prompt: mission.prompt,
    sealed_hash: 'image-ux-fixture-contract',
    answers: { IMAGE_UX_REVIEW_SOURCE_IMAGES: [relImage] }
  };
  await writeJsonAtomic(path.join(dir, 'decision-contract.json'), contract);
  await attachGeneratedReviewImage(root, dir, contract, sourceImage, { mock: true, realGenerated: false });
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT), {
    schema: 'sks.image-ux-issue-ledger.v3',
    schema_version: 3,
    issues: [{
      id: 'issue-fixture-1',
      severity: 'P2',
      source_screen_id: 'screen-1',
      screen_id: 'screen-1',
      generated_review_image_id: 'generated-review-fixture-1',
      evidence_image_id: 'generated-review-fixture-1',
      callout_id: 'callout-1',
      bbox: [0, 0, 1, 1],
      region: 'fixture pixel',
      title: 'Fixture density note',
      detail: 'Mock fixture issue extracted from generated review ledger.',
      likely_cause: 'fixture',
      fix_action: 'No-op fixture recheck',
      target_surface: 'fixture',
      candidate_files: [],
      status: 'mock',
      confidence: 0.5,
      source: 'mock_fixture',
      extracted_from_generated_image: true,
      extraction_provider: 'mock_fixture',
      extraction_schema: 'sks.image-ux-issue-ledger.v3',
      generated_image_sha256: 'mock_fixture_sha256',
      bbox_coordinate_space: 'generated_image',
      bbox_confidence: 0.5,
      severity_visible: true,
      callout_number_visible: true,
      text_ocr_confidence: 0.5,
      fix_verification_status: 'mock',
      post_fix_recheck_issue_id: null
    }]
  });
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract, { root, imageVoxelRelationsCreated: true, wrongnessChecked: true, honestModeComplete: true });
  const gate = {
    ...artifacts.gate,
    passed: false,
    ok: false,
    status: 'blocked',
    execution_class: 'mock_fixture',
    honest_mode_complete: true,
    blockers: ['image_ux_fixture_mode_cannot_claim_real'],
    fixture: true,
    verified_level: 'unverified_fixture',
    mock_fixture_cannot_claim_real: true
  };
  artifacts.gate = gate;
  await writeJsonAtomic(path.join(dir, 'image-ux-review-gate.json'), gate);
  await ensureFixtureImageVoxelRelation(root, id, relImage);
  const native = await writeRouteCollaborationArtifacts(root, {
    missionId: id,
    route: routeForCommand(command),
    routeKey: 'UX-Collab',
    prompt: 'UX collaboration route native agent plan for generated review images, issue extraction, safety, and proof closure.',
    mode: 'IMAGE_UX_REVIEW'
  });
  const proof = await finalizeImageUx(root, id, command, artifacts, { mock: true, requireRelation: flag(args, '--require-relation'), cmd: `sks ${command} fixture --mock` });
  const result = { schema: 'sks.image-ux-review-fixture.v2', ok: false, mission_id: id, artifacts, native_agent_collaboration: native, proof: proof.validation };
  process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`Image UX fixture: blocked ${id}`);
  return result;
}

async function attachGeneratedReviewImage(root: string, dir: string, contract: any, imagePath: string, opts: any = {}) {
  const inventory = await readJson(path.join(dir, 'image-ux-screen-inventory.json'), null).catch(() => null);
  const sourceScreen = inventory?.source_screens?.[0] || { id: 'screen-1' };
  const staged = await stageGeneratedImage(root, dir, imagePath, opts.mock ? 'generated-review-fixture.png' : null);
  const response = await readImagegenResponse(dir);
  const evidenceClass = opts.evidenceClass || response?.evidence_class || (opts.mock ? 'mock_fixture' : opts.realGenerated ? 'codex_app_imagegen' : null);
  const outputSource = opts.outputSource || response?.output_source || (opts.mock ? 'mock_fixture' : opts.realGenerated ? 'manual_attach' : null);
  const outputSha256 = opts.outputSha256 || response?.output_sha256 || response?.output_image_sha256 || null;
  const metadata = await generatedImageMetadata(root, staged, {
    id: opts.mock ? 'generated-review-fixture-1' : undefined,
    source_screen_id: sourceScreen.id || 'screen-1',
    provider_surface: opts.providerSurface || 'Codex App $imagegen',
    evidence_class: evidenceClass,
    output_source: outputSource,
    output_sha256: outputSha256 || undefined,
    output_id: response?.output_id || null,
    real_generated: opts.realGenerated === true && isFullImagegenEvidenceClass(evidenceClass),
    mock: opts.mock === true
  });
  if (response) {
    await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT), {
      ...response,
      generated_review_image_id: metadata.id,
      output_sha256: response.output_sha256 || response.output_image_sha256 || metadata.sha256,
      output_image_sha256: response.output_image_sha256 || response.output_sha256 || metadata.sha256
    });
  } else if (opts.realGenerated === true) {
    await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT), {
      schema: 'sks.image-ux-gpt-image-2-response.v1',
      created_at: nowIso(),
      provider: 'codex_app_imagegen',
      evidence_class: 'codex_app_imagegen',
      model: 'gpt-image-2',
      ok: true,
      status: 'generated',
      output_image_path: path.resolve(root, metadata.path),
      output_image_sha256: metadata.sha256,
      output_sha256: metadata.sha256,
      output_id: metadata.output_id || null,
      generated_review_image_id: metadata.id,
      output_source: 'manual_attach',
      dimensions: { width: metadata.width, height: metadata.height, format: metadata.format },
      local_only: true
    });
  }
  const ledger = {
    schema: 'sks.image-ux-generated-review-ledger.v2',
    schema_version: 2,
    created_at: nowIso(),
    status: 'generated',
    provider: { model: 'gpt-image-2', preferred_surface: 'Codex App $imagegen' },
    generated_review_images: [{
      ...metadata,
      source_screen_id: 'screen-1',
      status: 'generated',
      imagegen_response_artifact: opts.responseArtifact || (response || opts.realGenerated === true ? IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT : null),
      image_voxel_relation: 'generated_callout_review_of',
      callout_extraction_status: opts.mock ? 'succeeded' : 'pending',
      callouts: opts.mock ? [{
        id: 'callout-1',
        callout_id: 'callout-1',
        severity: 'P2',
        bbox: [0, 0, Math.max(1, Number(metadata.width || 1)), Math.max(1, Number(metadata.height || 1))],
        region: 'full image fixture region',
        title: 'Mock fixture callout',
        detail: 'Mock fixture callout for schema validation.',
        fix_action: 'Apply targeted UI adjustment, then recapture and re-review.',
        status: opts.mock ? 'mock' : 'open',
        source: opts.mock ? 'mock_fixture' : 'real_gpt_image_2_callout',
        confidence: opts.mock ? 0.5 : 0.82,
        extraction_provider: 'mock_fixture',
        extraction_schema: 'sks.image-ux-issue-ledger.v3',
        generated_image_sha256: metadata.sha256,
        bbox_coordinate_space: 'generated_image',
        bbox_confidence: 0.5,
        severity_visible: true,
        callout_number_visible: true,
        text_ocr_confidence: 0.5,
        fix_verification_status: opts.mock ? 'mock' : 'not_rechecked',
        post_fix_recheck_issue_id: null
      }] : []
    }],
    generated_count: 1,
    required_count: 1,
    blockers: [],
    passed: metadata.real_generated === true && opts.mock !== true,
    contract_hash: contract.sealed_hash || null
  };
  await writeJsonAtomic(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), ledger);
  return ledger;
}

async function readImagegenResponse(dir: string) {
  return readJson(path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT), null).catch(() => null);
}

async function enforceImageUxRuntimeGate(dir: string, gate: any = {}, opts: any = {}) {
  const inventory = await readJson(path.join(dir, IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT), null);
  const generatedLedger = await readJson(path.join(dir, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT), null);
  const issueLedger = await readJson(path.join(dir, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT), null);
  const extractionReport = await readJson(path.join(dir, IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT), null);
  const response = await readJson(path.join(dir, IMAGE_UX_REVIEW_GPT_IMAGE_2_RESPONSE_ARTIFACT), null);
  const blockers = new Set<string>(Array.isArray(gate?.blockers) ? gate.blockers.map(String) : []);
  const sourceScreens = Array.isArray(inventory?.source_screens) ? inventory.source_screens : [];
  if (!opts.mock) {
    if (sourceScreens.length === 0) blockers.add('no_source_screenshots_for_imagegen_review');
    for (const screen of sourceScreens) {
      const width = Number(screen?.width || screen?.original_resolution?.width || 0);
      const height = Number(screen?.height || screen?.original_resolution?.height || 0);
      if (screen?.status !== 'captured') blockers.add(`source_screenshot_unreadable:${screen?.id || 'unknown'}`);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) blockers.add(`source_screenshot_below_min_resolution:${screen?.id || 'unknown'}`);
    }
  }
  const issues = Array.isArray(issueLedger?.issues) ? issueLedger.issues : [];
  if (issues.some((issue: any) => issue?.extraction_provider === 'mock_fixture' || issue?.source === 'mock_fixture')) blockers.add('mock_issue_extraction_cannot_pass_gate');
  if (opts.mock) blockers.add('image_ux_mock_mode_cannot_claim_real');
  const responseEvidence = await validateImagegenResponseEvidence(response, dir);
  for (const blocker of responseEvidence.blockers) blockers.add(blocker);
  const bindingBlockers = validateGeneratedImageEvidenceBinding(response, generatedLedger, extractionReport, issueLedger);
  for (const blocker of bindingBlockers) blockers.add(blocker);
  const nextBlockers = [...blockers];
  const codexGenerated = responseEvidence.ok === true && gate?.gpt_image_2_callout_generated === true;
  const sourceScreenshotMinResolutionPassed = sourceScreens.length > 0
    && sourceScreens.every((screen: any) => Number(screen?.width || 0) >= 64 && Number(screen?.height || 0) >= 64);
  const issueLedgerRealExtraction = issues.length > 0
    && issues.every((issue: any) => issue?.extraction_provider !== 'mock_fixture' && issue?.source !== 'mock_fixture');
  const reviewReportCompleted = gate?.review_report_completed === true
    && codexGenerated
    && bindingBlockers.length === 0
    && sourceScreenshotMinResolutionPassed
    && issueLedgerRealExtraction;
  const passed = gate?.passed === true && codexGenerated && nextBlockers.length === 0;
  return {
    ...gate,
    passed,
    ok: passed,
    status: passed ? 'passed' : reviewReportCompleted ? 'review_completed' : 'blocked',
    verified_level: passed ? gate?.verified_level || 'verified' : reviewReportCompleted ? 'verified_partial' : 'blocked',
    review_report_completed: reviewReportCompleted,
    completion_scope: reviewReportCompleted ? 'capture_imagegen_ocr_and_ux_report' : gate?.completion_scope || null,
    gpt_image_2_callout_generated: codexGenerated,
    generated_image_evidence: responseEvidence.ok === true,
    imagegen_response_evidence: responseEvidence,
    source_screenshot_min_resolution_passed: sourceScreenshotMinResolutionPassed,
    issue_ledger_real_extraction: issueLedgerRealExtraction,
    blockers: nextBlockers
  };
}

async function validateImagegenResponseEvidence(response: any = null, dir: string = process.cwd()) {
  const blockers: string[] = [];
  if (!response || typeof response !== 'object') {
    return { ok: false, blockers: ['imagegen_response_artifact_missing'] };
  }
  if (response.schema !== 'sks.image-ux-gpt-image-2-response.v1') blockers.push('imagegen_response_schema_invalid');
  if (response.ok !== true || response.status !== 'generated') blockers.push(response.blocker || 'imagegen_response_not_generated');
  if (response.image_output_partial_frame === true || response.payload_summary?.image_output_partial_frame === true) {
    blockers.push('imagegen_response_partial_image_output');
  }
  const evidenceClass = String(response.evidence_class || '');
  blockers.push(...imagegenEvidenceClassBlockers('imagegen_response', evidenceClass));
  const source = String(response.output_source || '');
  if (!isFullImagegenOutputSource(source)) blockers.push('imagegen_response_output_source_invalid');
  const outputPath = String(response.output_image_path || '');
  const expectedSha = String(response.output_sha256 || response.output_image_sha256 || '');
  const generatedReviewImageId = String(response.generated_review_image_id || '');
  if (!generatedReviewImageId) blockers.push('imagegen_response_generated_review_image_id_missing');
  if (!outputPath) blockers.push('imagegen_response_output_path_missing');
  if (!expectedSha) blockers.push('imagegen_response_output_sha256_missing');
  if (outputPath) {
    try {
      const root = rootFromMissionDir(dir);
      const absolute = path.isAbsolute(outputPath) ? outputPath : path.resolve(root, outputPath);
      const actualSha = await sha256File(absolute);
      if (expectedSha && actualSha !== expectedSha) blockers.push('imagegen_response_output_sha256_mismatch');
      const dims = await imageDimensions(absolute);
      if (!Number.isFinite(Number(dims.width)) || !Number.isFinite(Number(dims.height)) || Number(dims.width) <= 0 || Number(dims.height) <= 0) {
        blockers.push('imagegen_response_output_dimensions_invalid');
      }
    } catch {
      blockers.push('imagegen_response_output_file_unreadable');
    }
  }
  return {
    ok: blockers.length === 0,
    provider: response.provider || null,
    evidence_class: evidenceClass || null,
    output_source: source || null,
    output_image_path: outputPath || null,
    output_sha256: expectedSha || null,
    generated_review_image_id: generatedReviewImageId || null,
    blockers: [...new Set(blockers)]
  };
}

function validateGeneratedImageEvidenceBinding(response: any, generatedLedger: any, extractionReport: any, issueLedger: any): string[] {
  if (!response || response.ok !== true || response.status !== 'generated') return [];
  const blockers: string[] = [];
  const generatedId = String(response.generated_review_image_id || '');
  const responseSha = String(response.output_sha256 || response.output_image_sha256 || '');
  const images = Array.isArray(generatedLedger?.generated_review_images) ? generatedLedger.generated_review_images : [];
  const image = images.find((row: any) => String(row?.id || '') === generatedId);
  if (generatedId && !image) blockers.push('imagegen_response_generated_review_image_id_not_in_ledger');
  if (image && responseSha && String(image.sha256 || '') !== responseSha) blockers.push('imagegen_response_generated_review_image_sha256_mismatch');
  if (extractionReport) {
    if (String(extractionReport.generated_image_id || '') !== generatedId) blockers.push('callout_extraction_generated_image_id_mismatch');
    if (responseSha && String(extractionReport.generated_image_sha256 || '') !== responseSha) blockers.push('callout_extraction_generated_image_sha256_mismatch');
  }
  for (const issue of Array.isArray(issueLedger?.issues) ? issueLedger.issues : []) {
    if (String(issue.generated_review_image_id || '') !== generatedId) blockers.push(`issue_generated_image_id_mismatch:${issue.id || 'unknown'}`);
    if (responseSha && String(issue.generated_image_sha256 || '') !== responseSha) blockers.push(`issue_generated_image_sha256_mismatch:${issue.id || 'unknown'}`);
  }
  return [...new Set(blockers)];
}

function rootFromMissionDir(dir: string) {
  const marker = `${path.sep}.sneakoscope${path.sep}missions${path.sep}`;
  const idx = String(dir).indexOf(marker);
  return idx >= 0 ? String(dir).slice(0, idx) : process.cwd();
}

function nextActionForGate(gate: any = {}) {
  const blockers = gate?.blockers || [];
  if (blockers.includes('missing_generated_annotated_review_images')) return 'Run `sks ux-review run --image <path> --generate-callouts --json` or attach a real generated image.';
  if (blockers.includes('callout_extraction_pending')) return 'Run `sks ux-review extract-issues --generated-image <path> --json` with Codex output-schema session or OpenAI API fallback.';
  if (blockers.includes('manual_recapture_required')) return 'Run `sks ux-review attach-after --image <path> --json` after applying patches.';
  return blockers.length ? 'Resolve listed blockers, then rerun `sks ux-review proof latest --json`.' : 'No blockers recorded.';
}

async function finalizeImageUx(root: string, missionId: string, command: string, artifacts: any, opts: any = {}) {
  const visualEvidence = imageUxReviewProofEvidence(artifacts.gate, artifacts);
  const claimStatus = artifacts.gate?.verified_level || (opts.mock ? 'verified_partial' : artifacts.gate?.passed ? 'verified' : 'blocked');
  const artifactList = Object.entries(artifacts)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key]) => IMAGE_UX_REVIEW_ARTIFACT_PATHS[key] || key);
  const finalized = await maybeFinalizeRoute(root, {
    missionId,
    route: routeForCommand(command),
    gateFile: 'image-ux-review-gate.json',
    gate: artifacts.gate,
    mock: opts.mock === true,
    visual: true,
    requireRelation: opts.requireRelation === true,
    statusHint: artifacts.gate?.passed ? 'verified_partial' : 'blocked',
    visualEvidence: { image_ux_review: visualEvidence },
    artifacts: artifactList,
    claims: [{ id: 'image-ux-review-callout-loop', status: claimStatus }],
    blockers: artifacts.gate?.blockers || [],
    allowActiveWrongnessPartial: artifacts.gate?.reference_only === true,
    command: { cmd: opts.cmd || `sks ${command}`, status: artifacts.gate?.blockers?.length ? 1 : 0 }
  });
  const proofIssues = Array.isArray(finalized?.validation?.issues)
    ? finalized.validation.issues.map(String)
    : [];
  await closeWorkOrderLedgerForRouteResult(missionDir(root, missionId), {
    ok: artifacts.gate?.passed === true && finalized?.ok === true,
    blockers: [...new Set([
      ...(Array.isArray(artifacts.gate?.blockers) ? artifacts.gate.blockers.map(String) : []),
      ...proofIssues
    ])]
  });
  return finalized;
}

async function ensureFixtureImageVoxelRelation(root: string, missionId: string, imageRel: string) {
  await ingestImage(root, imageRel, { missionId, source: 'mock_fixture_source', id: `${missionId}-source-screen` });
  await ingestImage(root, imageRel, { missionId, source: 'mock_fixture_generated_callout', id: `${missionId}-generated-callout` });
  await addImageRelation(root, {
    missionId,
    route: '$Image-UX-Review',
    type: 'generated_callout_review_of',
    beforeImageId: `${missionId}-source-screen`,
    afterImageId: `${missionId}-generated-callout`,
    anchors: [],
    status: 'verified_partial',
    verification: 'mock-generated-callout-relation'
  });
}

async function stageSourceImage(root: string, dir: string, imagePath: string) {
  return stageImageReference(root, dir, imagePath, 'source-screens');
}

async function stageGeneratedImage(root: string, dir: string, imagePath: string, preferredName: string | null = null) {
  return stageImageReference(root, dir, imagePath, 'generated-callouts', preferredName);
}

export async function stageImageReference(root: string, dir: string, imagePath: string, subdir: string, preferredName: string | null = null) {
  const source = path.resolve(root, imagePath);
  const id = `${subdir}-${preferredName || path.basename(source)}`.replace(/[^A-Za-z0-9._:-]+/g, '-');
  const reference = await registerPathImageReference({
    id,
    filePath: source,
    allowedRoots: [root],
    allowOutOfRoot: path.isAbsolute(imagePath),
    consent: 'local-only'
  });
  await upsertImageReferenceRegistry(path.join(dir, 'image-references.json'), reference);
  const relative = path.relative(root, source).split(path.sep).join('/');
  return relative.startsWith('../') ? source : relative;
}

function promptForRun(command: string, args: any[]) {
  const source = readOption(args, '--image', null) || readOption(args, '--screenshot', null) || readOption(args, '--mission', null) || 'latest Codex Chrome Extension or native Computer Use screenshot';
  return `$${routeForCommand(command).replace(/^\$/, '')} ${source} with gpt-image-2 callouts${flag(args, '--fix') ? ', then fix the issues' : ''}`;
}

function sourceImageFromContract(contract: any): string | null {
  const sources = contract?.answers?.IMAGE_UX_REVIEW_SOURCE_IMAGES;
  return Array.isArray(sources) && sources.length ? String(sources[0]) : null;
}

function missingMission(args: any[]) {
  const result = { schema: 'sks.image-ux-review-status.v2', ok: false, status: 'missing_mission' };
  if (flag(args, '--json')) return printJson(result);
  console.error('No mission found.');
  process.exitCode = 1;
  return result;
}

function routeForCommand(command: any) {
  return command === 'ux-review' ? '$UX-Review' : command === 'visual-review' ? '$Visual-Review' : command === 'ui-ux-review' ? '$UI-UX-Review' : '$Image-UX-Review';
}
