import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectConfinedPath } from '../managed-path-safety.js';

const NESTED_AGENTS_MAX_DEPTH = 12;
const NESTED_AGENTS_MAX_DIRECTORIES = 4096;
const NESTED_AGENTS_SKIPPED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.sneakoscope',
  '.tox',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'node_modules',
  'out',
  'pods',
  'target',
  'venv'
]);

export interface NestedProjectGuidanceScanWarning {
  code: 'guidance_scan_truncated';
  cutoff_path: string;
  cutoff_reason: 'directory_limit' | 'depth_limit';
  visited_directory_count: number;
  exceeded_directory_count: number;
  directory_limit: typeof NESTED_AGENTS_MAX_DIRECTORIES;
  depth_limit: typeof NESTED_AGENTS_MAX_DEPTH;
}

export interface NestedProjectGuidanceScanResult {
  roots: string[];
  errorCount: number;
  truncated: boolean;
  warnings: NestedProjectGuidanceScanWarning[];
}

export async function collectNestedProjectRoots(
  projectRoot: string,
  excludedRoots: Set<string>
): Promise<NestedProjectGuidanceScanResult> {
  const roots = new Set<string>();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: projectRoot, depth: 0 }];
  const excluded = new Set([...excludedRoots].map((root) => path.resolve(root)));
  let cursor = 0;
  let errorCount = 0;
  let cutoffPath: string | null = null;
  let cutoffReason: NestedProjectGuidanceScanWarning['cutoff_reason'] | null = null;
  let exceededDirectoryCount = 0;

  const recordCutoff = (
    target: string,
    reason: NestedProjectGuidanceScanWarning['cutoff_reason']
  ) => {
    cutoffPath ||= path.resolve(target);
    cutoffReason ||= reason;
    exceededDirectoryCount += 1;
  };

  while (cursor < queue.length) {
    if (cursor >= NESTED_AGENTS_MAX_DIRECTORIES) {
      recordCutoff(queue[cursor]?.directory || projectRoot, 'directory_limit');
      break;
    }
    const current = queue[cursor++]!;
    const inspection = await inspectConfinedPath(projectRoot, current.directory).catch(() => null);
    if (!inspection) {
      errorCount += 1;
      continue;
    }
    if (!inspection.exists || inspection.leafSymlink || !inspection.stat?.isDirectory()) continue;

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(current.directory, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      errorCount += 1;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current.directory, entry.name);
      if (current.depth > 0 && entry.name === 'AGENTS.md' && entry.isFile()) {
        roots.add(current.directory);
      }
      if (!entry.isDirectory()) continue;
      if (NESTED_AGENTS_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (excluded.has(path.resolve(target))) continue;
      if (entry.name === '.agents' || entry.name === '.codex') {
        if (current.depth > 0) roots.add(current.directory);
        continue;
      }
      if (current.depth >= NESTED_AGENTS_MAX_DEPTH) {
        recordCutoff(target, 'depth_limit');
        continue;
      }
      if (queue.length >= NESTED_AGENTS_MAX_DIRECTORIES) {
        recordCutoff(target, 'directory_limit');
        continue;
      }
      queue.push({ directory: target, depth: current.depth + 1 });
    }
  }

  const warnings: NestedProjectGuidanceScanWarning[] = cutoffPath && cutoffReason
    ? [{
        code: 'guidance_scan_truncated',
        cutoff_path: cutoffPath,
        cutoff_reason: cutoffReason,
        visited_directory_count: cursor,
        exceeded_directory_count: exceededDirectoryCount,
        directory_limit: NESTED_AGENTS_MAX_DIRECTORIES,
        depth_limit: NESTED_AGENTS_MAX_DEPTH
      }]
    : [];
  return {
    roots: [...roots].sort(),
    errorCount,
    truncated: warnings.length > 0,
    warnings
  };
}
