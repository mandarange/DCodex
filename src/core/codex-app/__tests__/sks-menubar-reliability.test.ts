import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256, runProcess } from '../../fsx.js';
import { aggregateFileHashes } from '../menubar/build-stamp.js';
import { NATIVE_RESOURCE_FILES } from '../menubar/constants.js';
import { recoverMenuBarGenerationTransaction, rollbackGenerationPairs } from '../menubar/generation-transaction.js';
import { shouldAutoRollbackMenuBarLaunch, sksMenuBarRestartDeferred } from '../menubar/installer.js';
import { launchAgentSource, launchMenuBar, restartLaunchAgent, isUnloadableLaunchdKickstartError } from '../menubar/launch-agent.js';
import { sksMenuBarPaths } from '../menubar/paths.js';
import { normalizeLegacyMenuBarBuildStamp, rollbackSksMenuBar } from '../menubar/rollback.js';
import type { SksMenuBarBuildStamp } from '../menubar/types.js';

test('launchctl kickstart timeout is accepted only after launchctl print verifies a running service', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('timeout-running');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: null, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, true);
  assert.equal(launch.kickstart_timed_out, true);
  assert.equal(launch.verified_running_after_timeout, true);
  assert.equal(launch.print_code, 0);
  assert.equal(launch.terminal_uncertain, false);

  const restart = await restartLaunchAgent(fixture.paths, fixture.env);
  assert.equal(restart.ok, true);
  assert.equal(restart.timed_out, true);
  assert.equal(restart.verified_running_after_timeout, true);
  assert.equal(restart.terminal_uncertain, false);
  assert.equal(restart.recovered_via_bootstrap, false);
});

test('menubar restart re-bootstraps when launchd no longer has the service loaded', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('missing-service-recover');
  t.after(fixture.cleanup);
  await fs.writeFile(fixture.paths.launch_agent_path, launchAgentSource(fixture.paths.executable_path, fixture.paths.install_dir));
  await fs.mkdir(path.dirname(fixture.paths.executable_path), { recursive: true });
  await fs.writeFile(fixture.paths.executable_path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const first = await runProcess(fixture.launchctl, ['kickstart', '-k', 'gui/501/com.sneakoscope.sks-menubar'], {
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024
  }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error) }));
  assert.equal(first.code, 113, `direct kickstart should miss the service: ${JSON.stringify(first)}`);
  const restart = await restartLaunchAgent(fixture.paths, {
    ...fixture.env,
    SKS_MENUBAR_OPEN: fixture.open,
    SKS_MENUBAR_KICKSTART_TIMEOUT_MS: '2000'
  });
  assert.equal(restart.recovered_via_bootstrap, true, JSON.stringify(restart, null, 2));
  assert.equal(restart.ok, true, JSON.stringify(restart, null, 2));
  assert.equal(restart.terminal_uncertain, false);
  assert.equal(restart.error, null);
});

test('unloadable kickstart errors are classified without treating arbitrary failures as missing services', () => {
  assert.equal(isUnloadableLaunchdKickstartError('Could not find service "com.sneakoscope.sks-menubar" in domain for user gui: 501'), true);
  assert.equal(isUnloadableLaunchdKickstartError('Could not kickstart service "com.sneakoscope.sks-menubar": 1: Operation not permitted'), true);
  assert.equal(isUnloadableLaunchdKickstartError('Bad request.'), true);
  assert.equal(isUnloadableLaunchdKickstartError('launchctl print failed: permission denied by policy'), false);
});

test('launchctl kickstart timeout remains terminal uncertain when print cannot confirm state', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('timeout-unknown');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: null, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, false);
  assert.equal(launch.kickstart_timed_out, true);
  assert.equal(launch.verified_running_after_timeout, false);
  assert.equal(launch.terminal_uncertain, true);
});

test('launchctl kickstart timeout polls through spawn scheduled until running is read back', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('timeout-spawn-running');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: null, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, true, JSON.stringify(launch, null, 2));
  assert.equal(launch.kickstart_timed_out, true);
  assert.equal(launch.verified_running_after_timeout, true);
  assert.equal(launch.terminal_uncertain, false);
  assert.ok(await readCount(fixture.printCountPath) >= 3);
});

test('spawn scheduled that never becomes running remains terminal uncertain without exposing launchctl print output', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('timeout-spawn-stuck');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: null, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, false);
  assert.equal(launch.kickstart_timed_out, true);
  assert.equal(launch.print_code, 0);
  assert.equal(launch.verified_running_after_timeout, false);
  assert.equal(launch.terminal_uncertain, true);
  assert.equal(launch.error, 'launchd_not_running:state=spawn_scheduled:active_count=0:pid=none');
  assert.doesNotMatch(String(launch.error), /SENSITIVE_LAUNCH_VALUE/);
  assert.ok(await readCount(fixture.printCountPath) > 1);
});

test('completed kickstart with a readable non-running state is a hard launch failure', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('success-spawn-stuck');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: null, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, false);
  assert.equal(launch.kickstart_timed_out, false);
  assert.equal(launch.print_code, 0);
  assert.equal(launch.terminal_uncertain, false);
  assert.equal(launch.error, 'launchd_not_running:state=spawn_scheduled:active_count=0:pid=none');
});

test('completed kickstart with unreadable launchd state remains terminal uncertain', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('success-print-unknown');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: null, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, false);
  assert.equal(launch.kickstart_timed_out, false);
  assert.equal(launch.print_code, 3);
  assert.equal(launch.terminal_uncertain, true);
  assert.match(String(launch.error), /^launchctl_print_failed:3:/);
});

test('installer does not compound terminal launch uncertainty with an automatic rollback', () => {
  assert.equal(shouldAutoRollbackMenuBarLaunch({
    launch: { requested: true, method: 'launchctl', ok: false, terminal_uncertain: true },
    upToDate: false,
    rollbackCandidateExists: true
  }), false);
  assert.equal(shouldAutoRollbackMenuBarLaunch({
    launch: { requested: true, method: 'launchctl', ok: false, terminal_uncertain: false },
    upToDate: false,
    rollbackCandidateExists: true
  }), true);
});

test('update-owned Doctor and postinstall work defer Menu Bar restart until the parent operation completes', () => {
  assert.equal(sksMenuBarRestartDeferred({ SKS_UPDATE_DEFER_MENUBAR_RESTART: '1' }), true);
  assert.equal(sksMenuBarRestartDeferred({ SKS_SKIP_SKS_MENUBAR_LAUNCH: '1' }), true);
  assert.equal(sksMenuBarRestartDeferred({ SKS_UPDATE_DEFER_MENUBAR_RESTART: '0' }), false);
  assert.equal(sksMenuBarRestartDeferred({}), false);
});

test('launchctl bootstrap timeout succeeds only when launchctl print confirms the service is running', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('bootstrap-timeout-running');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: fixture.open, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, true);
  assert.equal(launch.method, 'launchctl');
  assert.equal(launch.bootstrap_timed_out, true);
  assert.equal(launch.verified_running_after_timeout, true);
  assert.equal(launch.terminal_uncertain, false);
  assert.equal(await fs.stat(fixture.openMarker).then(() => true).catch(() => false), false);
});

test('launchctl bootstrap timeout is terminal uncertain and never masked by open fallback when state is unreadable', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd reliability contract is macOS-only');
  const fixture = await createFixture('bootstrap-timeout-unknown');
  t.after(fixture.cleanup);
  const launch = await launchMenuBar({ launchctl: fixture.launchctl, open: fixture.open, paths: fixture.paths, env: fixture.env });
  assert.equal(launch.ok, false);
  assert.equal(launch.method, 'launchctl');
  assert.equal(launch.bootstrap_timed_out, true);
  assert.equal(launch.verified_running_after_timeout, false);
  assert.equal(launch.terminal_uncertain, true);
  assert.equal(await fs.stat(fixture.openMarker).then(() => true).catch(() => false), false);
});

test('Menu Bar rollback validates then swaps the complete previous app generation before kickstart', async (t) => {
  if (process.platform !== 'darwin') return t.skip('codesign and launchd rollback contract is macOS-only');
  const fixture = await createFixture('success');
  t.after(fixture.cleanup);
  await writeArtifactSet(fixture.paths, 'active', '6.3.0', false);
  await writeArtifactSet(fixture.paths, 'previous', '6.2.0', true);

  const result = await rollbackSksMenuBar({ home: fixture.home, root: fixture.root, env: fixture.env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.previous_version, '6.2.0');
  assert.equal(result.replaced_version, '6.3.0');
  assert.equal(result.verification_before?.ok, true);
  assert.equal(result.verification_after?.ok, true);
  assert.equal(await fs.readFile(fixture.paths.executable_path, 'utf8'), 'previous:6.2.0\n');
  assert.equal(await fs.readFile(path.join(fixture.paths.backup_app_path, 'Contents', 'MacOS', 'SKSMenuBar'), 'utf8'), 'active:6.3.0\n');
  assert.equal(JSON.parse(await fs.readFile(fixture.paths.build_stamp_path, 'utf8')).package_version, '6.2.0');
  assert.equal(JSON.parse(await fs.readFile(fixture.paths.previous_build_stamp_path, 'utf8')).package_version, '6.3.0');
  assert.match(await fs.readFile(fixture.paths.action_script_path, 'utf8'), /previous:6\.2\.0/);
  assert.match(await fs.readFile(fixture.paths.previous_action_script_path, 'utf8'), /active:6\.3\.0/);
  assert.match(await fs.readFile(fixture.paths.launch_agent_path, 'utf8'), /previous:6\.2\.0/);
  assert.match(await fs.readFile(fixture.paths.previous_launch_agent_path, 'utf8'), /active:6\.3\.0/);
});

test('invalid previous resources fail closed without changing the active Menu Bar', async (t) => {
  if (process.platform !== 'darwin') return t.skip('codesign rollback contract is macOS-only');
  const fixture = await createFixture('success');
  t.after(fixture.cleanup);
  await writeArtifactSet(fixture.paths, 'active', '6.3.0', false);
  await writeArtifactSet(fixture.paths, 'previous', '6.2.0', true);
  await fs.writeFile(path.join(fixture.paths.backup_app_path, 'Contents', 'Resources', NATIVE_RESOURCE_FILES[0]!), 'tampered');

  const result = await rollbackSksMenuBar({ home: fixture.home, root: fixture.root, env: fixture.env, launch: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.ok(result.blockers.includes('rollback_resources_invalid'));
  assert.equal(await fs.readFile(fixture.paths.executable_path, 'utf8'), 'active:6.3.0\n');
  assert.equal(await fs.readFile(path.join(fixture.paths.backup_app_path, 'Contents', 'MacOS', 'SKSMenuBar'), 'utf8'), 'previous:6.2.0\n');
});

test('invalid previous launch agent fails closed without changing the active Menu Bar', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launch agent rollback contract is macOS-only');
  const fixture = await createFixture('success');
  t.after(fixture.cleanup);
  await writeArtifactSet(fixture.paths, 'active', '6.3.0', false);
  await writeArtifactSet(fixture.paths, 'previous', '6.2.0', true);
  await fs.appendFile(fixture.paths.previous_launch_agent_path, '<!-- tampered -->\n');

  const result = await rollbackSksMenuBar({ home: fixture.home, root: fixture.root, env: fixture.env, launch: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.ok(result.blockers.includes('rollback_launch_agent_hash_mismatch'));
  assert.equal(await fs.readFile(fixture.paths.executable_path, 'utf8'), 'active:6.3.0\n');
  assert.match(await fs.readFile(fixture.paths.launch_agent_path, 'utf8'), /active:6\.3\.0/);
});

test('verified filesystem rollback reports terminal_uncertain when launchd outcome cannot be read back', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd rollback contract is macOS-only');
  const fixture = await createFixture('timeout-unknown');
  t.after(fixture.cleanup);
  await writeArtifactSet(fixture.paths, 'active', '6.3.0', false);
  await writeArtifactSet(fixture.paths, 'previous', '6.2.0', true);

  const result = await rollbackSksMenuBar({ home: fixture.home, root: fixture.root, env: fixture.env });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'terminal_uncertain');
  assert.ok(result.blockers.includes('menubar_rollback_launch_terminal_uncertain'));
  assert.equal(result.verification_after?.ok, true);
  assert.equal(await fs.readFile(fixture.paths.executable_path, 'utf8'), 'previous:6.2.0\n');
});

test('rollback transaction reports the current failing pair after a forward rename fault and restores the active generation', async (t) => {
  if (process.platform !== 'darwin') return t.skip('rollback transaction contract is macOS-only');
  const fixture = await createFixture('success');
  t.after(fixture.cleanup);
  await writeArtifactSet(fixture.paths, 'active', '6.3.0', false);
  await writeArtifactSet(fixture.paths, 'previous', '6.2.0', true);
  const env = { ...fixture.env, SKS_MENUBAR_TRANSACTION_FAULT_AT: 'rollback:action_script:temp_to_backup:after' };

  const result = await rollbackSksMenuBar({ home: fixture.home, root: fixture.root, env, launch: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.transaction?.status, 'rolled_back');
  assert.equal(result.transaction?.failure_pair, 'action_script');
  assert.equal(result.transaction?.failure_point, 'temp_to_backup:after');
  assert.equal(result.transaction?.recovery_failure_pair, null);
  assert.equal(await fs.readFile(fixture.paths.executable_path, 'utf8'), 'active:6.3.0\n');
  assert.match(await fs.readFile(fixture.paths.action_script_path, 'utf8'), /active:6\.3\.0/);
});

test('rollback transaction preserves forward and reverse failure state and can resume recovery from its journal', async (t) => {
  if (process.platform !== 'darwin') return t.skip('rollback transaction contract is macOS-only');
  const fixture = await createFixture('success');
  t.after(fixture.cleanup);
  await writeArtifactSet(fixture.paths, 'active', '6.3.0', false);
  await writeArtifactSet(fixture.paths, 'previous', '6.2.0', true);
  const env = {
    ...fixture.env,
    SKS_MENUBAR_TRANSACTION_FAULT_AT: [
      'rollback:launch_agent:temp_to_backup:after',
      'rollback:launch_agent:recover_backup_to_active:before'
    ].join(',')
  };

  const result = await rollbackSksMenuBar({ home: fixture.home, root: fixture.root, env, launch: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'terminal_uncertain');
  assert.ok(result.blockers.includes('menubar_rollback_swap_terminal_uncertain'));
  assert.equal(result.transaction?.failure_pair, 'launch_agent');
  assert.equal(result.transaction?.failure_point, 'temp_to_backup:after');
  assert.equal(result.transaction?.recovery_failure_pair, 'launch_agent');
  assert.equal(result.transaction?.recovery_failure_point, 'recover_backup_to_active:before');
  const launchPair = result.transaction?.pairs.find((pair) => pair.kind === 'launch_agent');
  assert.equal(launchPair?.temporary_exists, true);
  assert.equal(await fs.stat(fixture.paths.rollback_transaction_path).then(() => true).catch(() => false), true);

  const resumed = await recoverMenuBarGenerationTransaction({
    purpose: 'rollback',
    journalPath: fixture.paths.rollback_transaction_path,
    pairs: rollbackGenerationPairs(fixture.paths),
    env: fixture.env
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed, null, 2));
  assert.equal(await fs.readFile(fixture.paths.executable_path, 'utf8'), 'active:6.3.0\n');
  assert.match(await fs.readFile(fixture.paths.launch_agent_path, 'utf8'), /active:6\.3\.0/);
});

test('6.2 v1 rollback metadata is normalized only after every legacy hash and signature verifies', async (t) => {
  if (process.platform !== 'darwin') return t.skip('legacy Menu Bar signature verification is macOS-only');
  const fixture = await createFixture('success');
  t.after(fixture.cleanup);
  const sourcePath = path.join(fixture.paths.install_dir, 'SKSMenuBar.swift');
  const source = 'import Cocoa\nprint("SKS 6.2.0 fixture")\n';
  const action = '#!/bin/sh\necho "sneakoscope 6.2.0"\n';
  const info = '<plist><dict><key>CFBundleShortVersionString</key><string>6.2.0</string></dict></plist>\n';
  const launch = '<plist><dict><key>Label</key><string>com.sneakoscope.sks-menubar</string></dict></plist>\n';
  await fs.mkdir(path.dirname(fixture.paths.executable_path), { recursive: true });
  await fs.writeFile(fixture.paths.executable_path, 'legacy-6.2.0-binary\n', { mode: 0o755 });
  await fs.writeFile(sourcePath, source);
  await fs.writeFile(fixture.paths.info_plist_path, info);
  await fs.writeFile(fixture.paths.action_script_path, action, { mode: 0o755 });
  await fs.writeFile(fixture.paths.launch_agent_path, launch);
  const legacy = {
    schema: 'sks.sks-menubar-build-stamp.v1',
    package_version: '6.2.0',
    source_sha256: sha256(source),
    action_script_sha256: sha256(action),
    info_plist_sha256: sha256(info),
    launch_agent_sha256: sha256(launch),
    swiftc_version: 'Swift 6.2 fixture',
    codesign_identifier: 'com.sneakoscope.sks-menubar'
  } as const;
  await fs.writeFile(fixture.paths.build_stamp_path, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  const normalized = await normalizeLegacyMenuBarBuildStamp({
    appPath: fixture.paths.app_path,
    legacySourcePath: sourcePath,
    buildStampPath: fixture.paths.build_stamp_path,
    actionScript: action,
    launchAgentPath: fixture.paths.launch_agent_path,
    env: fixture.env
  });
  assert.equal(normalized.ok, true, JSON.stringify(normalized, null, 2));
  assert.equal(normalized.stamp?.schema, 'sks.sks-menubar-build-stamp.v2');
  assert.equal(normalized.stamp?.package_version, '6.2.0');
  assert.equal(normalized.stamp?.legacy_v1?.original_schema, legacy.schema);
  assert.equal(normalized.stamp?.legacy_v1?.source_file_sha256, legacy.source_sha256);
  assert.equal(normalized.stamp?.legacy_v1?.executable_sha256, sha256('legacy-6.2.0-binary\n'));
  assert.deepEqual(normalized.stamp?.resource_files_sha256, {});

  await fs.writeFile(sourcePath, `${source}// tampered\n`);
  const rejected = await normalizeLegacyMenuBarBuildStamp({
    appPath: fixture.paths.app_path,
    legacySourcePath: sourcePath,
    buildStampPath: fixture.paths.build_stamp_path,
    actionScript: action,
    launchAgentPath: fixture.paths.launch_agent_path,
    env: fixture.env
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.blockers.includes('legacy_source_hash_mismatch'));
});

async function createFixture(mode: 'success' | 'success-spawn-stuck' | 'success-print-unknown' | 'timeout-running' | 'timeout-unknown' | 'timeout-spawn-running' | 'timeout-spawn-stuck' | 'bootstrap-timeout-running' | 'bootstrap-timeout-unknown' | 'missing-service-recover') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-reliability-'));
  const home = path.join(temp, 'home');
  const root = path.join(temp, 'root');
  const paths = sksMenuBarPaths(home, root);
  await fs.mkdir(path.dirname(paths.launch_agent_path), { recursive: true });
  await fs.mkdir(paths.install_dir, { recursive: true });
  const launchctl = path.join(temp, 'fake-launchctl');
  const printCountPath = path.join(temp, 'print-count');
  const bootstrappedPath = path.join(temp, 'bootstrapped');
  await fs.writeFile(launchctl, `#!${process.execPath}
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const printCountPath = ${JSON.stringify(printCountPath)};
const bootstrappedPath = ${JSON.stringify(bootstrappedPath)};
const command = process.argv[2] || '';
if (command === 'bootstrap' && mode.startsWith('bootstrap-timeout-')) {
  process.on('SIGTERM', () => process.exit(124));
  setInterval(() => {}, 1000);
} else if (command === 'bootstrap' && mode === 'missing-service-recover') {
  fs.writeFileSync(bootstrappedPath, '1');
  process.exit(0);
} else if (command === 'kickstart' && mode === 'missing-service-recover') {
  if (!fs.existsSync(bootstrappedPath)) {
    process.stderr.write('Could not find service "com.sneakoscope.sks-menubar" in domain for user gui: 501\\n');
    process.exit(113);
  }
  process.exit(0);
} else if (command === 'kickstart' && mode.startsWith('timeout-')) {
  process.on('SIGTERM', () => process.exit(124));
  setInterval(() => {}, 1000);
} else if (command === 'print') {
  const printCount = Number(fs.existsSync(printCountPath) ? fs.readFileSync(printCountPath, 'utf8') : '0') + 1;
  fs.writeFileSync(printCountPath, String(printCount));
  if (mode === 'success' || mode === 'timeout-running' || mode === 'bootstrap-timeout-running' || (mode === 'missing-service-recover' && fs.existsSync(bootstrappedPath)) || (mode === 'timeout-spawn-running' && printCount >= 3)) {
    process.stdout.write('active count = 1\\nstate = running\\npid = 4242\\n');
    process.exit(0);
  }
  if (mode === 'missing-service-recover') {
    process.stdout.write('active count = 0\\nstate = spawn scheduled\\n');
    process.exit(0);
  }
  if (mode === 'timeout-spawn-running' || mode === 'timeout-spawn-stuck' || mode === 'success-spawn-stuck') {
    process.stdout.write('active count = 0\\nstate = spawn scheduled\\ninherited environment = {\\n  SECRET => SENSITIVE_LAUNCH_VALUE\\n}\\n');
    process.exit(0);
  }
  process.stderr.write('service state unavailable\\n');
  process.exit(3);
} else {
  process.exit(0);
}
`, { mode: 0o755 });
  const openMarker = path.join(temp, 'open-invoked');
  const open = path.join(temp, 'fake-open');
  await fs.writeFile(open, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(openMarker)}, 'invoked\\n');\n`, { mode: 0o755 });
  const codesign = path.join(temp, 'fake-codesign');
  await fs.writeFile(codesign, `#!${process.execPath}
if (process.argv.includes('-dv')) process.stderr.write('Identifier=com.sneakoscope.sks-menubar\\n');
process.exit(0);
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SKS_MENUBAR_LAUNCHCTL: launchctl,
    SKS_MENUBAR_OPEN: open,
    SKS_MENUBAR_CODESIGN: codesign,
    SKS_MENUBAR_BOOTSTRAP_TIMEOUT_MS: mode.startsWith('bootstrap-timeout-') ? '250' : '2000',
    SKS_MENUBAR_KICKSTART_TIMEOUT_MS: mode.startsWith('success') ? '3000' : '250',
    SKS_MENUBAR_PRINT_TIMEOUT_MS: '2000',
    SKS_MENUBAR_LAUNCH_READBACK_TIMEOUT_MS: mode === 'success-print-unknown'
      ? '3000'
      : mode === 'timeout-spawn-running'
        ? '6000'
        : mode === 'timeout-spawn-stuck'
          ? '3000'
          : '1500',
    SKS_MENUBAR_LAUNCH_READBACK_INTERVAL_MS: '50'
  };
  // The release DAG disables real Menu Bar launches globally. These fixtures
  // use only temp paths and fake launchctl/open binaries, so retain the launch
  // path under test instead of inheriting the gate-level safety skip.
  delete env.SKS_SKIP_SKS_MENUBAR_LAUNCH;
  return {
    temp,
    home,
    root,
    paths,
    launchctl,
    open,
    openMarker,
    printCountPath,
    env,
    cleanup: () => fs.rm(temp, { recursive: true, force: true })
  };
}

async function readCount(file: string): Promise<number> {
  return Number(await fs.readFile(file, 'utf8').catch(() => '0')) || 0;
}

async function writeArtifactSet(
  paths: ReturnType<typeof sksMenuBarPaths>,
  marker: 'active' | 'previous',
  version: string,
  backup: boolean
) {
  const appPath = backup ? paths.backup_app_path : paths.app_path;
  const stampPath = backup ? paths.previous_build_stamp_path : paths.build_stamp_path;
  const actionPath = backup ? paths.previous_action_script_path : paths.action_script_path;
  const launchAgentPath = backup ? paths.previous_launch_agent_path : paths.launch_agent_path;
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'SKSMenuBar');
  const infoPlist = `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`;
  const actionScript = `#!/bin/sh\necho ${marker}:${version}\n`;
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.writeFile(executable, `${marker}:${version}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(appPath, 'Contents', 'Info.plist'), infoPlist);
  const resourceHashes: Record<string, string> = {};
  for (const name of NATIVE_RESOURCE_FILES) {
    const bytes = Buffer.from(`${marker}:${version}:${name}\n`);
    await fs.writeFile(path.join(resourcesDir, name), bytes);
    resourceHashes[name] = sha256(bytes);
  }
  await fs.writeFile(actionPath, actionScript, { mode: 0o755 });
  const launchAgent = `<plist><dict><key>Label</key><string>com.sneakoscope.sks-menubar</string><key>Generation</key><string>${marker}:${version}</string></dict></plist>\n`;
  await fs.writeFile(launchAgentPath, launchAgent);
  const stamp: SksMenuBarBuildStamp = {
    schema: 'sks.sks-menubar-build-stamp.v2',
    package_version: version,
    source_sha256: sha256(`${marker}:${version}:source`),
    source_files_sha256: {},
    resources_sha256: aggregateFileHashes(resourceHashes),
    resource_files_sha256: resourceHashes,
    action_script_sha256: sha256(actionScript),
    info_plist_sha256: sha256(infoPlist),
    launch_agent_sha256: sha256(launchAgent),
    swiftc_version: 'Swift test',
    codesign_identifier: 'com.sneakoscope.sks-menubar'
  };
  await fs.writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 });
}
