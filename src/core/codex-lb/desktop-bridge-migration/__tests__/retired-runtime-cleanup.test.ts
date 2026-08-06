import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultDesktopBridgeServiceSettings } from '../../desktop-service.js';
import {
  cleanupRetiredDesktopBridgeRuntime,
  prepareRetiredDesktopBridgeRuntime,
} from '../retired-runtime-cleanup.js';

const RETIRED_LABEL = ['com.sneakoscope', 'codex-lb-desktop-bridge'].join('.');

function processResult(code: number) {
  return { code, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false };
}

async function retiredFixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retired-bridge-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const runtime = path.join(home, '.codex', 'sks');
  const logs = path.join(runtime, 'logs');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  await Promise.all([
    fsp.mkdir(logs, { recursive: true }),
    fsp.mkdir(launchAgents, { recursive: true }),
  ]);
  const current = defaultDesktopBridgeServiceSettings({ listen_port: 54_321 });
  const settings = path.join(runtime, 'codex-lb-desktop-bridge-settings.json');
  const state = path.join(runtime, 'codex-lb-desktop-bridge.json');
  const plist = path.join(launchAgents, `${RETIRED_LABEL}.plist`);
  const stdout = path.join(logs, 'codex-lb-desktop-bridge.out.log');
  const stderr = path.join(logs, 'codex-lb-desktop-bridge.err.log');
  await Promise.all([
    fsp.writeFile(settings, `${JSON.stringify({ ...current, schema: 'sks.codex-lb-desktop-bridge-settings.v2' })}\n`, { mode: 0o600 }),
    fsp.writeFile(state, '{"schema":"sks.codex-lb-desktop-bridge.v2"}\n', { mode: 0o600 }),
    fsp.writeFile(plist, `<plist><string>${RETIRED_LABEL}</string></plist>\n`, { mode: 0o600 }),
    fsp.writeFile(stdout, '', { mode: 0o600 }),
    fsp.writeFile(stderr, '', { mode: 0o600 }),
  ]);
  return { home, files: [settings, state, plist, stdout, stderr] };
}

test('installed provider-branded bridge is booted out before settings import and owned artifact removal', async (t) => {
  const fixture = await retiredFixture(t);
  const calls: string[][] = [];
  let loaded = true;
  const run = async (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'bootout') { loaded = false; return processResult(0); }
    if (args[0] === 'print') return processResult(loaded ? 0 : 1);
    return processResult(1);
  };
  const prepared = await prepareRetiredDesktopBridgeRuntime({ home: fixture.home, uid: 501, run });
  assert.equal(prepared.present, true);
  assert.equal(prepared.settings?.listen_port, 54_321);
  assert.deepEqual(calls.map((args) => args[0]), ['print', 'bootout', 'print']);
  assert.ok(calls.every((args) => args.join(' ').includes(RETIRED_LABEL)));
  await cleanupRetiredDesktopBridgeRuntime(prepared);
  for (const file of fixture.files) await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
});

test('retired bridge cleanup fails stopped while launchd still reports the old job loaded', async (t) => {
  const fixture = await retiredFixture(t);
  const run = async () => processResult(0);
  await assert.rejects(
    prepareRetiredDesktopBridgeRuntime({ home: fixture.home, uid: 501, run }),
    /desktop_bridge_retired_launchd_still_loaded/,
  );
  for (const file of fixture.files) assert.equal((await fsp.stat(file)).isFile(), true);
});
