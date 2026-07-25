import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const architectureScript = path.resolve('dist/scripts/check-architecture.js');

test('architecture check detects a committed clean-branch regression from merge-base', () => {
  const fixture = createFixture();
  try {
    writeLines(path.join(fixture, 'src/feature.ts'), 6);
    git(fixture, ['add', '.']);
    git(fixture, ['commit', '-m', 'grow feature']);
    const result = runArchitecture(fixture, ['--base-ref', 'main']);
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stderr, /src\/feature\.ts: 6 lines > 5 default-handwritten-source budget/);
    const report = JSON.parse(fs.readFileSync(path.join(fixture, '.sneakoscope/reports/architecture-check.json'), 'utf8'));
    assert.equal(report.mode, 'merge-base-changed');
    assert.equal(report.changed_files.includes('src/feature.ts'), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('strict-all checks unchanged files and shrink-only waivers reject growth', () => {
  const fixture = createFixture({ waivedLines: 7 });
  try {
    const changedOnly = runArchitecture(fixture, ['--base-ref', 'main']);
    assert.equal(changedOnly.status, 0, changedOnly.stderr || changedOnly.stdout);
    const strict = runArchitecture(fixture, ['--base-ref', 'main', '--strict-all']);
    assert.equal(strict.status, 0, strict.stderr || strict.stdout);

    git(fixture, ['checkout', '-b', 'feature']);
    writeLines(path.join(fixture, 'src/waived.ts'), 8);
    git(fixture, ['add', '.']);
    git(fixture, ['commit', '-m', 'grow waived source']);
    const grown = runArchitecture(fixture, ['--base-ref', 'main']);
    assert.notEqual(grown.status, 0, grown.stdout || grown.stderr);
    assert.match(grown.stderr, /shrink-only ceiling 7 exceeded/);

    writeLines(path.join(fixture, 'src/waived.ts'), 6);
    const shrunk = runArchitecture(fixture, ['--base-ref', 'main']);
    assert.equal(shrunk.status, 0, shrunk.stderr || shrunk.stdout);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('rename-aware baseline allows a high-similarity renamed file to use a shrink-only waiver', () => {
  const fixture = createFixture({ waivedLines: 7 });
  try {
    git(fixture, ['checkout', '-b', 'feature']);
    git(fixture, ['mv', 'src/waived.ts', 'src/renamed-waived.ts']);
    writeLines(path.join(fixture, 'src/renamed-waived.ts'), 6);
    writeWaivers(fixture, [{
      schema: 'sks.architecture-waiver.v1',
      file: 'src/renamed-waived.ts',
      reason: 'fixture renamed legacy debt',
      policy: 'shrink-only',
      baseline_lines: 7
    }]);
    git(fixture, ['add', '.']);
    git(fixture, ['commit', '-m', 'rename and shrink waived source']);

    const result = runArchitecture(fixture, ['--base-ref', 'main']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rename = gitOutput(fixture, ['diff', '--name-status', '--find-renames', 'main', '--']);
    assert.match(rename, /^R\d+\s+src\/waived\.ts\s+src\/renamed-waived\.ts$/m);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('architecture waivers remain forbidden for genuinely new files', () => {
  const fixture = createFixture();
  try {
    writeLines(path.join(fixture, 'src/new-waived.ts'), 6);
    writeWaivers(fixture, [{
      schema: 'sks.architecture-waiver.v1',
      file: 'src/new-waived.ts',
      reason: 'fixture must not waive a new file',
      policy: 'shrink-only',
      baseline_lines: 6
    }]);
    git(fixture, ['add', '.']);
    git(fixture, ['commit', '-m', 'add oversized waived source']);

    const result = runArchitecture(fixture, ['--base-ref', 'main']);
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stderr, /new files cannot use architecture waivers/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-architecture-fixture-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      'pipeline-budget:check': 'node -e "process.exit(0)"',
      'pipeline-runtime:check': 'node -e "process.exit(0)"'
    }
  }));
  fs.writeFileSync(path.join(root, 'config/architecture-budgets.v1.json'), JSON.stringify({
    schema: 'sks.architecture-budgets.v1',
    scan_roots: ['src'],
    source_extensions: ['.ts'],
    split_review_lines: 20,
    default_new_file_max_lines: 5,
    budgets: [{ id: 'default-handwritten-source', match: '.*', max_lines: 5, new_file_max_lines: 5 }],
    waiver_policy: { mode: 'shrink-only', required_fields: ['schema', 'file', 'reason', 'policy', 'baseline_lines'] }
  }));
  const waivers = options.waivedLines ? [{
    schema: 'sks.architecture-waiver.v1',
    file: 'src/waived.ts',
    reason: 'fixture legacy debt',
    policy: 'shrink-only',
    baseline_lines: options.waivedLines
  }] : [];
  writeWaivers(root, waivers);
  writeLines(path.join(root, 'src/feature.ts'), 5);
  if (options.waivedLines) writeLines(path.join(root, 'src/waived.ts'), options.waivedLines);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'Architecture Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  if (!options.waivedLines) git(root, ['checkout', '-b', 'feature']);
  return root;
}

function runArchitecture(root, args) {
  return spawnSync(process.execPath, [architectureScript, ...args], { cwd: root, encoding: 'utf8' });
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitOutput(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function writeWaivers(root, waivers) {
  fs.writeFileSync(path.join(root, 'src/generated/architecture-waivers.json'), JSON.stringify({
    schema: 'sks.architecture-waivers.v1',
    waivers
  }));
}

function writeLines(file, count) {
  fs.writeFileSync(file, Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join('\n'));
}
