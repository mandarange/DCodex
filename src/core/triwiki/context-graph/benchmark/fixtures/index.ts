/**
 * Hermetic fixture repository builder.
 *
 * A fixture only ever exists inside `os.tmpdir()`. Nothing here reads the real
 * HOME, and the git-backed families run with HOME, the global config and the
 * system config all redirected into the fixture so a `git init` cannot touch the
 * operator's machine state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES,
  type ContextGraphBenchmarkFixtureFamily
} from '../types.js';
import type { FixtureDefinition, FixtureFile } from './kinds.js';
import { CODE_FIXTURE_DEFINITIONS } from './definitions-code.js';
import { FIXTURE_ABSOLUTE_PATH, FIXTURE_SECRET_TOKEN, SAFETY_FIXTURE_DEFINITIONS } from './definitions-safety.js';

export type { FixtureDefinition, FixtureFile, FixtureSymlink, FixtureGitPlan } from './kinds.js';
export { FIXTURE_ABSOLUTE_PATH, FIXTURE_SECRET_TOKEN };

const DEFINITIONS: ReadonlyMap<ContextGraphBenchmarkFixtureFamily, FixtureDefinition> = new Map(
  [...CODE_FIXTURE_DEFINITIONS, ...SAFETY_FIXTURE_DEFINITIONS].map((definition) => [definition.family, definition])
);

export const OUTSIDE_SYMLINK_TARGET_TOKEN = '@outside';

export function contextGraphBenchmarkFixtureFamilies(): readonly ContextGraphBenchmarkFixtureFamily[] {
  return CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES;
}

export function fixtureDefinition(family: ContextGraphBenchmarkFixtureFamily): FixtureDefinition {
  const definition = DEFINITIONS.get(family);
  if (!definition) throw new Error(`no fixture definition for family ${family}`);
  return definition;
}

/** Every declared family must have a definition; used by the runner capability report. */
export function missingFixtureDefinitions(): readonly string[] {
  return CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES.filter((family) => !DEFINITIONS.has(family));
}

export interface FixtureHandle {
  readonly family: ContextGraphBenchmarkFixtureFamily;
  /** Absolute path to the materialized repository. Never written into a report. */
  readonly root: string;
  readonly fileCount: number;
  readonly gitInitialized: boolean;
  readonly symlinksCreated: number;
  readonly symlinkSupported: boolean;
  readonly dirtyPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  dispose(): void;
}

export interface MaterializeFixtureOptions {
  /** Directory the temp fixture is created under. Defaults to `os.tmpdir()`. */
  readonly tmpDir?: string;
  /** Skip `git init` even for families that declare a git plan. */
  readonly skipGit?: boolean;
  readonly prefix?: string;
}

function writeFixtureFile(root: string, file: FixtureFile): void {
  const absolute = path.join(root, ...file.path.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, file.content, 'utf8');
}

function appendFixtureFile(root: string, file: FixtureFile): void {
  const absolute = path.join(root, ...file.path.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, file.content, 'utf8');
}

function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, '.config'),
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig-fixture'),
    GIT_CONFIG_SYSTEM: path.join(root, '.gitconfig-system-fixture'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0'
  };
}

function runGit(root: string, args: readonly string[]): boolean {
  const result = spawnSync('git', [...args], {
    cwd: root,
    env: gitEnv(root),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  });
  return result.status === 0;
}

export function gitAvailable(): boolean {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0;
}

function initGitFixture(root: string, definition: FixtureDefinition): boolean {
  if (!runGit(root, ['init', '-q'])) return false;
  runGit(root, ['config', 'user.email', 'benchmark@fixture.invalid']);
  runGit(root, ['config', 'user.name', 'Context Graph Benchmark Fixture']);
  runGit(root, ['config', 'commit.gpgsign', 'false']);
  runGit(root, ['config', 'core.hooksPath', path.join(root, '.git', 'no-hooks')]);
  if (!runGit(root, ['add', '-A'])) return false;
  if (!runGit(root, ['commit', '-q', '-m', 'fixture baseline', '--no-gpg-sign'])) return false;
  const plan = definition.git;
  if (plan) {
    for (const file of plan.dirtyAppend) appendFixtureFile(root, file);
    for (const file of plan.untracked) writeFixtureFile(root, file);
  }
  return true;
}

function createSymlinks(root: string, outsideDir: string, definition: FixtureDefinition): { created: number; supported: boolean } {
  const links = definition.symlinks ?? [];
  if (!links.length) return { created: 0, supported: true };
  let created = 0;
  for (const link of links) {
    const absolute = path.join(root, ...link.path.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const target = link.target === OUTSIDE_SYMLINK_TARGET_TOKEN
      ? path.relative(path.dirname(absolute), outsideDir).split(path.sep).join('/')
      : link.target;
    try {
      fs.symlinkSync(target, absolute, 'dir');
      created += 1;
    } catch {
      return { created, supported: false };
    }
  }
  return { created, supported: true };
}

export function materializeFixture(
  family: ContextGraphBenchmarkFixtureFamily,
  options: MaterializeFixtureOptions = {}
): FixtureHandle {
  const definition = fixtureDefinition(family);
  const base = options.tmpDir ?? os.tmpdir();
  const prefix = options.prefix ?? 'sks-cg-bench-';
  const root = fs.mkdtempSync(path.join(base, `${prefix}${family}-`));
  const outsideDir = fs.mkdtempSync(path.join(base, `${prefix}outside-`));
  fs.writeFileSync(path.join(outsideDir, 'escaped.ts'), 'export const ESCAPED = 1;\n', 'utf8');

  let fileCount = 0;
  for (const file of definition.files) {
    writeFixtureFile(root, file);
    fileCount += 1;
  }
  if (definition.generated && definition.generatedCount) {
    for (let index = 0; index < definition.generatedCount; index += 1) {
      for (const file of definition.generated(index)) {
        writeFixtureFile(root, file);
        fileCount += 1;
      }
    }
  }

  const symlinks = createSymlinks(root, outsideDir, definition);
  const wantsGit = Boolean(definition.git) && !options.skipGit;
  const gitInitialized = wantsGit ? initGitFixture(root, definition) : false;
  const plan = definition.git;
  const dirtyPaths = gitInitialized && plan ? plan.dirtyAppend.map((file) => file.path) : [];
  const untrackedPaths = gitInitialized && plan ? plan.untracked.map((file) => file.path) : [];
  if (!gitInitialized && plan) {
    // Without git the tree still needs the dirty/untracked content so path counts stay stable.
    for (const file of plan.dirtyAppend) appendFixtureFile(root, file);
    for (const file of plan.untracked) {
      writeFixtureFile(root, file);
      fileCount += 1;
    }
  }

  let disposed = false;
  return {
    family,
    root,
    fileCount,
    gitInitialized,
    symlinksCreated: symlinks.created,
    symlinkSupported: symlinks.supported,
    dirtyPaths,
    untrackedPaths,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  };
}

/** Materialize, run `fn`, and always clean the temp directories back up. */
export async function withFixture<T>(
  family: ContextGraphBenchmarkFixtureFamily,
  fn: (handle: FixtureHandle) => Promise<T> | T,
  options: MaterializeFixtureOptions = {}
): Promise<T> {
  const handle = materializeFixture(family, options);
  try {
    return await fn(handle);
  } finally {
    handle.dispose();
  }
}
