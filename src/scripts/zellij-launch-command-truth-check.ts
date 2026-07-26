#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { root, assertGate, emitGate, readText } from './gate-lib.js';

// Locks the single documented Zellij launch command across code + changelog and
// forbids the stale `zellij --session <s> --layout <l>` launch pattern.

const launcherText = readText('src/core/zellij/zellij-launcher.ts');
const builderText = readText('src/core/zellij/zellij-layout-builder.ts');

for (const [rel, text] of [
  ['src/core/zellij/zellij-launcher.ts', launcherText],
  ['src/core/zellij/zellij-layout-builder.ts', builderText]
]) {
  assertGate(text.includes('--create-background'), `missing --create-background in ${rel}`, { file: rel });
  assertGate(text.includes('--default-layout'), `missing --default-layout in ${rel}`, { file: rel });
}

// The launcher must use the attach form: the argv array literal begins with
// 'attach', '--create-background'.
assertGate(
  launcherText.includes("'attach', '--create-background'"),
  "launcher must use the attach form: \"'attach', '--create-background'\"",
  { file: 'src/core/zellij/zellij-launcher.ts' }
);

// Stale-pattern ban across src/ and scripts/ (.ts/.mjs/.js only). The stale
// launch is `zellij --session <s> --layout <l>`; the regex matches that line
// shape. zellij-screen-proof.ts uses ['--session', name, 'action',
// 'dump-screen', ...] (no --layout) so it is correctly ignored.
const STALE_RE = /--session[^\n]*--layout/;
const exts = new Set(['.ts', '.mjs', '.js']);
const scanRoots = ['src', 'scripts'];
// This gate's own source necessarily contains the stale pattern (the regex +
// the doc comment), so it must exclude itself from the scan.
const SELF_FILE = 'zellij-launch-command-truth-check.ts';
const offenders = [];
let filesScanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === SELF_FILE) continue;
    if (!exts.has(path.extname(entry.name))) continue;
    filesScanned += 1;
    const text = fs.readFileSync(full, 'utf8');
    if (STALE_RE.test(text)) offenders.push(path.relative(root, full));
  }
}

for (const scanRoot of scanRoots) walk(path.join(root, scanRoot));

assertGate(
  offenders.length === 0,
  'stale `zellij --session <s> --layout <l>` launch pattern found',
  { offenders, pattern: String(STALE_RE) }
);

// Changelog agreement: the documented command in CHANGELOG must match the code.
const changelog = readText('CHANGELOG.md');
assertGate(changelog.includes('--create-background'), 'CHANGELOG.md missing --create-background', {});
assertGate(changelog.includes('--default-layout'), 'CHANGELOG.md missing --default-layout', {});

const report = {
  schema: 'sks.zellij-launch-command-truth.v1',
  ok: true,
  launcher_ok: true,
  files_scanned: filesScanned,
  offenders
};
fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'zellij-launch-command-truth.json'),
  `${JSON.stringify(report, null, 2)}\n`
);

emitGate('zellij:launch-command-truth', { launcher_ok: true, files_scanned: filesScanned });
