import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_VERSION } from '../../version.js';

test('cached installer refuses to reinstall itself when the registry latest is newer', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX npm shim fixture');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-stale-installer-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'npm-calls.jsonl');
  const npm = path.join(bin, 'npm');
  try {
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(npm, [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.SKS_TEST_NPM_LOG, JSON.stringify(args) + '\\n');",
      "if (args.join(' ') === 'view sneakoscope version --silent --prefer-online') { console.log('99.0.0'); process.exit(0); }",
      "if (args[0] === 'install') { console.error('stale installer must not install'); process.exit(9); }",
      "process.exit(2);"
    ].join('\n'));
    await fs.chmod(npm, 0o755);

    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'dist', 'bin', 'install.js'), 'install', '--yes'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        PATH: bin,
        SKS_TEST_NPM_LOG: log
      }
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.ok(output.includes(`installer package is stale (${PACKAGE_VERSION}); the registry latest is 99.0.0`), output);
    assert.match(output, /sneakoscope@latest/);
    const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls, [['view', 'sneakoscope', 'version', '--silent', '--prefer-online']]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
