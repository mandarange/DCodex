#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { osTempPngFixtureArg } from './lib/valid-png-fixture.js';

const enabled = process.env.SKS_TEST_REAL_IMAGEGEN === '1' || process.env.SKS_REAL_IMAGEGEN === '1';
const reportDir = path.join(process.cwd(), '.sneakoscope', 'reports');
const out = path.join(reportDir, 'real-imagegen-smoke.json');
fs.mkdirSync(reportDir, { recursive: true });
function writeReport(report) {
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
function parseUxReviewJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {}
  }
  return null;
}
function missionIdFromRun(stdout, parsed) {
  const direct = parsed?.mission_id || parsed?.mission?.mission_id || parsed?.mission?.id || parsed?.contract?.mission_id || null;
  if (direct) return String(direct);
  const matches = String(stdout || '').match(/M-\d{8}-\d{6}-[a-f0-9]+/g);
  return matches?.length ? matches[matches.length - 1] : null;
}
function readJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function imagegenRequestEvidence(missionId) {
  if (!missionId) return { request_artifact: null, response_artifact: null, request: null, response: null };
  const missionRoot = path.join(process.cwd(), '.sneakoscope', 'missions', missionId);
  const requestCandidates = [
    path.join(missionRoot, 'generated-callouts', 'image-ux-gpt-image-2-request.json'),
    path.join(missionRoot, 'image-ux-gpt-image-2-request.json')
  ];
  const requestArtifact = requestCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  const responseArtifact = requestArtifact
    ? requestArtifact.replace(/request\.json$/, 'response.json')
    : null;
  return {
    request_artifact: requestArtifact,
    response_artifact: responseArtifact && fs.existsSync(responseArtifact) ? responseArtifact : null,
    request: readJsonIfExists(requestArtifact),
    response: readJsonIfExists(responseArtifact)
  };
}
function verifiedGeneratedOutput(response) {
  const outputPath = response?.output_image_path ? path.resolve(String(response.output_image_path)) : null;
  const exists = Boolean(outputPath && fs.existsSync(outputPath));
  const fake = response?.fake_adapter === true || response?.mock === true || response?.provider === 'fake_imagegen_adapter';
  return {
    output_image_path: outputPath,
    output_image_exists: exists,
    output_image_sha256: response?.output_image_sha256 || null,
    output_dimensions: response?.dimensions || null,
    provider: response?.provider || null,
    response_ok: response?.ok === true,
    response_status: response?.status || null,
    fake_adapter: fake,
    real_generated_output_verified: response?.ok === true && response?.status === 'generated' && exists && !fake
  };
}
if (!enabled) {
  const skipped = {
    schema: 'sks.imagegen-real-smoke.v1',
    ok: true,
    status: 'skipped',
    reason: 'Set SKS_TEST_REAL_IMAGEGEN=1 with OPENAI_API_KEY or Codex App imagegen output to run live smoke.',
    compatibility_env_alias: 'SKS_REAL_IMAGEGEN=1',
    release_gate: 'release:real-check_only',
    request_validator_checked: false,
    input_fidelity_present: false,
    local_only_artifact_policy: true
  };
  writeReport(skipped);
  console.log(JSON.stringify(skipped, null, 2));
  process.exit(0);
}
const started = Date.now();
const sourceImage = osTempPngFixtureArg('imagegen-real-smoke-source.png');
const run = spawnSync(process.execPath, ['./dist/bin/sks.js', 'ux-review', 'run', '--image', sourceImage, '--generate-callouts', '--fix', '--json'], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
  timeout: Number(process.env.SKS_IMAGEGEN_SMOKE_TIMEOUT_MS || 180000),
  maxBuffer: 8 * 1024 * 1024
});
const parsed = parseUxReviewJson(run.stdout);
const missionId = missionIdFromRun(run.stdout, parsed);
const evidence = imagegenRequestEvidence(missionId);
const inputFidelityPresent = evidence.request?.validation?.params_checked?.input_fidelity_present === true;
const generatedOutput = verifiedGeneratedOutput(evidence.response);
const report = {
  schema: 'sks.imagegen-real-smoke.v1',
  ok: run.status === 0 && generatedOutput.real_generated_output_verified === true,
  status: run.status === 0 && generatedOutput.real_generated_output_verified === true ? 'passed' : 'blocked',
  env_flag: 'SKS_TEST_REAL_IMAGEGEN',
  mission_id: missionId,
  latency_ms: Date.now() - started,
  cost: 'not_reported_by_adapter',
  source_image: sourceImage,
  request_validator_checked: Boolean(evidence.request?.validation),
  request_artifact: evidence.request_artifact,
  response_artifact: evidence.response_artifact,
  imagegen_provider: evidence.request?.provider || evidence.response?.provider || null,
  imagegen_blocker: evidence.response?.blocker || null,
  generated_output: generatedOutput,
  process_error: run.error?.message || null,
  process_signal: run.signal || null,
  input_fidelity_present: inputFidelityPresent,
  local_only_artifact_policy: true,
  stdout_tail: run.stdout.slice(-4000),
  stderr_tail: run.stderr.slice(-4000)
};
if (run.status === 0 && !generatedOutput.real_generated_output_verified) {
  report.blocker = generatedOutput.fake_adapter
    ? 'fake_imagegen_output_not_real_smoke'
    : generatedOutput.output_image_exists
      ? 'generated_output_not_marked_real'
      : 'generated_output_file_missing';
}
if (report.input_fidelity_present) {
  report.ok = false;
  report.status = 'blocked';
  report.blocker = 'input_fidelity_must_not_be_sent_for_gpt_image_2';
}
writeReport(report);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
