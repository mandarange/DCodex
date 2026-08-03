#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '..', 'QAFixtures', 'architecture-hardening-restart-matrix.json');
const fixture = JSON.parse(await fsp.readFile(fixturePath, 'utf8'));
validateFixture(fixture);

const appPath = String(process.env.SKS_SIGNED_APP_PATH || '').trim();
const xctestrun = String(process.env.SKS_SIGNED_UI_TEST_XCTESTRUN || '').trim();
const approved = process.env.SKS_SIGNED_QA_APPROVED === '1';
const identityKind = String(process.env.SKS_SIGNING_IDENTITY_KIND || '').trim();
const SIGNED_QA_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

if (!appPath) finish({ status: 'not_verified', reason: 'signed_app_required', signing_identity_kind: null });
if (!approved) finish({ status: 'not_verified', reason: 'signed_app_qa_approval_required', signing_identity_kind: identityKind || null });
if (identityKind !== 'developer-id-application') {
  finish({ status: 'not_verified', reason: 'production_signing_kind_required', signing_identity_kind: identityKind || null });
}
if (!xctestrun) finish({ status: 'not_verified', reason: 'signed_ui_test_bundle_required', signing_identity_kind: identityKind });

const [appStat, testStat] = await Promise.all([fsp.stat(appPath).catch(() => null), fsp.stat(xctestrun).catch(() => null)]);
if (!appStat?.isDirectory()) finish({ status: 'failed', reason: 'signed_app_path_invalid', signing_identity_kind: identityKind }, 1);
if (!testStat?.isFile()) finish({ status: 'failed', reason: 'signed_ui_test_bundle_invalid', signing_identity_kind: identityKind }, 1);

const signature = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], safeEnv());
if (signature.code !== 0) finish({ status: 'failed', reason: 'signed_app_verification_failed', signing_identity_kind: identityKind }, 1);

const qaHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-signed-ui-qa-'));
try {
  const result = await run('/usr/bin/xcodebuild', [
    'test-without-building',
    '-xctestrun', xctestrun,
    '-only-testing:ArchitectureHardeningRestartQATests'
  ], {
    ...safeEnv(),
    HOME: qaHome,
    SKS_SIGNED_QA_APPROVED: '1',
    SKS_SIGNED_APP_PATH: appPath
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/credential|api[_ -]?key|account[_ -]?identifier|fingerprint/i.test(combined)) {
    finish({ status: 'failed', reason: 'qa_output_sensitive_field_detected', signing_identity_kind: identityKind }, 1);
  }
  finish({
    status: result.code === 0 ? 'verified' : 'failed',
    reason: result.code === 0 ? null : 'signed_ui_test_failed',
    signing_identity_kind: identityKind,
    launch_cycles: fixture.launch_cycles,
    scenarios_checked: fixture.scenarios.map((scenario) => scenario.id)
  }, result.code === 0 ? 0 : 1);
} finally {
  await fsp.rm(qaHome, { recursive: true, force: true });
}

function validateFixture(value) {
  if (value?.schema !== 'sks.menubar-signed-restart-qa.v1') throw new Error('signed_qa_fixture_schema_invalid');
  if (!Number.isInteger(value.launch_cycles) || value.launch_cycles < 3) throw new Error('signed_qa_launch_cycles_invalid');
  if (!Array.isArray(value.signing_domains) || !value.signing_domains.some((row) => row.environment === 'production' && row.identity_kind === 'developer-id-application')) {
    throw new Error('signed_qa_production_domain_missing');
  }
  const scenarioIds = new Set((value.scenarios || []).map((scenario) => scenario.id));
  for (const required of ['explicit-connect-then-relaunch', 'credential-deleted', 'credential-damaged', 'keychain-locked', 'signing-mismatch', 'offline-proxy-catalog-save-failure']) {
    if (!scenarioIds.has(required)) throw new Error(`signed_qa_scenario_missing:${required}`);
  }
  const prohibited = new Set(value.prohibited_record_fields || []);
  for (const field of ['signing_identity_identifier', 'account_identifier', 'credential', 'credential_fingerprint']) {
    if (!prohibited.has(field)) throw new Error(`signed_qa_prohibited_field_missing:${field}`);
  }
}

function safeEnv() {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'en_US.UTF-8' };
}

function run(command, args, env) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const finishRun = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finishRun({ code: 124, stdout, stderr: `${stderr}\nsigned_qa_process_timeout` });
    }, SIGNED_QA_PROCESS_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', () => finishRun({ code: 127, stdout: '', stderr: '' }));
    child.once('close', (code) => finishRun({ code: code ?? 1, stdout, stderr }));
  });
}

function finish(result, code = 0) {
  process.stdout.write(`${JSON.stringify({ schema: 'sks.menubar-signed-restart-qa-result.v1', ...result }, null, 2)}\n`);
  process.exit(code);
}
