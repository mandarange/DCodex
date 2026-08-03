import fs from 'node:fs/promises';
import path from 'node:path';
import { withHeartbeat } from '../../../cli/cli-theme.js';
import { ensureDir, exists, runProcess, writeTextAtomic } from '../../fsx.js';
import { SKS_MENUBAR_LABEL } from './constants.js';
import { copyNativeResources, materializeNativeSources } from './resources.js';
import type { NativeSourceInput } from './types.js';
import type { sksMenuBarPaths } from './paths.js';

export async function buildMenuBarAppStaging(input: {
  paths: ReturnType<typeof sksMenuBarPaths>;
  swiftc: string;
  codesign: string;
  runtime: NativeSourceInput;
  infoPlist: string;
  actions: string[];
  quiet?: boolean;
}): Promise<{
  sourceSha256: string;
  sourceHashes: Record<string, string>;
  resourceHashes: Record<string, string>;
}> {
  const stagingContents = path.join(input.paths.staging_app_path, 'Contents');
  const stagingMacOS = path.join(stagingContents, 'MacOS');
  const stagingResources = path.join(stagingContents, 'Resources');
  await fs.rm(input.paths.staging_app_path, { recursive: true, force: true });
  await ensureDir(stagingMacOS);
  await ensureDir(stagingResources);
  const sources = await materializeNativeSources({ targetDir: input.paths.sources_path, runtime: input.runtime });
  const resourceHashes = await copyNativeResources(stagingResources);
  await writeTextAtomic(path.join(stagingContents, 'Info.plist'), input.infoPlist);
  if (!/<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/.test(input.infoPlist)) {
    throw new MenuBarBuildError('menubar_info_plist_icon_missing', 'CFBundleIconFile=AppIcon is required');
  }
  if (!(await exists(path.join(stagingResources, 'AppIcon.icns')))) {
    throw new MenuBarBuildError('menubar_app_icon_missing', 'Contents/Resources/AppIcon.icns is required');
  }
  const executable = path.join(stagingMacOS, 'SKSMenuBar');
  const compileWork = runProcess(input.swiftc, [
    '-framework', 'Cocoa',
    '-framework', 'LocalAuthentication',
    '-framework', 'Security',
    '-framework', 'UserNotifications',
    ...sources.files,
    '-o', executable
  ], { timeoutMs: 90_000, maxOutputBytes: 128 * 1024 });
  const compile = input.quiet ? await compileWork : await withHeartbeat('swiftc SKS Control Center', compileWork, { warnAfterMs: 30_000 });
  if (compile.code !== 0) throw new MenuBarBuildError('swift_compile_failed', String(compile.stderr || compile.stdout).trim());
  await fs.chmod(executable, 0o755);
  input.actions.push(`compiled ${sources.files.length} Swift sources`);

  const signed = await runProcess(input.codesign, [
    '--force', '--sign', '-', '--identifier', SKS_MENUBAR_LABEL, input.paths.staging_app_path
  ], { timeoutMs: 20_000, maxOutputBytes: 32 * 1024 });
  if (signed.code !== 0) throw new MenuBarBuildError('codesign_failed', String(signed.stderr || signed.stdout).trim());
  const verified = await runProcess(input.codesign, ['--verify', '--deep', '--strict', input.paths.staging_app_path], {
    timeoutMs: 20_000, maxOutputBytes: 32 * 1024
  });
  if (verified.code !== 0) throw new MenuBarBuildError('codesign_verify_failed', String(verified.stderr || verified.stdout).trim());
  input.actions.push(`signed and verified ${input.paths.staging_app_path}`);

  input.actions.push(`prepared ${input.paths.staging_app_path}`);
  return { sourceSha256: sources.combinedSha256, sourceHashes: sources.hashes, resourceHashes };
}

export class MenuBarBuildError extends Error {
  constructor(readonly blocker: string, message: string) {
    super(message || blocker);
  }
}
