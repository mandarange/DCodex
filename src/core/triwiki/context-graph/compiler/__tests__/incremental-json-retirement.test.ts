/**
 * ADR §8 as a check rather than a promise.
 *
 * The incremental compiler's whole reason to exist is that it does not read the
 * previous full JSON snapshot. That is a property of the import graph, not of
 * behaviour a fixture happens to exercise: a single `readContextGraphSnapshot`
 * added later would still pass every other test in this directory while quietly
 * reintroducing the 108 MB store CRK2 deletes.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const COMPILER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_MODULES = [
  'incremental-build.js',
  'incremental-extract.js',
  'fragment-plan.js',
  'fragment-merge.js',
  'fragment-manifest.js',
  'fragment-manifest-schema.js',
  'fragment-manifest-store.js',
  'fragment-store.js',
  'source-fragment.js',
  'k-way-merge.js',
];

const FORBIDDEN = [/snapshot-store/, /context-graph\.prev\.json/, /readContextGraphSnapshot/, /contextGraphSnapshotPath/];

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

test('nothing the incremental compiler imports can reach the JSON runtime store', async () => {
  const visited = new Set<string>();
  const queue = [...ENTRY_MODULES];
  const checked: string[] = [];

  while (queue.length > 0) {
    const relative = queue.pop() as string;
    if (visited.has(relative)) continue;
    visited.add(relative);
    const source = await fsp.readFile(path.join(COMPILER_DIR, relative), 'utf8');
    // The module's own text catches a call reached through some other module's
    // re-export; its specifiers catch the import that would make one possible.
    checked.push(source);
    for (const specifier of importSpecifiers(source)) {
      checked.push(specifier);
      // Only siblings are followed: anything outside this directory is caught by
      // the specifier check, and walking it would drag in the whole repository.
      if (specifier.startsWith('./')) queue.push(specifier.slice(2));
    }
  }

  for (const entry of ENTRY_MODULES) assert.ok(visited.has(entry), `${entry} was not walked`);
  for (const text of checked) {
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(text), false, `${pattern} reaches the retired JSON runtime store`);
    }
  }
});
