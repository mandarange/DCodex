import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { codePackFreshnessNote } from '../hooks-runtime/code-pack-freshness-preflight.js';
import { inspectCodePackHeadFreshness } from '../triwiki/code-pack-head-freshness.js';

const SEMANTIC_TEST_BUDGET_MS = 5_000;
const FAILURE_CLASSIFICATION_TIMEOUT_MS = 30_000;
let repoTemplatePromise: Promise<{ root: string; head: string }> | null = null;

async function tempRepo(): Promise<{ root: string; head: string }> {
  repoTemplatePromise ||= createRepoTemplate();
  const template = await repoTemplatePromise;
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-code-pack-fresh-'));
  const root = path.join(parent, 'repo');
  await fsp.cp(template.root, root, { recursive: true });
  return { root, head: template.head };
}

async function createRepoTemplate(): Promise<{ root: string; head: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-code-pack-template-'));
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  await fsp.writeFile(path.join(root, 'a.txt'), 'a\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  return { root, head };
}

async function writePack(root: string, sha: string | null): Promise<void> {
  const dir = path.join(root, '.sneakoscope', 'wiki');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'code-pack.json'), JSON.stringify({ schema: 'sks.code-pack.v1', git_head_sha: sha, entries: [] }));
}

type FakeGitBehavior =
  | { kind: 'immediate_failure' }
  | { kind: 'node'; source: string };

async function withFakeGit<T>(behavior: FakeGitBehavior, work: () => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-code-pack-fake-git-'));
  const launcher = path.join(dir, process.platform === 'win32' ? 'git.cmd' : 'git');
  if (behavior.kind === 'immediate_failure') {
    if (process.platform === 'win32') {
      await fsp.writeFile(launcher, '@echo simulated git failure 1>&2\r\n@exit /b 1\r\n');
    } else {
      await fsp.writeFile(launcher, "#!/bin/sh\nprintf '%s\\n' 'simulated git failure' >&2\nexit 1\n", { mode: 0o755 });
    }
  } else {
    const script = path.join(dir, 'fake-git.cjs');
    await fsp.writeFile(script, behavior.source);
    if (process.platform === 'win32') {
      await fsp.writeFile(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      await fsp.writeFile(launcher, `#!${process.execPath}\n${behavior.source}`, { mode: 0o755 });
    }
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`;
  try {
    return await work();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('codePackFreshnessNote stays silent when there is no code pack at all (never nag opt-out repos)', async () => {
  const { root } = await tempRepo();
  assert.equal(await codePackFreshnessNote(root), null);
});

test('codePackFreshnessNote stays silent when the pack matches the current HEAD', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
});

test('codePackFreshnessNote stays silent after a follow-up commit containing only tracked navigation metadata', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  await fsp.writeFile(path.join(root, '.sneakoscope/wiki/code-navigation-manifest.json'), '{}\n');
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['add', '.sneakoscope/wiki/code-pack.json', '.sneakoscope/wiki/code-navigation-manifest.json']);
  git(['commit', '-q', '-m', 'refresh code pack']);

  const inspection = await inspectCodePackHeadFreshness(root, head, { timeoutMs: SEMANTIC_TEST_BUDGET_MS });
  assert.equal(inspection.fresh, true);
  assert.equal(inspection.reason, 'metadata_only_history');
  assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
});

test('metadata-only advisory cache keeps the real Git-backed freshness component below 100ms p95', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['add', '.sneakoscope/wiki/code-pack.json']);
  git(['commit', '-q', '-m', 'refresh code pack']);
  assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);

  const durations: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now();
    assert.equal(await codePackFreshnessNote(root), null);
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  assert.ok(p95 < 100, `expected cached freshness p95 < 100ms, received ${p95.toFixed(2)}ms`);
});

test('codePackFreshnessNote stays silent when Git inspection fails for metadata-only freshness', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['add', '.sneakoscope/wiki/code-pack.json']);
  git(['commit', '-q', '-m', 'refresh code pack']);

  await withFakeGit({ kind: 'immediate_failure' }, async () => {
    // This assertion distinguishes a non-zero exit from the separately tested
    // timeout branch; it is not a process-startup performance budget.
    const inspection = await inspectCodePackHeadFreshness(root, head, { timeoutMs: FAILURE_CLASSIFICATION_TIMEOUT_MS });
    assert.equal(inspection.fresh, false);
    assert.equal(inspection.conclusive, false);
    assert.equal(inspection.reason, 'git_failed');
    assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
  });
});

test('codePackFreshnessNote stays silent when Git inspection times out for metadata-only freshness', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['add', '.sneakoscope/wiki/code-pack.json']);
  git(['commit', '-q', '-m', 'refresh code pack']);

  await withFakeGit({ kind: 'node', source: 'setTimeout(() => {}, 10_000);\n' }, async () => {
    const inspection = await inspectCodePackHeadFreshness(root, head, { timeoutMs: 75 });
    assert.equal(inspection.fresh, false);
    assert.equal(inspection.conclusive, false);
    assert.equal(inspection.reason, 'git_timeout');
    const started = performance.now();
    assert.equal(await codePackFreshnessNote(root, { budgetMs: 150 }), null);
    assert.ok(performance.now() - started < 1_000, 'timeout path must remain bounded');
  });
});

test('codePackFreshnessNote reports stale when source code changes after a code-pack-only commit', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['add', '.sneakoscope/wiki/code-pack.json']);
  git(['commit', '-q', '-m', 'refresh code pack']);
  assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
  await fsp.writeFile(path.join(root, 'a.txt'), 'changed\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'change source']);

  const note = await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS });
  assert.match(String(note || ''), /sks align run/);
});

test('codePackFreshnessNote sees source changes on an older side branch merged after the pack commit', async () => {
  const { root } = await tempRepo();
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const mainBranch = git(['branch', '--show-current']).stdout.trim();

  git(['checkout', '-q', '-b', 'older-side']);
  await fsp.writeFile(path.join(root, 'a.txt'), 'side change\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'side source change']);
  await fsp.writeFile(path.join(root, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'side source revert']);
  const prevPack = path.join(root, '.sneakoscope', 'wiki', 'code-pack.prev.json');
  await fsp.mkdir(path.dirname(prevPack), { recursive: true });
  await fsp.writeFile(prevPack, '{}\n');
  git(['add', '.sneakoscope/wiki/code-pack.prev.json']);
  git(['commit', '-q', '-m', 'side metadata']);

  git(['checkout', '-q', mainBranch]);
  await fsp.writeFile(path.join(root, 'anchor.txt'), 'pack point\n');
  git(['add', 'anchor.txt']);
  git(['commit', '-q', '-m', 'pack point']);
  const packSha = git(['rev-parse', 'HEAD']).stdout.trim();
  await writePack(root, packSha);
  git(['add', '.sneakoscope/wiki/code-pack.json']);
  git(['commit', '-q', '-m', 'pack metadata']);
  git(['merge', '--no-ff', '-q', 'older-side', '-m', 'merge older side']);

  const note = await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS });
  assert.match(String(note || ''), /sks align run/);
});

test('codePackFreshnessNote stays stale when a committed source change is later reverted', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  await fsp.writeFile(path.join(root, 'a.txt'), 'changed\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'change source']);
  await fsp.writeFile(path.join(root, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'revert source']);

  const note = await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS });
  assert.match(String(note || ''), /sks align run/);
});

test('codePackFreshnessNote does not normalize a leading-space path into metadata allowlist', async () => {
  const { root, head } = await tempRepo();
  await writePack(root, head);
  const disguised = path.join(root, ' .sneakoscope', 'wiki', 'code-pack.json');
  await fsp.mkdir(path.dirname(disguised), { recursive: true });
  await fsp.writeFile(disguised, '{}\n');
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['add', ' .sneakoscope/wiki/code-pack.json']);
  git(['commit', '-q', '-m', 'add disguised metadata path']);

  const note = await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS });
  assert.match(String(note || ''), /sks align run/);
});

test('codePackFreshnessNote reports stale when the recorded pack commit is not an ancestor of HEAD', async () => {
  const { root } = await tempRepo();
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const tree = git(['write-tree']).stdout.trim();
  const divergent = git(['commit-tree', tree, '-m', 'divergent root']).stdout.trim();
  await writePack(root, divergent);

  const inspection = await inspectCodePackHeadFreshness(root, divergent, { timeoutMs: SEMANTIC_TEST_BUDGET_MS });
  assert.equal(inspection.fresh, false);
  assert.equal(inspection.conclusive, true);
  assert.equal(inspection.reason, 'pack_not_ancestor');
  const note = await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS });
  assert.match(String(note || ''), /sks align run/);
});

test('authoritative freshness ignores an ambient GIT_DIR pointing at a sibling repository', async () => {
  const rootRepo = await tempRepo();
  const siblingRepo = await tempRepo();
  const rootGit = (args: string[]) => spawnSync('git', args, { cwd: rootRepo.root, encoding: 'utf8' });
  const siblingGit = (args: string[]) => spawnSync('git', args, { cwd: siblingRepo.root, encoding: 'utf8' });

  await fsp.writeFile(path.join(rootRepo.root, 'a.txt'), 'root source change\n');
  rootGit(['add', 'a.txt']);
  rootGit(['commit', '-q', '-m', 'root source change']);
  const rootHead = rootGit(['rev-parse', 'HEAD']).stdout.trim();
  await writePack(siblingRepo.root, siblingRepo.head);
  siblingGit(['add', '.sneakoscope/wiki/code-pack.json']);
  siblingGit(['commit', '-q', '-m', 'sibling metadata only']);

  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(siblingRepo.root, '.git');
  try {
    const result = await inspectCodePackHeadFreshness(rootRepo.root, rootRepo.head, {
      timeoutMs: SEMANTIC_TEST_BUDGET_MS,
    });
    assert.equal(result.fresh, false);
    assert.equal(result.current_sha, rootHead);
    assert.ok(result.changed_paths.includes('a.txt'));
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
});

test('codePackFreshnessNote stays silent when the recorded pack sha is malformed or invalid', async () => {
  const { root } = await tempRepo();
  for (const invalidSha of ['not-a-sha', '0000000000000000000000000000000000000000']) {
    await writePack(root, invalidSha);
    const inspection = await inspectCodePackHeadFreshness(root, invalidSha, { timeoutMs: SEMANTIC_TEST_BUDGET_MS });
    assert.equal(inspection.fresh, false);
    assert.equal(inspection.conclusive, false);
    assert.equal(inspection.reason, 'invalid_pack_sha');
    assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
  }
});

test('codePackFreshnessNote stays silent when the pack has no recorded git sha (non-git build)', async () => {
  const { root } = await tempRepo();
  await writePack(root, null);
  assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
});

test('codePackFreshnessNote never throws even when the root is not a git repo', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-code-pack-nogit-'));
  await writePack(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  // Not a git repo -> git rev-parse fails -> no current sha to compare -> silent, not a throw.
  assert.equal(await codePackFreshnessNote(root, { budgetMs: SEMANTIC_TEST_BUDGET_MS }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
