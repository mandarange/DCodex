import path from 'node:path';
import { findReferences } from './impact-scan.js';

export interface DiffQuality {
  schema: 'sks.diff-quality.v1';
  minimality: { plan_files: number; touched_files: number; ratio: number };
  dead_additions: string[];
  comment_noise: number;
  guard_bloat: number;
  warnings: string[];
  errors: string[];
}

const ADDED_EXPORT_RE = /^\+\s*export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)\b/;

export async function analyzeDiffQuality(input: {
  root: string;
  changedFiles: string[];
  patchText: string;
  plannedFiles?: string[];
}): Promise<DiffQuality> {
  const planFiles = new Set((input.plannedFiles || []).map(normalizePath).filter(Boolean));
  const touchedFiles = new Set(input.changedFiles.map(normalizePath).filter(Boolean));
  const ratio = touchedFiles.size / Math.max(1, planFiles.size || touchedFiles.size || 1);
  const deadAdditions = await detectDeadAdditions(input.root, input.patchText, input.changedFiles);
  const commentNoise = detectCommentNoise(input.patchText);
  const guardBloat = detectGuardBloat(input.patchText);
  const warnings = [
    ...(ratio > 2 ? [`minimality_ratio:${ratio.toFixed(2)}`] : []),
    ...(commentNoise > 0 ? [`comment_noise:${commentNoise}`] : []),
    ...(guardBloat > 0 ? [`guard_bloat:${guardBloat}`] : [])
  ];
  const errors = deadAdditions.map((name) => `dead_addition:${name}`);
  return {
    schema: 'sks.diff-quality.v1',
    minimality: {
      plan_files: planFiles.size,
      touched_files: touchedFiles.size,
      ratio: Number(ratio.toFixed(3))
    },
    dead_additions: deadAdditions,
    comment_noise: commentNoise,
    guard_bloat: guardBloat,
    warnings,
    errors
  };
}

function addedExports(patchText: string, changedFiles: string[]): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  let currentFile = normalizePath(changedFiles[0] || '');
  for (const line of String(patchText || '').split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = normalizePath(line.slice('+++ b/'.length));
      continue;
    }
    const match = line.match(ADDED_EXPORT_RE);
    if (match?.[1]) out.push({ name: match[1], file: currentFile });
  }
  const seen = new Set<string>();
  return out.filter((row) => {
    const key = `${row.file}:${row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function detectDeadAdditions(root: string, patchText: string, changedFiles: string[]): Promise<string[]> {
  const additions = addedExports(patchText, changedFiles);
  if (!additions.length) return [];
  const dead: string[] = [];
  for (const addition of additions) {
    const found = await findReferences(root, addition.name, { excludeFile: addition.file });
    if (!found.refs.length) dead.push(addition.name);
  }
  return dead;
}

function detectCommentNoise(patchText: string): number {
  const added = String(patchText || '').split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  let count = 0;
  for (let i = 0; i < added.length - 1; i += 1) {
    const comment = added[i]?.replace(/^\+\s*/, '') || '';
    const code = added[i + 1]?.replace(/^\+\s*/, '') || '';
    if (!/^(\/\/|\/\*|\*)/.test(comment.trim())) continue;
    if (tokenOverlap(comment, code) >= 0.7) count += 1;
  }
  return count;
}

function detectGuardBloat(patchText: string): number {
  const text = String(patchText || '').split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
  const matches = text.match(/catch\s*\([^)]*\)\s*\{\s*(?:console\.(?:log|warn|error)\([^)]*\);?\s*)?\}/g);
  return matches?.length || 0;
}

function tokenOverlap(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function tokens(value: string): Set<string> {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
}

function normalizePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}
