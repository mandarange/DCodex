import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../dist/core/fsx.js';

test('Computer Use status output avoids MAD-SKS safety-block wording', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-computer-use-status-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "sentinel-provider"\n');
  const entry = path.join(process.cwd(), 'dist', 'bin', 'sks.js');
  const result = await runProcess(process.execPath, [entry, 'computer-use', 'status', '--json'], {
    env: { ...process.env, CI: 'true', HOME: home, CODEX_HOME: codexHome },
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const text = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(text, /Computer Use blocked by safety policy|MAD-SKS disabled Computer Use|안전 정책상 차단/i);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.status, 'codex_app_capability_missing');
  assert.equal(json.mad_sks_independent, true);
});
