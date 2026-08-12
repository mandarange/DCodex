/**
 * The fuzz campaign's base index, and the observation that decides whether a
 * mutation changed anything.
 *
 * `runtime-index/__tests__/format.test.ts` already covers thirteen hand-built
 * corrupt cases. This module is the generative complement: it produces one
 * valid index and a total description of what a reader answers from it, so a
 * mutated file can be classified without a human deciding case by case whether
 * a difference matters.
 *
 * Two design choices carry the whole measurement:
 *
 * **Every section is non-empty.** A zero-length section's `offset` descriptor
 * field is unconstrained by construction — nothing overlaps it, nothing is read
 * from it, and its checksum is the checksum of no bytes — so a mutation there is
 * inert rather than refused. A base index with an empty section would therefore
 * report a rejection rate below 100% for a reason that says nothing about the
 * reader. The snapshot below carries metadata, provenance, cycles, groups,
 * source hashes and all four lexical lanes so that every byte inside the covered
 * range carries information.
 *
 * **The observation is a string, compared for equality.** A mutation that opens
 * is only benign if the reader's answers are *identical*, not merely
 * "reasonable". `observeContextIndex` walks every node, every edge, every
 * cursor and every lane, so a divergence anywhere lands in the signature.
 */
import {
  CONTEXT_GRAPH_SCHEMA,
  type ContextGraphEdge,
  type ContextGraphNode,
  type ContextGraphSnapshot,
} from '../contracts.js';
import { encodeContextIndex } from '../runtime-index/writer.js';
import { CONTEXT_INDEX_PROFILE_MASK_ALL, type ContextIndexReader } from '../runtime-index/reader.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../query/ranking-config.js';

export const FUZZ_SNAPSHOT_HASH = 'fa11ba5e'.repeat(8);
export const FUZZ_CONFIG_HASH: Uint8Array = new Uint8Array(32).fill(0x5c);

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

function node(spec: {
  id: string;
  kind?: ContextGraphNode['kind'];
  label: string;
  path?: string;
  line?: number;
  column?: number;
  contentHash?: string;
  risk?: ContextGraphNode['risk'];
  freshness?: ContextGraphNode['freshness'];
  trust?: number;
  tokenCost?: number;
  metadata?: ContextGraphNode['metadata'];
}): ContextGraphNode {
  return {
    id: spec.id,
    kind: spec.kind ?? 'file',
    label: spec.label,
    ...(spec.path === undefined ? {} : { path: spec.path }),
    ...(spec.line === undefined
      ? {}
      : { locator: { line: spec.line, ...(spec.column === undefined ? {} : { column: spec.column }) } }),
    ...(spec.contentHash === undefined ? {} : { contentHash: spec.contentHash }),
    trust: spec.trust ?? 0.5,
    freshness: spec.freshness ?? 'fresh',
    risk: spec.risk ?? 'low',
    tokenCost: spec.tokenCost ?? 24,
    metadata: spec.metadata ?? {},
  };
}

function edge(spec: {
  from: string;
  to: string;
  type?: ContextGraphEdge['type'];
  confidence?: ContextGraphEdge['confidence'];
  path: string;
  line?: number;
  hash: string;
  extractor: string;
}): ContextGraphEdge {
  const type = spec.type ?? 'imports';
  return {
    id: `edge:${spec.from}->${spec.to}:${type}`,
    from: spec.from,
    to: spec.to,
    type,
    confidence: spec.confidence ?? 'exact',
    provenance: {
      path: spec.path,
      ...(spec.line === undefined ? {} : { line: spec.line }),
      hash: spec.hash,
      extractor: spec.extractor,
    },
    observedAt: OBSERVED_AT,
  };
}

const NODES: readonly ContextGraphNode[] = [
  node({
    id: 'file:src/core/service/runner.ts',
    label: 'runner.ts',
    path: 'src/core/service/runner.ts',
    contentHash: 'sha256:1111',
    metadata: { language: 'ts', lexeme: 'kernel', tags: ['core', 'service'] },
  }),
  node({
    id: 'file:src/core/service/registry.ts',
    label: 'registry.ts',
    path: 'src/core/service/registry.ts',
    contentHash: 'sha256:2222',
    freshness: 'stale',
    metadata: { language: 'ts', exported: 'true' },
  }),
  node({
    id: 'file:src/other/adapter.ts',
    label: 'adapter.ts',
    path: 'src/other/adapter.ts',
    contentHash: 'sha256:3333',
    metadata: { language: 'ts' },
  }),
  node({
    id: 'symbol:src/core/service/runner.ts#function:runService@41',
    kind: 'symbol',
    label: 'runService',
    path: 'src/core/service/runner.ts',
    line: 41,
    column: 7,
    contentHash: 'sha256:4444',
    trust: 0.75,
    metadata: { exported: 'true', kindHint: 'function' },
  }),
  node({
    id: 'test:src/core/service/__tests__/runner.test.ts',
    kind: 'test',
    label: 'runner.test.ts',
    path: 'src/core/service/__tests__/runner.test.ts',
    contentHash: 'sha256:5555',
    metadata: { isTest: 'true' },
  }),
  node({
    id: 'gate:release:service_contract',
    kind: 'gate',
    label: 'release:service_contract',
    path: 'release-gates.v2.json',
    line: 12,
    contentHash: 'sha256:6666',
    risk: 'protected',
    trust: 0.95,
    tokenCost: 9,
    metadata: { requiredForPublish: 'true', alwaysOnRelease: 'false', namespace: 'release' },
  }),
];

const EDGES: readonly ContextGraphEdge[] = [
  edge({
    from: 'file:src/core/service/runner.ts',
    to: 'file:src/core/service/registry.ts',
    path: 'src/core/service/runner.ts',
    line: 3,
    hash: 'sha256:aaaa',
    extractor: 'typescript',
  }),
  edge({
    from: 'file:src/core/service/registry.ts',
    to: 'file:src/core/service/runner.ts',
    type: 'depends_on',
    confidence: 'syntactic',
    path: 'src/core/service/registry.ts',
    line: 5,
    hash: 'sha256:bbbb',
    extractor: 'typescript',
  }),
  edge({
    from: 'file:src/core/service/runner.ts',
    to: 'symbol:src/core/service/runner.ts#function:runService@41',
    type: 'defines',
    path: 'src/core/service/runner.ts',
    line: 41,
    hash: 'sha256:cccc',
    extractor: 'typescript',
  }),
  edge({
    from: 'test:src/core/service/__tests__/runner.test.ts',
    to: 'symbol:src/core/service/runner.ts#function:runService@41',
    type: 'references',
    confidence: 'syntactic',
    path: 'src/core/service/__tests__/runner.test.ts',
    line: 8,
    hash: 'sha256:dddd',
    extractor: 'typescript',
  }),
  edge({
    from: 'gate:release:service_contract',
    to: 'file:src/core/service/runner.ts',
    type: 'verified_by',
    confidence: 'manifest',
    path: 'release-gates.v2.json',
    line: 12,
    hash: 'sha256:eeee',
    extractor: 'gate-manifest',
  }),
  edge({
    from: 'file:src/other/adapter.ts',
    to: 'file:src/core/service/registry.ts',
    path: 'src/other/adapter.ts',
    line: 2,
    hash: 'sha256:ffff',
    extractor: 'typescript',
  }),
];

/**
 * A two-node cycle is declared so `CYCLE_TABLE` is non-empty. The pair of edges
 * between `runner.ts` and `registry.ts` above is what makes the declaration true.
 */
export function fuzzBaseSnapshot(): ContextGraphSnapshot {
  const nodes = [...NODES].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const edges = [...EDGES].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash: FUZZ_SNAPSHOT_HASH,
    nodes,
    edges,
    cycles: [
      {
        id: 'cycle:service',
        nodes: ['file:src/core/service/registry.ts', 'file:src/core/service/runner.ts'],
      },
    ],
    extractors: [],
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

/**
 * The lexicon config is threaded in, not defaulted.
 *
 * `writer-types.ts` is explicit that omitting it leaves all four dictionary
 * sections empty — an absent lexicon rather than a defaulted one. A fuzz base
 * index built without it would leave `LEXICON_TABLE`, `LEXICON_POSTINGS`,
 * `COARSE_TERM_TABLE` and `COARSE_POSTINGS` zero-length, and mutations to those
 * four descriptors' offsets would register as inert.
 */
export function fuzzBaseIndexBytes(): Uint8Array {
  return encodeContextIndex({
    snapshot: fuzzBaseSnapshot(),
    configHash: FUZZ_CONFIG_HASH,
    schemaRevision: 1,
    lexicon: CONTEXT_GRAPH_LEXICON_CONFIG,
  }).bytes;
}

/** Terms probed on every observation; they span all four lanes of the base index. */
export const FUZZ_PROBE_TERMS: readonly string[] = [
  'runservice',
  'runner',
  'registry',
  'service',
  'kernel',
  'release',
  'src/core/service/runner.ts',
  'file:src/core/service/runner.ts',
  'gate:release:service_contract',
  'absent-term-that-must-not-resolve',
];

const BOUNDS = { postingCapPerTerm: 64, candidateBudget: 64 } as const;

function cursorSignature(reader: ContextIndexReader, node: number, direction: 'out' | 'in'): string {
  const cursor = direction === 'out'
    ? reader.outgoing(node, CONTEXT_INDEX_PROFILE_MASK_ALL)
    : reader.incoming(node, CONTEXT_INDEX_PROFILE_MASK_ALL);
  const steps: string[] = [];
  while (cursor.next()) {
    steps.push(`${cursor.edge}/${cursor.target}/${cursor.type}/${cursor.confidence}/${cursor.flags}/${cursor.provenance}`);
  }
  return `${direction}${node}[${steps.join(';')}]v${cursor.visited}`;
}

/**
 * A total description of what this reader answers.
 *
 * "Total" is load-bearing: a partial observation would let a mutation that
 * corrupts an unread field register as inert, and the campaign's whole claim is
 * that an accepted mutation changed nothing a caller can see.
 */
export function observeContextIndex(reader: ContextIndexReader): string {
  const parts: string[] = [
    `snapshot=${reader.snapshotHash}`,
    `config=${reader.configHash}`,
    `nodes=${reader.nodeCount}`,
    `edges=${reader.edgeCount}`,
    `terms=${reader.termCount}`,
    `strings=${reader.stringCount}`,
    `bytes=${reader.byteLength}`,
  ];

  for (let index = 0; index < reader.nodeCount; index += 1) {
    const view = reader.hydrateNode(index);
    const score = reader.nodeScoreFields(index);
    const metadata = Object.keys(view.metadata)
      .sort()
      .map((key) => `${key}=${view.metadata[key] ?? ''}`)
      .join(',');
    parts.push(
      `n${index}:${view.id}|${view.kind}|${view.label}|${view.path ?? ''}|${view.line ?? -1}|${view.column ?? -1}`
        + `|${view.contentHash ?? ''}|${view.trust}|${view.freshness}|${view.risk}|${view.tokenCost}`
        + `|${view.flags}|${view.group}|{${metadata}}`
        + `|s:${score.kind}/${score.freshness}/${score.risk}/${score.flags}/${score.trust}`
        + `/${score.tokenCost}/${score.group}/${score.outDegree}/${score.inDegree}`
    );
    parts.push(cursorSignature(reader, index, 'out'));
    parts.push(cursorSignature(reader, index, 'in'));
    parts.push(`p${index}:${reader.provenance(index, []).map((item) => `${item.path}#${item.line ?? -1}#${item.hash}`).join(';')}`);
  }

  for (let index = 0; index < reader.edgeCount; index += 1) {
    const view = reader.hydrateEdge(index);
    parts.push(
      `e${index}:${view.target}|${view.type}|${view.confidence}|${view.flags}|${view.profileMask}`
        + `|${view.provenance.path}#${view.provenance.line ?? -1}#${view.provenance.hash}#${view.provenance.extractor ?? ''}`
    );
  }

  for (const term of FUZZ_PROBE_TERMS) {
    const id = reader.termId(term);
    const exact = reader.exact(term);
    const basename = reader.basename(term);
    const lexical = id < 0 ? { length: 0 } : reader.lexical([id], BOUNDS);
    const coarse = id < 0 ? { length: 0 } : reader.coarse([id], BOUNDS);
    parts.push(`t:${term}=${id}/${exact.length}/${basename.length}/${lexical.length}/${coarse.length}`);
  }

  parts.push(`src:${reader.sourceHashes().map((item) => `${item.path}=${item.hash}`).join(';')}`);
  return parts.join('\n');
}
