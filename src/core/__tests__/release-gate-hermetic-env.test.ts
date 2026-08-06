import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  cleanupReleaseGateHermeticEnv,
  createReleaseGateHermeticEnv
} from '../release/release-gate-hermetic-env.js';
import type { ReleaseGateNode } from '../release/release-gate-node.js';

function gate(id: string): ReleaseGateNode {
  return {
    id,
    command: 'true',
    deps: [],
    resource: ['cpu-light', 'fs-read'],
    side_effect: 'hermetic',
    timeout_ms: 1_000,
    output_contract: 'sks.gate-result.v2',
    cache: { enabled: false, inputs: [] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release']
  };
}

test('current-surface migration E2E explicitly removes an inherited migration-disable flag', () => {
  const previous = process.env.SKS_UPDATE_MIGRATION_GATE_DISABLED;
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-gate-env-test-'));
  process.env.SKS_UPDATE_MIGRATION_GATE_DISABLED = '1';
  const migration = createReleaseGateHermeticEnv({
    root: process.cwd(),
    runId: `migration-env-${process.pid}`,
    gate: gate('migration:current-surface-e2e'),
    reportRoot
  });
  const ordinary = createReleaseGateHermeticEnv({
    root: process.cwd(),
    runId: `ordinary-env-${process.pid}`,
    gate: gate('ordinary:gate'),
    reportRoot
  });
  let directScratch = '';
  try {
    assert.equal(migration.env.SKS_UPDATE_MIGRATION_GATE_DISABLED, undefined);
    assert.equal(ordinary.env.SKS_UPDATE_MIGRATION_GATE_DISABLED, '1');
    for (const key of ['SKS_TMP_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const) {
      assert.equal(migration.env[key], migration.tmp_dir);
      assert.equal(ordinary.env[key], ordinary.tmp_dir);
    }
    const direct = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-os-tmp-')));
    `], { env: migration.env, encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    directScratch = direct.stdout.trim();
    assert.ok(directScratch.startsWith(`${migration.tmp_dir}${path.sep}`));
    assert.equal(fs.existsSync(directScratch), true);
  } finally {
    cleanupReleaseGateHermeticEnv(migration);
    cleanupReleaseGateHermeticEnv(ordinary);
    fs.rmSync(reportRoot, { recursive: true, force: true });
    if (previous === undefined) delete process.env.SKS_UPDATE_MIGRATION_GATE_DISABLED;
    else process.env.SKS_UPDATE_MIGRATION_GATE_DISABLED = previous;
  }
  assert.equal(fs.existsSync(directScratch), false);
});
