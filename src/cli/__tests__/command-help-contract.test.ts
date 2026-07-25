import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { COMMAND_MANIFEST_LITE } from '../command-manifest-lite.js';
import { isHelpRequest, renderManifestHelp } from '../help.js';

const CLI = path.join(process.cwd(), 'dist', 'bin', 'sks.js');

// `sks version` answers before the router (src/bin/sks.ts), so it prints the
// version for any argument — that is the command's contract, not a help gap.
const ANSWERED_BEFORE_ROUTER = new Set(['version']);

function runHelp(command: string, form: string, cwd: string) {
  return spawnSync(process.execPath, [CLI, command, form], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SKS_SKIP_CODEX_APP_RESTART: '1' }
  });
}

test('isHelpRequest accepts the three help forms and ignores help as a value', () => {
  assert.equal(isHelpRequest(['--help']), true);
  assert.equal(isHelpRequest(['-h']), true);
  assert.equal(isHelpRequest(['help']), true);
  assert.equal(isHelpRequest(['status', '--help']), true);
  // A commit message of "help" must not be read as a usage request.
  assert.equal(isHelpRequest(['-m', 'help']), false);
  assert.equal(isHelpRequest([]), false);
});

test('manifest help names the command, its summary, and the help flag', () => {
  const entry = COMMAND_MANIFEST_LITE.find((item) => item.name === 'doctor');
  assert.ok(entry);
  const text = renderManifestHelp('doctor', entry);
  assert.match(text, /^Usage: sks doctor/);
  assert.ok(text.includes(entry!.summary), text);
  assert.match(text, /--help, -h/);
});

test('every manifest command answers --help with usage and never runs its work', () => {
  // Regression: help was delegated to each command module, so a module that
  // never learned to recognise --help ran its real work instead —
  // `sks commit-and-push --help` performed an actual commit and push.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-help-contract-'));
  execFileSync('git', ['init', '-q', '.'], { cwd });
  try {
    const failures: string[] = [];
    for (const entry of COMMAND_MANIFEST_LITE) {
      const result = runHelp(entry.name, '--help', cwd);
      if (result.status !== 0) {
        failures.push(`${entry.name}: exit ${result.status} ${String(result.stderr || '').slice(0, 120)}`);
        continue;
      }
      if (ANSWERED_BEFORE_ROUTER.has(entry.name)) continue;
      if (!/usage/i.test(String(result.stdout || ''))) {
        failures.push(`${entry.name}: no usage text`);
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('commit-and-push --help leaves the working tree and history untouched', () => {
  // The concrete safety failure this contract exists to prevent.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-help-safety-'));
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd });
    execFileSync('git', ['config', 'user.email', 'help@test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'help'], { cwd });
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'x\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd });
    fs.writeFileSync(path.join(cwd, 'pending.txt'), 'y\n');
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

    for (const form of ['--help', '-h']) {
      const result = runHelp('commit-and-push', form, cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.match(String(result.stdout), /Usage: sks commit-and-push/);
    }

    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), before);
    assert.match(
      execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }),
      /\?\? pending\.txt/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
