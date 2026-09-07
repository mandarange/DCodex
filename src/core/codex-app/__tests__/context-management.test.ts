import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { setContextManagement } from '../../codex/context-management.js';
import { normalizeCodexFastModeUiConfig } from '../../codex-runtime/codex-desktop-config-policy.js';
import { contextManagementCommand } from '../context-management-command.js';

test('global setup seeds context management once and preserves explicit disable', () => {
  const first = normalizeCodexFastModeUiConfig('model = "gpt-6-astra"\n');
  assert.equal((parse(first) as any).features.context_management.experimental_mode, true);
  const off = setContextManagement(first, false);
  assert.equal((parse(normalizeCodexFastModeUiConfig(off)) as any).features.context_management.experimental_mode, false);
  assert.equal(normalizeCodexFastModeUiConfig(first), first);
});

test('validated edits preserve comments and support table, dotted, and inline existing values', () => {
  for (const text of [
    '# keep\n[features.context_management]\nexperimental_mode = false # choice\n',
    '# keep\n[features]\ncontext_management.experimental_mode = false\n',
    '# keep\nfeatures = { context_management = { experimental_mode = false } }\n',
  ]) {
    assert.equal(setContextManagement(text, true), text.replace('false', 'true'));
    assert.equal(setContextManagement(text, true, true), text);
  }
  assert.throws(() => setContextManagement('[bad', true));
  for (const text of ['features = {}', '[features]\ncontext_management = {}', '[features.context_management]\n']) {
    assert.equal((parse(setContextManagement(text, true)) as any).features.context_management.experimental_mode, true);
  }
  assert.throws(() => setContextManagement('[features.context_management]\nexperimental_mode = "false"', true));
});

test('command writes, reads back, disables persistently, and rejects malformed config', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context-management-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, env: { HOME: home, CODEX_HOME: path.join(home, '.codex') } };
  assert.equal((await contextManagementCommand(['on'], options)).enabled, true);
  assert.equal((await contextManagementCommand(['status'], options)).enabled, true);
  assert.equal((await contextManagementCommand(['off'], options)).enabled, false);
  const file = path.join(home, '.codex/config.toml');
  await fs.writeFile(file, '[broken');
  assert.equal((await contextManagementCommand(['on'], options)).ok, false);
  assert.equal(await fs.readFile(file, 'utf8'), '[broken');
});
