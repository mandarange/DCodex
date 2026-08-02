import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { menubarCommand } from '../menubar-command.js';

test('menubar JSON status exits nonzero when the reported state is not ready', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-json-status-'));
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const output: string[] = [];
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  t.after(async () => {
    console.log = previousLog;
    process.exitCode = previousExitCode;
    await fs.rm(temp, { recursive: true, force: true });
  });

  process.exitCode = 0;
  const result = await menubarCommand('status', [
    '--home', path.join(temp, 'home'),
    '--root', path.join(temp, 'root'),
    '--json'
  ]);

  assert.equal(result?.ok, false);
  assert.equal(process.exitCode, 1);
  assert.equal(JSON.parse(output.join('\n')).schema, 'sks.menubar-status.v1');
});
