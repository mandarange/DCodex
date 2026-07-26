import path from 'node:path';
import { exists, projectRoot, readJson, writeJsonAtomic } from '../fsx.js';
import { createMission, findLatestMission, loadMission } from '../mission.js';
import { flag, readOption } from './command-utils.js';
import { printJson } from '../../cli/output.js';
import {
  PPT_AUDIENCE_STRATEGY_ARTIFACT,
  PPT_CLEANUP_REPORT_ARTIFACT,
  PPT_FACT_LEDGER_ARTIFACT,
  PPT_GATE_ARTIFACT,
  PPT_HTML_ARTIFACT,
  PPT_IMAGE_ASSET_LEDGER_ARTIFACT,
  PPT_ITERATION_REPORT_ARTIFACT,
  PPT_PARALLEL_REPORT_ARTIFACT,
  PPT_PDF_ARTIFACT,
  PPT_RENDER_REPORT_ARTIFACT,
  PPT_REVIEW_LEDGER_ARTIFACT,
  PPT_REVIEW_POLICY_ARTIFACT,
  PPT_SOURCE_LEDGER_ARTIFACT,
  PPT_STORYBOARD_ARTIFACT,
  PPT_STYLE_TOKENS_ARTIFACT,
  writePptBuildArtifacts,
  writePptRouteArtifacts
} from '../ppt.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { writePptImagegenReviewFixture } from '../ppt-imagegen-review.js';
import {
  PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT,
  PPT_REVIEW_ARTIFACT_PATHS,
  pptReviewProofEvidence,
  writePptImagegenReviewArtifacts
} from '../ppt-review/index.js';
import { writeRouteCollaborationArtifacts } from '../agents/route-collaboration-ledger.js';
import { requireCodexImagegen } from '../imagegen/require-imagegen.js';

export async function pptCommand(command: any, args: any = []) {
  const root = await projectRoot();
  const action = args[0] || 'status';
  if (action === 'fixture') return pptFixture(root, command, args);
  if (['review', 'export-slides', 'slide-export', 'callouts', 'extract-issues', 'fix', 'attach-after', 'attach-fixed-deck', 'recheck', 'proof'].includes(action)) {
    return pptImagegenReview(root, command, action, args.slice(1));
  }
  if (action === 'explain') return pptExplain(root, args.slice(1));

  const missionArg = args[1] && !String(args[1]).startsWith('--') ? args[1] : 'latest';
  // build/status act on ppt-gate.json (written by build, not the imagegen-review gate),
  // so scope by mode only here - requiring the imagegen-review gate would wrongly exclude
  // a fresh ppt mission that hasn't gone through review yet.
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'ppt' }) : missionArg;
  if (!missionId) return missingMission(args);
  const { dir, mission } = await loadMission(root, missionId);
  const contract = await readJson(path.join(dir, 'decision-contract.json'), { prompt: mission.prompt, answers: fixtureAnswers(), sealed_hash: 'ppt-fixture-contract' });
  if (action === 'build') {
    if (!flag(args, '--mock')) {
      const imagegenRequired = await requireCodexImagegen(root, { autoRepair: true, applyRepair: true });
      if (!imagegenRequired.ok) {
        const result = {
          schema: 'sks.ppt-build.v1',
          ok: false,
          status: 'blocked',
          mission_id: missionId,
          blocker: 'codex_imagegen_unavailable',
          imagegen_required: imagegenRequired,
          gate: {
            schema: 'sks.ppt-gate.v1',
            passed: false,
            status: 'blocked',
            blockers: ['codex_imagegen_unavailable'],
            imagegen_evidence: { passed: false, generated_image_evidence: false }
          }
        };
        process.exitCode = 1;
        if (flag(args, '--json')) return printJson(result);
        console.error('PPT build blocked: no selected Codex imagegen/gpt-image-2 provider is ready.');
        for (const action of imagegenRequired.blocker?.next_actions || []) console.error(`- ${action}`);
        return result;
      }
    }
    await writePptRouteArtifacts(dir, contract);
    const build = await writePptBuildArtifacts(dir, contract);
    const gate = await evaluatePptGateArtifacts(dir, build.gate);
    await writeJsonAtomic(path.join(dir, 'ppt-gate.json'), gate);
    const proof = await maybeFinalizeRoute(root, { missionId, route: '$PPT', gateFile: 'ppt-gate.json', gate, mock: flag(args, '--mock'), visual: true, artifacts: Object.keys(build.files || {}), claims: [{ id: 'ppt-build-fixture', status: gate.passed ? 'verified_partial' : 'blocked' }], blockers: gate.blockers || [], command: { cmd: `sks ppt build ${missionId}`, status: gate.passed ? 0 : 1 } });
    const ok = proof.ok === true && gate.passed === true;
    const result = { schema: 'sks.ppt-build.v1', ok, mission_id: missionId, build: { ...build, gate }, proof: proof.validation, blockers: gate.blockers || [] };
    if (flag(args, '--json')) return printJson(result);
    console.log(`PPT build: ${ok ? 'ok' : 'blocked'} ${missionId}`);
    if (!ok && gate.blockers?.length) console.log(`Blockers: ${gate.blockers.join(', ')}`);
    if (!ok) process.exitCode = 1;
    return result;
  }
  if (action === 'status') {
    const gate = await readJson(path.join(dir, 'ppt-gate.json'), null);
    const imagegenGate = await readJson(path.join(dir, PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT), null);
    const result = { schema: 'sks.ppt-status.v2', ok: true, mission_id: missionId, gate, imagegen_review_gate: imagegenGate };
    if (flag(args, '--json')) return printJson(result);
    console.log(`PPT mission: ${missionId}`);
    console.log(`Gate: ${gate?.passed ? 'passed' : gate ? 'present' : 'missing'}`);
    console.log(`Imagegen review: ${imagegenGate?.passed ? 'passed' : imagegenGate ? 'present' : 'missing'}`);
    return result;
  }
  await writeJsonAtomic(path.join(dir, 'ppt-command-error.json'), { action, args });
  console.error('Usage: sks ppt fixture|build|status|review|export-slides|callouts|extract-issues|fix|attach-after|attach-fixed-deck|recheck|proof|explain [mission-id|latest] [--deck <pptx>] [--json] [--mock]');
  process.exitCode = 1;
  return null;
}

async function pptImagegenReview(root: string, command: any, action: string, args: any[] = []) {
  const deckPath = readOption(args, '--deck', null);
  const fixtureMode = flag(args, '--fixture');
  const mockMode = flag(args, '--mock') || fixtureMode;
  const missionArg = firstPptPositional(args);
  const shouldCreate = Boolean(deckPath || mockMode || action === 'review' || action === 'export-slides' || action === 'slide-export' || action === 'callouts' || action === 'extract-issues');
  const missionId = shouldCreate && !missionArg
    ? null
    : missionArg === 'latest' || !missionArg ? await findLatestMission(root, { mode: 'ppt', route: '$PPT', gateFile: PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT }) : missionArg;
  const loaded = missionId ? await loadMission(root, missionId) : await createMission(root, { mode: 'ppt', prompt: `PPT imagegen review ${deckPath || 'fixture'}` });
  const id = 'id' in loaded ? loaded.id : missionId;
  const dir = loaded.dir;
  const mission = 'mission' in loaded ? loaded.mission : (loaded as any).mission;
  const contract = await readJson(path.join(dir, 'decision-contract.json'), {
    prompt: mission?.prompt || `PPT imagegen review ${deckPath || 'latest'}`,
    route: '$PPT',
    sealed_hash: `ppt-review-${id}`,
    answers: { PPT_DECK_PATH: deckPath }
  });
  if (!await readJson(path.join(dir, 'decision-contract.json'), null)) {
    await writeJsonAtomic(path.join(dir, 'decision-contract.json'), contract);
  }
  if (fixtureMode) {
    const fixture = await writePptImagegenReviewFixture(root, dir, id, { source: 'ppt-command-fixture' });
    const proof = await maybeFinalizeRoute(root, {
      missionId: id,
      route: '$PPT',
      gateFile: PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT,
      gate: fixture.artifacts.gate,
      mock: true,
      visual: true,
      visualEvidence: { ppt_review: fixture.proof_evidence },
      artifacts: Object.values(PPT_REVIEW_ARTIFACT_PATHS),
      claims: [{ id: 'ppt-imagegen-review-loop', status: 'verified_partial' }],
      blockers: fixture.artifacts.gate?.blockers || [],
      command: { cmd: `sks ${command} ${action} --fixture`, status: fixture.artifacts.gate?.passed ? 0 : 1 }
    });
    const result = {
      schema: 'sks.ppt-imagegen-review.v1',
      ok: proof.ok && fixture.artifacts.gate?.passed === true,
      status: fixture.artifacts.gate?.passed ? 'passed' : 'blocked',
      mission_id: id,
      artifacts: fixture.artifacts,
      proof_evidence: fixture.proof_evidence,
      proof: proof.validation
    };
    if (!result.ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(`PPT imagegen review: ${result.ok ? 'ok' : 'blocked'} ${id}`);
    return result;
  }
  if (!mockMode) {
    const imagegenRequired = await requireCodexImagegen(root, { autoRepair: true, applyRepair: true });
    if (!imagegenRequired.ok) {
      const result = {
        schema: 'sks.ppt-imagegen-review.v1',
        ok: false,
        status: 'blocked',
        mission_id: id,
        blocker: 'codex_imagegen_unavailable',
        imagegen_required: imagegenRequired,
        gate: {
          schema: 'sks.ppt-imagegen-review-gate.v1',
          passed: false,
          status: 'blocked',
          blockers: ['codex_imagegen_unavailable'],
          imagegen_evidence: { passed: false, generated_image_evidence: false }
        }
      };
      process.exitCode = 1;
      if (flag(args, '--json')) return printJson(result);
      console.error('PPT imagegen review blocked: no selected Codex imagegen/gpt-image-2 provider is ready.');
      for (const action of imagegenRequired.blocker?.next_actions || []) console.error(`- ${action}`);
      return result;
    }
  }
  const artifacts = await writePptImagegenReviewArtifacts({
    root,
    dir,
    missionId: id,
    deckPath: deckPath || contract.answers?.PPT_DECK_PATH || null,
    manualImages: readOption(args, '--manual-slide-images', null) || readOption(args, '--slide-images', null),
    generatedSlidePath: readOption(args, '--generated-slide', null),
    sessionId: readOption(args, '--session', null) || readOption(args, '--session-id', null),
    fixedDeckPath: action === 'attach-fixed-deck' ? deckPath : readOption(args, '--fixed-deck', null),
    afterSlideImages: readOption(args, '--image', null) ? [readOption(args, '--image', null)] : [],
    fixRequested: flag(args, '--fix') || action === 'fix',
    skipCallouts: action === 'export-slides' || action === 'slide-export',
    skipExtraction: action === 'export-slides' || action === 'slide-export' || action === 'callouts',
    mock: mockMode
  });
  const proofEvidence = pptReviewProofEvidence(artifacts.gate, artifacts);
  const proof = await maybeFinalizeRoute(root, {
    missionId: id,
    route: '$PPT',
    gateFile: PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT,
    gate: artifacts.gate,
    mock: mockMode,
    visual: true,
    visualEvidence: { ppt_review: proofEvidence },
    artifacts: Object.values(PPT_REVIEW_ARTIFACT_PATHS),
    claims: [{ id: 'ppt-imagegen-review-loop', status: mockMode ? 'verified_partial' : artifacts.gate?.passed ? 'verified' : 'blocked' }],
    blockers: artifacts.gate?.blockers || [],
    command: { cmd: `sks ${command} ${action}`, status: artifacts.gate?.passed ? 0 : 1 }
  });
  const result = { schema: 'sks.ppt-imagegen-review.v1', ok: proof.ok && artifacts.gate?.passed === true, status: artifacts.gate?.passed ? 'passed' : 'blocked', mission_id: id, artifacts: pptArtifactAliases(artifacts), proof_evidence: proofEvidence, proof: proof.validation };
  if (!result.ok && !mockMode) process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`PPT imagegen review: ${result.ok ? 'ok' : 'blocked'} ${id}`);
  return result;
}

async function pptFixture(root: string, command: any, args: any[]) {
  const { id, dir, mission } = await createMission(root, { mode: 'ppt', prompt: 'PPT fixture route build' });
  const contract = { prompt: mission.prompt, answers: fixtureAnswers(), sealed_hash: 'ppt-fixture-contract' };
  await writeJsonAtomic(path.join(dir, 'decision-contract.json'), contract);
  await writePptRouteArtifacts(dir, contract);
  const build = await writePptBuildArtifacts(dir, contract);
  const gate = mockPptFixtureGate(build.gate);
  await writeJsonAtomic(path.join(dir, 'ppt-gate.json'), gate);
  const review = await writePptImagegenReviewArtifacts({ root, dir, missionId: id, mock: true });
  const native = await writeRouteCollaborationArtifacts(root, {
    missionId: id,
    route: '$PPT',
    routeKey: 'PPT-Collab',
    prompt: 'PPT collaboration route native agent plan for source HTML, visual review, imagegen evidence, and proof closure.',
    mode: 'PPT'
  });
  const proof = await maybeFinalizeRoute(root, {
    missionId: id,
    route: '$PPT',
    gateFile: PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT,
    gate: review.gate,
    mock: true,
    visual: true,
    visualEvidence: { ppt_review: pptReviewProofEvidence(review.gate, review) },
    artifacts: [...Object.keys(build.files || {}), ...Object.values(PPT_REVIEW_ARTIFACT_PATHS), ...Object.values(native.artifacts || {})],
    claims: [{ id: 'ppt-fixture', status: 'verified_partial' }],
    blockers: gate.blockers || [],
    statusHint: 'blocked',
    command: { cmd: `sks ${command} fixture --mock`, status: 1 }
  });
  const result = { schema: 'sks.ppt-fixture.v2', ok: false, mission_id: id, build: { ...build, ok: false, gate }, imagegen_review: review, native_agent_collaboration: native, proof: proof.validation };
  if (flag(args, '--json')) {
    process.exitCode = 1;
    return printJson(result);
  }
  console.log(`PPT fixture: blocked ${id}`);
  process.exitCode = 1;
  return result;
}

async function pptExplain(root: string, args: any[] = []) {
  const missionArg = args.find((arg: any) => !String(arg).startsWith('--')) || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root, { mode: 'ppt', route: '$PPT', gateFile: PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT }) : missionArg;
  if (!missionId) return missingMission(args);
  const { dir } = await loadMission(root, missionId);
  const gate = await readJson(path.join(dir, PPT_IMAGEGEN_REVIEW_GATE_ARTIFACT), null);
  const result = { schema: 'sks.ppt-explain.v1', ok: Boolean(gate), mission_id: missionId, status: gate?.passed ? 'passed' : 'blocked', blockers: gate?.blockers || [], next_action: nextActionForPptGate(gate) };
  if (flag(args, '--json')) return printJson(result);
  console.log(`Status: ${result.status}`);
  console.log(`Next: ${result.next_action}`);
  return result;
}

function nextActionForPptGate(gate: any = {}) {
  const blockers = gate?.blockers || [];
  if (blockers.includes('deck_required')) return 'Run `sks ppt review --deck <pptx> --json`, or use --mock only for fixture evidence.';
  if (blockers.includes('slide_export_unavailable')) return 'Attach exported slide images with --manual-slide-images, then rerun the PPT review.';
  if (blockers.includes('ppt_imagegen_callouts_missing')) return 'Generate slide callout review images with Codex App $imagegen/gpt-image-2 and rerun extraction.';
  if (blockers.includes('ppt_slide_issue_extraction_missing')) return 'Run `sks ppt extract-issues --generated-slide <path> --session <id> --json`, or configure Structured Outputs fallback.';
  if (blockers.includes('ppt_slide_recheck_missing')) return 'Attach a fixed deck or fixed slide image, then rerun `sks ppt recheck latest --json`.';
  return blockers.length ? 'Resolve listed blockers and rerun `sks ppt proof latest --json`.' : 'No blockers recorded.';
}

function pptArtifactAliases(artifacts: any = {}) {
  return {
    ...artifacts,
    deckInventory: artifacts.deck_inventory,
    slideExport: artifacts.slide_export_ledger,
    callouts: artifacts.slide_callout_ledger,
    slideIssues: artifacts.slide_issue_ledger,
    deckIssues: artifacts.deck_issue_ledger,
    fixPlan: artifacts.fix_task_plan,
    handoff: artifacts.patch_handoff,
    patch: artifacts.patch_result,
    recheck: artifacts.recheck_report
  };
}

function firstPptPositional(args: any[] = []) {
  const valueFlags = new Set([
    '--deck',
    '--manual-slide-images',
    '--slide-images',
    '--generated-slide',
    '--session',
    '--session-id',
    '--fixed-deck',
    '--image',
    '--slide'
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('--')) return arg;
  }
  return null;
}

function missingMission(args: any[]) {
  const result = { schema: 'sks.ppt-status.v1', ok: false, status: 'missing_mission' };
  if (flag(args, '--json')) return printJson(result);
  console.error('No mission found.');
  process.exitCode = 1;
  return result;
}

function mockPptFixtureGate(gate: any = {}) {
  return {
    ...gate,
    passed: false,
    ok: false,
    status: 'blocked',
    execution_class: 'mock_fixture',
    mock_fixture: true,
    unsupported_critical_claims_zero: false,
    image_asset_policy_satisfied: false,
    bounded_iteration_complete: false,
    critical_review_issues_zero: false,
    render_report_passed: false,
    fact_ledger_passed: false,
    image_asset_ledger_passed: false,
    review_ledger_passed: false,
    iteration_report_passed: false,
    cleanup_report_passed: false,
    parallel_report_passed: false,
    honest_mode_complete: false,
    blockers: ['ppt_fixture_mode_cannot_claim_real']
  };
}

// The image-asset-ledger's `assets` array (see buildPptImageAssetLedger in ../ppt.ts) is the
// authoritative list of raster/bitmap image assets planned or generated for the deck; every
// entry in it is a raster PNG produced (or pending) via Codex App $imagegen/gpt-image-2. When the
// ledger omits `imagegen_evidence` outright, we must NOT assume the imagegen-required policy was
// satisfied. Instead derive a safe default from that asset list: any raster asset present forces
// the derived evidence to fail-closed (required + not passed) rather than silently pass.
function deriveImagegenEvidenceDefault(imageAssetLedger: any) {
  if (imageAssetLedger?.imagegen_evidence) return imageAssetLedger.imagegen_evidence;
  const rasterAssets = Array.isArray(imageAssetLedger?.assets) ? imageAssetLedger.assets : [];
  const rasterAssetCount = rasterAssets.length;
  if (rasterAssetCount === 0) {
    return {
      schema: 'sks.ppt-imagegen-evidence.v1',
      required: false,
      passed: true,
      blockers: [],
      derived: true,
      derivation_basis: { raster_asset_count: 0, source: 'derived_default_no_raster_assets' }
    };
  }
  return {
    schema: 'sks.ppt-imagegen-evidence.v1',
    required: true,
    passed: false,
    required_count: imageAssetLedger?.required_count || rasterAssetCount,
    generated_count: imageAssetLedger?.generated_count || 0,
    generated_image_evidence: false,
    assets: [],
    blockers: ['imagegen_evidence_missing'],
    derived: true,
    derivation_basis: {
      raster_asset_count: rasterAssetCount,
      source: 'derived_default_raster_assets_present',
      note: `imagegen_evidence section was absent from the image-asset-ledger while ${rasterAssetCount} raster asset(s) were present; failing closed instead of silently passing.`
    },
    passed_note: 'imagegen_evidence_missing: ledger omitted imagegen_evidence despite raster assets requiring Codex App imagegen verification'
  };
}

export async function evaluatePptGateArtifacts(dir: string, baseGate: any = {}) {
  const factLedger = await readJson(path.join(dir, PPT_FACT_LEDGER_ARTIFACT), null);
  const imageAssetLedger = await readJson(path.join(dir, PPT_IMAGE_ASSET_LEDGER_ARTIFACT), null);
  const reviewLedger = await readJson(path.join(dir, PPT_REVIEW_LEDGER_ARTIFACT), null);
  const iterationReport = await readJson(path.join(dir, PPT_ITERATION_REPORT_ARTIFACT), null);
  const renderReport = await readJson(path.join(dir, PPT_RENDER_REPORT_ARTIFACT), null);
  const cleanupReport = await readJson(path.join(dir, PPT_CLEANUP_REPORT_ARTIFACT), null);
  const parallelReport = await readJson(path.join(dir, PPT_PARALLEL_REPORT_ARTIFACT), null);
  const requiredArtifacts = [
    'decision-contract.json',
    PPT_AUDIENCE_STRATEGY_ARTIFACT,
    PPT_SOURCE_LEDGER_ARTIFACT,
    PPT_FACT_LEDGER_ARTIFACT,
    PPT_IMAGE_ASSET_LEDGER_ARTIFACT,
    PPT_STORYBOARD_ARTIFACT,
    PPT_STYLE_TOKENS_ARTIFACT,
    PPT_REVIEW_POLICY_ARTIFACT,
    PPT_REVIEW_LEDGER_ARTIFACT,
    PPT_ITERATION_REPORT_ARTIFACT,
    PPT_HTML_ARTIFACT,
    PPT_PDF_ARTIFACT,
    PPT_RENDER_REPORT_ARTIFACT,
    PPT_CLEANUP_REPORT_ARTIFACT,
    PPT_PARALLEL_REPORT_ARTIFACT
  ];
  const missing = [];
  for (const artifact of requiredArtifacts) {
    if (!(await exists(path.join(dir, artifact)))) missing.push(artifact);
  }
  const renderReportPassed = renderReport?.passed === true;
  const factLedgerPassed = factLedger?.passed === true && Number(factLedger.unsupported_critical_claims_count || 0) === 0;
  const imageAssetLedgerPassed = imageAssetLedger?.passed === true;
  const imagegenEvidence = deriveImagegenEvidenceDefault(imageAssetLedger);
  const imagegenEvidencePassed = imagegenEvidence?.required === true ? imagegenEvidence?.passed === true : true;
  const reviewLedgerPassed = reviewLedger?.passed === true;
  const iterationReportPassed = iterationReport?.passed === true;
  const cleanupReportPassed = cleanupReport?.source_html_preserved === true && cleanupReport?.temp_cleanup_completed === true;
  const parallelReportPassed = parallelReport?.passed === true;
  const blockers = [
    ...missing.map((artifact) => `missing_artifact:${artifact}`),
    ...(renderReportPassed ? [] : ['render_report_not_passed']),
    ...(factLedgerPassed ? [] : ['fact_ledger_not_passed']),
    ...(imageAssetLedgerPassed ? [] : ['image_asset_ledger_not_passed']),
    ...(imagegenEvidencePassed ? [] : ['ppt_imagegen_evidence_not_passed']),
    ...(reviewLedgerPassed ? [] : ['review_ledger_not_passed']),
    ...(iterationReportPassed ? [] : ['iteration_report_not_passed']),
    ...(cleanupReportPassed ? [] : ['cleanup_report_not_passed']),
    ...(parallelReportPassed ? [] : ['parallel_report_not_passed'])
  ];
  const passed = blockers.length === 0;
  return {
    ...baseGate,
    passed,
    ok: passed,
    status: passed ? 'pass' : 'blocked',
    render_report_passed: renderReportPassed,
    fact_ledger_passed: factLedgerPassed,
    image_asset_ledger_passed: imageAssetLedgerPassed,
    imagegen_evidence: imagegenEvidence,
    review_ledger_passed: reviewLedgerPassed,
    iteration_report_passed: iterationReportPassed,
    cleanup_report_passed: cleanupReportPassed,
    parallel_report_passed: parallelReportPassed,
    blockers
  };
}

function fixtureAnswers() {
  return {
    PRESENTATION_AUDIENCE_PROFILE: 'Release reviewer validating SKS route evidence.',
    PRESENTATION_STP_STRATEGY: 'Segment: developer tooling. Target: Codex trust-layer maintainers. Positioning: proof-first release readiness.',
    PRESENTATION_DELIVERY_CONTEXT: 'Mock release gate fixture.',
    PRESENTATION_PAINPOINT_SOLUTION_MAP: [
      'Route proof gaps -> automatic completion proof',
      'Visual evidence ambiguity -> image voxel anchors',
      'Fixture placeholders -> actual artifact validation'
    ]
  };
}
