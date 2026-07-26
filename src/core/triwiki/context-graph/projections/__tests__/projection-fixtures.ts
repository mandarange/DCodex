/**
 * Hermetic workspace + graph fixtures for the projection tests.
 *
 * The workspace is a real `fs.mkdtempSync` directory under `os.tmpdir()` with
 * real files, and every node's `contentHash` is the sha256 of the bytes actually
 * written — so freshness verdicts in the tests are decided the same way they are
 * in production. Nothing here reads or writes the operator's HOME.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import {
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  type ContextGraphEdge,
  type ContextGraphEdgeType,
  type ContextGraphMeta,
  type ContextGraphNode,
  type ContextGraphSnapshot
} from '../../contracts.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { buildContextGraphIndex, type ContextGraphIndex } from '../../graph-index.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../ids.js';
import { writeContextGraphSnapshot } from '../../store/snapshot-store.js';

export const FIXTURE_OBSERVED_AT = '2026-02-02T00:00:00.000Z';
export const HUB_FILE = 'src/core/hooks/runtime.ts';
export const HUB_MODULE_LABEL = 'core-hooks';

export interface ProjectionFixture {
  readonly root: string;
  readonly snapshot: ContextGraphSnapshot;
  readonly index: ContextGraphIndex;
  readonly hubFileNodeId: string;
  readonly moduleLabels: string[];
}

export interface ProjectionFixtureOptions {
  /** Filler modules that exist only so corpus order and query order can disagree. */
  readonly fillerModules?: number;
  /** Adds one more exported symbol to the hub file, which must move `index_digest`. */
  readonly extraExport?: boolean;
}

interface Builder {
  readonly root: string;
  readonly nodes: ContextGraphNode[];
  readonly edges: ContextGraphEdge[];
  readonly hashByPath: Map<string, string>;
}

function writeSource(builder: Builder, relative: string, body: string): string {
  const absolute = path.join(builder.root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
  const hash = sha256(body);
  builder.hashByPath.set(relative, hash);
  return hash;
}

function addEdge(builder: Builder, from: string, to: string, type: ContextGraphEdgeType, provenancePath: string, line: number): void {
  const hash = builder.hashByPath.get(provenancePath);
  if (!hash) throw new Error(`fixture provenance has no hash for ${provenancePath}`);
  builder.edges.push({
    id: contextGraphEdgeId({ from, to, type }),
    from,
    to,
    type,
    confidence: type === 'defines' || type === 'contains' ? 'exact' : 'syntactic',
    provenance: { path: provenancePath, line, hash, extractor: 'projection-fixture' },
    observedAt: FIXTURE_OBSERVED_AT
  });
}

function addModule(builder: Builder, dir: string, label: string): string {
  const id = contextGraphNodeId({ kind: 'module', moduleId: dir });
  builder.nodes.push({
    id,
    kind: 'module',
    label,
    path: dir,
    trust: 0.8,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 12,
    metadata: { dir, fileCount: 0 }
  });
  return id;
}

function addFile(builder: Builder, relative: string, body: string, fanIn: number): string {
  const hash = writeSource(builder, relative, body);
  const id = contextGraphNodeId({ kind: 'file', path: relative });
  builder.nodes.push({
    id,
    kind: 'file',
    label: path.posix.basename(relative),
    path: relative,
    contentHash: hash,
    trust: 1,
    freshness: 'fresh',
    risk: fanIn >= 3 ? 'high' : 'low',
    tokenCost: Math.ceil(body.length / 4),
    metadata: { language: 'typescript', lines: body.split('\n').length, bytes: body.length, fanIn, isTest: false }
  });
  return id;
}

function addSymbol(builder: Builder, relative: string, name: string, offset: number, line: number): string {
  const hash = builder.hashByPath.get(relative);
  if (!hash) throw new Error(`fixture symbol has no file hash for ${relative}`);
  const id = contextGraphNodeId({ kind: 'symbol', path: relative, symbolKind: 'function', name, startOffset: offset });
  builder.nodes.push({
    id,
    kind: 'symbol',
    label: name,
    path: relative,
    locator: { line },
    contentHash: hash,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 18,
    metadata: { symbolKind: 'function', exported: true, module: path.posix.dirname(relative) }
  });
  return id;
}

function sourceBody(name: string, extra: readonly string[] = []): string {
  return [`export function ${name}(): string {`, `  return '${name}';`, '}', ...extra, ''].join('\n');
}

/** hub module: one high fan-in file plus a sibling, imported by two other modules. */
function buildHub(builder: Builder, extraExport: boolean): string {
  const moduleId = addModule(builder, 'src/core/hooks', HUB_MODULE_LABEL);
  const extra = extraExport ? ['export function runHooksTwice(): string { return runHooks(); }'] : [];
  const hubFile = addFile(builder, HUB_FILE, sourceBody('runHooks', extra), 3);
  const gateFile = addFile(builder, 'src/core/hooks/gate.ts', sourceBody('checkGate'), 0);
  addEdge(builder, moduleId, hubFile, 'contains', HUB_FILE, 1);
  addEdge(builder, moduleId, gateFile, 'contains', 'src/core/hooks/gate.ts', 1);
  addEdge(builder, hubFile, addSymbol(builder, HUB_FILE, 'runHooks', 0, 1), 'defines', HUB_FILE, 1);
  if (extraExport) {
    addEdge(builder, hubFile, addSymbol(builder, HUB_FILE, 'runHooksTwice', 60, 4), 'defines', HUB_FILE, 4);
  }
  addEdge(builder, gateFile, addSymbol(builder, 'src/core/hooks/gate.ts', 'checkGate', 0, 1), 'defines', 'src/core/hooks/gate.ts', 1);
  return hubFile;
}

function buildImporter(builder: Builder, dir: string, label: string, file: string, symbol: string, hubFile: string): void {
  const moduleId = addModule(builder, dir, label);
  const fileId = addFile(builder, file, sourceBody(symbol), 1);
  addEdge(builder, moduleId, fileId, 'contains', file, 1);
  addEdge(builder, fileId, addSymbol(builder, file, symbol, 0, 1), 'defines', file, 1);
  addEdge(builder, fileId, hubFile, 'imports', file, 1);
}

function buildFiller(builder: Builder, ordinal: number): string {
  const slug = `mod${String(ordinal).padStart(2, '0')}`;
  const dir = `src/core/${slug}`;
  const label = `core-${slug}`;
  const moduleId = addModule(builder, dir, label);
  for (const name of ['alpha', 'beta']) {
    const relative = `${dir}/${name}.ts`;
    const fileId = addFile(builder, relative, sourceBody(`${slug}${name}`), 0);
    addEdge(builder, moduleId, fileId, 'contains', relative, 1);
    addEdge(builder, fileId, addSymbol(builder, relative, `${slug}${name}`, 0, 1), 'defines', relative, 1);
  }
  return label;
}

export function createProjectionFixture(options: ProjectionFixtureOptions = {}): ProjectionFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-graph-projection-'));
  const builder: Builder = { root, nodes: [], edges: [], hashByPath: new Map() };
  const hubFileNodeId = buildHub(builder, options.extraExport === true);
  buildImporter(builder, 'src/core/mcp', 'core-mcp', 'src/core/mcp/manager.ts', 'startManager', hubFileNodeId);
  buildImporter(builder, 'src/core/ppt', 'core-ppt', 'src/core/ppt/review.ts', 'reviewDeck', hubFileNodeId);
  const moduleLabels = [HUB_MODULE_LABEL, 'core-mcp', 'core-ppt'];
  for (let ordinal = 0; ordinal < (options.fillerModules ?? 18); ordinal += 1) {
    moduleLabels.push(buildFiller(builder, ordinal));
  }

  const snapshot = buildContextGraphSnapshot({
    nodes: builder.nodes,
    edges: builder.edges,
    cycles: [],
    extractors: [
      {
        id: 'projection-fixture',
        revision: '1.0.0',
        nodeCount: builder.nodes.length,
        edgeCount: builder.edges.length,
        issueCount: 0,
        skippedCount: 0
      }
    ]
  });
  return { root, snapshot, index: buildContextGraphIndex(snapshot), hubFileNodeId, moduleLabels };
}

export function fixtureMeta(snapshot: ContextGraphSnapshot, head: string | null = 'fixturehead0000'): ContextGraphMeta {
  return {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: snapshot.snapshotHash,
    previousSnapshotHash: null,
    generatedAt: FIXTURE_OBSERVED_AT,
    cacheKey: `cache-${snapshot.snapshotHash.slice(0, 12)}`,
    cacheKeyParts: {
      workspaceIdentity: 'projection-fixture',
      head,
      gitState: 'clean',
      trackedDirtyFingerprint: 'none',
      untrackedFingerprint: 'none',
      schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
      tsconfigHash: 'none',
      commandManifestHash: 'none',
      gateManifestHash: 'none',
      proofIndexHash: 'none',
      wikiContextHash: 'none'
    },
    inputHashes: {},
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    lint: { ok: true, errors: 0, warnings: 0 },
    skipped: [],
    durationMs: 0
  };
}

/** Materialize the stored graph so the workspace-level entry points can read it. */
export async function writeFixtureGraph(fixture: ProjectionFixture, head: string | null = 'fixturehead0000'): Promise<void> {
  await writeContextGraphSnapshot({
    root: fixture.root,
    snapshot: fixture.snapshot,
    meta: fixtureMeta(fixture.snapshot, head)
  });
}

export function removeProjectionFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
