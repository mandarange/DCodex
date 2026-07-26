import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { menubarCommand } from '../menubar-command.js';
import type { SksMenuBarRollbackResult } from '../../codex-app/menubar/index.js';

test('menubar rollback command exposes the guarded previous-artifact path and --no-launch', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-command-rollback-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const output: string[] = [];
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  t.after(() => {
    console.log = previousLog;
    process.exitCode = previousExitCode;
  });

  const result = await menubarCommand('rollback', [
    '--home', path.join(temp, 'home'),
    '--root', path.join(temp, 'root'),
    '--no-launch'
  ]) as SksMenuBarRollbackResult;
  assert.equal(result?.schema, 'sks.menubar-rollback.v1');
  if (process.platform === 'darwin') {
    assert.equal(result?.ok, false);
    assert.equal(result?.status, 'failed');
    assert.match(output.join('\n'), /SKS menu bar rollback: failed/);
    output.length = 0;
    process.exitCode = 0;
    const jsonResult = await menubarCommand('rollback', [
      '--home', path.join(temp, 'home'),
      '--root', path.join(temp, 'root'),
      '--no-launch',
      '--json'
    ]) as SksMenuBarRollbackResult;
    assert.equal(jsonResult.status, 'failed');
    assert.equal(process.exitCode, 1);
    assert.equal(JSON.parse(output.join('\n')).schema, 'sks.menubar-rollback.v1');
  } else {
    assert.equal(result?.ok, true);
    assert.equal(result?.status, 'unsupported_platform');
  }
  const commandSource = await fs.readFile(path.join(process.cwd(), 'src', 'core', 'commands', 'menubar-command.ts'), 'utf8');
  assert.match(commandSource, /sks menubar rollback \[--no-launch\] \[--json\]/);
});
