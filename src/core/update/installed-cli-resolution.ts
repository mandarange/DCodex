import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../fsx.js';
import { extractSemVer } from './semver.js';

export const INSTALLED_CLI_RESOLUTION_SCHEMA = 'sks.installed-cli-resolution.v1' as const;

export interface InstalledCliResolution {
  schema: typeof INSTALLED_CLI_RESOLUTION_SCHEMA;
  ok: boolean;
  expected_version: string;
  global_root: string | null;
  package_root: string | null;
  manifest_name: string | null;
  manifest_version: string | null;
  entrypoint: string | null;
  entrypoint_version: string | null;
  path_binary: string | null;
  path_realpath: string | null;
  path_version: string | null;
  path_targets_entrypoint: boolean;
  blockers: string[];
  warnings: string[];
}

export async function inspectInstalledCliResolution(input: {
  packageName?: string;
  expectedVersion: string;
  globalRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<InstalledCliResolution> {
  const packageName = input.packageName || 'sneakoscope';
  const expectedVersion = extractSemVer(input.expectedVersion) || input.expectedVersion;
  const globalRoot = input.globalRoot ? path.resolve(input.globalRoot) : null;
  const env = input.env || process.env;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const validPackageName = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName);
  if (!validPackageName) blockers.push('installed_cli_package_name_invalid');
  if (!globalRoot) blockers.push('installed_cli_global_root_missing');

  const packageRoot = validPackageName && globalRoot
    ? path.resolve(globalRoot, ...packageName.split('/'))
    : null;
  if (packageRoot && !pathIsWithin(globalRoot!, packageRoot)) {
    blockers.push('installed_cli_package_root_escaped_global_root');
  }

  const manifest = packageRoot
    ? await readJsonRecord(path.join(packageRoot, 'package.json'))
    : null;
  const manifestName = typeof manifest?.name === 'string' ? manifest.name : null;
  const manifestVersion = typeof manifest?.version === 'string'
    ? extractSemVer(manifest.version)
    : null;
  if (!manifest) blockers.push('installed_cli_manifest_missing');
  else {
    if (manifestName !== packageName) blockers.push('installed_cli_manifest_name_mismatch');
    if (manifestVersion !== expectedVersion) blockers.push('installed_cli_manifest_version_mismatch');
  }

  const entrypointCandidate = packageRoot ? path.join(packageRoot, 'dist', 'bin', 'sks.js') : null;
  const entrypoint = entrypointCandidate && await isRegularFile(entrypointCandidate)
    ? entrypointCandidate
    : null;
  if (!entrypoint) blockers.push('installed_cli_entrypoint_missing');
  const entrypointVersion = entrypoint
    ? await probeVersion(process.execPath, [entrypoint, '--version'], env, input)
    : null;
  if (entrypoint && entrypointVersion !== expectedVersion) {
    blockers.push('installed_cli_entrypoint_version_mismatch');
  }

  const pathBinary = await executableOnInjectedPath('sks', env);
  if (!pathBinary) blockers.push('installed_cli_path_binary_missing');
  const pathVersion = pathBinary
    ? await probeVersion(pathBinary, ['--version'], env, input)
    : null;
  if (pathBinary && pathVersion !== expectedVersion) {
    blockers.push('installed_cli_path_version_mismatch');
  }

  const [pathRealpath, entrypointRealpath] = await Promise.all([
    pathBinary ? fs.realpath(pathBinary).catch(() => path.resolve(pathBinary)) : Promise.resolve(null),
    entrypoint ? fs.realpath(entrypoint).catch(() => path.resolve(entrypoint)) : Promise.resolve(null)
  ]);
  const pathTargetsEntrypoint = Boolean(
    pathRealpath
    && entrypointRealpath
    && path.resolve(pathRealpath) === path.resolve(entrypointRealpath)
  ) || Boolean(pathBinary && entrypoint && await shimReferencesEntrypoint(pathBinary, entrypoint));
  if (pathBinary && pathVersion === expectedVersion && !pathTargetsEntrypoint) {
    blockers.push('installed_cli_path_target_mismatch');
  }

  return {
    schema: INSTALLED_CLI_RESOLUTION_SCHEMA,
    ok: blockers.length === 0,
    expected_version: expectedVersion,
    global_root: globalRoot,
    package_root: packageRoot,
    manifest_name: manifestName,
    manifest_version: manifestVersion,
    entrypoint,
    entrypoint_version: entrypointVersion,
    path_binary: pathBinary,
    path_realpath: pathRealpath,
    path_version: pathVersion,
    path_targets_entrypoint: pathTargetsEntrypoint,
    blockers,
    warnings
  };
}

export async function executableOnInjectedPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const rawPath = String(env.PATH ?? '').slice(0, 64 * 1024);
  const extensions = process.platform === 'win32'
    ? uniqueStrings(String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => extension.toLowerCase()))
    : [''];
  const names = process.platform === 'win32' && path.extname(command)
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);
  for (const directory of rawPath.split(path.delimiter).filter(Boolean).slice(0, 256)) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

async function probeVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }
): Promise<string | null> {
  const result = await runProcess(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...env,
      SKS_DISABLE_UPDATE_CHECK: '1',
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1'
    },
    timeoutMs: Math.max(1_000, Math.min(options.timeoutMs ?? 5_000, 15_000)),
    maxOutputBytes: Math.max(1_024, Math.min(options.maxOutputBytes ?? 4_096, 64 * 1_024))
  }).catch(() => null);
  if (!result || result.code !== 0) return null;
  return extractSemVer(`${result.stdout || ''}\n${result.stderr || ''}`);
}

async function readJsonRecord(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function shimReferencesEntrypoint(shim: string, entrypoint: string): Promise<boolean> {
  try {
    if (process.platform !== 'win32' || !['.cmd', '.bat'].includes(path.extname(shim).toLowerCase())) return false;
    const stat = await fs.stat(shim);
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    const source = normalizeShimPath(await fs.readFile(shim, 'utf8'));
    const absolute = normalizeShimPath(path.resolve(entrypoint));
    const relative = normalizeShimPath(path.relative(path.dirname(shim), entrypoint));
    const referencesEntrypoint = source.includes(absolute) || (relative.length > 0 && source.includes(relative));
    return referencesEntrypoint && source.includes('%*') && (source.includes('"%_prog%"') || source.includes('node.exe'));
  } catch {
    return false;
  }
}

function normalizeShimPath(value: string): string {
  const normalized = String(value).replaceAll('\\', '/').toLowerCase();
  return process.platform === 'win32'
    ? normalized.replaceAll('%dp0%/', '').replaceAll('%~dp0', '').replaceAll('$basedir/', '')
    : normalized;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
