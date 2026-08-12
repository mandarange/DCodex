/**
 * Fixtures for the incremental compiler tests.
 *
 * The extractors here implement the real `ContextGraphSourceExtractor` contract
 * against files that actually exist on disk, and they count every source they are
 * asked about. That counter is the point: an incremental build that produces the
 * right graph by re-extracting everything is indistinguishable from a correct one
 * unless the test asserts how much work ran.
 *
 * Every fixture workspace is an `fs.mkdtempSync` directory under `os.tmpdir()`;
 * nothing here reads or writes the operator's HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import type { ContextGraphEdge, ContextGraphNode } from '../../contracts.js';
import { contextGraphNodeId } from '../../ids.js';
import { buildFragmentManifestIdentity, type FragmentManifestIdentity } from '../fragment-manifest.js';
import { fileSourceFragmentStore, type SourceFragmentStore } from '../fragment-store.js';
import {
  buildSourceFragment,
  type ContextGraphSourceExtractionRequest,
  type ContextGraphSourceExtractor,
  type ContextGraphSourceFragment,
} from '../source-fragment.js';
import { edgeBetween, fileNode } from './graph-test-fixtures.js';

export { makeFixtureRoot, removeFixtureRoot, writeFixtureFile } from './graph-test-fixtures.js';

export const FIXTURE_OBSERVED_AT = '2026-02-01T00:00:00.000Z';

export function fixtureIdentity(overrides: Partial<FragmentManifestIdentity> = {}): FragmentManifestIdentity {
  return buildFragmentManifestIdentity({
    schemaRevision: '1.0.0',
    configFingerprint: sha256('config'),
    tokenizerFingerprint: sha256('tokenizer'),
    ...overrides,
  });
}

/** The inventory the planner diffs against: workspace-relative path -> content hash. */
export function inventoryOf(root: string, relatives: readonly string[]): Map<string, string> {
  const inventory = new Map<string, string>();
  for (const relative of [...relatives].sort()) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    inventory.set(relative, sha256(fs.readFileSync(absolute)));
  }
  return inventory;
}

export function removeFixtureFile(root: string, relative: string): void {
  fs.rmSync(path.join(root, relative), { force: true });
}

export function seedWorkspace(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, 'utf8');
  }
}

export interface CountingFragmentStore extends SourceFragmentStore {
  loads: number;
  saves: number;
}

/** Counts cache traffic, which is how the no-op path proves it did nothing rather than a little. */
export function countingFragmentStore(root: string): CountingFragmentStore {
  const inner = fileSourceFragmentStore(root);
  const counter: CountingFragmentStore = {
    loads: 0,
    saves: 0,
    async load(entry) {
      counter.loads += 1;
      return inner.load(entry);
    },
    async save(fragment) {
      counter.saves += 1;
      return inner.save(fragment);
    },
  };
  return counter;
}

/** `import "src/b.ts";` — enough syntax to make a dependency real without a parser. */
function parseImports(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/^import "([^"]+)";$/gm)) {
    const target = match[1];
    if (target) targets.push(target);
  }
  return targets;
}

export interface CountingSourceExtractor extends ContextGraphSourceExtractor {
  /** Every `sourcePaths` set the compiler asked for, in call order. */
  readonly calls: string[][];
  /** Every source path this extractor was asked to extract, cumulative. */
  readonly extracted: string[];
  reset(): void;
}

export interface FixtureExtractorOptions {
  /**
   * `true` models an extractor that opens the files it imports (a resolver), so
   * a change to an imported file invalidates the importer's fragment. `false`
   * models one that reads only its own bytes.
   */
  readonly declareImportDependencies?: boolean | undefined;
  /** `module` also emits a module node, which exercises merging across extractors. */
  readonly shape?: 'file' | 'module' | undefined;
}

function fragmentFor(
  extractor: string,
  revision: string,
  request: ContextGraphSourceExtractionRequest,
  sourcePath: string,
  options: FixtureExtractorOptions,
): ContextGraphSourceFragment | null {
  const absolute = path.join(request.root, sourcePath);
  if (!fs.existsSync(absolute)) return null;
  const bytes = fs.readFileSync(absolute);
  const hash = sha256(bytes);
  const imports = parseImports(bytes.toString('utf8'));
  const fileId = contextGraphNodeId({ kind: 'file', path: sourcePath });
  const nodes: ContextGraphNode[] = [fileNode(sourcePath, hash)];
  const edges: ContextGraphEdge[] = [];

  if (options.shape === 'module') {
    const moduleId = contextGraphNodeId({ kind: 'module', moduleId: sourcePath });
    nodes.push({
      id: moduleId,
      kind: 'module',
      label: sourcePath,
      trust: 0.8,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 4,
      metadata: {},
    });
    edges.push(
      edgeBetween(fileId, moduleId, {
        type: 'contains',
        confidence: 'exact',
        path: sourcePath,
        hash,
        extractor,
        observedAt: request.observedAt,
      }),
    );
  }

  for (const target of imports) {
    // A real extractor does not emit a relation into a file it can see is gone;
    // the fixture must not either, or the delete case would fail on a lint error
    // instead of exercising the reused-edge prune.
    if (!fs.existsSync(path.join(request.root, target))) continue;
    edges.push(
      edgeBetween(fileId, contextGraphNodeId({ kind: 'file', path: target }), {
        type: 'imports',
        confidence: 'exact',
        path: sourcePath,
        hash,
        extractor,
        observedAt: request.observedAt,
      }),
    );
  }

  return buildSourceFragment({
    extractor,
    extractorRevision: revision,
    sourcePath,
    sourceHash: hash,
    dependencyKeys: options.declareImportDependencies ? imports : [],
    nodes,
    edges,
  });
}

export function fixtureExtractor(
  id: string,
  revision: string,
  options: FixtureExtractorOptions = {},
): CountingSourceExtractor {
  const calls: string[][] = [];
  const extracted: string[] = [];
  return {
    id,
    revision,
    calls,
    extracted,
    reset(): void {
      calls.length = 0;
      extracted.length = 0;
    },
    async extractSources(request: ContextGraphSourceExtractionRequest): Promise<readonly ContextGraphSourceFragment[]> {
      calls.push([...request.sourcePaths]);
      const fragments: ContextGraphSourceFragment[] = [];
      for (const sourcePath of request.sourcePaths) {
        extracted.push(sourcePath);
        const fragment = fragmentFor(id, revision, request, sourcePath, options);
        if (fragment) fragments.push(fragment);
      }
      return fragments;
    },
  };
}
