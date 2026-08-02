import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureCodexLb } from '../../dist/cli/install-helpers.js';

const compatibleRecoveryFetch = async () => new Response('{}', { status: 200, headers: { 'x-app-version': '1.21.0-beta.3' } });

test('codex-lb fake launchctl syncs only the non-secret base URL', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-lb-launchctl-'));
  const bin = path.join(home, 'launchctl');
  await fs.writeFile(bin, '#!/usr/bin/env sh\nexit 0\n');
  await fs.chmod(bin, 0o755);
  const result = await configureCodexLb({
    home,
    host: 'lb.example.test',
    apiKey: 'sk-clb-launchctl',
    writeEnvFile: true,
    storeKeychain: false,
    syncLaunchctl: true,
    forceLaunchEnv: true,
    launchctlBin: bin,
    platform: 'linux',
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleRecoveryFetch
  });
  assert.equal(result.codex_environment?.launch_environment?.status, 'synced');
  assert.ok(result.persistence?.applied_modes.includes('durable_env_file'));
  assert.equal(result.persistence?.applied_modes.includes('durable_launchctl'), false);
  assert.equal(result.applied_actions?.find((action) => action.type === 'sync_launchctl')?.ok, true);
});
