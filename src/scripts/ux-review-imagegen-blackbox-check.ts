#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { osTempPngFixtureArg } from './lib/valid-png-fixture.js';

const repoRoot = process.cwd();
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-ux-review-imagegen-blackbox-'));
const sksBin = path.join(repoRoot, 'dist', 'bin', 'sks.js');
const sourceImage = osTempPngFixtureArg('ux-review-imagegen-blackbox-source.png');
const run = spawnSync(process.execPath, [sksBin, 'ux-review', 'run', '--image', sourceImage, '--mock', '--json'], {
  cwd: runRoot,
  env: { ...process.env, SKS_TEST_FAKE_IMAGEGEN: '1', SKS_TEST_FAKE_EXTRACTOR: '1', SKS_MOCK: '1', NODE_ENV: 'test', SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_SKIP_NPM_FRESHNESS_CHECK: '1' },
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024
});
const parsed = parseJson(run.stdout);
const missionDir = parsed?.mission_id ? path.join(runRoot, '.sneakoscope', 'missions', parsed.mission_id) : null;
const request = missionDir ? readJson(path.join(missionDir, 'image-ux-gpt-image-2-request.json')) : null;
const response = missionDir ? readJson(path.join(missionDir, 'image-ux-gpt-image-2-response.json')) : null;
const issues = missionDir ? readJson(path.join(missionDir, 'image-ux-issue-ledger.json')) : null;
const generated = missionDir ? readJson(path.join(missionDir, 'image-ux-generated-review-ledger.json')) : null;
const extraction = missionDir ? readJson(path.join(missionDir, 'image-ux-callout-extraction-report.json')) : null;
const uxReport = missionDir ? readJson(path.join(missionDir, 'image-ux-iteration-report.json')) : null;
const proof = missionDir ? readJson(path.join(missionDir, 'completion-proof.json')) : null;
const ok = Boolean(parsed?.mission_id)
  && [0, 1].includes(run.status)
  && ['blocked', 'verified_partial_reference'].includes(parsed?.status)
  && request?.validation?.ok === true
  && /senior Toss UI\/UX product designer/.test(request?.prompt || '')
  && /P0\/P1\/P2\/P3/.test(request?.prompt || '')
  && /visual hierarchy/.test(request?.prompt || '')
  && /contrast/.test(request?.prompt || '')
  && /density/.test(request?.prompt || '')
  && /affordance/.test(request?.prompt || '')
  && /eye-flow arrows/.test(request?.prompt || '')
  && /corrected mini-comp/.test(request?.prompt || '')
  && response?.evidence_class === 'mock_fixture'
  && generated?.generated_count === 1
  && generated?.real_generated_count === 0
  && generated?.non_real_generated_count === 1
  && generated?.generated_review_images?.[0]?.mock === true
  && generated?.generated_review_images?.[0]?.callout_extraction_status === 'succeeded'
  && Array.isArray(issues?.issues)
  && issues.issues.length > 0
  && issues.issues.every((issue) => issue.source === 'mock_fixture')
  && issues.issues.every((issue) => issue.generated_review_image_id === generated.generated_review_images[0].id)
  && issues.issues.every((issue) => issue.generated_image_sha256 === generated.generated_review_images[0].sha256)
  && extraction?.analysis_input === 'generated_annotated_review_image'
  && extraction?.source_screenshot_used_for_extraction === false
  && extraction?.generated_image_id === generated.generated_review_images[0].id
  && extraction?.generated_image_sha256 === generated.generated_review_images[0].sha256
  && response?.generated_review_image_id === generated.generated_review_images[0].id
  && uxReport?.report_type === 'ux_ui_change_report'
  && uxReport?.analysis_basis?.primary_evidence === 'generated_annotated_review_image'
  && uxReport?.analysis_basis?.based_on_generated_image === true
  && uxReport?.recommendations?.length === issues.issues.length
  && ['mock_only', 'verified_partial'].includes(proof?.status)
  && proof?.evidence?.image_ux_review?.reference_only === true
  && proof?.evidence?.image_ux_review?.generated_gpt_image_2_callout_images_count === 0;
console.log(JSON.stringify({
  schema: 'sks.ux-review-imagegen-blackbox-check.v1',
  ok,
  process_status: run.status,
  mission_id: parsed?.mission_id || null,
  gate_status: parsed?.status || null,
  run_root: runRoot,
  proof_status: proof?.status || null,
  reference_only: proof?.evidence?.image_ux_review?.reference_only === true,
  source_image: sourceImage,
  request,
  response,
  extraction,
  ux_report: uxReport,
  issue_count: issues?.issues?.length || 0
}, null, 2));
if (!ok) process.exitCode = 1;

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
