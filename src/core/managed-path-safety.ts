import fsp from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { errorCodeOf } from './errors/message.js';

export class ManagedPathSafetyError extends Error {
  constructor(readonly code: string, readonly target: string) {
    super(`${code}:${target}`);
    this.name = 'ManagedPathSafetyError';
  }
}

export interface ConfinedPathInspection {
  path: string;
  exists: boolean;
  leafSymlink: boolean;
  stat: Stats | null;
}

export interface ConfinedWalkResult {
  entries: string[];
  errors: string[];
}

export interface EmptyTreeRemovalResult {
  ok: boolean;
  removed_directory_count: number;
  remaining_paths: string[];
  errors: string[];
}

export function isLexicallyConfined(boundary: string, candidate: string): boolean {
  const root = path.resolve(boundary);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function inspectConfinedPath(boundary: string, candidate: string): Promise<ConfinedPathInspection> {
  const root = path.resolve(boundary);
  const target = path.resolve(candidate);
  if (!isLexicallyConfined(root, target)) throw new ManagedPathSafetyError('managed_path_escape_refused', target);

  const rootStat = await lstatOrNull(root);
  if (!rootStat) throw new ManagedPathSafetyError('managed_path_boundary_missing', root);
  if (rootStat.isSymbolicLink()) throw new ManagedPathSafetyError('managed_path_boundary_symlink_refused', root);
  if (!rootStat.isDirectory()) throw new ManagedPathSafetyError('managed_path_boundary_not_directory', root);
  if (target === root) return { path: target, exists: true, leafSymlink: false, stat: rootStat };

  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = await lstatOrNull(current);
    if (!stat) return { path: target, exists: false, leafSymlink: false, stat: null };
    const leaf = index === parts.length - 1;
    if (stat.isSymbolicLink()) {
      if (leaf) return { path: target, exists: true, leafSymlink: true, stat };
      throw new ManagedPathSafetyError('managed_path_ancestor_symlink_refused', current);
    }
    if (!leaf && !stat.isDirectory()) {
      throw new ManagedPathSafetyError('managed_path_ancestor_not_directory', current);
    }
    if (leaf) return { path: target, exists: true, leafSymlink: false, stat };
  }
  return { path: target, exists: false, leafSymlink: false, stat: null };
}

export async function ensureConfinedDirectory(boundary: string, directory: string): Promise<void> {
  const root = path.resolve(boundary);
  const target = path.resolve(directory);
  if (!isLexicallyConfined(root, target)) throw new ManagedPathSafetyError('managed_path_escape_refused', target);

  const rootStat = await lstatOrNull(root);
  if (!rootStat) throw new ManagedPathSafetyError('managed_path_boundary_missing', root);
  if (rootStat.isSymbolicLink()) throw new ManagedPathSafetyError('managed_path_boundary_symlink_refused', root);
  if (!rootStat.isDirectory()) throw new ManagedPathSafetyError('managed_path_boundary_not_directory', root);

  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat = await lstatOrNull(current);
    if (!stat) {
      try {
        await fsp.mkdir(current);
      } catch (error: unknown) {
        if (errorCodeOf(error) !== 'EEXIST') throw error;
      }
      stat = await lstatOrNull(current);
    }
    if (!stat) throw new ManagedPathSafetyError('managed_path_directory_create_failed', current);
    if (stat.isSymbolicLink()) throw new ManagedPathSafetyError('managed_path_directory_symlink_refused', current);
    if (!stat.isDirectory()) throw new ManagedPathSafetyError('managed_path_directory_not_directory', current);
  }
}

export async function walkConfinedEntries(boundary: string, root: string): Promise<ConfinedWalkResult> {
  const entries: string[] = [];
  const errors: string[] = [];
  await walk(path.resolve(root));
  return { entries, errors };

  async function walk(current: string): Promise<void> {
    let inspected: ConfinedPathInspection;
    try {
      inspected = await inspectConfinedPath(boundary, current);
    } catch (error: unknown) {
      errors.push(publicPathError(error, current));
      return;
    }
    if (!inspected.exists) return;
    if (inspected.leafSymlink || !inspected.stat?.isDirectory()) {
      entries.push(current);
      return;
    }
    let children: Dirent[];
    try {
      children = await fsp.readdir(current, { withFileTypes: true, encoding: 'utf8' });
    } catch (error: unknown) {
      errors.push(`${errorCodeOf(error) || 'managed_path_readdir_failed'}:${current}`);
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) await walk(path.join(current, child.name));
  }
}

export async function removeManagedPathVerified(boundary: string, target: string): Promise<void> {
  const absolute = path.resolve(target);
  await removeNode(absolute);
  const remaining = await inspectConfinedPath(boundary, absolute);
  if (remaining.exists) throw new ManagedPathSafetyError('managed_path_remove_verification_failed', absolute);

  async function removeNode(current: string): Promise<void> {
    const inspected = await inspectConfinedPath(boundary, current);
    if (!inspected.exists) return;
    if (inspected.leafSymlink) throw new ManagedPathSafetyError('managed_path_leaf_symlink_refused', current);
    if (inspected.stat?.isDirectory()) {
      const children: Dirent[] = await fsp.readdir(current, { withFileTypes: true, encoding: 'utf8' });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) await removeNode(path.join(current, child.name));
      await fsp.rmdir(current);
      return;
    }
    if (!inspected.stat?.isFile()) throw new ManagedPathSafetyError('managed_path_non_regular_refused', current);
    await fsp.unlink(current);
  }
}

export async function uniqueConfinedPath(boundary: string, base: string): Promise<string> {
  if (!(await inspectConfinedPath(boundary, base)).exists) return path.resolve(base);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}.${index}`;
    if (!(await inspectConfinedPath(boundary, candidate)).exists) return path.resolve(candidate);
  }
  throw new ManagedPathSafetyError('managed_path_unique_name_exhausted', path.resolve(base));
}

export async function moveConfinedPath(boundary: string, source: string, destination: string): Promise<void> {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  const inspected = await inspectConfinedPath(boundary, sourcePath);
  if (!inspected.exists) return;
  await ensureConfinedDirectory(boundary, path.dirname(destinationPath));
  const destinationInspection = await inspectConfinedPath(boundary, destinationPath);
  if (destinationInspection.exists) throw new ManagedPathSafetyError('managed_path_destination_exists', destinationPath);
  await fsp.rename(sourcePath, destinationPath);
  const [sourceAfter, destinationAfter] = await Promise.all([
    inspectConfinedPath(boundary, sourcePath),
    inspectConfinedPath(boundary, destinationPath)
  ]);
  if (sourceAfter.exists || !destinationAfter.exists) {
    throw new ManagedPathSafetyError('managed_path_move_verification_failed', sourcePath);
  }
}

export async function removeConfinedDirectoryIfEmpty(boundary: string, directory: string): Promise<boolean> {
  const inspected = await inspectConfinedPath(boundary, directory);
  if (!inspected.exists) return false;
  if (inspected.leafSymlink) throw new ManagedPathSafetyError('managed_path_leaf_symlink_refused', path.resolve(directory));
  if (!inspected.stat?.isDirectory()) return false;
  const entries = await fsp.readdir(directory);
  if (entries.length > 0) return false;
  await fsp.rmdir(directory);
  const after = await inspectConfinedPath(boundary, directory);
  if (after.exists) throw new ManagedPathSafetyError('managed_path_rmdir_verification_failed', path.resolve(directory));
  return true;
}

export async function removeEmptyTreeVerified(boundary: string, root: string): Promise<EmptyTreeRemovalResult> {
  const remainingPaths: string[] = [];
  const errors: string[] = [];
  let removedDirectoryCount = 0;
  await prune(path.resolve(root));
  return {
    ok: errors.length === 0 && remainingPaths.length === 0,
    removed_directory_count: removedDirectoryCount,
    remaining_paths: [...new Set(remainingPaths)].sort(),
    errors: [...new Set(errors)].sort()
  };

  async function prune(current: string): Promise<void> {
    let inspected: ConfinedPathInspection;
    try {
      inspected = await inspectConfinedPath(boundary, current);
    } catch (error: unknown) {
      errors.push(publicPathError(error, current));
      remainingPaths.push(current);
      return;
    }
    if (!inspected.exists) return;
    if (inspected.leafSymlink || !inspected.stat?.isDirectory()) {
      remainingPaths.push(current);
      return;
    }

    let children: Dirent[];
    try {
      children = await fsp.readdir(current, { withFileTypes: true, encoding: 'utf8' });
    } catch (error: unknown) {
      errors.push(`${errorCodeOf(error) || 'managed_path_readdir_failed'}:${current}`);
      remainingPaths.push(current);
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(current, child.name);
      if (child.isDirectory() && !child.isSymbolicLink()) await prune(childPath);
      else remainingPaths.push(childPath);
    }

    let after: string[];
    try {
      after = await fsp.readdir(current);
    } catch (error: unknown) {
      errors.push(`${errorCodeOf(error) || 'managed_path_readdir_failed'}:${current}`);
      remainingPaths.push(current);
      return;
    }
    if (after.length > 0) {
      remainingPaths.push(current);
      return;
    }
    try {
      await fsp.rmdir(current);
    } catch (error: unknown) {
      errors.push(`${errorCodeOf(error) || 'managed_path_rmdir_failed'}:${current}`);
      remainingPaths.push(current);
      return;
    }
    const verified = await inspectConfinedPath(boundary, current);
    if (verified.exists) {
      errors.push(`managed_path_rmdir_verification_failed:${current}`);
      remainingPaths.push(current);
      return;
    }
    removedDirectoryCount += 1;
  }
}

export async function lstatConfinedOrNull(boundary: string, target: string): Promise<ConfinedPathInspection> {
  return inspectConfinedPath(boundary, target);
}

export function publicPathError(error: unknown, fallback: string): string {
  if (error instanceof ManagedPathSafetyError) return `${error.code}:${error.target}`;
  return `${errorCodeOf(error) || 'managed_path_operation_failed'}:${fallback}`;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (error: unknown) {
    if (errorCodeOf(error) === 'ENOENT') return null;
    throw error;
  }
}
