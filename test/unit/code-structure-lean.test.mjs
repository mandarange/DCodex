import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('code structure scan emits lean change evidence for explicit changed files', async () => {
  const mod = await import('../../dist/core/code-structure.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-code-structure-lean-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(root, 'src/demo.ts'), [
    "import fs from 'node:fs';",
    '// sks-lean: ceiling=local fixture; revisit_when=shared scanner grows; upgrade=extract parser fixture',
    'const cwdExists = fs.existsSync(".");',
    'export const value = cwdExists ? 1 : 0;'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'test/demo.test.ts'), [
    "import test from 'node:test';",
    "test('fixture', () => {",
    '  Boolean(true);',
    '});'
  ].join('\n'));

  const report = await mod.scanCodeStructure(root, {
    includeOk: true,
    changedFiles: ['src/demo.ts', 'test/demo.test.ts']
  });

  assert.equal(report.lean_change_evidence.schema, 'sks.lean-change-evidence.v1');
  assert.equal(report.lean_change_evidence.policy_id, 'sks.lean-engineering-policy.v1');
  assert.deepEqual(report.dependencies_added, []);
  assert.ok(report.runnable_checks.includes('test/demo.test.ts'));
  assert.ok(report.intentional_simplifications.some((marker) => marker.status === 'complete'));
  assert.equal(report.semantic_review.status, 'pass');
});

test('code structure scan only treats real ts-nocheck directives as scoped blockers', async () => {
  const mod = await import('../../dist/core/code-structure.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-code-structure-nocheck-'));
  await fs.mkdir(path.join(root, 'src/core'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(root, 'src/core/code-structure.ts'), [
    'const detector = "/@ts-nocheck/";',
    'export const ok = detector.length;'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src/scripts/seo-fixture-check.ts'), [
    '// @ts-nocheck',
    'export const fixture = 1;'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'test/nocheck.test.ts'), [
    "import test from 'node:test';",
    "test('fixture', () => Boolean(true));"
  ].join('\n'));

  const report = await mod.scanCodeStructure(root, {
    includeOk: true,
    changedFiles: ['src/core/code-structure.ts', 'src/scripts/seo-fixture-check.ts', 'test/nocheck.test.ts']
  });

  assert.equal(report.files.find((entry) => entry.path === 'src/core/code-structure.ts').lean_signals.ts_nocheck, false);
  assert.equal(report.files.find((entry) => entry.path === 'src/scripts/seo-fixture-check.ts').lean_signals.ts_nocheck, true);
  assert.equal(report.semantic_review.status, 'needs-review');
  assert.equal(report.semantic_review.findings.some((finding) => finding.severity === 'blocker'), false);
});

test('full code structure scan skips hidden worktree and cache repository copies', async () => {
  const mod = await import('../../dist/core/code-structure.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-code-structure-hidden-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude/worktrees/clone/src'), { recursive: true });
  await fs.mkdir(path.join(root, '.cache/mirror/src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/main.ts'), 'export const main = true;\n');
  await fs.writeFile(path.join(root, '.claude/worktrees/clone/src/huge.ts'), 'export {};\n'.repeat(3_100));
  await fs.writeFile(path.join(root, '.cache/mirror/src/cached.ts'), 'export {};\n'.repeat(3_100));

  const report = await mod.scanCodeStructure(root, { includeOk: true });
  const paths = report.files.map((entry) => entry.path);

  assert.ok(paths.includes('src/main.ts'));
  assert.equal(paths.some((file) => file.startsWith('.claude/')), false);
  assert.equal(paths.some((file) => file.startsWith('.cache/')), false);
});

test('a requested changed scope that matched nothing scans nothing instead of the whole tree', async () => {
  // Route prep asks for the changed scope before any edit exists. Falling back
  // to a full-repo deep scan there stalled the UserPromptSubmit hook for
  // minutes; an empty request must stay empty.
  const mod = await import('../../dist/core/code-structure.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-code-structure-empty-scope-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  for (let i = 0; i < 5; i += 1) {
    await fs.writeFile(path.join(root, `src/file-${i}.ts`), `export const v${i} = ${i};\n`);
  }

  // No git repo and no explicit changed files => the changed scope is empty.
  const scoped = await mod.scanCodeStructure(root, { changed: true, includeOk: true });
  assert.equal(scoped.files.length, 0, JSON.stringify(scoped.files.map((e) => e.path)));

  const scopedSince = await mod.scanCodeStructure(root, { changedSince: 'HEAD', includeOk: true });
  assert.equal(scopedSince.files.length, 0);

  // A caller that asks for no scope at all still gets the full listing.
  const full = await mod.scanCodeStructure(root, { includeOk: true });
  assert.equal(full.files.length, 5, JSON.stringify(full.files.map((e) => e.path)));

  await fs.rm(root, { recursive: true, force: true });
});
