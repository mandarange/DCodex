/**
 * NC-8: packed surface must expose cleanup (triwiki-cleanup) and align dollar/CLI routes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('cleanup and align are registered on CLI manifests', () => {
  const lite = read('src/cli/command-manifest-lite.ts');
  assert.match(lite, /name:\s*'cleanup'/);
  assert.match(lite, /name:\s*'align'/);
  assert.match(lite, /Permanently blank active TriWiki|no retained/i);
  assert.match(lite, /Create or replace TriWiki|code-only repository navigation/i);
});

test('dollar manifest exposes $Cleanup and $Align', () => {
  const dollar = read('src/core/routes/dollar-manifest-lite.ts');
  assert.match(dollar, /\$Cleanup/);
  assert.match(dollar, /\$Align/);
});

test('core skill manifest includes cleanup and align, not loop', () => {
  const manifest = read('src/core/codex-native/core-skill-manifest.ts');
  assert.match(manifest, /sks-core-cleanup/);
  assert.match(manifest, /sks-core-align/);
  assert.doesNotMatch(manifest, /sks-core-loop/);
});

test('light completion routes encode C6 set', () => {
  const light = read('src/core/routes/light-routes.ts');
  assert.match(light, /answer/);
  assert.match(light, /dfix/);
  assert.match(light, /help/);
  assert.match(light, /status/);
});

test('wiki refresh --code aliases to align repair command constant', () => {
  const contracts = read('src/core/triwiki/context-graph/contracts.ts');
  assert.match(contracts, /CONTEXT_GRAPH_REPAIR_COMMAND = 'sks align run'/);
  const wiki = read('src/core/commands/wiki-command.ts');
  assert.match(wiki, /alignCommand/);
  assert.match(wiki, /aliasing to sks align run|→ sks align run/);
});
