import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('concurrent TypeScript and Swift stale-lock recovery preserves every state transaction', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift cross-language lock harness is macOS-only');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-telegram-state-lock-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const sksHome = path.join(temp, '.sneakoscope');
  const stateDir = path.join(sksHome, 'state');
  const statePath = path.join(stateDir, 'telegram.json');
  const lockPath = path.join(stateDir, '.telegram.lock');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);
  await fs.writeFile(statePath, `${JSON.stringify({
    schema: 'sks.telegram-state.v1',
    bot_id: null,
    poll_offset: 0,
    pairing: null,
    chats: [],
    confirmations: [],
    counter: 0
  })}\n`, { mode: 0o600 });
  await fs.chmod(statePath, 0o600);
  await fs.writeFile(lockPath, `${JSON.stringify({
    schema: 'sks.telegram-lock.v1',
    pid: 2_147_483_647,
    token: '55555555-5555-4555-8555-555555555555'
  })}\n`, { mode: 0o600 });
  await fs.chmod(lockPath, 0o600);

  const swiftHarness = path.join(temp, 'Harness.swift');
  const swiftBinary = path.join(temp, 'telegram-state-lock-harness');
  await fs.writeFile(swiftHarness, `
import Darwin
import Foundation

@main
struct Harness {
    static func main() throws {
        guard let homePath = ProcessInfo.processInfo.environment["HOME"] else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        let support = TelegramPrivateFileSupport(
            homeDirectory: URL(fileURLWithPath: homePath, isDirectory: true),
            environment: [:]
        )
        let mode = ProcessInfo.processInfo.environment["MODE"] ?? "increment"
        if mode == "stage" {
            try support.withStateTransaction {
                let state: [String: Any] = [
                    "schema": "sks.telegram-state.v1", "bot_id": 101, "poll_offset": 44,
                    "pairing": NSNull(), "confirmations": [],
                    "chats": [[
                        "chat_id": 7, "sender_id": 8,
                        "paired_at": "2026-08-01T00:00:00.000Z", "active": false
                    ]]
                ]
                let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) + Data([0x0A])
                try support.writeStateData(data)
            }
            return
        }
        if mode == "verify" {
            let store = TelegramPrivateFileStore(
                homeDirectory: URL(fileURLWithPath: homePath, isDirectory: true),
                environment: [:]
            )
            let binding = try store.bindBotIdentity(101)
            guard !binding.stateReset, try store.authorizedCount() == 0 else {
                throw TelegramPrivateFileError.invalidStoredValue
            }
            return
        }
        guard let iterationsText = ProcessInfo.processInfo.environment["ITERATIONS"],
              let iterations = Int(iterationsText) else { throw TelegramPrivateFileError.invalidStoredValue }
        for _ in 0..<iterations {
            try support.withStateTransaction {
                guard let data = try support.readStateData(),
                      var state = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let counter = state["counter"] as? NSNumber else {
                    throw TelegramPrivateFileError.invalidStoredValue
                }
                usleep(2_000)
                state["counter"] = counter.intValue + 1
                let next = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) + Data([0x0A])
                try support.writeStateData(next)
            }
        }
    }
}
`);

  const source = (name) => path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', name);
  const compiled = await run('swiftc', [
    source('TelegramStateLock.swift'),
    source('TelegramPrivateFileSupport.swift'),
    source('TelegramPrivateFileStore.swift'),
    source('TelegramSupport.swift'),
    swiftHarness,
    '-o', swiftBinary
  ], process.env, 30_000);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);

  const workersPerRuntime = 8;
  const iterations = 3;
  const keychainPath = path.join(process.cwd(), 'dist', 'core', 'telegram', 'keychain.js');
  const staged = await run(swiftBinary, [], { ...process.env, HOME: temp, MODE: 'stage' }, 30_000);
  assert.equal(staged.code, 0, `${staged.stdout}\n${staged.stderr}`);
  const setupWorker = `
const { bindTelegramBotIdentity, readTelegramState, telegramPrivatePaths } = require(${JSON.stringify(keychainPath)});
const paths = telegramPrivatePaths({ HOME: ${JSON.stringify(temp)} });
(async () => {
  const before = await readTelegramState(paths);
  if (before.chats[0]?.active !== false) throw new Error('staged_active_not_preserved');
  const binding = await bindTelegramBotIdentity(101, { paths });
  if (!binding.state_reset || (await readTelegramState(paths)).chats.length !== 0) {
    throw new Error('pending_pairing_not_reset');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
  const setup = await run(process.execPath, ['-e', setupWorker], process.env, 30_000);
  assert.equal(setup.code, 0, `${setup.stdout}\n${setup.stderr}`);
  const restarted = await run(swiftBinary, [], { ...process.env, HOME: temp, MODE: 'verify' }, 30_000);
  assert.equal(restarted.code, 0, `${restarted.stdout}\n${restarted.stderr}`);

  await fs.writeFile(statePath, `${JSON.stringify({
    schema: 'sks.telegram-state.v1', bot_id: null, poll_offset: 0,
    pairing: null, chats: [], confirmations: [], counter: 0
  })}\n`, { mode: 0o600 });
  await fs.writeFile(lockPath, `${JSON.stringify({
    schema: 'sks.telegram-lock.v1', pid: 2_147_483_647,
    token: '55555555-5555-4555-8555-555555555555'
  })}\n`, { mode: 0o600 });
  await fs.chmod(lockPath, 0o600);
  const nodeWorker = `
const { updateTelegramState, telegramPrivatePaths } = require(${JSON.stringify(keychainPath)});
const paths = telegramPrivatePaths({ HOME: ${JSON.stringify(temp)} });
(async () => {
  for (let index = 0; index < ${iterations}; index += 1) {
    await updateTelegramState(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { ...state, counter: Number(state.counter || 0) + 1 };
    }, paths);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
  const runs = [];
  for (let index = 0; index < workersPerRuntime; index += 1) {
    runs.push(run(process.execPath, ['-e', nodeWorker], process.env, 30_000));
    runs.push(run(swiftBinary, [], { ...process.env, HOME: temp, ITERATIONS: String(iterations) }, 30_000));
  }
  const results = await Promise.all(runs);
  for (const result of results) assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const finalState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(finalState.counter, workersPerRuntime * 2 * iterations);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${lockPath}.reclaim`), { code: 'ENOENT' });
});

function run(command, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
