import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectConfinedPath } from '../../managed-path-safety.js';
import { sha256 } from '../../fsx.js';
import {
  SKS_SKILL_MANIFEST_FILE,
  canonicalSkillNameFromValue
} from './inventory.js';

export async function listSkillDirs(
  targetDir: string,
  opts: { includeUnsafeEntries?: boolean } = {}
) {
  const boundary = rootFromSkillsDir(targetDir);
  let rootInspection;
  try {
    rootInspection = await inspectConfinedPath(boundary, targetDir);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  if (!rootInspection.exists) return [];
  if (rootInspection.leafSymlink || !rootInspection.stat?.isDirectory()) {
    throw new Error(`skill_target_not_safe_directory:${targetDir}`);
  }
  const rows = await fsp.readdir(targetDir, { withFileTypes: true });
  const out: any[] = [];
  for (const row of rows) {
    const dir = path.join(targetDir, row.name);
    const directoryCanonical = canonicalSkillNameFromValue(row.name);
    if (row.isSymbolicLink() || !row.isDirectory()) {
      if (opts.includeUnsafeEntries) {
        out.push({
          name: row.name,
          dir,
          skillMdPath: null,
          text: '',
          canonical: directoryCanonical,
          declaredCanonical: '',
          directoryCanonical,
          hash: '',
          unsafeEntry: row.isSymbolicLink() ? 'symlink' : 'non-directory'
        });
      }
      continue;
    }
    const skillMdPath = path.join(dir, 'SKILL.md');
    const inspected = await inspectConfinedPath(boundary, skillMdPath);
    if (!inspected.exists || inspected.leafSymlink || !inspected.stat?.isFile()) {
      if (opts.includeUnsafeEntries) {
        out.push({
          name: row.name,
          dir,
          skillMdPath,
          text: '',
          canonical: directoryCanonical,
          declaredCanonical: '',
          directoryCanonical,
          hash: '',
          unsafeEntry: inspected.leafSymlink ? 'skill-file-symlink' : 'missing-or-non-file-skill'
        });
      }
      continue;
    }
    const text = await fsp.readFile(skillMdPath, 'utf8');
    const displayName = /^name:\s*(.+)\s*$/m.exec(text)?.[1] || row.name;
    const declaredCanonical = canonicalSkillNameFromValue(displayName);
    out.push({
      name: row.name,
      dir,
      skillMdPath,
      text,
      canonical: declaredCanonical,
      declaredCanonical,
      directoryCanonical,
      hash: sha256(text)
    });
  }
  return out;
}

export function rootFromSkillsDir(targetDir: string): string {
  const normalized = path.resolve(targetDir);
  if (path.basename(normalized) === 'skills' && path.basename(path.dirname(normalized)) === '.agents') {
    return path.dirname(path.dirname(normalized));
  }
  return path.dirname(path.dirname(normalized));
}

export async function pruneProjectGeneratedManifest(targetDir: string): Promise<void> {
  await fsp.rm(path.join(targetDir, SKS_SKILL_MANIFEST_FILE), { force: true }).catch(() => undefined);
}

function nodeErrorCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException | null)?.code || '');
}
