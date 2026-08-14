// First import: update-migration stages (fastmode normalize, skills install,
// hook trust) resolve os.homedir()/process.env.HOME directly and ignore
// injected env, so the default home must be redirected before they load.
import './helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSksUpdateNow } from '../update-check.js';
import { updateOperationLastInstallPath } from '../update/update-operation.js';
import { projectUpdateMigrationReceiptPath } from '../update/update-migration-state.js';
import { PACKAGE_VERSION, packageRoot } from '../fsx.js';

// `sks update` from a NON-PROJECT cwd — the home directory is the canonical
// case: root discovery refuses home as a project (9.0.2), so the cwd fallback
// makes HOME itself the receipt root. The update must still be complete there:
// global_install, the migration stages (including the desktop-bridge rows),
// a home-rooted migration receipt, and a rollback pointer keyed by the home
// path hash.
async function updateFromHomeFixture(input: { seamDoctor: boolean }) {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-from-home-'));
  const home = await fs.realpath(raw);
  const binDir = path.join(home, 'bin');
  const log = path.join(home, 'npm-log.jsonl');
  const stateFile = path.join(home, 'installed-version.txt');
  const fakeNpm = path.join(home, 'npm-fake.mjs');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(stateFile, '1.10.0\n');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'list' && args[1] === '-g' && args[2] === 'sneakoscope') {
  console.log(JSON.stringify({ dependencies: { sneakoscope: { version: fs.readFileSync(process.env.SKS_FAKE_STATE, 'utf8').trim() } } }));
  process.exit(0);
}
if (args[0] === 'root' && (args[1] === '-g' || args[1] === '--global')) {
  console.log(path.join(process.env.SKS_FAKE_NPM_ROOT, 'node_modules'));
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'version') {
  console.log(${JSON.stringify(PACKAGE_VERSION)});
  process.exit(0);
}
if (args[0] === 'install' && args[1] === '--global' && args[2] === ${JSON.stringify(`sneakoscope@${PACKAGE_VERSION}`)}) {
  fs.writeFileSync(process.env.SKS_FAKE_STATE, ${JSON.stringify(`${PACKAGE_VERSION}\n`)});
  fs.unlinkSync(process.env.SKS_FAKE_PATH_SKS);
  fs.symlinkSync(process.env.SKS_FAKE_ENTRYPOINT, process.env.SKS_FAKE_PATH_SKS);
  console.log('globally installed');
  process.exit(0);
}
console.error('unexpected args: ' + args.join(' '));
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  const globalPackageRoot = path.join(home, 'node_modules', 'sneakoscope');
  const installedEntrypoint = path.join(globalPackageRoot, 'dist', 'bin', 'sks.js');
  await fs.mkdir(path.dirname(installedEntrypoint), { recursive: true });
  await fs.writeFile(path.join(globalPackageRoot, 'package.json'), `${JSON.stringify({
    name: 'sneakoscope',
    version: PACKAGE_VERSION,
    bin: { sks: 'dist/bin/sks.js', sneakoscope: 'dist/bin/sks.js' }
  }, null, 2)}\n`);
  if (input.seamDoctor) {
    // Seam mode never spawns the doctor children, so a version printer is a
    // sufficient installed entrypoint.
    await fs.writeFile(installedEntrypoint, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(`sneakoscope ${PACKAGE_VERSION}\n`)});
`);
  } else {
    // Real-child mode spawns THIS repository's built CLI as the freshly
    // installed package, so the update runs the actual new-version doctor from
    // the home cwd — the exact field flow the 9.0.2 regression broke.
    const dispatch = path.join(packageRoot(), 'dist', 'bin', 'sks-dispatch.js');
    await fs.writeFile(installedEntrypoint, `#!/usr/bin/env node
const firstArg = process.argv[2];
if (firstArg === '--version' || firstArg === '-v' || firstArg === 'version') {
  process.stdout.write(${JSON.stringify(`sneakoscope ${PACKAGE_VERSION}\n`)});
} else {
  import(${JSON.stringify(dispatch)}).then(({ runSks }) => runSks(process.argv.slice(2))).catch((err) => {
    console.error(err instanceof Error && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
`);
  }
  await fs.chmod(installedEntrypoint, 0o755);
  const pathSks = path.join(binDir, 'sks');
  await fs.writeFile(pathSks, `#!${process.execPath}
const fs = require('node:fs');
console.log('sneakoscope ' + fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8').trim());
`);
  await fs.chmod(pathSks, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
    SKS_MUTATION_LEDGER_ROOT: home,
    SKS_FAKE_NPM_LOG: log,
    SKS_FAKE_NPM_ROOT: home,
    SKS_FAKE_STATE: stateFile,
    SKS_FAKE_PATH_SKS: pathSks,
    SKS_FAKE_ENTRYPOINT: installedEntrypoint,
    SKS_UPDATE_CHECK_CACHE_ROOT: path.join(home, 'update-cache'),
    SKS_UPDATE_STATUS_PATH: path.join(home, 'update-status.json'),
    SKS_UPDATE_SKIP_TEMP_INSTALL_SMOKE: '1',
    SKS_UPDATE_SKIP_OLD_DOCTOR_PREFLIGHT: '1',
    SKS_UPDATE_SKIP_SKS_MENUBAR: '1',
    SKS_UPDATE_QUIET: '1',
    ...(input.seamDoctor
      ? { SKS_TEST_DOCTOR_OK: '1', SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '1' }
      : {})
  };
  delete env.SKS_NPM_VIEW_SNEAKOSCOPE_VERSION;
  return {
    home,
    env,
    options: {
      npmBin: fakeNpm,
      currentVersion: '1.10.0',
      // The CLI resolves `sks update` from home to projectRoot=home (cwd
      // fallback after findProjectRoot returns null there).
      projectRoot: home,
      env,
      timeoutMs: 120_000,
      json: true
    },
    cleanup: () => fs.rm(raw, { recursive: true, force: true })
  };
}

function assertCompleteHomeUpdate(result: any, home: string, receipt: any) {
  assert.equal(result.project_root, home);
  const stageById = new Map<string, any>((result.stages || []).map((stage: any) => [stage.id, stage] as [string, any]));
  const install: any = stageById.get('global_install');
  assert.equal(install?.ok, true, JSON.stringify(install));
  assert.equal(install?.status, 'installed');
  const receiptStage: any = stageById.get('project_receipt');
  assert.equal(receiptStage?.ok, true, JSON.stringify(receiptStage));
  assert.equal(receiptStage?.status, 'current');
  assert.equal(receiptStage?.detail?.root, home);
  assert.equal(receipt.status, 'current');
  assert.equal(receipt.sks_version, PACKAGE_VERSION);
  assert.equal(path.resolve(receipt.root), home);
  const stageIds = (receipt.migration_stages || []).map((stage: any) => stage.id);
  assert.ok(stageIds.includes('desktop-bridge-restage'), `restage row missing: ${stageIds.join(',')}`);
  assert.ok(stageIds.includes('desktop-bridge-catalog-repair'), `catalog repair row missing: ${stageIds.join(',')}`);
}

test('update from a home (non-project) root runs global_install and every migration stage', async () => {
  const fixture = await updateFromHomeFixture({ seamDoctor: true });
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  try {
    // The seam doctor writes the receipt in-process, so its migration stages
    // resolve HOME from the process environment; scope them into the fixture.
    process.env.HOME = fixture.home;
    process.env.SKS_GLOBAL_ROOT = path.join(fixture.home, '.sneakoscope-global');
    const result = await runSksUpdateNow(fixture.options);
    assert.equal(result.ok, true, result.error || JSON.stringify(result.stages));
    assert.equal(result.status, 'updated');
    const receipt = JSON.parse(await fs.readFile(projectUpdateMigrationReceiptPath(fixture.home), 'utf8'));
    assertCompleteHomeUpdate(result, fixture.home, receipt);
    // The rollback pointer is keyed by the project-root hash — the home path
    // here — and must authorize a rollback of exactly this install.
    const lastInstall = JSON.parse(await fs.readFile(updateOperationLastInstallPath(fixture.home, fixture.env), 'utf8'));
    assert.equal(lastInstall.project_root, fixture.home);
    assert.equal(lastInstall.target_version, PACKAGE_VERSION);
    assert.equal(lastInstall.previous_version, '1.10.0');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fixture.cleanup();
  }
});

// End to end with the REAL doctor children: the freshly "installed" package is
// this repository's built CLI, so `new_version_doctor` runs the actual
// `doctor --fix --profile migration` from the home cwd. 9.0.2 routed that run
// to the global-only fix, which skipped the migration receipt — every
// `sks update` from home then failed its `project_receipt` stage after a
// successful npm install. The global-only migration doctor now writes the
// home-rooted receipt itself.
test('update from home completes against the real new-version doctor', { timeout: 240_000 }, async () => {
  const fixture = await updateFromHomeFixture({ seamDoctor: false });
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  try {
    process.env.HOME = fixture.home;
    process.env.SKS_GLOBAL_ROOT = path.join(fixture.home, '.sneakoscope-global');
    const result = await runSksUpdateNow(fixture.options);
    const doctorTail = `${result.new_version_doctor?.stdout_tail || ''}\n${result.new_version_doctor?.stderr_tail || ''}`;
    assert.equal(result.new_version_doctor?.ok, true, doctorTail);
    const receipt = JSON.parse(await fs.readFile(projectUpdateMigrationReceiptPath(fixture.home), 'utf8'));
    assert.equal(receipt.source, 'doctor-migration', 'the real doctor child must own the home receipt');
    assertCompleteHomeUpdate(result, fixture.home, receipt);
    assert.equal(result.ok, true, result.error || JSON.stringify(result.stages));
    assert.equal(result.status, 'updated');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fixture.cleanup();
  }
});
