import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkHarnessModification,
  classifyHarnessPayload,
  harnessGuardBlockReason
} from '../../dist/core/harness-guard.js';

const policy = {
  enabled: true,
  locked: true,
  engine_source_exception: false,
  protected_files: ['.codex/config.toml', '.sneakoscope/harness-guard.json'],
  protected_dirs: ['.agents/skills', '.codex/agents']
};

test('harness guard allows deleting mission artifacts even when their content mentions package manifests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-harness-mission-'));
  const payload = {
    tool_name: 'apply_patch',
    command: `*** Begin Patch
*** Delete File: .sneakoscope/missions/M-fixture/agents/agent-proof-evidence.json
-{"command":"npm publish ./repo --ignore-scripts --dry-run","path":"package.json","package":"sneakoscope@4.7.0",".codex/config.toml":"mentioned as evidence only"}
*** End Patch`
  };

  const classified = classifyHarnessPayload(root, payload, policy);
  assert.equal(classified.writeIntent, true);
  assert.equal(classified.block, false);
  assert.deepEqual(classified.reasons, []);
});

test('harness guard still blocks actual Sneakoscope package manifest edits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-harness-package-'));
  const payload = {
    tool_name: 'apply_patch',
    command: `*** Begin Patch
*** Update File: package.json
@@
-  "name": "sneakoscope",
+  "name": "sneakoscope",
*** End Patch`
  };

  const classified = classifyHarnessPayload(root, payload, policy);
  assert.equal(classified.block, true);
  assert.ok(classified.reasons.includes('package_manifest_sneakoscope_edit_blocked'));
});

test('harness guard blocks protected harness target paths but not runtime mission paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-harness-target-'));

  const protectedTarget = classifyHarnessPayload(root, {
    tool_name: 'apply_patch',
    command: `*** Begin Patch
*** Update File: .codex/config.toml
@@
-model = "old"
+model = "new"
*** End Patch`
  }, policy);
  assert.equal(protectedTarget.block, true);
  assert.ok(protectedTarget.matches.includes('.codex/config.toml'));

  const missionTarget = classifyHarnessPayload(root, {
    tool_name: 'shell',
    command: 'rm -rf .sneakoscope/missions/M-fixture'
  }, policy);
  assert.equal(missionTarget.writeIntent, true);
  assert.equal(missionTarget.block, false);
});

test('harness guard classifies sks doctor --fix as blocked maintenance', () => {
  const root = '/tmp/sks-harness-doctor-classify';
  const classified = classifyHarnessPayload(root, {
    tool_name: 'Shell',
    command: 'sks doctor --fix'
  }, policy);
  assert.equal(classified.block, true);
  assert.ok(classified.reasons.includes('sks_doctor_fix_blocked'));
  assert.match(harnessGuardBlockReason({ reasons: ['sks_doctor_fix_blocked'] }), /Ask the user to run `sks doctor --fix`/);
});

test('harness guard blocks sks doctor --fix even under engine source exception', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-harness-doctor-engine-'));
  await fs.mkdir(path.join(root, '.sneakoscope'), { recursive: true });
  await fs.writeFile(path.join(root, '.sneakoscope', 'harness-guard.json'), JSON.stringify({
    schema_version: 1,
    enabled: true,
    locked: false,
    engine_source_exception: true,
    fingerprints: {}
  }));

  const blocked = await checkHarnessModification(root, {
    tool_name: 'Shell',
    command: 'cd /tmp && sks doctor --fix --json'
  });
  assert.equal(blocked.action, 'block');
  assert.deepEqual(blocked.reasons, ['sks_doctor_fix_blocked']);

  const allowedRead = await checkHarnessModification(root, {
    tool_name: 'Shell',
    command: 'sks doctor --json'
  });
  assert.equal(allowedRead.action, 'allow');
});
