import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../dist/core/fsx.js';

test('postinstall is externally inert by default and NO_BOOTSTRAP overrides opt-in', async () => {
  for (const variant of [
    { name: 'local-default', bootstrap: '', noBootstrap: '', npmGlobal: '' },
    { name: 'global-default', bootstrap: '', noBootstrap: '', npmGlobal: 'true' },
    { name: 'safety-override', bootstrap: '1', noBootstrap: '1', npmGlobal: 'true' }
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-postinstall-inert-${variant.name}-`));
    try {
      const home = path.join(root, 'home');
      const codexHome = path.join(root, 'codex-home');
      const initCwd = path.join(root, 'project');
      const globalRoot = path.join(root, 'global');
      const bin = path.join(root, 'bin');
      const tmp = path.join(root, 'tmp');
      const launchctlLog = path.join(root, 'launchctl.log');
      const codexLog = path.join(root, 'codex.log');
      await Promise.all([home, codexHome, initCwd, globalRoot, bin, tmp].map((dir) => fs.mkdir(dir, { recursive: true })));
      await fs.writeFile(path.join(initCwd, 'package.json'), '{"name":"postinstall-inert-fixture","private":true}\n');
      await Promise.all([
        writeLoggingStub(path.join(bin, 'launchctl'), launchctlLog),
        writeLoggingStub(path.join(bin, 'codex'), codexLog)
      ]);
      const before = await snapshotTrees({ home, codexHome, initCwd, globalRoot });
      const result = await runProcess(process.execPath, [path.join(process.cwd(), 'dist/bin/sks.js'), 'postinstall'], {
        cwd: process.cwd(),
        timeoutMs: 30000,
        maxOutputBytes: 64 * 1024,
        env: {
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          INIT_CWD: initCwd,
          SKS_GLOBAL_ROOT: globalRoot,
          TMPDIR: tmp,
          NODE_DISABLE_COMPILE_CACHE: '1',
          NODE_COMPILE_CACHE: '',
          PATH: `${bin}${path.delimiter}${String(process.env.PATH || '')}`,
          SKS_MENUBAR_LAUNCHCTL: path.join(bin, 'launchctl'),
          SKS_POSTINSTALL_BOOTSTRAP: variant.bootstrap,
          SKS_POSTINSTALL_NO_BOOTSTRAP: variant.noBootstrap,
          npm_config_global: variant.npmGlobal,
          SKS_TEST_ISOLATION: '1',
          SKS_DISABLE_NETWORK: '1',
          SKS_DISABLE_UPDATE_CHECK: '1'
        }
      });
      const after = await snapshotTrees({ home, codexHome, initCwd, globalRoot });

      assert.equal(result.code, 0, `${variant.name}: ${result.stderr || result.stdout}`);
      assert.deepEqual(after, before, variant.name);
      assert.equal(await fs.readFile(launchctlLog, 'utf8'), '', variant.name);
      assert.equal(await fs.readFile(codexLog, 'utf8'), '', variant.name);
      assert.match(result.stdout, /Automatic bootstrap was not run/);
      assert.match(result.stdout, /SKS_POSTINSTALL_BOOTSTRAP=1/);
      assert.doesNotMatch(result.stdout, /SKS command:|Context7 MCP:|global Doctor ran|Setup complete:/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('postinstall command auto-bootstrap passes a callable bootstrap command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-postinstall-'));
  try {
    const home = path.join(root, 'home');
    const initCwd = path.join(root, 'project');
    const globalRoot = path.join(root, 'global');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(initCwd, { recursive: true });
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.writeFile(path.join(initCwd, 'package.json'), '{"name":"postinstall-opt-in-fixture","private":true}\n');

    const result = await runProcess(process.execPath, [path.join(process.cwd(), 'dist/bin/sks.js'), 'postinstall'], {
      cwd: process.cwd(),
      timeoutMs: 30000,
      maxOutputBytes: 64 * 1024,
      env: {
        HOME: home,
        INIT_CWD: initCwd,
        SKS_GLOBAL_ROOT: globalRoot,
        SKS_POSTINSTALL_BOOTSTRAP: '1',
        SKS_POSTINSTALL_NO_BOOTSTRAP: '',
        SKS_POSTINSTALL_NO_PROMPT: '1',
        SKS_SKIP_POSTINSTALL_SHIM: '1',
        SKS_SKIP_POSTINSTALL_CONTEXT7: '1',
        SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
        SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
        SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '1',
        SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
        SKS_SKIP_CODEX_APP_UPGRADE_REPAIR: '1',
        SKS_POSTINSTALL_SKIP_IMAGEGEN_REPAIR: '1',
        SKS_POSTINSTALL_RETENTION_CLEANUP: '0',
        SKS_POSTINSTALL_GLOBAL_DOCTOR: '0'
      }
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SKS bootstrap: forced by SKS_POSTINSTALL_BOOTSTRAP=1/);
    assert.match(result.stdout, /Setup complete:/);
    assert.doesNotMatch(result.stderr + result.stdout, /bootstrap is not a function/);
    assert.equal(await exists(path.join(initCwd, '.sneakoscope')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeLoggingStub(file, log) {
  const source = process.platform === 'win32'
    ? `@echo %*>>"${log}"\r\n@exit /b 0\r\n`
    : `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
exit 0
`;
  const target = process.platform === 'win32' ? `${file}.cmd` : file;
  await fs.writeFile(target, source);
  await fs.chmod(target, 0o700).catch(() => {});
  await fs.writeFile(log, '');
}

async function snapshotTrees(roots) {
  const rows = [];
  for (const [label, root] of Object.entries(roots)) await walk(root, root, label, rows);
  return rows.sort();
}

async function walk(root, current, label, rows) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    const stat = await fs.lstat(absolute);
    const mode = (stat.mode & 0o777).toString(8);
    if (entry.isDirectory()) {
      rows.push(`${label}:${relative}:directory:${mode}`);
      await walk(root, absolute, label, rows);
    } else if (entry.isFile()) {
      const bytes = await fs.readFile(absolute);
      rows.push(`${label}:${relative}:file:${mode}:${bytes.length}:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    } else if (entry.isSymbolicLink()) {
      rows.push(`${label}:${relative}:symlink:${mode}:${await fs.readlink(absolute)}`);
    }
  }
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}
