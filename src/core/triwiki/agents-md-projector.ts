import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, nowIso, readJson, sha256, writeTextAtomic } from '../fsx.js';
import { guardedRm, guardContextForRoute } from '../safety/mutation-guard.js';
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js';

export interface ProjectorReport {
  ok: boolean;
  reason: string | null;
  written: string[];
  hot_dirs?: Array<{ path: string; score: number; files: string[] }>;
}

export interface ProjectorTransaction {
  report: ProjectorReport;
  rollback(): Promise<void>;
}

export const TRIWIKI_AGENTS_BLOCK_BEGIN = '<!-- BEGIN SKS PROJECT MEMORY (auto) -->';
export const TRIWIKI_AGENTS_BLOCK_END = '<!-- END SKS PROJECT MEMORY -->';
export const TRIWIKI_INIT_DEEP_BLOCK_BEGIN = '<!-- BEGIN SKS INIT-DEEP MANAGED SECTION -->';
export const TRIWIKI_INIT_DEEP_BLOCK_END = '<!-- END SKS INIT-DEEP MANAGED SECTION -->';

export const TRIWIKI_AGENTS_SCAN_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxDepth: 256,
  maxAgentsFiles: 10_000,
  maxAgentFileBytes: 8 * 1024 * 1024,
  maxTotalAgentBytes: 64 * 1024 * 1024,
  timeoutMs: 5 * 60_000
});

const ACTIVE_TRIWIKI_BLOCKS = Object.freeze([
  [TRIWIKI_AGENTS_BLOCK_BEGIN, TRIWIKI_AGENTS_BLOCK_END],
  [TRIWIKI_INIT_DEEP_BLOCK_BEGIN, TRIWIKI_INIT_DEEP_BLOCK_END]
] as const);

export async function projectTriwikiToAgentsMd(root: string, opts: { maxLocalFiles?: number } = {}): Promise<ProjectorReport> {
  return (await projectTriwikiToAgentsMdTransactional(root, opts)).report;
}

export async function projectTriwikiToAgentsMdTransactional(
  root: string,
  opts: { maxLocalFiles?: number } = {}
): Promise<ProjectorTransaction> {
  const pack = await readJson<any>(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), null);
  if (!pack) {
    return { report: { ok: false, reason: 'no_context_pack', written: [] }, rollback: async () => undefined };
  }
  const written: string[] = [];
  const backups = new Map<string, { existed: boolean; before: string; after_sha256: string }>();
  const rootContent = buildRootSections(pack);
  let hotDirs: Array<{ path: string; score: number; files: string[] }> = [];
  try {
    if (pack?.mode === 'repository_code_navigation_only') {
      for (const file of await collectAgentsMdFiles(root)) {
        const previous = await readAgentsMdText(file);
        const withoutStaleProjection = removeActiveTriwikiBlocks(previous);
        if (withoutStaleProjection === previous) continue;
        await writeTrackedText(file, withoutStaleProjection, backups);
        written.push(file);
      }
    }
    written.push(await upsertManagedBlock(path.join(root, 'AGENTS.md'), rootContent, backups));
    hotDirs = await scoreComplexDirs(root, pack, opts.maxLocalFiles ?? 8);
    for (const dir of hotDirs) {
      written.push(await upsertManagedBlock(path.join(root, dir.path, 'AGENTS.md'), buildLocalSection(pack, dir), backups));
    }
  } catch (error) {
    const failures = await rollbackProjectorWrites(root, backups);
    if (failures.length) throw new Error(`triwiki_projection_failed:${String(error)};rollback_failed:${failures.join('|')}`);
    throw error;
  }
  return {
    report: { ok: true, reason: null, written, hot_dirs: hotDirs },
    rollback: async () => {
      const failures = await rollbackProjectorWrites(root, backups);
      if (failures.length) throw new Error(`triwiki_projection_rollback_failed:${failures.join('|')}`);
    }
  };
}

export async function removeTriwikiAgentsMdBlocks(root: string): Promise<string[]> {
  const files = await collectAgentsMdFiles(root);
  const changed: string[] = [];
  for (const file of files) {
    const prev = await readAgentsMdText(file);
    const next = removeActiveTriwikiBlocks(prev);
    if (next !== prev) {
      await writeTextAtomic(file, next);
      changed.push(file);
    }
  }
  return changed;
}

export async function inspectTriwikiAgentsMdBlocks(root: string): Promise<string[]> {
  const files = await collectAgentsMdFiles(root);
  const matched: string[] = [];
  for (const file of files) {
    const text = await readAgentsMdText(file);
    if (ACTIVE_TRIWIKI_BLOCKS.some(([begin]) => text.includes(begin))) matched.push(file);
  }
  return matched.sort((left, right) => left.localeCompare(right));
}

async function upsertManagedBlock(
  file: string,
  content: string,
  backups?: Map<string, { existed: boolean; before: string; after_sha256: string }>
): Promise<string> {
  const existed = await fsp.stat(file).then(() => true).catch(() => false);
  const prev = await readAgentsMdText(file);
  const block = `${TRIWIKI_AGENTS_BLOCK_BEGIN}\n${content.trim()}\n${TRIWIKI_AGENTS_BLOCK_END}`;
  const next = String(prev || '').includes(TRIWIKI_AGENTS_BLOCK_BEGIN)
    ? String(prev || '').replace(new RegExp(`${escapeRe(TRIWIKI_AGENTS_BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(TRIWIKI_AGENTS_BLOCK_END)}`), block)
    : `${String(prev || '').trim()}\n\n${block}\n`;
  if (next !== prev) {
    await writeTrackedText(file, next.trimStart(), backups);
  } else if (backups?.has(file)) {
    const prior = backups.get(file)!;
    backups.set(file, { ...prior, after_sha256: sha256(prev) });
  }
  if (backups && !backups.has(file)) {
    backups.set(file, { existed, before: prev, after_sha256: sha256(await readAgentsMdText(file)) });
  }
  return file;
}

async function writeTrackedText(
  file: string,
  contents: string,
  backups: Map<string, { existed: boolean; before: string; after_sha256: string }> | undefined
): Promise<void> {
  const existing = backups?.get(file);
  const existed = existing?.existed ?? await fsp.stat(file).then(() => true).catch(() => false);
  const before = existing?.before ?? await readAgentsMdText(file);
  await ensureDir(path.dirname(file));
  await writeTextAtomic(file, contents);
  backups?.set(file, { existed, before, after_sha256: sha256(await readAgentsMdText(file)) });
}

async function rollbackProjectorWrites(
  root: string,
  backups: ReadonlyMap<string, { existed: boolean; before: string; after_sha256: string }>
): Promise<string[]> {
  const failures: string[] = [];
  const contract = createRequestedScopeContract({
    route: '$sks-align',
    userRequest: 'Rollback only AGENTS.md files changed by the current TriWiki projection transaction',
    projectRoot: root
  });
  const guard = guardContextForRoute(root, contract, 'rollback failed TriWiki AGENTS.md projection');
  for (const [file, backup] of [...backups.entries()].reverse()) {
    try {
      const current = await readAgentsMdText(file);
      if (sha256(current) !== backup.after_sha256) throw new Error('projection_file_changed_after_write');
      if (backup.existed) await writeTextAtomic(file, backup.before);
      else await guardedRm(guard, file, { force: true });
    } catch (error) {
      failures.push(`${path.relative(root, file)}:${String(error)}`);
    }
  }
  return failures;
}

function removeManagedBlock(text: string): string {
  return text.replace(new RegExp(`\\n?${escapeRe(TRIWIKI_AGENTS_BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(TRIWIKI_AGENTS_BLOCK_END)}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n');
}

function removeActiveTriwikiBlocks(text: string): string {
  let next = text;
  for (const [begin, end] of ACTIVE_TRIWIKI_BLOCKS) {
    next = next.replace(
      new RegExp(`(\\r?\\n)?${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}(\\r?\\n)?`, 'g'),
      (_match, before: string | undefined, after: string | undefined) => before || after || ''
    );
  }
  return next;
}

function buildRootSections(pack: any): string {
  if (pack?.mode === 'repository_code_navigation_only') return buildCodeNavigationRootSection(pack);
  const claims = compactClaims(pack).slice(0, 8);
  const modules = compactModules(pack).slice(0, 8);
  const wrongness = compactWrongness(pack).slice(0, 5);
  return [
    `# SKS Project Memory`,
    ``,
    `Generated: ${nowIso()}`,
    `Source: .sneakoscope/wiki/context-pack.json`,
    ``,
    `## Architecture Summary`,
    claims.length ? claims.map((claim) => `- ${claim}`).join('\n') : '- No high-trust TriWiki claims available yet.',
    ``,
    `## Core Modules`,
    modules.length ? modules.map((item) => `- ${item}`).join('\n') : '- No module map entries available yet.',
    ``,
    `## Recent Lessons`,
    wrongness.length ? wrongness.map((item) => `- ${item}`).join('\n') : '- No wrongness-ledger lessons available yet.'
  ].join('\n');
}

function buildLocalSection(pack: any, dir: { path: string; files: string[] }): string {
  if (pack?.mode === 'repository_code_navigation_only') return buildCodeNavigationLocalSection(pack, dir);
  const claims = compactClaims(pack)
    .filter((claim) => claim.includes(dir.path))
    .slice(0, 6);
  return [
    `# SKS Local Project Memory: ${dir.path}`,
    ``,
    `Generated: ${nowIso()}`,
    ``,
    `## Local Anchors`,
    dir.files.slice(0, 8).map((file) => `- ${file}`).join('\n') || '- No file anchors available.',
    ``,
    `## TriWiki Notes`,
    claims.length ? claims.map((claim) => `- ${claim}`).join('\n') : '- Use root AGENTS.md SKS Project Memory plus nearby source files as authority.'
  ].join('\n');
}

function buildCodeNavigationRootSection(pack: any): string {
  const modules = compactClaims(pack).slice(0, 12);
  const index = pack?.index || {};
  return [
    '# SKS Code Navigation Index',
    '',
    `Generated: ${nowIso()}`,
    'Source: repository code bytes only via .sneakoscope/wiki/context-graph.json',
    `Coverage: ${Number(index.source_file_count || 0)} files, ${Number(index.symbol_count || 0)} symbols, ${Number(index.edge_count || 0)} directed relations`,
    '',
    '## Fast Code Map',
    modules.length ? modules.map((item) => `- ${item}`).join('\n') : '- No projected code summaries are available.',
    '',
    '## Lookup Rule',
    '- Use the Context Graph for exact file, symbol, line, import, call, reference, and containment lookup; hydrate the cited source before editing.'
  ].join('\n');
}

function buildCodeNavigationLocalSection(pack: any, dir: { path: string; files: string[] }): string {
  const claims = compactClaims(pack)
    .filter((claim) => claim.includes(dir.path))
    .slice(0, 8);
  return [
    `# SKS Local Code Navigation: ${dir.path}`,
    '',
    `Generated: ${nowIso()}`,
    '',
    '## Source Anchors',
    dir.files.slice(0, 12).map((file) => `- ${file}`).join('\n') || '- No source anchors available.',
    '',
    '## Code-Derived Map',
    claims.length ? claims.map((claim) => `- ${claim}`).join('\n') : '- Query the code Context Graph for exact symbols and directed relations in this directory.'
  ].join('\n');
}

async function scoreComplexDirs(root: string, pack: any, maxLocalFiles: number) {
  const sourcePaths = extractSourcePaths(pack).filter((file) => !file.includes('node_modules') && !file.startsWith('.git/'));
  const scores = new Map<string, { path: string; score: number; files: Set<string> }>();
  for (const file of sourcePaths) {
    const dir = firstInterestingDir(file);
    if (!dir) continue;
    const row = scores.get(dir) || { path: dir, score: 0, files: new Set<string>() };
    row.score += 2;
    row.files.add(file);
    scores.set(dir, row);
  }
  for (const dir of ['src/core', 'src/commands', 'src/scripts', 'src/cli']) {
    const count = sourcePaths.filter((file) => file.startsWith(`${dir}/`)).length;
    if (!count) continue;
    const row = scores.get(dir) || { path: dir, score: 0, files: new Set<string>() };
    row.score += count;
    scores.set(dir, row);
  }
  return [...scores.values()]
    .filter((row) => row.path.split('/').length <= 3)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, maxLocalFiles))
    .map((row) => ({ path: row.path, score: row.score, files: [...row.files].slice(0, 12) }));
}

function compactClaims(pack: any): string[] {
  const rows = flattenRecords(pack).filter((row) => typeof row.claim === 'string' || typeof row.text === 'string' || typeof row.summary === 'string');
  return rows
    .map((row) => sanitizeLine(row.claim || row.text || row.summary))
    .filter(Boolean)
    .slice(0, 40);
}

function compactModules(pack: any): string[] {
  const rows = flattenRecords(pack).filter((row) => row.path || row.source_path || row.file);
  return rows
    .map((row) => sanitizeLine(`${row.path || row.source_path || row.file}${row.summary ? ` - ${row.summary}` : ''}`))
    .filter(Boolean)
    .slice(0, 40);
}

function compactWrongness(pack: any): string[] {
  const rows = flattenRecords(pack).filter((row) => /wrong|lesson|mistake|stale|failure/i.test(String(row.kind || row.type || row.id || '')));
  return rows.map((row) => sanitizeLine(row.lesson || row.summary || row.text || row.claim || row.id)).filter(Boolean).slice(0, 20);
}

function extractSourcePaths(pack: any): string[] {
  return [...new Set(flattenRecords(pack).flatMap((row) => [row.path, row.source_path, row.file, row.rel, row.relative_path]).map((value) => String(value || '').replace(/^\.\//, '')).filter((value) => value.includes('/')))];
}

function flattenRecords(value: any, depth = 0): any[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => flattenRecords(item, depth + 1));
  if (typeof value !== 'object') return [];
  const own = value as Record<string, any>;
  return [own, ...Object.values(own).flatMap((child) => flattenRecords(child, depth + 1))];
}

function firstInterestingDir(file: string): string | null {
  const parts = file.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === 'src' && parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  return parts[0] || null;
}

async function collectAgentsMdFiles(root: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: resolvedRoot, depth: 0 }];
  const startedAt = Date.now();
  let entries = 0;
  let agentsFiles = 0;
  let agentsBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    assertAgentsScanBudget(startedAt, entries, current.depth, relativeProjectPath(resolvedRoot, current.dir));
    let directory: Awaited<ReturnType<typeof fsp.opendir>>;
    try {
      directory = await fsp.opendir(current.dir);
    } catch (error: any) {
      throw new Error(`triwiki_agents_scan_unreadable:${relativeProjectPath(resolvedRoot, current.dir)}:${String(error?.code || 'unknown')}`);
    }
    try {
      for await (const row of directory) {
        entries += 1;
        assertAgentsScanBudget(startedAt, entries, current.depth, relativeProjectPath(resolvedRoot, current.dir));
        if (['.git', '.sneakoscope', 'node_modules', 'dist', 'target'].includes(row.name)) continue;
        const file = path.join(current.dir, row.name);
        const rel = relativeProjectPath(resolvedRoot, file);
      if (rel === '.claude/worktrees' || rel.startsWith('.claude/worktrees/')) continue;
        if (row.isSymbolicLink()) {
          if (row.name === 'AGENTS.md') throw new Error(`triwiki_agents_scan_symlink_refused:${rel}`);
          continue;
        }
        if (row.isDirectory()) {
          const depth = current.depth + 1;
          if (depth > TRIWIKI_AGENTS_SCAN_LIMITS.maxDepth) {
            throw new Error(`triwiki_agents_scan_depth_limit_exceeded:${rel}`);
          }
          stack.push({ dir: file, depth });
          continue;
        }
        if (row.name !== 'AGENTS.md') continue;
        if (!row.isFile()) throw new Error(`triwiki_agents_scan_type_refused:${rel}`);
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`triwiki_agents_scan_type_refused:${rel}`);
        if (stat.size > TRIWIKI_AGENTS_SCAN_LIMITS.maxAgentFileBytes) {
          throw new Error(`triwiki_agents_scan_file_size_limit_exceeded:${rel}`);
        }
        agentsFiles += 1;
        agentsBytes += stat.size;
        if (agentsFiles > TRIWIKI_AGENTS_SCAN_LIMITS.maxAgentsFiles) {
          throw new Error(`triwiki_agents_scan_file_count_limit_exceeded:${rel}`);
        }
        if (agentsBytes > TRIWIKI_AGENTS_SCAN_LIMITS.maxTotalAgentBytes) {
          throw new Error(`triwiki_agents_scan_byte_limit_exceeded:${rel}`);
        }
        files.push(file);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('triwiki_agents_scan_')) throw error;
      throw new Error(`triwiki_agents_scan_unreadable:${relativeProjectPath(resolvedRoot, current.dir)}:${String(error)}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function assertAgentsScanBudget(startedAt: number, entries: number, depth: number, relative: string): void {
  if (Date.now() - startedAt > TRIWIKI_AGENTS_SCAN_LIMITS.timeoutMs) {
    throw new Error(`triwiki_agents_scan_timeout_exceeded:${relative}`);
  }
  if (entries > TRIWIKI_AGENTS_SCAN_LIMITS.maxEntries) {
    throw new Error(`triwiki_agents_scan_entry_limit_exceeded:${relative}`);
  }
  if (depth > TRIWIKI_AGENTS_SCAN_LIMITS.maxDepth) {
    throw new Error(`triwiki_agents_scan_depth_limit_exceeded:${relative}`);
  }
}

function relativeProjectPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/') || '.';
}

async function readAgentsMdText(file: string): Promise<string> {
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`triwiki_agents_file_type_refused:${file}`);
  }
  if (stat.size > TRIWIKI_AGENTS_SCAN_LIMITS.maxAgentFileBytes) {
    throw new Error(`triwiki_agents_file_size_limit_exceeded:${file}`);
  }
  const contents = await fsp.readFile(file, 'utf8');
  if (Buffer.byteLength(contents) > TRIWIKI_AGENTS_SCAN_LIMITS.maxAgentFileBytes) {
    throw new Error(`triwiki_agents_file_size_limit_exceeded:${file}`);
  }
  return contents;
}

function sanitizeLine(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
