// First import: every read-only command is spawned with the ambient env; the
// update-status probe writes $HOME/.sneakoscope-global when home leaks through.
import '../../core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COMMANDS, type CommandName } from '../command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKS_BIN = path.resolve(__dirname, '..', '..', 'bin', 'sks.js');

// launchd-spawned callers (the menu bar app) and other non-project invocations run
// with cwd=/. A read-only command must never assume a project workspace exists
// under the current directory — the historical bug class here was `mkdir '/.sneakoscope'`
// crashing the whole command before it could even report a diagnostic.
const READ_ONLY_COMMANDS = (Object.keys(COMMANDS) as CommandName[])
  .filter((name) => COMMANDS[name].readonly === true)
  .sort();

test('at least the expected number of read-only commands are covered by this sweep', () => {
  assert.ok(READ_ONLY_COMMANDS.length >= 12, `expected >=12 read-only commands, got ${READ_ONLY_COMMANDS.length}: ${READ_ONLY_COMMANDS.join(', ')}`);
});

for (const name of READ_ONLY_COMMANDS) {
  test(`read-only command "${name}" does not crash when run from cwd=/`, () => {
    const result = spawnSync(process.execPath, [SKS_BIN, name, '--json'], {
      cwd: '/',
      timeout: 15_000,
      encoding: 'utf8',
      env: { ...process.env, SKS_DISABLE_UPDATE_CHECK: '1' }
    });
    assert.equal(result.signal, null, `command was killed by signal ${result.signal} (likely a hang) — stderr: ${result.stderr?.slice(-2000)}`);
    assert.equal(result.error, undefined, `spawn itself failed: ${result.error}`);
    // A crash from the filesystem-root class of bug throws ENOENT/EACCES trying to
    // mkdir/write under "/" — that string must never appear in stderr regardless of
    // exit code, since even an honest failure must not be caused by this bug class.
    assert.doesNotMatch(String(result.stderr || ''), /ENOENT.*'\/\.sneakoscope'|EACCES.*'\/\.sneakoscope'|mkdir '\/'/, `filesystem-root crash class detected in stderr: ${result.stderr}`);
  });
}
