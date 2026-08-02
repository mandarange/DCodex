import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { configureCodexLb } from '../../dist/cli/install-helpers.js';
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../../dist/core/codex-lb/codex-lb-tool-output-recovery.js';

const compatibleRecoveryFetch = async () => new Response('{}', {
  status: 200,
  headers: { 'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION }
});

test('codex-lb launchctl failure is structured and redacted', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-unit-codex-lb-launchctl-'));
  const fakeLaunchctl = path.join(home, 'launchctl');
  await fs.writeFile(fakeLaunchctl, '#!/bin/sh\necho "launchctl denied $3" >&2\nexit 7\n');
  await fs.chmod(fakeLaunchctl, 0o755);
  const result = await configureCodexLb({
    home,
    host: 'lb.example.test',
    apiKey: 'sk-launchctl-secret',
    forceLaunchEnv: true,
    syncLaunchctl: true,
    launchctlBin: fakeLaunchctl,
    platform: 'linux',
    syncCodexLogin: false,
    processEnv: {},
    toolOutputRecoveryFetch: compatibleRecoveryFetch
  });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /sk-launchctl-secret/);
  assert.equal(result.codex_environment.launch_environment.status, 'launch_env_failed');
  assert.equal(result.status, 'partial_configuration_external_state_unknown');
});
