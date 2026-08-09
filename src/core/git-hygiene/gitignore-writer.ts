import path from 'node:path';
import { readText, runProcess, writeTextAtomic } from '../fsx.js';
import { GIT_HYGIENE_BLOCK } from './git-policy.js';

export const GITIGNORE_BLOCK = `# BEGIN ${GIT_HYGIENE_BLOCK}
# Local SKS runtime noise
.sneakoscope/missions/
.sneakoscope/reports/
.sneakoscope/tmp/
.sneakoscope/cache/
.sneakoscope/arenas/
.sneakoscope/processes/
.sneakoscope/bench/
.sneakoscope/blackbox/
.sneakoscope/logs/
.sneakoscope/state/
.sneakoscope/db/
.sneakoscope/evidence/
.sneakoscope/proof/
.sneakoscope/perf/
.sneakoscope/research/
.sneakoscope/skills/
.sneakoscope/smoke-archives/
.sneakoscope/memory/
.sneakoscope/manifest.json
.sneakoscope/policy.json
.sneakoscope/db-safety.json
.sneakoscope/db-safety-scan.json
.sneakoscope/harness-guard.json
.sneakoscope/managed-paths.json
.sneakoscope/**/*.log

# Generated TriWiki indexes and transient context packs
.sneakoscope/wiki/indexes/
.sneakoscope/wiki/context-packs/
.sneakoscope/wiki/architecture-map/
.sneakoscope/wiki/architecture-map/**
.sneakoscope/wiki/tmp/
.sneakoscope/wiki/context-pack.json
.sneakoscope/wiki/image-assets.json
.sneakoscope/wiki/image-voxel-ledger.json
.sneakoscope/wiki/wrongness-ledger.json
.sneakoscope/wiki/wrongness-index.json
.sneakoscope/wiki/wrongness-summary.md
.sneakoscope/wiki/image-wrongness-index.json
.sneakoscope/wiki/visual-anchors.json
.sneakoscope/wiki/last-sweep-report.json

# Shared SKS memory records are intentionally tracked:
# .sneakoscope/wiki/records/
# .sneakoscope/wiki/wrongness/
# .sneakoscope/wiki/image-voxels/
# .sneakoscope/wiki/avoidance-rules/
# END ${GIT_HYGIENE_BLOCK}
`;

const LEGACY_BROAD_SKS_IGNORES = new Set(['.sneakoscope/', '.sneakoscope']);

export async function installGitignoreBlock(root: string): Promise<{ path: string; changed: boolean; removed_legacy_patterns: string[] }> {
  const file = path.join(root, '.gitignore');
  const current = await readText(file, '');
  const cleaned = removeLegacyBroadSksIgnores(current);
  const next = mergeHashBlock(cleaned.text, GIT_HYGIENE_BLOCK, GITIGNORE_BLOCK);
  if (next !== current) await writeTextAtomic(file, next);
  return { path: file, changed: next !== current, removed_legacy_patterns: cleaned.removed };
}

export async function removeLegacyGitInfoExclude(root: string): Promise<{ path: string | null; changed: boolean; removed_legacy_patterns: string[] }> {
  const gitPath = await runProcess('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, timeoutMs: 30000, maxOutputBytes: 64 * 1024 });
  if (gitPath.code !== 0) return { path: null, changed: false, removed_legacy_patterns: [] };
  const rawPath = gitPath.stdout.trim();
  if (!rawPath) return { path: null, changed: false, removed_legacy_patterns: [] };
  const file = path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath);
  const current = await readText(file, '');
  const cleaned = removeLegacyBroadSksIgnores(current);
  if (cleaned.text !== current) await writeTextAtomic(file, cleaned.text.endsWith('\n') ? cleaned.text : `${cleaned.text}\n`);
  return { path: file, changed: cleaned.text !== current, removed_legacy_patterns: cleaned.removed };
}

export function hasGitignoreBlock(text: string): boolean {
  return String(text || '').includes(`# BEGIN ${GIT_HYGIENE_BLOCK}`) && String(text || '').includes(`# END ${GIT_HYGIENE_BLOCK}`);
}

export function removeLegacyBroadSksIgnores(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = String(text || '').split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (LEGACY_BROAD_SKS_IGNORES.has(trimmed)) {
      removed.push(trimmed);
      return false;
    }
    return true;
  });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}

export function mergeHashBlock(text: string, markerName: string, block: string): string {
  const begin = `# BEGIN ${markerName}`;
  const end = `# END ${markerName}`;
  const current = String(text || '').trimEnd();
  const cleanBlock = `${String(block || '').trim()}\n`;
  if (!current) return cleanBlock;
  const start = current.indexOf(begin);
  const stop = current.indexOf(end);
  if (start >= 0 && stop >= start) {
    const after = stop + end.length;
    return `${current.slice(0, start).replace(/\s*$/, '')}\n${cleanBlock}${current.slice(after).replace(/^\s*/, '\n').replace(/\n{3,}/g, '\n\n')}`.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  }
  return `${current}\n\n${cleanBlock}`;
}
