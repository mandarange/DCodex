import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultDesktopBridgeServiceSettings, readDesktopBridgeServiceSettings, writeDesktopBridgeServiceSettings } from '../desktop-service.js';

test('v2 service settings persist one bridge runtime with registry/policy snapshots and no active provider mode', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-single-runtime-')); t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const settings = defaultDesktopBridgeServiceSettings();
  await writeDesktopBridgeServiceSettings(file, settings);
  const raw = await fsp.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /provider_mode|gateway_auth_transport|gatewayKey|api_key/i);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.schema, 'sks.codex-lb-desktop-bridge-settings.v2');
  assert.equal((parsed.route_policy as Record<string, unknown>).fallback, 'none');
  assert.equal((parsed.route_policy as Record<string, unknown>).default_provider_id, null);
  assert.deepEqual(Object.keys((parsed.provider_registry as { providers: object }).providers).sort(), ['codex-lb', 'openrouter']);
  const loaded = await readDesktopBridgeServiceSettings(file); assert.ok(loaded); assert.equal(loaded.provider_registry.providers['codex-lb'].provider_id, 'codex-lb');
  assert.equal(loaded.provider_registry.providers['codex-lb'].enabled, false);
  assert.equal(loaded.provider_registry.providers.openrouter.enabled, false);
});
