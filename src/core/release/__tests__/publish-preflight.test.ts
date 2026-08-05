import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { inspectPublishPreflight, type PublishPreflightCommandResult } from '../publish-preflight.js';

const SHA = 'a'.repeat(40);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-publish-preflight-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '8.0.3' }));
  return root;
}

function runner(root: string, overrides: Record<string, PublishPreflightCommandResult> = {}) {
  const defaults: Record<string, PublishPreflightCommandResult> = {
    'git rev-parse --show-toplevel': ok(`${root}\n`),
    'git symbolic-ref --quiet --short HEAD': ok('main\n'),
    'git status --porcelain=v1 --untracked-files=all': ok(''),
    'git rev-parse HEAD': ok(`${SHA}\n`),
    'git remote get-url origin': ok('https://github.com/mandarange/Sneakoscope-Codex.git\n'),
    'git ls-remote --exit-code origin refs/heads/main': ok(`${SHA}\trefs/heads/main\n`),
    'git rev-parse refs/tags/v8.0.3^{commit}': ok(`${SHA}\n`),
    'git ls-remote --exit-code origin refs/tags/v8.0.3 refs/tags/v8.0.3^{}': ok(`${SHA}\trefs/tags/v8.0.3\n`),
  };
  return (command: string, args: string[]) => overrides[`${command} ${args.join(' ')}`] || defaults[`${command} ${args.join(' ')}`] || fail();
}

test('publish preflight binds a clean main checkout to live origin/main and the exact version tag', async () => {
  const root = await fixture();
  const report = inspectPublishPreflight({ root, run: runner(root), requirePhysicalReleaseGates: false });
  assert.equal(report.ok, true, report.blockers.join(', '));
  assert.equal(report.package_version, '8.0.3');
  assert.equal(report.release_tag, 'v8.0.3');
  assert.equal(report.release_tag_required, true);
  assert.equal(report.physical_release_gates_required, false);
  assert.equal(report.head, SHA);
  assert.equal(report.origin_main, SHA);
  assert.equal(report.clean_tree, true);
});

test('publish dry-run keeps main and origin binding but does not require release tags', async () => {
  const root = await fixture();
  const report = inspectPublishPreflight({
    root,
    run: runner(root, {
      'git rev-parse refs/tags/v8.0.3^{commit}': fail(),
      'git ls-remote --exit-code origin refs/tags/v8.0.3 refs/tags/v8.0.3^{}': fail(),
    }),
    requireReleaseTag: false,
  });
  assert.equal(report.ok, true, report.blockers.join(', '));
  assert.equal(report.release_tag, 'v8.0.3');
  assert.equal(report.release_tag_required, false);
  assert.equal(report.physical_release_gates_required, false);
  assert.equal(report.head, SHA);
  assert.equal(report.origin_main, SHA);
  assert.equal(report.local_release_tag_commit, null);
  assert.equal(report.remote_release_tag_commit, null);
});

test('dirty, detached, stale-remote, and mistagged publish states fail closed', async () => {
  const root = await fixture();
  const cases: Array<[string, Record<string, PublishPreflightCommandResult>, string]> = [
    ['dirty', { 'git status --porcelain=v1 --untracked-files=all': ok(' M src/index.ts\n') }, 'worktree_not_clean'],
    ['detached', { 'git symbolic-ref --quiet --short HEAD': fail() }, 'publish_requires_main_branch:detached'],
    ['stale remote main', { 'git ls-remote --exit-code origin refs/heads/main': ok(`${'b'.repeat(40)}\trefs/heads/main\n`) }, 'head_not_origin_main'],
    ['missing version tag', { 'git rev-parse refs/tags/v8.0.3^{commit}': fail() }, 'release_tag_missing:v8.0.3'],
    ['remote tag mismatch', { 'git ls-remote --exit-code origin refs/tags/v8.0.3 refs/tags/v8.0.3^{}': ok(`${'b'.repeat(40)}\trefs/tags/v8.0.3\n`) }, 'remote_release_tag_not_head:v8.0.3'],
  ];
  for (const [name, overrides, blocker] of cases) {
    const report = inspectPublishPreflight({ root, run: runner(root, overrides), requirePhysicalReleaseGates: false });
    assert.equal(report.ok, false, name);
    assert.ok(report.blockers.some((value) => value.startsWith(blocker)), `${name}: ${report.blockers.join(', ')}`);
  }
});

test('real publish preflight fails closed when source-bound physical release evidence is missing', async () => {
  const root = await fixture();
  const report = inspectPublishPreflight({
    root,
    run: runner(root),
    requirePhysicalReleaseGates: true,
  });
  assert.equal(report.ok, false);
  assert.equal(report.physical_release_gates_required, true);
  assert.equal(report.physical_release_gates?.ok, false);
  assert.ok(report.blockers.includes('physical_receipt_missing_or_invalid'));
});

function ok(stdout: string): PublishPreflightCommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(): PublishPreflightCommandResult {
  return { status: 1, stdout: '', stderr: 'fixture failure' };
}
