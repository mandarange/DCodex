#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from '../core/fsx.js';
import { assertGate, emitGate, root } from './gate-lib.js';

export { assertGate, emitGate, root };

export function makeSearchVisibilityFixture(name = 'search-visibility', options = {}) {
  const dir = tmpdir(`sks-${name}-`);
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const packageJson = {
    name: `sks-${name}-fixture`,
    version: '0.0.0',
    description: options.description || 'Source-backed search visibility fixture for Sneakoscope gates.',
    keywords: ['sneakoscope', 'search-visibility'],
    repository: { type: 'git', url: 'https://example.test/repo.git' },
    homepage: 'https://example.test/',
    bugs: { url: 'https://example.test/issues' },
    bin: { [`${name}-fixture`]: 'bin/fixture.js' },
    scripts: { build: 'node -e "console.log(1)"' },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'bin', 'fixture.js'), '#!/usr/bin/env node\nconsole.log("fixture")\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${options.title || 'Search Visibility Fixture'}\n\nInstall with \`npm i\` and run \`${name}-fixture\`.\n`);
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), options.html || [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Search Visibility Fixture</title><meta name="description" content="A source-backed fixture."></head>',
    '<body><main><h1>Search Visibility Fixture</h1><p>Official source-backed content.</p><a href="/docs">Docs</a></main></body>',
    '</html>',
    '',
  ].join('\n'));
  return dir;
}

export function runSks(args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), ...args], {
    cwd: options.cwd || root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      SKS_TEST_REAL_IMAGEGEN: '0',
      SKS_REAL_IMAGEGEN: '0',
      SKS_REQUIRE_REAL_COMPUTER_USE: '0',
      ...(options.env || {}),
    },
    timeout: options.timeoutMs || 120000,
  });
  if (!options.allowFailure) {
    assertGate(result.status === 0, `sks command failed: ${args.join(' ')}`, {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}

export function runSksJson(args, options = {}) {
  const result = runSks(args, options);
  const parsed = parseJsonOutput(result.stdout);
  assertGate(parsed && typeof parsed === 'object', `sks command did not emit JSON: ${args.join(' ')}`, {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return { result, json: parsed };
}

export function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function missionDir(missionId, baseRoot = root) {
  return path.join(baseRoot, '.sneakoscope', 'missions', missionId);
}

export function artifactPath(missionId, rel, baseRoot = root) {
  return path.join(missionDir(missionId, baseRoot), rel.startsWith('search-visibility/') ? rel : path.join('search-visibility', rel));
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function assertMissionArtifact(missionId, rel, baseRoot = root) {
  const file = rel === 'completion-proof.json' || rel.endsWith('-gate.json')
    ? path.join(missionDir(missionId, baseRoot), rel)
    : artifactPath(missionId, rel, baseRoot);
  assertGate(fs.existsSync(file), `missing mission artifact: ${rel}`, { missionId, file });
  return readJsonFile(file);
}

export function listSourceFiles(dir) {
  const out = [];
  walk(dir, out);
  return out
    .map((file) => path.relative(dir, file).split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('.sneakoscope/'))
    .sort();
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.sneakoscope' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}
