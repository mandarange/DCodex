import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureCodexLb } from '../../dist/cli/install-helpers.js';

const compatibleRecoveryFetch = async () => new Response('{}', { status: 200, headers: { 'x-app-version': '1.21.0-beta.3' } });

test('an identity-verified Keychain helper can supplement the required owner-only env file', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-lb-keychain-helper-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const apiKey = 'sk-clb-keychain';
  const result = await configureCodexLb({
    home,
    platform: 'linux',
    host: 'lb.example.test',
    apiKey,
    writeEnvFile: true,
    storeKeychain: true,
    keychain: true,
    keychainStoreImpl: async (receivedKey) => ({
      ok: receivedKey === apiKey,
      status: 'stored',
      keychain_state_verified: true,
      keychain_state_status: 'replacement_verified_by_helper'
    }),
    syncLaunchctl: false,
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleRecoveryFetch
  });
  assert.equal(result.keychain?.ok, true);
  assert.ok(result.persistence?.applied_modes.includes('durable_keychain'));
  assert.ok(result.persistence?.applied_modes.includes('durable_env_file'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
});
