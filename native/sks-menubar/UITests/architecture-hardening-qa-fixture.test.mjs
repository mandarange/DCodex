import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('signed restart fixture separates development and production and records no identity identifier', async () => {
  const fixture = JSON.parse(await fsp.readFile(path.join(here, '..', 'QAFixtures', 'architecture-hardening-restart-matrix.json'), 'utf8'));
  assert.equal(fixture.launch_cycles, 5);
  assert.equal(fixture.signing_domains.find((row) => row.environment === 'development').live_claim_allowed, false);
  assert.equal(fixture.signing_domains.find((row) => row.environment === 'production').identity_kind, 'developer-id-application');
  assert.ok(fixture.prohibited_record_fields.includes('signing_identity_identifier'));
  assert.equal(fixture.scenarios.length, 6);
});

test('signed QA runner refuses to convert an absent signed app into mock evidence', async () => {
  const result = await run(process.execPath, [path.join(here, 'run-signed-restart-qa.mjs')], {
    PATH: process.env.PATH || '/usr/bin:/bin',
    SKS_SIGNED_QA_APPROVED: '0',
    SKS_SIGNED_APP_PATH: '',
    SKS_SIGNED_UI_TEST_XCTESTRUN: '',
    SKS_SIGNING_IDENTITY_KIND: ''
  });
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'not_verified');
  assert.equal(report.reason, 'signed_app_required');
  assert.equal(report.signing_identity_kind, null);
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
  });
}
