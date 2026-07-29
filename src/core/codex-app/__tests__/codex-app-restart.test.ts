import test from 'node:test';
import assert from 'node:assert/strict';
import { quitCodexApp, restartCodexApp } from '../codex-app-restart.js';
import { codexAppCandidatePaths } from '../../codex-app.js';

test('Codex restart targets the ChatGPT bundle id and waits for exit before open', async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const run = async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    if (args[0] === '-e' && args[1]?.includes('is running')) return { code: 0, stdout: 'false\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await restartCodexApp({
    root: '/tmp/sks-codex-app-restart-test-home',
    env: {
      HOME: '/tmp/sks-codex-app-restart-test-home',
      CODEX_HOME: '/tmp/sks-codex-app-restart-test-home/.codex'
    },
    platform: 'darwin',
    delayMs: 0,
    pollMs: 1,
    osascriptPath: '/test/osascript',
    openPath: '/test/open',
    runProcessImpl: run as any
  });
  assert.equal(result.ok, true);
  assert.equal(result.bundle_id, 'com.openai.codex');
  assert.ok(calls.some((call) => call.args[0] === '-e' && call.args[1]?.includes('tell application id "com.openai.codex" to quit')));
  assert.ok(calls.some((call) => call.args[0] === '-b' && call.args[1] === 'com.openai.codex'));
});

test('Codex app discovery includes the installed ChatGPT.app bundle path', () => {
  const paths = codexAppCandidatePaths('/Users/test', {});
  if (process.platform === 'darwin') {
    assert.ok(paths.includes('/Applications/ChatGPT.app'));
    assert.ok(paths.includes('/Users/test/Applications/ChatGPT.app'));
  }
});

test('Codex quit verifies process exit without reopening the app', async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const result = await quitCodexApp({
    platform: 'darwin',
    pollMs: 1,
    osascriptPath: '/test/osascript',
    runProcessImpl: (async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      if (args[1]?.includes('is running')) return { code: 0, stdout: 'false\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }) as any
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'quit');
  assert.equal(result.exit_wait?.ok, true);
  assert.ok(calls.some((call) => call.args[1]?.includes('to quit')));
  assert.equal(calls.some((call) => call.args[0] === '-b'), false);
});
