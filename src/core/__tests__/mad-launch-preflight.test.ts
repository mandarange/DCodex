import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexLaunchPreflight } from '../preflight/parallel-preflight-engine.js';

test('MAD launch preflight reports the first read-only failure without repeating repair inspection', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-mad-preflight-fast-fail-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const started = performance.now();
  const result = await runCodexLaunchPreflight(root, {
    fix: false,
    launchFast: true,
    writeReport: false
  });
  const durationMs = performance.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.repair, null);
  assert.equal(result.blockers.includes('missing_config') || result.blockers.includes('missing_codex_dir'), true);
  assert.ok(durationMs < 5_000, `read-only failure should fail fast, observed ${Math.round(durationMs)}ms`);
});
