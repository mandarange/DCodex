import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { COMMAND_MANIFEST_LITE } from '../command-manifest-lite.js';
import { isHelpRequest, renderManifestHelp } from '../help.js';

const CLI = path.join(process.cwd(), 'dist', 'bin', 'sks.js');

// `version` and `help` answer before the router (src/bin/sks.ts,
// src/bin/sks-dispatch.ts) and own their presentation: `version` prints the
// version for any argument, `help` prints the frontdoor. That is each command's
// contract, not a help gap.
const ANSWERED_BEFORE_ROUTER = new Set(['version', 'help']);

function runHelp(command: string, form: string, cwd: string) {
  return spawnSync(process.execPath, [CLI, command, form], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    // NO_COLOR so the banner assertion reads the text, not an ANSI dim wrapper.
    env: { ...process.env, NO_COLOR: '1', SKS_SKIP_CODEX_APP_RESTART: '1' }
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

test('a command that exports usage() gets its own text, not the manifest floor', () => {
  // Regression: every registry wrapper rebuilt CommandModule from one named
  // export and dropped `usage`, so the router's richer-help branch was
  // unreachable for all 100 commands.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-help-usage-'));
  execFileSync('git', ['init', '-q', '.'], { cwd });
  try {
    const stdout = String(runHelp('release', '--help', cwd).stdout || '');
    assert.match(stdout, /Usage: sks release affected\|full\|background\|stage/);
    assert.match(stdout, /stage never runs `npm stage approve`/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Naruto public help exposes its 256-child ceiling and host-auth contract', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-naruto-help-'));
  execFileSync('git', ['init', '-q', '.'], { cwd });
  try {
    const stdout = String(runHelp('naruto', '--help', cwd).stdout || '');
    assert.match(stdout, /--agents N[\s\S]*1-256/);
    assert.match(stdout, /either lane may expand to 256/);
    assert.match(stdout, /measured lower Codex host or explicit provider\/API limit remains authoritative/);
    assert.match(stdout, /--auth-mode MODE/);
    assert.match(stdout, /--provider-env-key NAME/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('manifest help names the command, its summary, and the help flag', () => {
  const entry = COMMAND_MANIFEST_LITE.find((item) => item.name === 'doctor');
  assert.ok(entry);
  const text = renderManifestHelp('doctor', entry);
  assert.match(text, /^Usage: sks doctor/);
  assert.ok(text.includes(entry!.summary), text);
  assert.match(text, /--help, -h/);
});

test('config and Telegram CLI surfaces are local-only control commands', () => {
  for (const name of ['config', 'telegram']) {
    const entry = COMMAND_MANIFEST_LITE.find((item) => item.name === name);
    assert.ok(entry, name);
    assert.equal(entry.remoteAllowed, false, name);
    assert.equal(entry.supportsJson, true, name);
    assert.equal(entry.inputProfile, 'json-only', name);
  }
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
      const stdout = String(result.stdout || '');
      if (!/usage/i.test(stdout)) {
        failures.push(`${entry.name}: no usage text`);
      }
      // Help is CLI output and carries the same banner and status vocabulary as
      // any other command, so the output-consistency contract holds for it too.
      if (!/^SKS \d+\.\d+\.\d+ · /.test(stdout)) failures.push(`${entry.name}: help output has no version banner`);
      if (!/[✔▲✖]/.test(stdout)) failures.push(`${entry.name}: help output has no status vocabulary`);
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
