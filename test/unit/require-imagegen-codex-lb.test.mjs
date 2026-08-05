import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { requireCodexImagegen } from '../../dist/core/imagegen/require-imagegen.js';
import { measureAndWriteCodexLbRoutingTruth } from '../../dist/core/codex-lb/routing-truth.js';

test('selected ready codex-lb satisfies real UX and PPT imagegen preflight without repair', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-codex-lb-preflight-'));
  const codexHome = path.join(root, 'custom-codex-home');
  const apiKey = 'test-key';
  const baseUrl = 'https://codex.hyper-lab.xyz/backend-api/codex';
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false'
  ].join('\n'));
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    `export CODEX_LB_BASE_URL='${baseUrl}'`,
    `export CODEX_LB_API_KEY='${apiKey}'`
  ].join('\n'), { mode: 0o600 });
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.json'), JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    api_key: { sha256: createHash('sha256').update(apiKey).digest('hex') }
  }), { mode: 0o600 });
  await measureAndWriteCodexLbRoutingTruth({
    selected: true,
    baseUrl,
    apiKey,
    authTransport: 'authorization-bearer',
    fetchImpl: async () => new Response('{"data":[]}', { status: 200 })
  }, {
    receiptPath: path.join(codexHome, 'sks-codex-lb-routing-truth.json')
  });

  const result = await requireCodexImagegen(root, {
    autoRepair: true,
    applyRepair: true,
    codexBin: path.join(root, 'missing-codex'),
    home: root,
    env: { HOME: root, CODEX_HOME: codexHome }
  });

  assert.equal(result.ok, true);
  assert.equal(result.preflight_ready, true);
  assert.equal(result.preflight_provider, 'codex_lb');
  assert.equal(result.capability.core_ready, false);
  assert.equal(result.capability.codex_lb.selected, true);
  assert.equal(result.capability.codex_lb.available, true);
  assert.equal(result.capability.codex_lb.routing_active, true);
  assert.equal(result.capability.codex_lb.routing_truth.measured, true);
  assert.equal(result.capability.codex_lb.routing_truth.fresh, true);
  assert.equal(result.repair, null);
  assert.deepEqual(result.blockers, []);
});
