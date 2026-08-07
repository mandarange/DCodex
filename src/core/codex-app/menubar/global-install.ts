import path from 'node:path';
import { exists, nowIso, readJson, readText, runProcess, writeJsonAtomic } from '../../fsx.js';
import { ensureConfinedDirectory, inspectConfinedPath, removeManagedPathVerified } from '../../managed-path-safety.js';
import { realUserHome } from './installer/runtime.js';
import type { SksMenuBarBuildStamp } from './types.js';
import type { sksMenuBarPaths } from './paths.js';

export interface ProjectMenuBarDuplicateCleanupResult {
  schema: 'sks.menubar-project-duplicate-cleanup.v1';
  ok: boolean;
  canonical_only: boolean;
  canonical_install_dir: string;
  inspected: string[];
  removed: string[];
  preserved: string[];
  receipt_path: string | null;
  blockers: string[];
  warnings: string[];
}

export interface ProjectMenuBarCanonicalState {
  canonical_only: boolean;
  inspected: string[];
  candidate_paths: string[];
  verified_duplicates: string[];
  unverified_collisions: string[];
  blockers: string[];
  warnings: string[];
}

interface ProjectMenuBarDuplicateCandidates {
  inspected: string[];
  discovered: string[];
}

const MENU_BAR_EXECUTABLE_SUFFIX = path.join('SKSMenuBar.app', 'Contents', 'MacOS', 'SKSMenuBar');
const MENU_BAR_PROCESS_DISCOVERY_TIMEOUT_MS = 5_000;

export function projectMenuBarDuplicateInstallDirs(input: {
  paths: ReturnType<typeof sksMenuBarPaths>;
  root: string;
}): string[] {
  const root = path.resolve(input.root);
  const home = path.resolve(input.paths.home);
  const canonical = path.resolve(input.paths.install_dir);
  return [...new Set([
    path.join(root, '.codex', 'sks-menubar'),
    path.join(root, '.sneakoscope', 'sks-menubar'),
    path.join(root, '.sneakoscope', 'codex-app', 'sks-menubar'),
    path.join(home, '.sneakoscope', 'sks-menubar'),
    path.join(home, '.sneakoscope', 'codex-app', 'sks-menubar')
  ].map((candidate) => path.resolve(candidate)).filter((candidate) => candidate !== canonical))];
}

export async function verifiedProjectMenuBarDuplicateExecutablePaths(input: {
  paths: ReturnType<typeof sksMenuBarPaths>;
  root: string;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<string[]> {
  const root = path.resolve(input.root);
  const home = path.resolve(input.paths.home);
  const executables: string[] = [];
  const candidates = await discoverProjectMenuBarDuplicateCandidates(input);
  for (const candidate of candidates.inspected) {
    if (isOutsideScopeReapingRefused(candidate, root, home)) continue;
    const confinementRoot = confinementRootForCandidate(root, home, candidate);
    const state = await inspectConfinedPath(confinementRoot, candidate).catch(() => null);
    if (!state?.exists || state.leafSymlink || !state.stat?.isDirectory()) continue;
    const stamp = await readJson<SksMenuBarBuildStamp | null>(path.join(candidate, 'build-stamp.json'), null);
    const executable = path.join(candidate, 'SKSMenuBar.app', 'Contents', 'MacOS', 'SKSMenuBar');
    if (stamp?.schema === 'sks.sks-menubar-build-stamp.v2'
        && stamp.codesign_identifier === 'com.sneakoscope.sks-menubar'
        && await exists(executable)) {
      executables.push(executable);
    }
  }
  return executables;
}

export async function inspectProjectMenuBarCanonicalState(input: {
  paths: ReturnType<typeof sksMenuBarPaths>;
  root: string;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<ProjectMenuBarCanonicalState> {
  const root = path.resolve(input.root);
  const home = path.resolve(input.paths.home);
  const discoveredCandidates = await discoverProjectMenuBarDuplicateCandidates(input);
  const inspected = discoveredCandidates.inspected;
  const verifiedDuplicates: string[] = [];
  const unverifiedCollisions: string[] = [];
  const blockers: string[] = [];
  for (const candidate of inspected) {
    const confinementRoot = confinementRootForCandidate(root, home, candidate);
    const state = await inspectConfinedPath(confinementRoot, candidate).catch(() => null);
    if (!state) {
      blockers.push(`menubar_project_duplicate_inspection_failed:${candidate}`);
      continue;
    }
    if (!state.exists) continue;
    if (state.leafSymlink || !state.stat?.isDirectory()) {
      unverifiedCollisions.push(candidate);
      continue;
    }
    const stamp = await readJson<SksMenuBarBuildStamp | null>(path.join(candidate, 'build-stamp.json'), null);
    const executable = path.join(candidate, 'SKSMenuBar.app', 'Contents', 'MacOS', 'SKSMenuBar');
    if (stamp?.schema === 'sks.sks-menubar-build-stamp.v2'
        && stamp.codesign_identifier === 'com.sneakoscope.sks-menubar'
        && await exists(executable)) {
      verifiedDuplicates.push(candidate);
    } else {
      unverifiedCollisions.push(candidate);
    }
  }
  const candidatePaths = [...new Set([
    ...discoveredCandidates.discovered,
    ...verifiedDuplicates,
    ...unverifiedCollisions
  ])].sort();
  const warnings = candidatePaths.map((candidate) => `menubar_duplicate_candidate_detected:${candidate}`);
  return {
    canonical_only: candidatePaths.length === 0 && blockers.length === 0,
    inspected,
    candidate_paths: candidatePaths,
    verified_duplicates: verifiedDuplicates,
    unverified_collisions: unverifiedCollisions,
    blockers,
    warnings
  };
}

export async function cleanupProjectMenuBarDuplicates(input: {
  paths: ReturnType<typeof sksMenuBarPaths>;
  root: string;
  env?: NodeJS.ProcessEnv | undefined;
  candidateExecutablePaths?: string[] | undefined;
}): Promise<ProjectMenuBarDuplicateCleanupResult> {
  const root = path.resolve(input.root);
  const canonical = path.resolve(input.paths.install_dir);
  const discovered = await discoverProjectMenuBarDuplicateCandidates(input);
  const retainedCandidates = (input.candidateExecutablePaths || [])
    .map((executable) => duplicateInstallDirForExecutable(executable, canonical))
    .filter((candidate): candidate is string => Boolean(candidate));
  const inspected = [...new Set([...discovered.inspected, ...retainedCandidates])];
  const removed: string[] = [];
  const preserved: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const candidate of inspected) {
    if (isOutsideScopeReapingRefused(candidate, root, input.paths.home)) {
      preserved.push(candidate);
      warnings.push(`menubar_project_duplicate_outside_scope_preserved:${candidate}`);
      continue;
    }
    const confinementRoot = confinementRootForCandidate(root, input.paths.home, candidate);
    const state = await inspectConfinedPath(confinementRoot, candidate).catch(() => null);
    if (!state) {
      blockers.push(`menubar_project_duplicate_inspection_failed:${candidate}`);
      continue;
    }
    if (!state.exists) continue;
    if (state.leafSymlink || !state.stat?.isDirectory()) {
      preserved.push(candidate);
      warnings.push(`menubar_project_duplicate_unmanaged_collision_preserved:${candidate}`);
      continue;
    }
    const stamp = await readJson<SksMenuBarBuildStamp | null>(path.join(candidate, 'build-stamp.json'), null);
    if (stamp?.schema !== 'sks.sks-menubar-build-stamp.v2'
      || stamp.codesign_identifier !== 'com.sneakoscope.sks-menubar'
      || !await exists(path.join(candidate, 'SKSMenuBar.app', 'Contents', 'MacOS', 'SKSMenuBar'))) {
      preserved.push(candidate);
      warnings.push(`menubar_project_duplicate_unverified_preserved:${candidate}`);
      continue;
    }
    if (isProtectedDuplicateRemovalTarget(candidate, root, input.paths.home)) {
      preserved.push(candidate);
      warnings.push(`menubar_project_duplicate_protected_path_preserved:${candidate}`);
      continue;
    }
    try {
      await removeManagedPathVerified(confinementRoot, candidate);
      removed.push(candidate);
    } catch {
      blockers.push(`menubar_project_duplicate_remove_failed:${candidate}`);
    }
  }

  if (preserved.length > 0) warnings.push('menubar_strict_canonical_only_unmet');
  let receiptPath: string | null = null;
  if (removed.length > 0 || preserved.length > 0 || blockers.length > 0) {
    try {
      await ensureConfinedDirectory(input.paths.install_dir, input.paths.duplicate_receipts_dir);
      receiptPath = path.join(
        input.paths.duplicate_receipts_dir,
        `${Date.now()}-${process.pid}.json`
      );
      await writeJsonAtomic(receiptPath, {
        schema: 'sks.menubar-project-duplicate-cleanup-receipt.v1',
        generated_at: nowIso(),
        canonical_install_dir: canonical,
        project_root: root,
        inspected,
        removed,
        preserved,
        blockers,
        warnings
      }, { mode: 0o600 });
    } catch {
      blockers.push('menubar_project_duplicate_receipt_write_failed');
    }
  }
  const canonicalOnly = preserved.length === 0 && blockers.length === 0;
  return {
    schema: 'sks.menubar-project-duplicate-cleanup.v1',
    ok: blockers.length === 0,
    canonical_only: canonicalOnly,
    canonical_install_dir: canonical,
    inspected,
    removed,
    preserved,
    receipt_path: receiptPath,
    blockers,
    warnings
  };
}

async function discoverProjectMenuBarDuplicateCandidates(input: {
  paths: ReturnType<typeof sksMenuBarPaths>;
  root: string;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<ProjectMenuBarDuplicateCandidates> {
  const canonical = path.resolve(input.paths.install_dir);
  const fixed = projectMenuBarDuplicateInstallDirs(input);
  const discovered = [...new Set([
    ...await runningMenuBarDuplicateInstallDirs(canonical, input.env || process.env),
    ...await launchAgentDuplicateInstallDirs(input.paths.launch_agent_path, canonical)
  ])].sort();
  return {
    inspected: [...new Set([...fixed, ...discovered])],
    discovered
  };
}

async function runningMenuBarDuplicateInstallDirs(
  canonicalInstallDir: string,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const pgrep = await processTool(env, 'SKS_MENUBAR_PGREP', '/usr/bin/pgrep');
  if (!pgrep) return [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const result = await runProcess(pgrep, [
    ...(uid === null ? [] : ['-U', String(uid)]),
    '-f',
    'SKSMenuBar\\.app/Contents/MacOS/SKSMenuBar'
  ], { timeoutMs: MENU_BAR_PROCESS_DISCOVERY_TIMEOUT_MS, maxOutputBytes: 32 * 1024 }).catch(() => ({ code: 1, stdout: '' }));
  if (result.code !== 0) return [];
  const rows = String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => ({
    line,
    executable: runningExecutablePath(line)
  }));
  const executablePaths = rows.map((row) => row.executable).filter((value): value is string => Boolean(value));
  const unresolvedPids = rows
    .filter((row) => !row.executable)
    .map((row) => Number(row.line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .slice(0, 128);
  if (unresolvedPids.length > 0) {
    const ps = await processTool(env, 'SKS_MENUBAR_PS', '/bin/ps');
    if (ps) {
      const processList = await runProcess(ps, [
        '-p',
        unresolvedPids.join(','),
        '-o',
        'pid=,command='
      ], { timeoutMs: MENU_BAR_PROCESS_DISCOVERY_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }).catch(() => ({ code: 1, stdout: '' }));
      if (processList.code === 0) {
        executablePaths.push(...String(processList.stdout || '')
          .split(/\r?\n/)
          .map((line) => runningExecutablePath(line))
          .filter((value): value is string => Boolean(value)));
      }
    }
  }
  return [...new Set(executablePaths
    .map((executable) => duplicateInstallDirForExecutable(executable, canonicalInstallDir))
    .filter((candidate): candidate is string => Boolean(candidate)))].sort();
}

async function launchAgentDuplicateInstallDirs(
  launchAgentPath: string,
  canonicalInstallDir: string
): Promise<string[]> {
  const source = await readText(launchAgentPath, '');
  const block = source.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i)?.[1] || '';
  const encoded = block.match(/<string>([\s\S]*?)<\/string>/i)?.[1];
  if (!encoded) return [];
  const executable = decodeXml(encoded.trim());
  const candidate = duplicateInstallDirForExecutable(executable, canonicalInstallDir);
  return candidate ? [candidate] : [];
}

function runningExecutablePath(line: string): string | null {
  const command = line.replace(/^\s*\d+\s+/, '').trim();
  const suffixIndex = command.indexOf(MENU_BAR_EXECUTABLE_SUFFIX);
  if (suffixIndex < 0) return null;
  const suffixEnd = suffixIndex + MENU_BAR_EXECUTABLE_SUFFIX.length;
  const firstSlash = command.indexOf('/');
  if (firstSlash < 0 || firstSlash > suffixIndex) return null;
  return command.slice(firstSlash, suffixEnd);
}

function duplicateInstallDirForExecutable(executablePath: string, canonicalInstallDir: string): string | null {
  if (!path.isAbsolute(executablePath)) return null;
  const executable = path.resolve(executablePath);
  const suffix = `${path.sep}${MENU_BAR_EXECUTABLE_SUFFIX}`;
  if (!executable.endsWith(suffix)) return null;
  if (isWithin(path.resolve(canonicalInstallDir), executable)) return null;
  return executable.slice(0, -suffix.length);
}

// Duplicate discovery is process-wide (pgrep/ps and the launchd plist), so a
// run whose home is not the operator's real home — an isolated test home, a
// sandbox, or a custom --home — will discover the operator's REAL canonical
// install as a "duplicate" of its own temp canonical dir. Candidates outside
// both the project root and the active home may only be terminated/removed
// when the active home IS the real user home (cross-project reaping on the
// operator's canonical install); every other run must leave them untouched.
function isOutsideScopeReapingRefused(candidateInput: string, rootInput: string, homeInput: string): boolean {
  const candidate = path.resolve(candidateInput);
  const root = path.resolve(rootInput);
  const home = path.resolve(homeInput);
  if (isWithin(root, candidate) || isWithin(home, candidate)) return false;
  return home !== realUserHome();
}

function confinementRootForCandidate(rootInput: string, homeInput: string, candidate: string): string {
  const root = path.resolve(rootInput);
  const home = path.resolve(homeInput);
  if (isWithin(root, candidate)) return root;
  if (isWithin(home, candidate)) return home;
  return path.parse(path.resolve(candidate)).root;
}

function isProtectedDuplicateRemovalTarget(candidateInput: string, rootInput: string, homeInput: string): boolean {
  const candidate = path.resolve(candidateInput);
  return candidate === path.resolve(rootInput)
    || candidate === path.resolve(homeInput)
    || candidate === path.parse(candidate).root;
}

async function processTool(env: NodeJS.ProcessEnv, key: string, fallback: string): Promise<string | null> {
  const injected = env.SKS_MENUBAR_TEST_PROCESS_TOOLS === '1' ? env[key] : null;
  if (injected) return injected;
  return exists(fallback).then((available) => available ? fallback : null);
}

function decodeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
