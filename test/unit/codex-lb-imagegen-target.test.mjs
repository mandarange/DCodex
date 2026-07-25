import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
