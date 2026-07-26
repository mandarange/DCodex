/**
 * Deterministic fixtures shared by the compiler, store and lint tests.
 *
 * The extractors built here are in-memory objects implementing the real
 * `ContextGraphExtractor` contract: no production code is stubbed, and no test
 * ever touches the operator's HOME — every fixture repository is an
 * `fs.mkdtempSync` directory under `os.tmpdir()`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import {
  CONTEXT_GRAPH_FRAGMENT_SCHEMA,
  type ContextGraphEdge,
  type ContextGraphEdgeConfidence,
  type ContextGraphEdgeType,
  type ContextGraphExtractionInput,
  type ContextGraphExtractor,
  type ContextGraphFragment,
  type ContextGraphNode
} from '../../contracts.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../ids.js';

export const FIXED_OBSERVED_AT = '2026-01-01T00:00:00.000Z';

export function makeFixtureRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sks-${prefix}-`));
}

export function removeFixtureRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Write a workspace file and return the sha256 an extractor would record for it. */
export function writeFixtureFile(root: string, relative: string, text: string): string {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text, 'utf8');
  return sha256(Buffer.from(text, 'utf8'));
}

/**
 * Git commands are run with the global and system config redirected to
 * `/dev/null`, so a fixture can never read or write the operator's git identity.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
};

function git(root: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd: root, env: GIT_ENV, stdio: 'ignore' });
}

export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { env: GIT_ENV, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Turn a fixture directory into a committed one-commit repository. */
export function initGitRepo(root: string): void {
  git(root, ['-c', 'init.defaultBranch=main', 'init']);
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture'
  ]);
}

export function fileNode(relative: string, contentHash: string, overrides: Partial<ContextGraphNode> = {}): ContextGraphNode {
  return {
    id: contextGraphNodeId({ kind: 'file', path: relative }),
    kind: 'file',
    label: path.posix.basename(relative),
    path: relative,
    contentHash,
    trust: 0.9,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 32,
    metadata: {},
    ...overrides
  };
}

export function plainNode(id: string, overrides: Partial<ContextGraphNode> = {}): ContextGraphNode {
  return {
    id,
    kind: 'module',
    label: id,
    trust: 0.7,
    freshness: 'unknown',
    risk: 'low',
    tokenCost: 8,
    metadata: {},
    ...overrides
  };
}

export interface FixtureEdgeOptions {
  type?: ContextGraphEdgeType;
  confidence?: ContextGraphEdgeConfidence;
  path?: string;
  hash?: string;
  extractor?: string;
  observedAt?: string;
}

export function edgeBetween(from: string, to: string, options: FixtureEdgeOptions = {}): ContextGraphEdge {
  const type = options.type ?? 'imports';
  return {
    id: contextGraphEdgeId({ from, to, type }),
    from,
    to,
    type,
    confidence: options.confidence ?? 'exact',
    provenance: {
      path: options.path ?? 'src/a.ts',
      hash: options.hash ?? sha256('provenance'),
      extractor: options.extractor ?? 'fixture'
    },
    observedAt: options.observedAt ?? FIXED_OBSERVED_AT
  };
}

export function fragmentOf(
  extractor: string,
  revision: string,
  parts: Partial<Omit<ContextGraphFragment, 'schema' | 'extractor' | 'extractorRevision'>> = {}
): ContextGraphFragment {
  return {
    schema: CONTEXT_GRAPH_FRAGMENT_SCHEMA,
    extractor,
    extractorRevision: revision,
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    issues: parts.issues ?? [],
    skipped: parts.skipped ?? [],
    inputHashes: parts.inputHashes ?? {}
  };
}

export interface RecordingExtractor extends ContextGraphExtractor {
  /** Every `changedPaths` value the compiler passed, in call order. */
  readonly calls: Array<readonly string[] | null>;
}

/** In-memory extractor whose fragment is a pure function of the compiler's input. */
export function recordingExtractor(
  id: string,
  revision: string,
  build: (input: ContextGraphExtractionInput) => ContextGraphFragment | Promise<ContextGraphFragment>
): RecordingExtractor {
  const calls: Array<readonly string[] | null> = [];
  return {
    id,
    revision,
    calls,
    async extract(input: ContextGraphExtractionInput): Promise<ContextGraphFragment> {
      calls.push(input.changedPaths === null ? null : [...input.changedPaths]);
      return build(input);
    }
  };
}

/**
 * Extractor over a fixed file set: one `file` node per path plus an `imports`
 * chain, all hashed from the bytes actually on disk.
 */
export function fileGraphExtractor(id: string, revision: string, files: readonly string[]): RecordingExtractor {
  return recordingExtractor(id, revision, (input) => {
    const targets =
      input.changedPaths === null ? files : files.filter((file) => input.changedPaths?.includes(file));
    const nodes: ContextGraphNode[] = [];
    const edges: ContextGraphEdge[] = [];
    const inputHashes: Record<string, string> = {};
    for (const file of targets) {
      const absolute = path.join(input.root, file);
      if (!fs.existsSync(absolute)) continue;
      const hash = sha256(fs.readFileSync(absolute));
      inputHashes[file] = hash;
      nodes.push(fileNode(file, hash));
    }
    for (let index = 1; index < nodes.length; index += 1) {
      const from = nodes[index - 1];
      const to = nodes[index];
      if (!from || !to) continue;
      edges.push(
        edgeBetween(from.id, to.id, {
          type: 'imports',
          confidence: 'exact',
          path: from.path ?? 'src',
          hash: from.contentHash ?? sha256('x'),
          extractor: id,
          observedAt: input.observedAt
        })
      );
    }
    return fragmentOf(id, revision, { nodes, edges, inputHashes });
  });
}
