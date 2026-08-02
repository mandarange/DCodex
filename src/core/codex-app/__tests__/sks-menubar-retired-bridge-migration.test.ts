import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupRetiredRemoteBridgeLaunchAgent } from '../menubar/migration.js';

const RETIRED_LABEL = 'com.sneakoscope.telegram-hub';

test('retired bridge cleanup removes its verified plist without bootout when launchd proves the service absent', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-retired-absent-'));
  const launchAgentPath = path.join(home, 'Library', 'LaunchAgents', `${RETIRED_LABEL}.plist`);
  const calls: string[][] = [];
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
  await fs.writeFile(launchAgentPath, managedRetiredLaunchAgent(), 'utf8');

  const result = await cleanupRetiredRemoteBridgeLaunchAgent({
    home,
    force: true,
    uid: 501,
    run: async (_command, args) => {
      calls.push([...args]);
      assert.equal(args[0], 'print', 'an absent service must not receive a redundant bootout');
      return {
        code: 113,
        stdout: '',
        stderr: 'Bad request.\n',
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 13,
        truncated: false
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'removed');
  assert.equal(result.removed, true);
  assert.equal(result.stopped, false);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(calls, [['print', `gui/501/${RETIRED_LABEL}`]]);
  assert.equal(await fs.stat(launchAgentPath).then(() => true, () => false), false);
});

test('retired bridge cleanup preserves its plist when code 113 is not an absent-service response', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-retired-unknown-'));
  const launchAgentPath = path.join(home, 'Library', 'LaunchAgents', `${RETIRED_LABEL}.plist`);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
  await fs.writeFile(launchAgentPath, managedRetiredLaunchAgent(), 'utf8');

  const result = await cleanupRetiredRemoteBridgeLaunchAgent({
    home,
    force: true,
    uid: 501,
    run: async () => ({
      code: 113,
      stdout: '',
      stderr: 'Permission denied by policy.\n',
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 29,
      truncated: false
    })
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ['retired_remote_bridge_probe_failed']);
  assert.equal(await fs.stat(launchAgentPath).then(() => true, () => false), true);
});

function managedRetiredLaunchAgent(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${RETIRED_LABEL}</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>/usr/bin/node</string><string>/usr/local/bin/sks</string><string>telegram</string><string>hub</string><string>run</string><string>--project-root</string><string>/fixture/project</string><string>--json</string></array>
</dict></plist>
`;
}
