/**
 * Hermetic in-memory graphs for the query engine tests.
 *
 * Every fixture is built through the real serializer and the real index builder,
 * so the tests exercise the same ordering, hashing and adjacency the compiler
 * produces. Nothing here touches the operator's HOME: workspace fixtures are
 * `fs.mkdtempSync` directories under `os.tmpdir()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  type ContextGraphEdge,
  type ContextGraphEdgeConfidence,
  type ContextGraphEdgeType,
  type ContextGraphFreshness,
  type ContextGraphMeta,
  type ContextGraphMetadata,
  type ContextGraphNode,
  type ContextGraphNodeKind,
  type ContextGraphRisk,
  type ContextGraphSnapshot
} from '../../contracts.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { buildContextGraphIndex, type ContextGraphIndex } from '../../graph-index.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../ids.js';
import { writeContextGraphSnapshot } from '../../store/snapshot-store.js';

export const FIXTURE_OBSERVED_AT = '2026-01-01T00:00:00.000Z';

export const IDS = {
  fileService: contextGraphNodeId({ kind: 'file', path: 'src/app/service.ts' }),
  symbolRun: contextGraphNodeId({
    kind: 'symbol',
    path: 'src/app/service.ts',
    symbolKind: 'function',
    name: 'runService',
    startOffset: 0
  }),
  fileConsumer: contextGraphNodeId({ kind: 'file', path: 'src/app/consumer.ts' }),
  fileLegacy: contextGraphNodeId({ kind: 'file', path: 'src/legacy/old.ts' }),
  fileOtherA: contextGraphNodeId({ kind: 'file', path: 'src/other/a.ts' }),
  fileOtherB: contextGraphNodeId({ kind: 'file', path: 'src/other/b.ts' }),
  testService: contextGraphNodeId({ kind: 'test', path: 'src/app/__tests__/service.test.ts', testName: 'service' }),
  gateRelease: contextGraphNodeId({ kind: 'gate', gateId: 'release:publish' }),
  gateLint: contextGraphNodeId({ kind: 'gate', gateId: 'lint:fast' }),
  proofInvalid: contextGraphNodeId({ kind: 'proof', proofId: 'proof-invalid' }),
  commandWiki: contextGraphNodeId({ kind: 'command', name: 'wiki' })
} as const;

interface NodeSpec {
  id: string;
  kind: ContextGraphNodeKind;
  label: string;
  path?: string;
  line?: number;
  contentHash?: string;
  trust?: number;
  freshness?: ContextGraphFreshness;
  risk?: ContextGraphRisk;
  tokenCost: number;
  metadata?: ContextGraphMetadata;
}

function node(spec: NodeSpec): ContextGraphNode {
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    ...(spec.path === undefined ? {} : { path: spec.path }),
    ...(spec.line === undefined ? {} : { locator: { line: spec.line } }),
    ...(spec.contentHash === undefined ? {} : { contentHash: spec.contentHash }),
    trust: spec.trust ?? 1,
    freshness: spec.freshness ?? 'fresh',
    risk: spec.risk ?? 'low',
    tokenCost: spec.tokenCost,
    metadata: spec.metadata ?? {}
  };
}

function edge(
  from: string,
  to: string,
  type: ContextGraphEdgeType,
  confidence: ContextGraphEdgeConfidence,
  provenancePath: string,
  line?: number
): ContextGraphEdge {
  return {
    id: contextGraphEdgeId({ from, to, type }),
    from,
    to,
    type,
    confidence,
    provenance: {
      path: provenancePath,
      ...(line === undefined ? {} : { line }),
      hash: `sha-${provenancePath}`,
      extractor: 'query-fixture'
    },
    observedAt: FIXTURE_OBSERVED_AT
  };
}

export function fixtureNodes(): ContextGraphNode[] {
  return [
    node({ id: IDS.fileService, kind: 'file', label: 'service.ts', path: 'src/app/service.ts', contentHash: 'h-service', tokenCost: 120 }),
    node({
      id: IDS.symbolRun,
      kind: 'symbol',
      label: 'runService',
      path: 'src/app/service.ts',
      line: 3,
      contentHash: 'h-service',
      tokenCost: 40,
      metadata: { symbolKind: 'function', exported: true }
    }),
    node({ id: IDS.fileConsumer, kind: 'file', label: 'consumer.ts', path: 'src/app/consumer.ts', contentHash: 'h-consumer', tokenCost: 80 }),
    node({
      id: IDS.fileLegacy,
      kind: 'file',
      label: 'old.ts',
      path: 'src/legacy/old.ts',
      contentHash: 'h-legacy',
      freshness: 'stale',
      tokenCost: 60
    }),
    node({ id: IDS.fileOtherA, kind: 'file', label: 'a.ts', path: 'src/other/a.ts', contentHash: 'h-a', tokenCost: 45 }),
    node({ id: IDS.fileOtherB, kind: 'file', label: 'b.ts', path: 'src/other/b.ts', contentHash: 'h-b', tokenCost: 45 }),
    node({
      id: IDS.testService,
      kind: 'test',
      label: 'service.test.ts',
      path: 'src/app/__tests__/service.test.ts',
      contentHash: 'h-test',
      tokenCost: 50
    }),
    node({
      id: IDS.gateRelease,
      kind: 'gate',
      label: 'release:publish',
      path: 'config/release-gates.json',
      contentHash: 'h-gates',
      risk: 'protected',
      trust: 0.95,
      tokenCost: 30,
      metadata: { requiredForPublish: true }
    }),
    node({
      id: IDS.gateLint,
      kind: 'gate',
      label: 'lint:fast',
      path: 'config/release-gates.json',
      contentHash: 'h-gates',
      risk: 'high',
      trust: 0.95,
      tokenCost: 25
    }),
    node({
      id: IDS.proofInvalid,
      kind: 'proof',
      label: 'proof-invalid',
      path: 'config/proofs.json',
      contentHash: 'h-proofs',
      risk: 'medium',
      trust: 0.15,
      tokenCost: 20,
      metadata: { reusable: false, invalidation_reason_count: 1 }
    }),
    node({
      id: IDS.commandWiki,
      kind: 'command',
      label: 'wiki',
      path: 'src/cli/manifest.ts',
      contentHash: 'h-manifest',
      trust: 0.95,
      tokenCost: 20
    })
  ];
}

export function fixtureEdges(): ContextGraphEdge[] {
  return [
    edge(IDS.fileService, IDS.symbolRun, 'defines', 'exact', 'src/app/service.ts', 3),
    edge(IDS.fileConsumer, IDS.fileService, 'imports', 'syntactic', 'src/app/consumer.ts', 1),
    edge(IDS.fileOtherA, IDS.fileService, 'imports', 'syntactic', 'src/other/a.ts', 1),
    edge(IDS.fileOtherB, IDS.fileService, 'imports', 'syntactic', 'src/other/b.ts', 1),
    edge(IDS.fileService, IDS.fileLegacy, 'imports', 'syntactic', 'src/app/service.ts', 2),
    edge(IDS.testService, IDS.fileService, 'tests', 'syntactic', 'src/app/__tests__/service.test.ts', 4),
    edge(IDS.fileService, IDS.proofInvalid, 'verified_by', 'manifest', 'config/proofs.json', 7),
    edge(IDS.proofInvalid, IDS.gateLint, 'invalidates', 'manifest', 'config/proofs.json', 8),
    edge(IDS.fileService, IDS.gateRelease, 'gated_by', 'manifest', 'config/release-gates.json', 11),
    edge(IDS.fileService, IDS.gateLint, 'gated_by', 'manifest', 'config/release-gates.json', 12),
    edge(IDS.commandWiki, IDS.fileService, 'references', 'manifest', 'src/cli/manifest.ts', 5)
  ];
}

export function buildFixtureSnapshot(
  nodes: readonly ContextGraphNode[] = fixtureNodes(),
  edges: readonly ContextGraphEdge[] = fixtureEdges()
): ContextGraphSnapshot {
  return buildContextGraphSnapshot({
    nodes,
    edges,
    cycles: [],
    extractors: [
      { id: 'query-fixture', revision: '1.0.0', nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0, skippedCount: 0 }
    ]
  });
}

export function buildFixtureIndex(
  nodes?: readonly ContextGraphNode[],
  edges?: readonly ContextGraphEdge[]
): ContextGraphIndex {
  return buildContextGraphIndex(buildFixtureSnapshot(nodes, edges));
}

export function fixtureMeta(snapshot: ContextGraphSnapshot): ContextGraphMeta {
  return {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash: snapshot.snapshotHash,
    previousSnapshotHash: null,
    generatedAt: FIXTURE_OBSERVED_AT,
    cacheKey: `cache-${snapshot.snapshotHash.slice(0, 12)}`,
    cacheKeyParts: {
      workspaceIdentity: 'query-fixture',
      head: null,
      gitState: 'unknown',
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

export function makeFixtureRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sks-${prefix}-`));
}

export function removeFixtureRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Materialize a workspace whose stored graph is the fixture snapshot. */
export async function writeFixtureWorkspace(root: string, snapshot: ContextGraphSnapshot): Promise<void> {
  await writeContextGraphSnapshot({ root, snapshot, meta: fixtureMeta(snapshot) });
}
