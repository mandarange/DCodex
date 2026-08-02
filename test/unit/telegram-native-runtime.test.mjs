import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('Telegram native standalone runtime smoke covers audit fail-closed and bounded stop receipt', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS Cocoa framework required');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-telegram-native-runtime-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const binary = path.join(temp, 'telegram-runtime-smoke');
  const root = process.cwd();
  const source = (name) => path.join(root, 'native', 'sks-menubar', 'Sources', name);
  const testSource = (name) => path.join(root, 'native', 'sks-menubar', 'Tests', name);
  const sources = [
    source('ProcessClient.swift'),
    source('ProcessExecutionState.swift'),
    source('ProcessIdentityGuard.swift'),
    source('SecureProcessEnvelope.swift'),
    source('TelegramStateLock.swift'),
    source('TelegramPrivateFileSupport.swift'),
    source('TelegramPrivateFileStore.swift'),
    source('TelegramSupport.swift'),
    source('TelegramRuntimeSupport.swift'),
    source('TelegramTransport.swift'),
    source('TelegramProcessGateway.swift'),
    testSource('AppRuntimeTestSupport.swift'),
    testSource('TelegramRuntimeSmokeTests.swift')
  ];
  const compiled = await run('swiftc', [
    '-D', 'SKS_NATIVE_TESTING', '-D', 'TELEGRAM_STANDALONE_TEST',
    '-framework', 'Cocoa', ...sources, '-o', binary
  ], 30_000);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [], 20_000);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /telegram swift runtime smoke: ok/);
});

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
