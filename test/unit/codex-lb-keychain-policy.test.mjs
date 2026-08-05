import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodexLbEnv } from '../../dist/core/codex-lb/codex-lb-env.js';

test('codex-lb env loader reports an honest missing key without using Keychain', async () => {
  const previousKey = process.env.CODEX_LB_API_KEY;
  const previousBase = process.env.CODEX_LB_BASE_URL;
  delete process.env.CODEX_LB_API_KEY;
  delete process.env.CODEX_LB_BASE_URL;
  let result;
  try {
    result = await loadCodexLbEnv({
      forceMacos: true,
      securityBin: '/bin/false',
      home: '/tmp/sks-keychain-policy-home'
    });
  } finally {
    if (previousKey === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.CODEX_LB_BASE_URL;
    else process.env.CODEX_LB_BASE_URL = previousBase;
  }
  assert.equal(result.schema, 'sks.codex-lb-env.v1');
  assert.equal(result.keychain.checked, false);
  assert.equal(result.keychain.available, false);
  assert.equal(result.keychain.status, 'not_used');
  assert.equal(result.api_key.redacted, true);
  assert.equal(result.secret_api_key, null);
  assert.ok(result.credential_binding.blockers.includes('codex_lb_api_key_missing'));
  assert.match(result.guidance.join('\n'), /sks bridge provider configure codex-lb --host <host> --api-key-stdin --json/);
  assert.doesNotMatch(result.guidance.join('\n'), /sks codex-lb setup/);
});
