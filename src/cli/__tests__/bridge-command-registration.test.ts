import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_MANIFEST_BY_NAME } from '../command-manifest-lite.js';
import { COMMANDS } from '../command-registry.js';

test('bridge is registered with JSON support and rich non-secret help', async () => {
  const manifest = COMMAND_MANIFEST_BY_NAME.bridge;
  assert.equal(manifest.summary, 'Manage the single Desktop Bridge runtime, provider profiles, catalog, and routes');
  assert.equal(manifest.supportsJson, true);
  assert.equal(manifest.remoteAllowed, false);
  assert.equal(manifest.risk, 'R3');
  assert.equal(COMMANDS.bridge.packageRequiredFiles[0], 'dist/commands/bridge.js');

  const module = await COMMANDS.bridge.lazy();
  const help = module.usage?.('bridge') || '';
  assert.match(help, /provider configure codex-lb --host <host> --api-key-stdin/);
  assert.match(help, /verify --level shallow\|transport\|deep/);
  assert.match(help, /unmanage --confirm/);
  assert.doesNotMatch(help, /--api-key <|desktop-native-bridge|cli-provider/);

  assert.equal('codex-lb' in COMMAND_MANIFEST_BY_NAME, false);
  assert.equal('codex-lb' in COMMANDS, false);
});
