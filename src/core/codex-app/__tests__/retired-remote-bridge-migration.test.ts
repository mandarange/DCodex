import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupRetiredRemoteBridgeLaunchAgent,
  isManagedRetiredRemoteBridgeLaunchAgent,
  quarantineRetiredRemoteBridgeBindings
} from '../menubar/migration.js';
import { sha256 } from '../../fsx.js';

const LABEL = 'com.sneakoscope.telegram-hub';

test('retired remote bridge cleanup removes only the verified SKS LaunchAgent', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retired-remote-bridge-'));
  const launchAgent = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const calls: string[][] = [];
  await fsp.mkdir(path.dirname(launchAgent), { recursive: true });
  await fsp.writeFile(launchAgent, managedLaunchAgent(), 'utf8');

  const result = await cleanupRetiredRemoteBridgeLaunchAgent({
    home,
    force: true,
    uid: 501,
    env: { SKS_MENUBAR_LAUNCHCTL: '/fixture/launchctl' },
    run: async (_command, args) => {
      calls.push([...args]);
      return {
        code: 0, stdout: '', stderr: '', timedOut: false,
        stdoutBytes: 0, stderrBytes: 0, truncated: false
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'removed');
  assert.equal(result.removed, true);
  assert.equal(await fsp.stat(launchAgent).then(() => true, () => false), false);
  assert.deepEqual(calls, [
    ['print', `gui/501/${LABEL}`],
    ['bootout', `gui/501/${LABEL}`],
    ['bootout', 'gui/501', launchAgent]
  ]);
});

test('retired remote bridge cleanup stops a loaded exact label even when its plist is missing', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retired-remote-loaded-only-'));
  const calls: string[][] = [];
  const result = await cleanupRetiredRemoteBridgeLaunchAgent({
    home,
    force: true,
    uid: 501,
    run: async (_command, args) => {
      calls.push([...args]);
      return {
        code: 0, stdout: '', stderr: '', timedOut: false,
        stdoutBytes: 0, stderrBytes: 0, truncated: false
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'removed');
  assert.equal(result.detected, true);
  assert.equal(result.removed, false);
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [
    ['print', `gui/501/${LABEL}`],
    ['bootout', `gui/501/${LABEL}`]
  ]);
});

test('retired remote bridge cleanup preserves an unmanaged collision', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retired-remote-collision-'));
  const launchAgent = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  await fsp.mkdir(path.dirname(launchAgent), { recursive: true });
  await fsp.writeFile(launchAgent, '<plist><dict><key>Label</key><string>user-owned</string></dict></plist>\n', 'utf8');

  const result = await cleanupRetiredRemoteBridgeLaunchAgent({
    home,
    force: true,
    run: async () => {
      throw new Error('launchctl must not run for an unmanaged file');
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'preserved_collision');
  assert.equal(result.removed, false);
  assert.equal(await fsp.readFile(launchAgent, 'utf8'), '<plist><dict><key>Label</key><string>user-owned</string></dict></plist>\n');
});

test('retired remote bridge cleanup keeps the plist when launchd cannot stop it', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retired-remote-blocked-'));
  const launchAgent = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  await fsp.mkdir(path.dirname(launchAgent), { recursive: true });
  await fsp.writeFile(launchAgent, managedLaunchAgent(), 'utf8');

  const result = await cleanupRetiredRemoteBridgeLaunchAgent({
    home,
    force: true,
    run: async (_command, args) => args[0] === 'print'
      ? {
          code: 0, stdout: '', stderr: '', timedOut: false,
          stdoutBytes: 0, stderrBytes: 0, truncated: false
        }
      : {
          code: 1, stdout: '', stderr: 'Operation not permitted', timedOut: false,
          stdoutBytes: 0, stderrBytes: 23, truncated: false
        }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockers, ['retired_remote_bridge_bootout_failed']);
  assert.equal(await fsp.stat(launchAgent).then(() => true, () => false), true);
});

test('retired bridge binding migration quarantines only provable legacy rows and preserves other data', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retired-remote-bindings-'));
  const bindingPath = path.join(root, '.sneakoscope', 'remote', 'codex-session-bindings.json');
  const machineId = 'local-0123456789ab';
  const projectId = 'project-abcdef012345';
  const retiredSessionId = `telegram-${sha256(`${machineId}:${projectId}`).slice(0, 12)}`;
  const preserved = {
    session_id: 'user-authored-binding',
    machine_id: 'custom-machine',
    project_id: 'custom-project',
    project_root: root,
    codex_thread_id: 'thread-preserved'
  };
  await fsp.mkdir(path.dirname(bindingPath), { recursive: true });
  await fsp.writeFile(bindingPath, `${JSON.stringify({
    schema: 'sks.remote-codex-session-bindings.v1',
    bindings: [{
      session_id: retiredSessionId,
      machine_id: machineId,
      project_id: projectId,
      project_root: root,
      codex_thread_id: 'thread-retired'
    }, preserved]
  }, null, 2)}\n`, 'utf8');

  const result = await quarantineRetiredRemoteBridgeBindings(root);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'quarantined');
  assert.equal(result.retired_binding_count, 1);
  assert.equal(result.preserved_binding_count, 1);
  assert.ok(result.quarantine_path);
  assert.equal(await fsp.stat(result.quarantine_path!).then(() => true, () => false), true);
  const current = JSON.parse(await fsp.readFile(bindingPath, 'utf8')) as { bindings: unknown[] };
  assert.deepEqual(current.bindings, [preserved]);

  const repeated = await quarantineRetiredRemoteBridgeBindings(root);
  assert.equal(repeated.status, 'no_match');
});

test('legacy LaunchAgent ownership check requires the exact retired SKS program shape', () => {
  assert.equal(isManagedRetiredRemoteBridgeLaunchAgent(managedLaunchAgent()), true);
  assert.equal(isManagedRetiredRemoteBridgeLaunchAgent(managedLaunchAgent().replace('<string>run</string>', '<string>status</string>')), false);
  assert.equal(isManagedRetiredRemoteBridgeLaunchAgent(managedLaunchAgent().replace(LABEL, 'user-owned')), false);
});

function managedLaunchAgent(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>/usr/bin/node</string><string>/usr/local/bin/sks</string><string>telegram</string><string>hub</string><string>run</string><string>--project-root</string><string>/fixture/project</string><string>--json</string></array>
</dict></plist>
`;
}
