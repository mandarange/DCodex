import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_VERSION, runProcess, sha256, which } from '../core/fsx.js';
import {
  aggregateFileHashes,
  installSksMenuBar,
  NATIVE_RESOURCE_FILES,
  NATIVE_SOURCE_FILES,
  rollbackSksMenuBar,
  type SksMenuBarBuildStamp
} from '../core/codex-app/menubar/index.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-check-'));
const fakeRoot = path.join(temp, 'project-root');
await fs.mkdir(fakeRoot, { recursive: true });
const firstEntry = await writeProbeEntry(path.join(fakeRoot, 'first', 'dist', 'bin', 'sks.js'));
const replacementEntry = await writeProbeEntry(path.join(fakeRoot, 'replacement', 'dist', 'bin', 'sks.js'));
const env = { ...process.env, SKS_SKIP_SKS_MENUBAR_LAUNCH: '1' };

const initialResult = await installSksMenuBar({
  apply: true, launch: false, home: temp, root: fakeRoot, sksEntry: firstEntry, env, quiet: true
});

if (process.platform !== 'darwin') {
  const ok = initialResult.ok && initialResult.status === 'unsupported_platform';
  console.log(JSON.stringify({
    schema: 'sks.sks-menubar-install-check.v2', ok, temp, result: initialResult,
    is_idempotent: false, previous_app_rollback_verified: false, actual_rollback_verified: false,
    resource_sha256: null, resources_sha256: null,
    blockers: ok ? [] : ['sks_menubar_install_check_failed']
  }, null, 2));
  if (!ok) process.exit(1);
  process.exit(0);
}

const initialAppPath = required(initialResult.app_path, 'initial app path');
const initialExecutable = required(initialResult.executable_path, 'initial executable path');
const initialStamp = required(initialResult.build_stamp, 'initial build stamp');
const installDir = path.dirname(initialAppPath);
const initialExecutableSha256 = sha256(await fs.readFile(initialExecutable));
const initialInfoPlistSha256 = sha256(await fs.readFile(path.join(initialAppPath, 'Contents', 'Info.plist')));
const initialActionScript = await fs.readFile(required(initialResult.action_script_path, 'initial action script path'), 'utf8');
const initialLaunchAgent = await fs.readFile(required(initialResult.launch_agent_path, 'initial launch agent path'), 'utf8');

const secondResult = await installSksMenuBar({
  apply: true, launch: false, home: temp, root: fakeRoot, sksEntry: firstEntry, env, quiet: true
});
const secondExecutableSha256 = sha256(await fs.readFile(required(secondResult.executable_path, 'second executable path')));
const isIdempotent = secondResult.ok
  && secondResult.actions.includes('menubar_up_to_date')
  && secondExecutableSha256 === initialExecutableSha256
  && secondResult.build_stamp?.source_sha256 === initialStamp.source_sha256
  && secondResult.build_stamp?.resources_sha256 === initialStamp.resources_sha256;

// Changing only the pinned package entry is a legitimate upgrade input. It
// forces a fresh staging build without corrupting the currently installed app,
// so the resulting .previous bundle is a valid rollback candidate.
const result = await installSksMenuBar({
  apply: true, launch: false, home: temp, root: fakeRoot, sksEntry: replacementEntry, env, quiet: true
});
const appPath = required(result.app_path, 'final app path');
const executablePath = required(result.executable_path, 'final executable path');
const buildStamp = required(result.build_stamp, 'final build stamp');
const resourcesDir = path.join(appPath, 'Contents', 'Resources');
const sourcesDir = path.join(installDir, 'Sources');
const previousAppPath = `${appPath}.previous`;
const previousExecutablePath = path.join(previousAppPath, 'Contents', 'MacOS', 'SKSMenuBar');
const previousBuildStampPath = path.join(installDir, 'build-stamp.json.previous');
const previousActionScriptPath = path.join(installDir, 'sks-menubar-action.sh.previous');
const previousLaunchAgentPath = path.join(installDir, 'com.sneakoscope.sks-menubar.plist.previous');

const installedSourceNames = (await fs.readdir(sourcesDir)).sort();
const installedResourceNames = (await fs.readdir(resourcesDir)).sort();
const sourceHashes = await hashNamedFiles(sourcesDir, [...NATIVE_SOURCE_FILES]);
const resourceHashes = await hashNamedFiles(resourcesDir, [...NATIVE_RESOURCE_FILES]);
const sourceSha256 = aggregateFileHashes(sourceHashes);
const resourcesSha256 = aggregateFileHashes(resourceHashes);
const sourceBindingVerified = sourceSha256 === buildStamp.source_sha256
  && recordsEqual(sourceHashes, buildStamp.source_files_sha256);
const resourceBindingVerified = resourcesSha256 === buildStamp.resources_sha256
  && recordsEqual(resourceHashes, buildStamp.resource_files_sha256);

const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
const infoPlist = await fs.readFile(infoPlistPath, 'utf8');
const infoPlistIconVerified = /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/.test(infoPlist)
  && /<key>CFBundleDisplayName<\/key>\s*<string>SKS<\/string>/.test(infoPlist)
  && /<key>LSUIElement<\/key>\s*<true\/>/.test(infoPlist)
  && sha256(infoPlist) === buildStamp.info_plist_sha256;
const appIconPath = path.join(resourcesDir, 'AppIcon.icns');
const iconLoadSmoke = await imageLoadSmoke(appIconPath);
const signature = await strictCodesign(appPath);
const previousSignature = await strictCodesign(previousAppPath);
const swiftCompile = result.actions.includes(`compiled ${NATIVE_SOURCE_FILES.length} Swift sources`);
const swiftParse = await swiftParseSmoke(sourcesDir);
const actionScriptExecutable = await isExecutable(required(result.action_script_path, 'final action script path'));
const launchAgent = await fs.readFile(required(result.launch_agent_path, 'launch agent path'), 'utf8');
const launchAgentSafe = !launchAgent.includes('<key>KeepAlive</key>')
  && !launchAgent.includes('EnvironmentVariables')
  && launchAgent.includes('<key>ProcessType</key>')
  && launchAgent.includes('<string>Interactive</string>');

const nativeSources = await Promise.all(NATIVE_SOURCE_FILES.map((name) => fs.readFile(path.join(sourcesDir, name), 'utf8')));
const nativeSource = nativeSources.join('\n');
const notificationContract = ['SKS_OPERATION_RESULT', 'SKS_UPDATE_AVAILABLE', 'SKS_ACTION_REQUIRED',
  'OPEN_CONTROL_CENTER', 'OPEN_LOG', 'RETRY_OPERATION']
  .every((token) => nativeSource.includes(token))
  && !nativeSource.includes('OPEN_DASHBOARD')
  && !nativeSource.includes('onOpenDashboard')
  && nativeSource.includes('UNUserNotificationCenterDelegate')
  && nativeSource.includes('didReceive response: UNNotificationResponse')
  && !nativeSource.includes('display notification')
  && !nativeSource.includes('runModal(');
const notificationRuntime = await notificationRuntimeSmoke(sourcesDir);
const notificationActionTest = notificationContract && notificationRuntime.ok;
const accessibilitySmoke = nativeSource.includes('setAccessibilityLabel("Control Center sections")')
  && nativeSource.includes('setAccessibilityLabel("Effective MCP servers")')
  && nativeSource.includes('button.setAccessibilityLabel(title)');
const reducedMotionSmoke = nativeSource.includes('accessibilityDisplayShouldReduceMotion')
  && !nativeSource.includes('NSAnimationContext')
  && !nativeSource.includes('animator()');
const upgradedActionScriptSha256 = sha256(await fs.readFile(required(result.action_script_path, 'final action script path')));

const previousBuildStamp = await readJson<SksMenuBarBuildStamp>(previousBuildStampPath);
const previousActionScript = await fs.readFile(previousActionScriptPath, 'utf8').catch(() => '');
const previousLaunchAgent = await fs.readFile(previousLaunchAgentPath, 'utf8').catch(() => '');
const previousResources = await hashNamedFiles(path.join(previousAppPath, 'Contents', 'Resources'), [...NATIVE_RESOURCE_FILES]).catch(() => ({}));
const committedInstallGeneration = result.transaction?.status === 'committed'
  && result.transaction.pairs.length === 4
  && result.transaction.pairs.every((pair) => pair.active_exists
    && pair.backup_exists
    && !pair.staged_exists
    && !pair.temporary_exists
    && !pair.displaced_exists);
const previousAppRollbackVerified = await exists(previousExecutablePath)
  && sha256(await fs.readFile(previousExecutablePath)) === initialExecutableSha256
  && previousSignature.ok
  && previousBuildStamp?.source_sha256 === initialStamp.source_sha256
  && previousBuildStamp?.resources_sha256 === initialStamp.resources_sha256
  && recordsEqual(previousResources, initialStamp.resource_files_sha256)
  && sha256(await fs.readFile(path.join(previousAppPath, 'Contents', 'Info.plist'))) === initialInfoPlistSha256
  && previousActionScript === initialActionScript
  && previousLaunchAgent === initialLaunchAgent
  && committedInstallGeneration
  && result.actions.includes(`preserved complete previous generation at ${previousAppPath}`);
const rollbackResult = previousAppRollbackVerified
  ? await rollbackSksMenuBar({ home: temp, root: fakeRoot, env, launch: false })
  : null;
const restoredStamp = await readJson<SksMenuBarBuildStamp>(path.join(installDir, 'build-stamp.json'));
const restoredResources = await hashNamedFiles(path.join(appPath, 'Contents', 'Resources'), [...NATIVE_RESOURCE_FILES]).catch(() => ({}));
const committedRollbackGeneration = rollbackResult?.transaction?.status === 'committed'
  && rollbackResult.transaction.pairs.length === 4
  && rollbackResult.transaction.pairs.every((pair) => pair.active_exists
    && pair.backup_exists
    && !pair.temporary_exists
    && !pair.displaced_exists);
const actualRollbackVerified = rollbackResult?.ok === true
  && rollbackResult.status === 'rolled_back_launch_skipped'
  && rollbackResult.verification_before?.ok === true
  && rollbackResult.verification_after?.ok === true
  && sha256(await fs.readFile(executablePath)) === initialExecutableSha256
  && restoredStamp?.source_sha256 === initialStamp.source_sha256
  && restoredStamp?.resources_sha256 === initialStamp.resources_sha256
  && recordsEqual(restoredResources, initialStamp.resource_files_sha256)
  && await fs.readFile(required(result.action_script_path, 'final action script path'), 'utf8') === initialActionScript
  && await fs.readFile(required(result.launch_agent_path, 'final launch agent path'), 'utf8') === initialLaunchAgent
  && committedRollbackGeneration;

const expectedResourcesPresent = [
  'AppIcon.icns', 'SKSStatusTemplate.pdf', 'SKSStatusUpdateTemplate.pdf',
  'SKSStatusWarningTemplate.pdf', 'SKSStatusAttentionTemplate.pdf'
].every((name) => installedResourceNames.includes(name));
const buildStampVersionSourceBinding = buildStamp.package_version === PACKAGE_VERSION
  && buildStamp.codesign_identifier === 'com.sneakoscope.sks-menubar'
  && buildStamp.action_script_sha256 === upgradedActionScriptSha256
  && sourceBindingVerified
  && resourceBindingVerified;

const checks = {
  install_ok: result.ok && result.status === 'installed_launch_skipped',
  app_bundle_exists: await exists(appPath) && await exists(executablePath),
  swift_compile: swiftCompile,
  swift_parse: swiftParse.ok,
  source_inventory: recordsEqual(
    Object.fromEntries(installedSourceNames.map((name) => [name, 'present'])),
    Object.fromEntries([...NATIVE_SOURCE_FILES].sort().map((name) => [name, 'present']))
  ),
  resources_inventory: recordsEqual(
    Object.fromEntries(installedResourceNames.map((name) => [name, 'present'])),
    Object.fromEntries([...NATIVE_RESOURCE_FILES].sort().map((name) => [name, 'present']))
  ),
  expected_resources_present: expectedResourcesPresent,
  info_plist_icon_verified: infoPlistIconVerified,
  app_icon_load_smoke: iconLoadSmoke.ok,
  codesign_strict_verified: signature.ok,
  codesign_identifier_verified: signature.identifier === 'com.sneakoscope.sks-menubar',
  action_script_executable: actionScriptExecutable,
  launch_agent_safe: launchAgentSafe,
  notification_action_test: notificationActionTest,
  accessibility_smoke: accessibilitySmoke,
  reduced_motion_smoke: reducedMotionSmoke,
  build_stamp_version_source_binding: buildStampVersionSourceBinding,
  is_idempotent: isIdempotent,
  previous_app_rollback_verified: previousAppRollbackVerified,
  actual_rollback_verified: actualRollbackVerified
};
const failedChecks = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
const ok = failedChecks.length === 0;
const report = {
  schema: 'sks.sks-menubar-install-check.v2',
  ok,
  temp,
  result,
  initial_result: initialResult,
  second_result: secondResult,
  checks,
  is_idempotent: isIdempotent,
  previous_app_path: previousAppPath,
  previous_app_rollback_verified: previousAppRollbackVerified,
  actual_rollback_verified: actualRollbackVerified,
  rollback_result: rollbackResult,
  resource_sha256: resourcesSha256,
  resources_sha256: resourcesSha256,
  resource_files_sha256: resourceHashes,
  source_sha256: sourceSha256,
  source_files_sha256: sourceHashes,
  build_stamp_version_source_binding: buildStampVersionSourceBinding,
  signature,
  previous_signature: previousSignature,
  icon_load_smoke: iconLoadSmoke,
  notification_runtime: notificationRuntime,
  swift_parse: swiftParse,
  installed_source_names: installedSourceNames,
  installed_resource_names: installedResourceNames,
  failed_checks: failedChecks,
  blockers: ok ? [] : ['sks_menubar_install_check_failed']
};

console.log(JSON.stringify(report, null, 2));
if (!ok) process.exit(1);

async function writeProbeEntry(file: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    '#!/usr/bin/env node',
    `console.log('sks ${PACKAGE_VERSION}');`,
    ''
  ].join('\n'), { mode: 0o755 });
  return file;
}

async function hashNamedFiles(directory: string, names: string[]): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const name of names) output[name] = sha256(await fs.readFile(path.join(directory, name)));
  return output;
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}

async function strictCodesign(appPath: string): Promise<{ ok: boolean; identifier: string | null; verify_code: number | null; detail_code: number | null; error: string | null }> {
  const codesign = await which('codesign').catch(() => null) || '/usr/bin/codesign';
  const verify = await runProcess(codesign, ['--verify', '--deep', '--strict', appPath], { timeoutMs: 20_000, maxOutputBytes: 32 * 1024 })
    .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  const detail = await runProcess(codesign, ['-dv', '--verbose=4', appPath], { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 })
    .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  const detailText = `${detail.stdout || ''}\n${detail.stderr || ''}`;
  const identifier = detailText.match(/\bIdentifier=([^\n]+)/)?.[1]?.trim() || null;
  return {
    ok: verify.code === 0 && detail.code === 0,
    identifier,
    verify_code: verify.code,
    detail_code: detail.code,
    error: verify.code === 0 && detail.code === 0 ? null : String(verify.stderr || detail.stderr || detail.stdout).trim()
  };
}

async function imageLoadSmoke(iconPath: string): Promise<{ ok: boolean; width: number | null; height: number | null; code: number | null; error: string | null }> {
  const sips = await which('sips').catch(() => null) || '/usr/bin/sips';
  const result = await runProcess(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', iconPath], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 })
    .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const width = Number(text.match(/pixelWidth:\s*(\d+)/)?.[1] || '') || null;
  const height = Number(text.match(/pixelHeight:\s*(\d+)/)?.[1] || '') || null;
  return { ok: result.code === 0 && Boolean(width && height), width, height, code: result.code, error: result.code === 0 ? null : text.trim() };
}

async function swiftParseSmoke(sourcesDir: string): Promise<{ ok: boolean; code: number | null; error: string | null }> {
  const swiftc = await which('swiftc').catch(() => null) || '/usr/bin/swiftc';
  const files = NATIVE_SOURCE_FILES.map((name) => path.join(sourcesDir, name));
  const result = await runProcess(swiftc, ['-parse', ...files], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 })
    .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  return { ok: result.code === 0, code: result.code, error: result.code === 0 ? null : String(result.stderr || result.stdout).trim() };
}

async function notificationRuntimeSmoke(sourcesDir: string): Promise<{ ok: boolean; compile_code: number | null; run_code: number | null; error: string | null }> {
  const swiftc = await which('swiftc').catch(() => null) || '/usr/bin/swiftc';
  const harness = path.join(temp, 'NotificationHarness.swift');
  const binary = path.join(temp, 'notification-runtime');
  await fs.writeFile(harness, `
import Foundation
import UserNotifications

@main
struct NotificationHarness {
    static func main() {
        let coordinator = NotificationCoordinator()
        var calls: [String] = []
        coordinator.onOpenControlCenter = { calls.append("center") }
        coordinator.onOpenLog = { calls.append("log") }
        coordinator.onRetryOperation = { calls.append("retry") }
        let routes = [
            coordinator.dispatchActionIdentifier("OPEN_LOG"),
            coordinator.dispatchActionIdentifier("RETRY_OPERATION"),
            coordinator.dispatchActionIdentifier("OPEN_CONTROL_CENTER"),
            coordinator.dispatchActionIdentifier(UNNotificationDismissActionIdentifier)
        ]
        precondition(routes == ["open_log", "retry_operation", "open_control_center", "dismissed"])
        precondition(calls == ["log", "retry", "center"])
        precondition(NotificationCoordinator.authorizationIsDenied(.denied))
        precondition(!NotificationCoordinator.authorizationIsDenied(.authorized))
        precondition(!NotificationCoordinator.authorizationIsDenied(.notDetermined))
        precondition(NotificationCoordinator.categoryIdentifier() == "SKS_OPERATION_RESULT")
        precondition(NotificationCoordinator.categoryIdentifier(failed: true) == "SKS_ACTION_REQUIRED")
        let available = #"{"schema":"sks.update-status.v3","update_count":1}"#
        precondition(NotificationCoordinator.updateIsAvailable(in: available))
        precondition(NotificationCoordinator.categoryIdentifier(updateStatusOutput: available) == "SKS_UPDATE_AVAILABLE")
    }
}
`);
  const compiled = await runProcess(swiftc, [path.join(sourcesDir, 'NotificationCoordinator.swift'), harness, '-o', binary], {
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024
  }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  if (compiled.code !== 0) {
    return { ok: false, compile_code: compiled.code, run_code: null, error: String(compiled.stderr || compiled.stdout).trim() };
  }
  const executed = await runProcess(binary, [], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 })
    .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  return {
    ok: executed.code === 0,
    compile_code: compiled.code,
    run_code: executed.code,
    error: executed.code === 0 ? null : String(executed.stderr || executed.stdout).trim()
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch { return null; }
}

async function isExecutable(file: string): Promise<boolean> {
  return fs.access(file, fs.constants.X_OK).then(() => true).catch(() => false);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true).catch(() => false);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}
