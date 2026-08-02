// First import: update-check probes spawn real codex/npm and touch
// $HOME/.codex and $HOME/.sneakoscope when the default home leaks through.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const packageVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const fakeNpmTimeoutMs = 5_000;

function npmFixtureEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!Object.hasOwn(overrides, 'SKS_NPM_VIEW_SNEAKOSCOPE_VERSION')) {
    delete env.SKS_NPM_VIEW_SNEAKOSCOPE_VERSION;
  }
  return env;
}

async function writeFakePathSks(root, version) {
  const binary = path.join(root, 'sks');
  await fs.writeFile(binary, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(`${version}\n`)});
`);
  await fs.chmod(binary, 0o755);
  return `${root}${path.delimiter}${process.env.PATH || ''}`;
}

test('SKS update check is a function-only npm freshness check', async () => {
  const { runSksUpdateCheck, comparePackageVersions } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-check-'));
  const log = path.join(tmp, 'npm-log.jsonl');
  const cacheRoot = path.join(tmp, 'update-cache');
  const fakeNpm = path.join(tmp, 'npm-fake.mjs');
  const projectRoot = path.join(tmp, 'selected project');
  const registry = 'https://registry.example.test/custom';
  await fs.mkdir(projectRoot, { recursive: true });
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: process.env.SKS_FAKE_GLOBAL || '1.10.0' } } }));
  process.exit(0);
}
if (args[0] === 'root' && args[1] === '-g') {
  console.log(path.join(process.env.SKS_FAKE_NPM_ROOT || process.cwd(), 'node_modules'));
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'version') {
  console.log(process.env.SKS_FAKE_LATEST || '99.99.99');
  process.exit(0);
}
console.error('unexpected args: ' + args.join(' '));
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);

  const result = await runSksUpdateCheck({
    npmBin: fakeNpm,
    currentVersion: '1.10.0',
    projectRoot,
    registry,
    timeoutMs: fakeNpmTimeoutMs,
    env: npmFixtureEnv({
      SKS_FAKE_NPM_LOG: log,
      SKS_FAKE_LATEST: '99.99.99',
      SKS_FAKE_GLOBAL: '1.10.0',
      SKS_UPDATE_CHECK_CACHE_ROOT: cacheRoot
    })
  });

  assert.equal(result.schema, 'sks.update-check.v2');
  assert.equal(result.mode, 'function');
  assert.equal(result.route_required, false);
  assert.equal(result.pipeline_required, false);
  assert.equal(result.update_available, true);
  assert.equal(result.npm_global_current, '1.10.0');
  assert.equal(result.command, `sks update now --version 99.99.99 --project-root '${canonicalProjectRoot}' --registry ${registry}`);
  const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(['view', 'sneakoscope', 'version', '--silent', '--registry', registry])));
  assert.ok(calls.some((args) => args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope'));
  const cacheFiles = await fs.readdir(cacheRoot);
  assert.equal(cacheFiles.length, 1);
  assert.match(await fs.readFile(path.join(cacheRoot, cacheFiles[0]), 'utf8'), /"latest": "99\.99\.99"/);
  assert.equal(comparePackageVersions('1.10.0', '1.9.9'), 1);
});

test('SKS update now installs through npm global argv instead of local project install', async () => {
  const { runSksUpdateNow } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-now-global-'));
  const log = path.join(tmp, 'npm-log.jsonl');
  const fakeNpm = path.join(tmp, 'npm-fake.mjs');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '1.10.0' } } }));
  process.exit(0);
}
if (args[0] === 'root' && (args[1] === '-g' || args[1] === '--global')) {
  console.log(path.join(process.env.SKS_FAKE_NPM_ROOT || process.cwd(), 'node_modules'));
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'version') {
  console.log('${packageVersion}');
  process.exit(0);
}
if (args[0] === 'install' && args[1] === '--global' && args[2] === 'sneakoscope@${packageVersion}') {
  fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify({
    event: 'install-env',
    defer: process.env.SKS_UPDATE_DEFER_MENUBAR_RESTART || null,
    skipLaunch: process.env.SKS_SKIP_SKS_MENUBAR_LAUNCH || null
  }) + '\\n');
  console.log('globally installed');
  process.exit(0);
}
console.error('unexpected args: ' + args.join(' '));
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  const isolatedPath = await writeFakePathSks(tmp, '1.10.0');
  const doctorHome = process.env.HOME || tmp;

  const result = await runSksUpdateNow({
    npmBin: fakeNpm,
    currentVersion: '1.10.0',
    timeoutMs: fakeNpmTimeoutMs,
    env: npmFixtureEnv({
      // The package-local Doctor seam runs in this test process. Bind its
      // global skill surface and final verifier to the same isolated HOME,
      // matching the single child-process HOME used by a real update.
      HOME: doctorHome,
      PATH: isolatedPath,
      SKS_GLOBAL_ROOT: process.env.SKS_GLOBAL_ROOT || path.join(doctorHome, '.sneakoscope-global'),
      SKS_FAKE_NPM_LOG: log,
      SKS_MUTATION_LEDGER_ROOT: tmp,
      SKS_TEST_DOCTOR_OK: '1',
      SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '1',
      SKS_UPDATE_CHECK_CACHE_ROOT: path.join(tmp, 'update-cache'),
      SKS_UPDATE_SKIP_TEMP_INSTALL_SMOKE: '1',
      SKS_UPDATE_SKIP_SKS_MENUBAR: '1'
    })
  });

  assert.equal(result.schema, 'sks.update-now.v2');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'updated');
  assert.deepEqual(result.npm_args, ['install', '--global', `sneakoscope@${packageVersion}`, '--registry', 'https://registry.npmjs.org/']);
  const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.args?.[0] === 'root' && call.args[1] === '--global'));
  assert.ok(calls.some((call) => call.args?.[0] === 'install' && call.args[1] === '--global'));
  assert.ok(!calls.some((call) => call.args?.[0] === 'install' && call.args[1] !== '--global'));
  assert.ok(calls.some((call) => call.event === 'install-env' && call.defer === '1' && call.skipLaunch === '1'));
  const ledger = await fs.readFile(path.join(tmp, '.sneakoscope', 'reports', 'mutation-ledger.jsonl'), 'utf8');
  assert.match(ledger, /"kind":"package_install"/);
});

test('SKS update dry-run does not run doctor fix or npm install', async () => {
  const { runSksUpdateNow } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-dry-run-'));
  const log = path.join(tmp, 'npm-log.jsonl');
  const fakeNpm = path.join(tmp, 'npm-fake.mjs');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '1.10.0' } } }));
  process.exit(0);
}
if (args[0] === 'root' && (args[1] === '-g' || args[1] === '--global')) {
  console.log(path.join(process.env.SKS_FAKE_NPM_ROOT || process.cwd(), 'node_modules'));
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'version') {
  console.log('99.99.99');
  process.exit(0);
}
if (args[0] === 'install') {
  console.error('dry-run must not install');
  process.exit(2);
}
console.error('unexpected args: ' + args.join(' '));
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  const isolatedPath = await writeFakePathSks(tmp, '1.10.0');

  const result = await runSksUpdateNow({
    npmBin: fakeNpm,
    currentVersion: '1.10.0',
    dryRun: true,
    timeoutMs: fakeNpmTimeoutMs,
    env: npmFixtureEnv({
      HOME: tmp,
      PATH: isolatedPath,
      SKS_GLOBAL_ROOT: path.join(tmp, 'global'),
      SKS_FAKE_NPM_LOG: log,
      SKS_MUTATION_LEDGER_ROOT: tmp,
      SKS_UPDATE_CHECK_CACHE_ROOT: path.join(tmp, 'update-cache'),
      SKS_UPDATE_SKIP_SKS_MENUBAR: '1'
    })
  });

  assert.equal(result.schema, 'sks.update-now.v2');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'dry_run');
  assert.equal(result.old_version_doctor, null);
  assert.equal(result.install_code, null);
  assert.ok(result.stages.some((stage) => stage.id === 'preflight' && stage.status === 'skipped_dry_run'));
  assert.ok(result.stages.some((stage) => stage.id === 'download_or_registry_check' && stage.status === 'resolved'));
  assert.ok(result.stages.some((stage) => stage.id === 'temporary_install_smoke' && stage.status === 'skipped_dry_run'));
  assert.ok(result.stages.some((stage) => stage.id === 'global_install' && stage.status === 'dry_run'));
  const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(!calls.some((call) => call.args[0] === 'install'));
  await assert.rejects(
    fs.readFile(path.join(tmp, 'global', 'operations', 'update-latest.json'), 'utf8'),
    { code: 'ENOENT' }
  );
  assert.ok(result.operation_receipt_path);
  const receipt = JSON.parse(await fs.readFile(result.operation_receipt_path, 'utf8'));
  assert.equal(receipt.kind, 'update_dry_run');
  assert.equal(receipt.state, 'succeeded');
  assert.equal(receipt.result_status, 'dry_run');
  assert.equal(receipt.side_effects_started, false);
  assert.equal(receipt.target_version, '99.99.99');
  assert.ok(receipt.receipt_path.startsWith(path.join(tmp, 'global', 'operations') + path.sep));
});

test('SKS update check treats current global npm package as installed even when runtime is older', async () => {
  const { runSksUpdateCheck } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-check-global-'));
  const log = path.join(tmp, 'npm-log.jsonl');
  const fakeNpm = path.join(tmp, 'npm-fake.mjs');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '9.9.9' } } }));
  process.exit(0);
}
if (args[0] === 'root' && args[1] === '-g') {
  console.log(process.cwd() + '/node_modules');
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'version') {
  console.log('9.9.9');
  process.exit(0);
}
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  const result = await runSksUpdateCheck({
    npmBin: fakeNpm,
    currentVersion: '1.10.0',
    timeoutMs: fakeNpmTimeoutMs,
    env: npmFixtureEnv({ SKS_FAKE_NPM_LOG: log, SKS_UPDATE_CHECK_CACHE_ROOT: path.join(tmp, 'update-cache') })
  });
  assert.equal(result.current, '9.9.9');
  assert.equal(result.npm_global_current, '9.9.9');
  assert.equal(result.status, 'current');
  assert.equal(result.update_available, false);
  assert.equal(result.command, null);
});

test('SKS update check does not let source checkout version hide stale global npm install', async () => {
  const { runSksUpdateCheck } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-check-stale-global-'));
  const log = path.join(tmp, 'npm-log.jsonl');
  const fakeNpm = path.join(tmp, 'npm-fake.mjs');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '4.6.1' } } }));
  process.exit(0);
}
if (args[0] === 'root' && args[1] === '-g') {
  console.log(path.join(process.cwd(), 'node_modules'));
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'version') {
  console.log('4.6.2');
  process.exit(0);
}
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  const result = await runSksUpdateCheck({
    npmBin: fakeNpm,
    currentVersion: '4.6.3',
    timeoutMs: fakeNpmTimeoutMs,
    env: npmFixtureEnv({ SKS_FAKE_NPM_LOG: log, SKS_UPDATE_CHECK_CACHE_ROOT: path.join(tmp, 'update-cache') })
  });
  const packageVersion = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  assert.equal(result.current, '4.6.1');
  assert.equal(result.runtime_current, packageVersion);
  assert.equal(result.package_root_current, packageVersion);
  assert.equal(result.npm_global_current, '4.6.1');
  assert.equal(result.latest, '4.6.2');
  assert.equal(result.status, 'available');
  assert.equal(result.update_available, true);
  assert.equal(result.command, 'sks update now --version 4.6.2');
});

test('SKS update check can run without npm through the hermetic env override', async () => {
  const { runSksUpdateCheck } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-check-hermetic-'));
  try {
    const statusPath = path.join(tmp, 'update-status.json');
    const result = await runSksUpdateCheck({
      npmBin: null,
      currentVersion: '1.10.0',
      env: npmFixtureEnv({
        HOME: tmp,
        SKS_UPDATE_STATUS_PATH: statusPath,
        SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '99.99.99'
      })
    });
    assert.equal(result.status, 'available');
    assert.equal(result.latest, '99.99.99');
    assert.equal(result.pipeline_required, false);
    assert.equal(JSON.parse(await fs.readFile(statusPath, 'utf8')).sks.latest, '99.99.99');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('SKS update check override does not call npm view', async () => {
  const { runSksUpdateCheck } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-check-override-'));
  const log = path.join(tmp, 'npm-log.jsonl');
  const fakeNpm = path.join(tmp, 'npm-fake.mjs');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '1.10.0' } } }));
  process.exit(0);
}
if (args[0] === 'root' && args[1] === '-g') {
  console.log(path.join(process.cwd(), 'node_modules'));
  process.exit(0);
}
if (args[0] === 'view') {
  console.error('npm view should not run when override is present');
  process.exit(1);
}
process.exit(0);
`);
  await fs.chmod(fakeNpm, 0o755);
  const result = await runSksUpdateCheck({
    npmBin: fakeNpm,
    currentVersion: '1.10.0',
    env: npmFixtureEnv({
      HOME: tmp,
      SKS_UPDATE_STATUS_PATH: path.join(tmp, 'update-status.json'),
      SKS_FAKE_NPM_LOG: log,
      SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '99.99.99'
    })
  });
  assert.equal(result.status, 'available');
  assert.equal(result.latest, '99.99.99');
  const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === 'view'), false);
});

test('SKS update check reports unavailable instead of starting fallback work', async () => {
  const { runSksUpdateCheck } = await import('../../dist/core/update-check.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-no-npm-'));
  try {
    const result = await runSksUpdateCheck({
      npmBin: null,
      currentVersion: '1.10.0',
      env: {
        HOME: tmp,
        SKS_UPDATE_STATUS_PATH: path.join(tmp, 'update-status.json')
      }
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.update_available, false);
    assert.equal(result.command, null);
    assert.equal(result.error, 'npm not found on PATH');
    assert.equal(result.route_required, false);
    assert.equal(result.pipeline_required, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('CLI launch helper does not run SKS package update checks', async () => {
  const { maybePromptSksUpdateForLaunch } = await import('../../dist/cli/install-helpers.js');
  const previous = {
    SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: process.env.SKS_NPM_VIEW_SNEAKOSCOPE_VERSION,
    SKS_OPENCLAW: process.env.SKS_OPENCLAW,
    OPENCLAW: process.env.OPENCLAW,
    OPENCLAW_AGENT: process.env.OPENCLAW_AGENT,
    OPENCLAW_RUN_ID: process.env.OPENCLAW_RUN_ID,
    OPENCLAW_SESSION_ID: process.env.OPENCLAW_SESSION_ID,
    SKS_HERMES: process.env.SKS_HERMES,
    HERMES_AGENT: process.env.HERMES_AGENT,
    HERMES_RUN_ID: process.env.HERMES_RUN_ID,
    HERMES_SESSION_ID: process.env.HERMES_SESSION_ID
  };
  const logs = [];
  const originalLog = console.log;
  try {
    process.env.SKS_NPM_VIEW_SNEAKOSCOPE_VERSION = '99.99.99';
    for (const key of Object.keys(previous).filter((key) => key !== 'SKS_NPM_VIEW_SNEAKOSCOPE_VERSION')) {
      delete process.env[key];
    }
    console.log = (message) => logs.push(String(message));
    const result = await maybePromptSksUpdateForLaunch([], { label: 'MAD launch' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'manual_update_commands_only');
    assert.equal(result.latest, null);
    assert.equal(result.command, null);
    assert.equal(logs.join('\n'), '');
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
