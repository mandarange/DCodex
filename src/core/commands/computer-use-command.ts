import path from 'node:path';
import fsp from 'node:fs/promises';
import { nowIso, projectRoot, readJson, writeJsonAtomic } from '../fsx.js';
import { createMission, findLatestMission } from '../mission.js';
import { flag, readOption } from '../../cli/args.js';
import { printJson } from '../../cli/output.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { computerUseLiveSmoke, computerUseStatusReport } from '../computer-use-status.js';
import { computerUseLiveEvidencePath } from '../computer-use-live-evidence.js';
import { codexChromeExtensionStatus } from '../codex-app.js';

function routeIsWebVerification(route: any) {
  return /\$(?:QA-LOOP|Image-UX-Review|UX-Review|Visual-Review|UI-UX-Review|From-Chat-IMG)\b|qa-loop|ux-review|image-ux-review|visual-review|ui-ux-review|from-chat-img/i.test(String(route || ''));
}

export async function computerUseCommand(command: any, args: any = []) {
  const root = await projectRoot();
  const action = args[0] || 'import';
  if (action === 'status' || action === 'doctor') {
    const result = await computerUseStatusReport();
    if (flag(args, '--json')) return printJson(result, { failureExitCode: action === 'doctor' });
    console.log(`Computer Use status: ${result.status}`);
    if (result.guidance?.length) for (const line of result.guidance) console.log(`- ${line}`);
    if (!result.ok && action === 'doctor') process.exitCode = result.status === 'not_macos' ? 0 : 1;
    return;
  }
  if (action === 'smoke') {
    const missionArg = readOption(args, '--mission', null);
    const missionId = missionArg === 'latest' ? await findLatestMission(root) : missionArg;
    const route = readOption(args, '--route', null);
    const evidencePath = computerUseLiveEvidencePath(root, { missionId });
    const result = await computerUseLiveSmoke({
      root,
      real: flag(args, '--real'),
      requireReal: flag(args, '--require-real'),
      captureScreenshot: flag(args, '--capture-screenshot'),
      allowAction: flag(args, '--allow-action'),
      route,
      missionId,
      evidencePath
    });
    if (flag(args, '--json')) {
      printJson(result);
    } else {
      console.log(`Computer Use smoke: ${result.status} (${result.evidence_mode})`);
      if (result.live_evidence_path) console.log(`Live evidence: ${result.live_evidence_path}`);
      if (result.blockers?.length) for (const blocker of result.blockers) console.log(`- blocker: ${blocker}`);
      if (result.warnings?.length) for (const warning of result.warnings) console.log(`- warning: ${warning}`);
      if (result.guidance?.length) for (const line of result.guidance) console.log(`- ${line}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'enable') {
    const result = await computerUseStatusReport();
    const response = {
      schema: 'sks.computer-use-enable.v1',
      ok: result.status === 'available',
      status: result.status,
      macos: process.platform === 'darwin',
      guidance: [
        'Open Codex App and grant Screen Recording/Accessibility if macOS prompts.',
        'SKS does not widen MAD-SKS or DB permissions for Computer Use.'
      ],
      current: result
    };
    if (flag(args, '--json')) return printJson(response);
    console.log(`Computer Use enable: ${response.ok ? 'available' : response.status}`);
    for (const line of response.guidance) console.log(`- ${line}`);
    return;
  }
  if (action === 'require') {
    const routeArg = args.includes('--route') ? args[args.indexOf('--route') + 1] : null;
    if (routeIsWebVerification(routeArg) && !flag(args, '--native') && !flag(args, '--non-web')) {
      const chrome = await codexChromeExtensionStatus();
      const response = {
        schema: 'sks.computer-use-require.v1',
        ok: false,
        route: routeArg || null,
        status: 'web_verification_uses_chrome_extension',
        evidence: { schema: 'sks.computer-use-evidence.v1', status: 'not_required_for_web_verification', source: null, screens: [], actions: [], image_voxel_linked: false },
        blocker: 'web_verification_requires_codex_chrome_extension',
        chrome_extension: chrome,
        guidance: [
          'This route is web/browser/webapp verification, so SKS must not use Computer Use as the evidence path.',
          chrome.ok
            ? 'Codex Chrome Extension is ready; use the web verification gate instead of Computer Use.'
            : 'Set up the Codex Chrome Extension first, then resume after the user confirms installation is complete.'
        ]
      };
      process.exitCode = 1;
      if (flag(args, '--json')) return printJson(response);
      console.log(`Computer Use requirement for ${routeArg || 'route'}: blocked (${response.blocker})`);
      for (const line of response.guidance) console.log(`- ${line}`);
      return;
    }
    const result = await computerUseStatusReport();
    const response = { schema: 'sks.computer-use-require.v1', ok: result.status === 'available', route: routeArg || null, status: result.status, evidence: result.evidence, blocker: result.status === 'available' ? null : result.status };
    if (!response.ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(response);
    console.log(`Computer Use requirement for ${routeArg || 'route'}: ${response.ok ? 'available' : `blocked (${response.blocker})`}`);
    return;
  }
  if (action === 'import-fixture') return importFixture(root, command, args);
  const missionArg = args.find((arg: any) => !String(arg).startsWith('--')) || 'latest';
  const missionId = missionArg === 'latest' ? await findLatestMission(root) : missionArg;
  if (!missionId) {
    const result = { schema: 'sks.computer-use-evidence.v1', ok: false, status: 'missing_mission' };
    if (flag(args, '--json')) return printJson(result);
    console.error('No mission found.');
    process.exitCode = 1;
    return;
  }
  const route = command === 'cu' ? '$CU' : '$Computer-Use';
  const gate = await evaluateComputerUseGate(root, missionId);
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'missions', missionId, 'computer-use-gate.json'), gate);
  const proof = await maybeFinalizeRoute(root, {
    missionId,
    route,
    gateFile: 'computer-use-gate.json',
    gate,
    mock: flag(args, '--mock'),
    visual: true,
    requireRelation: flag(args, '--fix-claim') || flag(args, '--require-relation'),
    artifacts: ['computer-use-evidence-ledger.json', 'screen-capture-ledger.json', 'image-voxel-ledger.json', 'visual-anchors.json'],
    claims: [{ id: 'computer-use-evidence', status: flag(args, '--mock') ? 'verified_partial' : 'supported' }],
    blockers: gate.blockers || [],
    statusHint: gate.passed ? undefined : 'blocked',
    command: { cmd: `sks ${command} ${args.join(' ')}`.trim(), status: gate.passed ? 0 : 1 }
  });
  const result = { schema: 'sks.computer-use-evidence.v1', ok: proof.ok && gate.passed === true, mission_id: missionId, route, gate, proof: proof.validation };
  if (flag(args, '--json')) return printJson(result);
  console.log(`Computer Use evidence: ${proof.ok ? 'ok' : 'blocked'} ${missionId}`);
  if (!proof.ok) process.exitCode = 1;
}

async function importFixture(root: any, command: any, args: any) {
  const route = command === 'cu' ? '$CU' : '$Computer-Use';
  const { id, dir } = await createMission(root, { mode: 'computer-use', prompt: 'Computer Use fixture evidence import' });
  const evidence = {
    schema: 'sks.computer-use-evidence-ledger.v1',
    generated_at: nowIso(),
    mission_id: id,
    route,
    actions: [{ id: 'action-1', type: 'click', bbox: [0, 0, 1, 1], status: 'mocked', evidence: 'visual-fixture.png' }],
    mock: true
  };
  const captures = {
    schema: 'sks.screen-capture-ledger.v1',
    generated_at: nowIso(),
    mission_id: id,
    captures: [
      { id: 'before', path: `.sneakoscope/missions/${id}/visual-fixture.png`, status: 'mocked' },
      { id: 'after', path: `.sneakoscope/missions/${id}/visual-fixture.png`, status: 'mocked' }
    ],
    mock: true
  };
  await writeJsonAtomic(path.join(dir, 'computer-use-evidence-ledger.json'), evidence);
  await writeJsonAtomic(path.join(dir, 'screen-capture-ledger.json'), captures);
  const gate = {
    schema: 'sks.computer-use-gate.v1',
    schema_version: 1,
    passed: false,
    ok: false,
    status: 'blocked',
    execution_class: 'mock_fixture',
    computer_use_evidence: false,
    screen_capture_evidence: false,
    mock: true,
    blockers: ['computer_use_fixture_mode_cannot_claim_real']
  };
  await writeJsonAtomic(path.join(dir, 'computer-use-gate.json'), gate);
  const proof = await maybeFinalizeRoute(root, {
    missionId: id,
    route,
    gateFile: 'computer-use-gate.json',
    gate,
    mock: true,
    visual: true,
    requireRelation: flag(args, '--fix-claim') || flag(args, '--require-relation'),
    artifacts: ['computer-use-evidence-ledger.json', 'screen-capture-ledger.json', 'image-voxel-ledger.json', 'visual-anchors.json', 'completion-proof.json'],
    claims: [{ id: 'computer-use-import-fixture', status: 'verified_partial' }],
    statusHint: 'blocked',
    blockers: gate.blockers,
    command: { cmd: `sks ${command} import-fixture --mock`, status: 1 }
  });
  const result = { schema: 'sks.computer-use-import-fixture.v1', ok: false, mission_id: id, route, gate, proof: proof.validation };
  process.exitCode = 1;
  if (flag(args, '--json')) return printJson(result);
  console.log(`Computer Use fixture imported: blocked ${id}`);
}

async function evaluateComputerUseGate(root: string, missionId: string) {
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const evidence = await readJson(path.join(dir, 'computer-use-evidence-ledger.json'), null);
  const captures = await readJson(path.join(dir, 'screen-capture-ledger.json'), null);
  const blockers = new Set<string>();
  const actions = Array.isArray(evidence?.actions) ? evidence.actions : [];
  const captureRows = Array.isArray(captures?.captures) ? captures.captures : [];
  if (!actions.length) blockers.add('computer_use_actions_missing');
  if (actions.some((action: any) => action?.status === 'mocked' || action?.mock === true) || evidence?.mock === true) blockers.add('computer_use_mock_actions_not_evidence');
  if (!captureRows.length) blockers.add('screen_capture_evidence_missing');
  for (const capture of captureRows) {
    const rel = String(capture?.path || '');
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || stat.size < 256) blockers.add(`screen_capture_file_missing_or_too_small:${capture?.id || rel || 'unknown'}`);
    if (capture?.status === 'mocked' || capture?.mock === true || captures?.mock === true) blockers.add('screen_capture_mock_not_evidence');
  }
  const passed = blockers.size === 0;
  return {
    schema: 'sks.computer-use-gate.v1',
    schema_version: 1,
    passed,
    ok: passed,
    status: passed ? 'pass' : 'blocked',
    computer_use_evidence: actions.length > 0 && ![...blockers].includes('computer_use_mock_actions_not_evidence'),
    screen_capture_evidence: captureRows.length > 0 && ![...blockers].some((blocker) => blocker.startsWith('screen_capture_')),
    blockers: [...blockers]
  };
}
