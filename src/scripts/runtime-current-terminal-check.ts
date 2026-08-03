#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { root } from './lib/ensure-dist-fresh.js';

const scanRoots = ['src', 'scripts', 'package.json', 'README.md', 'docs'];
const migrationOnlyFiles = new Set([
  'dist/scripts/runtime-current-terminal-check.js',
  'src/scripts/runtime-current-terminal-check.ts',
  'src/cli/command-registry.ts',
  'src/core/commands/basic-cli.ts'
]);
const legacyFixtureFileRe = /^(scripts|test)\/.*(?:tmux|real-tmux|warp-right-lane).*$/;
const runtimePatterns = [
  ['tmux_binary_spawn', /(?:runProcess|spawnSync|spawn|execFile)\(\s*['"]tmux['"]/],
  ['tmux_import', /(?:from\s+['"][^'"]*tmux[^'"]*['"]|import\s*\([^)]*['"][^'"]*tmux[^'"]*['"])/],
  ['launchMadTmuxUi', /\blaunchMadTmuxUi\b/],
  ['agent-runner-tmux', /\bagent-runner-tmux\b/],
  ['tmux-physical-proof', /\btmux-physical-proof\b/],
  ['tmux-lane', /\btmux-lane\b/],
  ['real-tmux', /\breal-tmux\b/],
  ['warp-right-lane', /\bwarp-right-lane\b/]
];
const docRecommendationRe = /\b(?:sks\s+tmux|sks\s+deps\s+install\s+tmux|brew\s+install\s+tmux|install\s+tmux|requires?\s+tmux|tmux\s+for\s+the\s+CLI|opens?.{0,60}tmux|npm\s+run\s+(?:tmux:|agent:tmux)|cleanup-tmux|open-tmux|attach-tmux)\b/i;
const issues = [];
const legacy_fixture_allowlist = [];
const checked_files = [];

for (const base of scanRoots) {
  for (const file of await listFiles(path.join(root, base))) {
    const rel = path.relative(root, file);
    checked_files.push(rel);
    const text = await fs.readFile(file, 'utf8');
    if (rel === 'package.json') {
      inspectPackageJson(text);
      continue;
    }
    if (migrationOnlyFiles.has(rel)) continue;
    if (legacyFixtureFileRe.test(rel)) {
      legacy_fixture_allowlist.push(rel);
      continue;
    }
    if (rel.startsWith('docs/') || rel === 'README.md') {
      inspectDocs(rel, text);
      continue;
    }
    for (const [name, re] of runtimePatterns) {
      if (re.test(text)) issues.push({ file: rel, pattern: name });
    }
    inspectRuntimeRecommendations(rel, text);
  }
}
const ok = issues.length === 0;
emit({
  schema: 'sks.runtime-current-terminal-check.v1',
  ok,
  scan_roots: scanRoots,
  issues,
  checked_file_count: checked_files.length,
  migration_only_files: [...migrationOnlyFiles],
  legacy_fixture_allowlist
});

async function listFiles(target) {
  const out = [];
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return out;
  if (stat.isFile()) return [target];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const file = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(file));
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|json|md)$/.test(entry.name)) out.push(file);
  }
  return out;
}
function inspectPackageJson(text) {
  const pkg = JSON.parse(text);
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (name === 'runtime:terminal-current') continue;
    if (/^(tmux:|agent:tmux-)|warp-right-lane|real-tmux/i.test(name)) {
      issues.push({ file: 'package.json', script: name, pattern: 'tmux_script_name' });
    }
    if (/(?:npm\s+run\s+tmux:|agent-tmux|real-tmux|tmux-physical-proof|tmux-lane|warp-right-lane|mad-sks:warp-right-lane-attach)/i.test(String(command))) {
      issues.push({ file: 'package.json', script: name, pattern: 'tmux_script_command' });
    }
  }
}
function inspectDocs(rel, text) {
  inspectRuntimeRecommendations(rel, text);
}
function inspectRuntimeRecommendations(rel, text) {
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/\bremoved[-_ ]runtime\b|migration notice/i.test(line)) return;
    if (docRecommendationRe.test(line)) issues.push({ file: rel, line: index + 1, pattern: 'tmux_runtime_recommendation' });
  });
}
function emit(report) { console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
