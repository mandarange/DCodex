import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const RETIRED_TOKEN = ['zel', 'lij'].join('');
const ROOT = path.resolve('.');
const ROOT_CONFIG_FILES = new Set([
  '.gitattributes',
  '.gitignore',
  '.npmignore',
  '.npmrc',
  'CHANGELOG.md',
  'README.md',
  'package-lock.json',
  'package.json',
  'safety-mutation-allowlist.json'
]);

function isScopedSurface(file) {
  return ROOT_CONFIG_FILES.has(file)
    || file.startsWith('docs/')
    || file.startsWith('schemas/')
    || file.startsWith('src/')
    || file.startsWith('templates/')
    || file.startsWith('test/')
    || file.startsWith('.codex/')
    || file.startsWith('.github/')
    || /^(?:infra-harness|release|runtime-required|tsconfig)[^/]*\.(?:json|ya?ml)$/.test(file);
}

function isGeneratedTriWikiPack(file) {
  return /^\.sneakoscope\/wiki\/code-pack[^/]*\.json$/.test(file);
}

test('tracked package, release, source, test, docs, and config surfaces contain no retired terminal token', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const matches = [];

  for (const file of tracked) {
    if (!isScopedSurface(file) || isGeneratedTriWikiPack(file)) continue;
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    if (file.toLowerCase().includes(RETIRED_TOKEN)) matches.push(`path:${file}`);
    const contents = fs.readFileSync(absolute);
    if (!contents.includes(0) && contents.toString('utf8').toLowerCase().includes(RETIRED_TOKEN)) {
      matches.push(`content:${file}`);
    }
  }

  assert.deepEqual(matches, []);
});
