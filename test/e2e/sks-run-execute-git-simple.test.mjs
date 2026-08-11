import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distCli = path.join(repoRoot, 'dist', 'bin', 'sks.js');

test('sks run --execute routes $Commit through deterministic simple git command', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-run-commit-'));
  runGit(cwd, ['init']);
  runGit(cwd, ['config', 'user.email', 'codex@example.test']);
  runGit(cwd, ['config', 'user.name', 'Codex Test']);
  await fs.writeFile(path.join(cwd, '.gitignore'), '.sneakoscope/\n');
  runGit(cwd, ['add', '.gitignore']);
  runGit(cwd, ['commit', '-m', 'test: initialize ignore file']);
  await fs.writeFile(path.join(cwd, 'owned.txt'), 'hello\n');

  const result = spawnSync(process.execPath, [distCli, 'run', '$Commit', '--execute', '--json'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKS_SKIP_NPM_FRESHNESS_CHECK: '1',
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.route, '$Commit');
  assert.equal(parsed.execution.command, 'sks commit --json');
  assert.equal(parsed.execution.execution_kind, 'safe_deterministic');
  assert.doesNotMatch(parsed.execution.command, /naruto|--mock/);

  const message = runGit(cwd, ['log', '-1', '--pretty=%B']).stdout;
  assert.equal((message.match(/Co-authored-by: Codex <noreply@openai\.com>/g) || []).length, 1);
  assert.equal(runGit(cwd, ['status', '--short']).stdout.trim(), '');
});

test('sks run --execute keeps clean $Commit on deterministic no_changes path', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-run-commit-clean-'));
  runGit(cwd, ['init']);
  runGit(cwd, ['config', 'user.email', 'codex@example.test']);
  runGit(cwd, ['config', 'user.name', 'Codex Test']);
  await fs.writeFile(path.join(cwd, '.gitignore'), '.sneakoscope/\n');
  runGit(cwd, ['add', '.gitignore']);
  runGit(cwd, ['commit', '-m', 'test: initialize ignore file']);

  const result = spawnSync(process.execPath, [distCli, 'run', '$Commit', '--execute', '--json'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKS_SKIP_NPM_FRESHNESS_CHECK: '1',
    }
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.execution.command, 'sks commit --json');
  assert.equal(parsed.execution.execution_kind, 'blocked');
  assert.match(parsed.execution.stdout_tail, /no_changes/);
  assert.doesNotMatch(parsed.execution.command, /naruto|--mock/);
});

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
