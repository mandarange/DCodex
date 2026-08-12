/**
 * Input fingerprint for the Context Graph cache.
 *
 * The graph is a generated cache, so the only thing that makes a stored snapshot
 * reusable is a byte-level match on everything it was derived from: git state,
 * the manifests that define commands/routes/gates, the TypeScript config, the
 * proof index and the wiki context. When git state cannot be established the
 * cache is declared non-reusable rather than optimistically trusted.
 *
 * Nothing here records an absolute path, an environment value, or file contents:
 * every input collapses into a sha256 digest keyed by a workspace-relative path.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess, sha256 } from '../../../fsx.js';
import {
  CONTEXT_GRAPH_SCHEMA_REVISION,
  type ContextGraphCacheKeyParts,
  type ContextGraphGitState,
  type ContextGraphStaleReason
} from '../contracts.js';
import { shortDigest } from '../ids.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';

const GIT_TIMEOUT_MS = 10_000;
const MAX_FINGERPRINT_FILES = 2000;
const MAX_FINGERPRINT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIR_FINGERPRINT_ENTRIES = 4000;

const TSCONFIG_INPUTS = ['tsconfig.json', 'tsconfig.build.json'] as const;
const COMMAND_MANIFEST_INPUTS = [
  'src/cli/command-registry.ts',
  'src/cli/command-manifest-lite.ts',
  'runtime-required-scripts.json'
] as const;
const GATE_MANIFEST_INPUTS = [
  'release-gates.v2.json',
  'infra-harness-gates.json',
  'config/architecture-budgets.v1.json'
] as const;
const PROOF_INDEX_DIR = '.sneakoscope/triwiki/proof-bank';
const WIKI_CONTEXT_DIR = '.sneakoscope/wiki';

/**
 * Graph artifacts must never feed their own cache key.
 *
 * `context-graph.prev.json` is no longer written, and it stays on this list
 * anyway: every workspace built before the write was removed still has a copy,
 * and the entry is what keeps that leftover out of `wikiContextHash` until the
 * next commit reclaims it. Dropping the name would move the cache key on exactly
 * the workspaces that are mid-migration, which is the one population that cannot
 * afford it.
 */
const WIKI_CONTEXT_EXCLUDED = new Set([
  'context-graph.json',
  'context-graph.meta.json',
  'context-graph.prev.json',
  'context-graph-events.jsonl',
  'context-pack.json',
  'code-pack.json',
  'code-pack.prev.json'
]);
const WIKI_CONTEXT_GIT_EXCLUDED = new Set(
  [...WIKI_CONTEXT_EXCLUDED].map((name) => `${WIKI_CONTEXT_DIR}/${name}`)
);

const RELEVANT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.toml',
  '.yml',
  '.yaml',
  '.swift',
  '.rs',
  '.py'
]);

export interface ContextGraphGitSnapshot {
  state: ContextGraphGitState;
  head: string | null;
  trackedDirtyFingerprint: string;
  untrackedFingerprint: string;
  dirtyPaths: string[];
}

export interface ContextGraphCacheKeyResult {
  key: string;
  parts: ContextGraphCacheKeyParts;
  /** `false` whenever git state is unknown: an unverifiable working tree can never justify a cache hit. */
  reusable: boolean;
  reasons: ContextGraphStaleReason[];
  dirtyPaths: string[];
}

export interface ExtractorIdentity {
  readonly id: string;
  readonly revision: string;
}

export interface ComputeContextGraphCacheKeyInput {
  root: string;
  extractors: readonly ExtractorIdentity[];
}

export interface ComputeSourceOnlyContextGraphCacheKeyInput extends ComputeContextGraphCacheKeyInput {
  inputHashes: Readonly<Record<string, string>>;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

async function hashFile(root: string, relative: string): Promise<string | null> {
  if (!isWorkspaceRelativePosixPath(relative)) return null;
  const absolute = path.resolve(root, relative);
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(absolute);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return `symlink:${shortDigest(relative)}`;
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FINGERPRINT_FILE_BYTES) return `oversize:${stat.size}`;
  try {
    return sha256(await fsp.readFile(absolute));
  } catch {
    return null;
  }
}

async function fingerprintFiles(root: string, relatives: readonly string[]): Promise<string> {
  const rows: string[] = [];
  const ordered = [...new Set(relatives)].sort();
  let count = 0;
  for (const relative of ordered) {
    if (count >= MAX_FINGERPRINT_FILES) {
      rows.push(`truncated:${ordered.length}`);
      break;
    }
    count += 1;
    const hash = await hashFile(root, relative);
    rows.push(`${relative}:${hash ?? 'missing'}`);
  }
  return sha256(rows.join('\n'));
}

async function listDirectoryFiles(root: string, relativeDir: string): Promise<string[]> {
  const absolute = path.resolve(root, relativeDir);
  const out: string[] = [];
  const stack: string[] = [absolute];
  while (stack.length) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_DIR_FINGERPRINT_ENTRIES) return out.sort();
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = toPosix(path.relative(root, child));
      if (!isWorkspaceRelativePosixPath(relative)) continue;
      out.push(relative);
    }
  }
  return out.sort();
}

async function fingerprintDirectory(
  root: string,
  relativeDir: string,
  exclude: ReadonlySet<string> = new Set()
): Promise<string> {
  const files = (await listDirectoryFiles(root, relativeDir)).filter(
    (relative) => !exclude.has(path.posix.basename(relative))
  );
  return fingerprintFiles(root, files);
}

function parsePorcelain(stdout: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (!file) continue;
    if (status === '??') untracked.push(toPosix(file));
    else tracked.push(toPosix(file));
  }
  return { tracked: tracked.sort(), untracked: untracked.sort() };
}

function isRelevant(relative: string): boolean {
  if (relative.startsWith('.sneakoscope/')) return false;
  if (relative.startsWith('node_modules/') || relative.includes('/node_modules/')) return false;
  if (relative.startsWith('dist/')) return false;
  return RELEVANT_EXTENSIONS.has(path.posix.extname(relative));
}

/**
 * Read git HEAD plus the dirty/untracked fingerprints. Any failure (no git, not a
 * repository, timeout) yields `state: 'unknown'`, which callers must treat as a
 * hard cache miss instead of guessing.
 */
export async function readContextGraphGitState(root: string): Promise<ContextGraphGitSnapshot> {
  const unknown: ContextGraphGitSnapshot = {
    state: 'unknown',
    head: null,
    trackedDirtyFingerprint: 'unknown',
    untrackedFingerprint: 'unknown',
    dirtyPaths: []
  };
  const head = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS
  }).catch(() => null);
  if (!head || head.code !== 0 || head.timedOut) return unknown;
  const headSha = head.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/.test(headSha)) return unknown;

  const status = await runProcess(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS }
  ).catch(() => null);
  if (!status || status.code !== 0 || status.timedOut || status.truncated) return unknown;

  const { tracked, untracked } = parsePorcelain(status.stdout);
  const relevantTracked = tracked.filter((relative) => !WIKI_CONTEXT_GIT_EXCLUDED.has(relative));
  const relevantUntracked = untracked.filter(isRelevant);
  return {
    state: relevantTracked.length === 0 && relevantUntracked.length === 0 ? 'clean' : 'dirty',
    head: headSha,
    trackedDirtyFingerprint: await fingerprintFiles(root, relevantTracked),
    untrackedFingerprint: await fingerprintFiles(root, relevantUntracked),
    dirtyPaths: [...new Set([...relevantTracked, ...relevantUntracked])].sort()
  };
}

async function workspaceIdentity(root: string): Promise<string> {
  let name = '';
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
      name = (parsed as { name: string }).name;
    }
  } catch {
    name = '';
  }
  // Only the workspace *basename* participates, never the absolute path: the key
  // has to stay stable and leak-free while still separating two checkouts.
  return sha256(JSON.stringify({ name, dir: path.basename(path.resolve(root)) }));
}

function extractorSchemaRevision(extractors: readonly ExtractorIdentity[]): string {
  const rows = [...extractors]
    .map((extractor) => `${extractor.id}@${extractor.revision}`)
    .sort();
  return `${CONTEXT_GRAPH_SCHEMA_REVISION}+${shortDigest(rows.join('\n'))}`;
}

export function contextGraphCacheKey(parts: ContextGraphCacheKeyParts): string {
  return sha256(
    JSON.stringify([
      parts.sourcePolicy ?? 'workspace',
      parts.sourceInventoryHash ?? '',
      parts.workspaceIdentity,
      parts.head ?? 'no-head',
      parts.gitState,
      parts.trackedDirtyFingerprint,
      parts.untrackedFingerprint,
      parts.schemaRevision,
      parts.tsconfigHash,
      parts.commandManifestHash,
      parts.gateManifestHash,
      parts.proofIndexHash,
      parts.wikiContextHash
    ])
  );
}

export async function computeContextGraphCacheKey(
  input: ComputeContextGraphCacheKeyInput
): Promise<ContextGraphCacheKeyResult> {
  const root = path.resolve(input.root);
  const git = await readContextGraphGitState(root);
  const [tsconfigHash, commandManifestHash, gateManifestHash, proofIndexHash, wikiContextHash, identity] =
    await Promise.all([
      fingerprintFiles(root, TSCONFIG_INPUTS),
      fingerprintFiles(root, COMMAND_MANIFEST_INPUTS),
      fingerprintFiles(root, GATE_MANIFEST_INPUTS),
      fingerprintDirectory(root, PROOF_INDEX_DIR),
      fingerprintDirectory(root, WIKI_CONTEXT_DIR, WIKI_CONTEXT_EXCLUDED),
      workspaceIdentity(root)
    ]);

  const parts: ContextGraphCacheKeyParts = {
    sourcePolicy: 'workspace',
    workspaceIdentity: identity,
    head: git.head,
    gitState: git.state,
    trackedDirtyFingerprint: git.trackedDirtyFingerprint,
    untrackedFingerprint: git.untrackedFingerprint,
    schemaRevision: extractorSchemaRevision(input.extractors),
    tsconfigHash,
    commandManifestHash,
    gateManifestHash,
    proofIndexHash,
    wikiContextHash
  };
  const reusable = git.state !== 'unknown';
  return {
    key: contextGraphCacheKey(parts),
    parts,
    reusable,
    reasons: reusable ? [] : ['git_state_unknown'],
    dirtyPaths: git.dirtyPaths
  };
}

/**
 * Cache identity for the code-navigation graph. Only accepted source bytes,
 * extractor revisions and TypeScript resolution config participate. Missions,
 * package names, checkout directory names, docs, proof banks, existing wiki
 * state, git history, and release manifests cannot influence this key.
 */
export async function computeSourceOnlyContextGraphCacheKey(
  input: ComputeSourceOnlyContextGraphCacheKeyInput
): Promise<ContextGraphCacheKeyResult> {
  const root = path.resolve(input.root);
  const empty = sha256('');
  const sourceInventoryHash = sha256(
    Object.entries(input.inputHashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relative, hash]) => `${relative}\u0000${hash}`)
      .join('\n')
  );
  const parts: ContextGraphCacheKeyParts = {
    sourcePolicy: 'repository_code_only',
    sourceInventoryHash,
    // Source-only graphs are content-addressed and portable across equivalent
    // checkouts. Project/package names and directory basenames are not code
    // semantics and must not invalidate an otherwise identical index.
    workspaceIdentity: sha256('repository_code_only'),
    head: null,
    gitState: 'clean',
    trackedDirtyFingerprint: sourceInventoryHash,
    untrackedFingerprint: empty,
    schemaRevision: extractorSchemaRevision(input.extractors),
    tsconfigHash: await fingerprintFiles(root, TSCONFIG_INPUTS),
    commandManifestHash: empty,
    gateManifestHash: empty,
    proofIndexHash: empty,
    wikiContextHash: empty
  };
  return {
    key: contextGraphCacheKey(parts),
    parts,
    reusable: true,
    reasons: [],
    dirtyPaths: []
  };
}

const PART_REASONS: ReadonlyArray<readonly [keyof ContextGraphCacheKeyParts, ContextGraphStaleReason]> = [
  ['sourcePolicy', 'cache_key_changed'],
  ['sourceInventoryHash', 'dirty_fingerprint_changed'],
  ['head', 'head_changed'],
  ['trackedDirtyFingerprint', 'dirty_fingerprint_changed'],
  ['untrackedFingerprint', 'dirty_fingerprint_changed'],
  ['schemaRevision', 'schema_revision_changed'],
  ['tsconfigHash', 'tsconfig_changed'],
  ['commandManifestHash', 'command_manifest_changed'],
  ['gateManifestHash', 'gate_manifest_changed'],
  ['proofIndexHash', 'proof_index_changed'],
  ['wikiContextHash', 'wiki_context_changed'],
  ['workspaceIdentity', 'cache_key_changed']
];

/** Deterministic, de-duplicated stale reasons for a cache-key diff. */
export function compareCacheKeyParts(
  previous: ContextGraphCacheKeyParts | null | undefined,
  current: ContextGraphCacheKeyParts
): ContextGraphStaleReason[] {
  const reasons: ContextGraphStaleReason[] = [];
  if (!previous) return ['cache_key_changed'];
  if (current.gitState === 'unknown' || previous.gitState === 'unknown') reasons.push('git_state_unknown');
  for (const [field, reason] of PART_REASONS) {
    if (previous[field] !== current[field] && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}
