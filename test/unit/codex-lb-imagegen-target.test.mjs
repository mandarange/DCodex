import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexLbImagegenTarget } from '../../dist/core/imagegen/codex-lb-imagegen-target.js';

async function codexHome(configModel) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-imagegen-'));
  const catalog = path.join(home, '.codex', 'sks-codex-lb-tool-catalog.json');
  await fs.mkdir(path.dirname(catalog), { recursive: true });
  await fs.writeFile(catalog, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.5' }] }));
  const configText = [
    'model_provider = "codex-lb"',
    `model_catalog_json = "${catalog}"`,
    `model = "${configModel}"`
  ].join('\n');
  return { home, configText };
}

// The proxy answers 403 model_not_allowed for a slug the codex-lb key cannot
// use, so config.toml's `model` is only usable when the served catalog lists it.
test('a configured model outside the served catalog falls back to a catalog slug', async () => {
  const { home, configText } = await codexHome('moonshotai/kimi-k3');
  const target = await resolveCodexLbImagegenTarget({ home, configText, env: { HOME: home } });
  assert.equal(target.selected, true);
  assert.equal(target.model, 'gpt-5.6-sol');
  assert.equal(target.model_source, 'catalog_default');
});

test('a configured model that the catalog serves is kept', async () => {
  const { home, configText } = await codexHome('gpt-5.5');
  const target = await resolveCodexLbImagegenTarget({ home, configText, env: { HOME: home } });
  assert.equal(target.model, 'gpt-5.5');
  assert.equal(target.model_source, 'configured_model_in_catalog');
});

test('an explicit override wins over the catalog', async () => {
  const { home, configText } = await codexHome('gpt-5.5');
  const target = await resolveCodexLbImagegenTarget({
    home,
    configText,
    env: { HOME: home, SKS_IMAGEGEN_RESPONSES_MODEL: 'gpt-5.6-luna' }
  });
  assert.equal(target.model, 'gpt-5.6-luna');
  assert.equal(target.model_source, 'explicit');
});

test('a generic OPENAI_MODEL does not override the selected codex-lb catalog', async () => {
  const { home, configText } = await codexHome('gpt-5.5');
  const target = await resolveCodexLbImagegenTarget({
    home,
    configText,
    env: { HOME: home, OPENAI_MODEL: 'disallowed/model' }
  });
  assert.equal(target.model, 'gpt-5.5');
  assert.equal(target.model_source, 'configured_model_in_catalog');
});

test('a provider other than codex-lb is reported as not selected', async () => {
  const { home } = await codexHome('gpt-5.5');
  const target = await resolveCodexLbImagegenTarget({
    home,
    configText: 'model_provider = "openai"\n',
    env: { HOME: home }
  });
  assert.equal(target.selected, false);
  assert.equal(target.blocker, 'codex_lb_not_selected');
});

test('target discovery reads config, credentials, and catalog from CODEX_HOME', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-home-'));
  const codexHome = path.join(home, 'custom-codex-home');
  const apiKey = 'test-key';
  const baseUrl = 'https://codex.hyper-lab.xyz/backend-api/codex';
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    'model = "gpt-5.6-terra"',
    '',
    '[model_providers.codex-lb]',
    `base_url = "${baseUrl}"`,
    'env_key = "CODEX_LB_API_KEY"',
    'requires_openai_auth = true'
  ].join('\n'));
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb-tool-catalog.json'), JSON.stringify({
    models: [{ slug: 'gpt-5.6-terra' }]
  }));
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    `export CODEX_LB_BASE_URL='${baseUrl}'`,
    `export CODEX_LB_API_KEY='${apiKey}'`
  ].join('\n'));
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.json'), JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    api_key: { sha256: createHash('sha256').update(apiKey).digest('hex') }
  }));

  const target = await resolveCodexLbImagegenTarget({
    env: { HOME: home, CODEX_HOME: codexHome }
  });
  assert.equal(target.selected, true);
  assert.equal(target.blocker, null);
  assert.equal(target.base_url, baseUrl);
  assert.equal(target.api_key, apiKey);
  assert.equal(target.model, 'gpt-5.6-terra');
});
