/**
 * Shared fixtures for the kernel suite.
 *
 * The index is built by calling the real writer and then reopened with the real
 * reader: a hand-assembled buffer would prove things about a file the compiler
 * never produces.
 *
 * The lexical and coarse dictionaries are laid by hand, because format revision
 * 1's writer declares those two sections empty (CG2-04 fills them without moving
 * the layout). They are laid with term ids resolved *through the reader*, never
 * with literals — the term-id space is the interned string table, so a fixture
 * that guessed at ids would pass while the kernel's own lookup was broken.
 */
import {
  CONTEXT_GRAPH_SCHEMA,
  type ContextGraphEdge,
  type ContextGraphEdgeType,
  type ContextGraphNode,
  type ContextGraphSnapshot,
} from '../../contracts.js';
import { CONTEXT_INDEX_SECTION } from '../../runtime-index/format.js';
import { CONTEXT_INDEX_NODE_ROW_BYTES, encodeContextIndex } from '../../runtime-index/writer.js';
import { openContextIndex, type ContextIndexReader } from '../../runtime-index/reader.js';
import {
  makeEdge,
  makeNode,
  rewriteSections,
  sectionBytes,
  termTable,
} from '../../runtime-index/__tests__/reader-fixtures.js';

/** Node-row offset of the group field; `reader-layout.ts` decodes the same one. */
const NODE_GROUP_OFFSET = 32;

export const KERNEL_SNAPSHOT_HASH = 'fedcba9876543210'.repeat(4);
const CONFIG_HASH = new Uint8Array(32).fill(0x7c);

/** Node integers are assigned in sorted node-id order, so these are stable. */
export const DEEP = 0;
export const FORMAT = 1;
export const KERNEL = 2;
export const LANES = 3;
export const GATE = 4;
export const MODULE = 5;
export const INVALID = 6;
export const STALE = 7;
export const UNKNOWN = 8;
export const SYMBOL = 9;
export const TEST = 10;

export const KERNEL_PATH = 'src/core/kernel.ts';
export const GATE_ID = 'gate:release:proof';

/**
 * `lexeme` values exist only to intern query terms into the string table. The
 * lexical lane's term ids are string ids, so a term the writer never interned
 * has no id and no posting run to lay.
 */
const NODES: readonly ContextGraphNode[] = [
  makeNode({
    id: 'file:src/core/kernel.ts',
    kind: 'file',
    label: 'kernel.ts',
    path: KERNEL_PATH,
    contentHash: 'sha256:k',
    trust: 0.9,
    tokenCost: 40,
    metadata: { lexeme: 'kernel', alt: 'retrieval' },
  }),
  makeNode({
    id: 'file:src/core/lanes.ts',
    kind: 'file',
    label: 'lanes.ts',
    path: 'src/core/lanes.ts',
    contentHash: 'sha256:l',
    tokenCost: 30,
  }),
  // Two more hops than the default depth allows, so the depth cap has something
  // to stop at. Without them the fixture proves the cap is never reached.
  makeNode({
    id: 'file:src/core/format.ts',
    kind: 'file',
    label: 'format.ts',
    path: 'src/core/format.ts',
    contentHash: 'sha256:f',
    tokenCost: 22,
  }),
  makeNode({
    id: 'file:src/core/deep.ts',
    kind: 'file',
    label: 'deep.ts',
    path: 'src/core/deep.ts',
    contentHash: 'sha256:d',
    tokenCost: 18,
  }),
  makeNode({ id: GATE_ID, kind: 'gate', label: 'release proof', risk: 'protected', tokenCost: 12 }),
  makeNode({ id: 'module:core', kind: 'module', label: 'core', tokenCost: 20 }),
  makeNode({ id: 'proof:invalid', kind: 'proof', label: 'invalid proof', tokenCost: 5 }),
  makeNode({ id: 'proof:stale', kind: 'proof', label: 'stale proof', freshness: 'stale', tokenCost: 5 }),
  // Neither fresh nor stale: the writer leaves `GROUNDABLE` clear, which is what
  // "ungroundable" means on the query side.
  makeNode({ id: 'proof:unknown', kind: 'proof', label: 'unknown proof', freshness: 'unknown', tokenCost: 5 }),
  makeNode({
    id: 'symbol:src/core/kernel.ts#runContextKernel',
    kind: 'symbol',
    label: 'runContextKernel',
    path: KERNEL_PATH,
    line: 10,
    contentHash: 'sha256:s',
    tokenCost: 25,
  }),
  makeNode({
    id: 'test:kernel.spec',
    kind: 'test',
    label: 'kernel spec',
    path: 'src/core/kernel.spec.ts',
    contentHash: 'sha256:t',
    tokenCost: 15,
  }),
];

function edge(from: string, to: string, type: ContextGraphEdgeType): ContextGraphEdge {
  return makeEdge({ from, to, type, path: 'src/core/kernel.ts', line: 1 });
}

const EDGES: readonly ContextGraphEdge[] = [
  edge('file:src/core/kernel.ts', 'file:src/core/lanes.ts', 'imports'),
  edge('file:src/core/kernel.ts', 'symbol:src/core/kernel.ts#runContextKernel', 'defines'),
  edge('symbol:src/core/kernel.ts#runContextKernel', GATE_ID, 'verified_by'),
  edge('test:kernel.spec', 'file:src/core/kernel.ts', 'tests'),
  edge('module:core', 'file:src/core/kernel.ts', 'contains'),
  edge('file:src/core/lanes.ts', 'file:src/core/format.ts', 'imports'),
  edge('file:src/core/format.ts', 'file:src/core/deep.ts', 'imports'),
  // Neither type is in the implementation profile, which is exactly the point:
  // the safety closure must reach both when the relevance walk cannot.
  edge('file:src/core/lanes.ts', 'file:src/core/kernel.ts', 'conflicts_with'),
  edge('proof:invalid', GATE_ID, 'invalidates'),
];

function snapshot(): ContextGraphSnapshot {
  const nodes = [...NODES].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [...EDGES].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash: KERNEL_SNAPSHOT_HASH,
    nodes,
    edges,
    cycles: [],
    extractors: [],
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

const BASE_BYTES = encodeContextIndex({
  snapshot: snapshot(),
  configHash: CONFIG_HASH,
  schemaRevision: 1,
  invalidatedNodeIds: ['proof:invalid'],
}).bytes;

/** Postings are keyed by term string; ids are resolved through the reader below. */
const LEXICAL_POSTINGS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['kernel', [KERNEL, SYMBOL]],
  ['retrieval', [MODULE]],
];

const COARSE_POSTINGS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['retrieval', [KERNEL, MODULE]],
];

function laneSections(
  resolver: ContextIndexReader,
  entries: ReadonlyArray<readonly [string, readonly number[]]>,
): ReturnType<typeof termTable> {
  const rows = entries
    .map(([term, nodes]) => [resolver.termId(term), nodes] as const)
    .filter(([id]) => id >= 0)
    // The reader binary-searches the term table, so it must be ascending. A
    // fixture that ignored this would be rejected at open, not silently searched.
    .sort((left, right) => left[0] - right[0]);
  return termTable(rows);
}

export const KERNEL_INDEX_BYTES = (() => {
  const resolver = openContextIndex(BASE_BYTES);
  const lexical = laneSections(resolver, LEXICAL_POSTINGS);
  const coarse = laneSections(resolver, COARSE_POSTINGS);
  return rewriteSections(BASE_BYTES, new Map([
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, lexical.table],
    [CONTEXT_INDEX_SECTION.LEXICON_POSTINGS, lexical.postings],
    [CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE, coarse.table],
    [CONTEXT_INDEX_SECTION.COARSE_POSTINGS, coarse.postings],
  ]));
})();

export function openKernelIndex(): ContextIndexReader {
  return openContextIndex(KERNEL_INDEX_BYTES);
}

/**
 * The same index with every node but the gate collapsed into one structural
 * group. The writer gives each node its own group, so the share cap has nothing
 * to cap without this; a single group would disable diversity entirely, which is
 * why the gate keeps its own.
 */
export function openSharedGroupIndex(): ContextIndexReader {
  // The group is encoded twice — node row and group table — and the reader
  // rejects an index where the two disagree. Both are rewritten here for that
  // reason, not for redundancy's sake.
  const nodes = sectionBytes(KERNEL_INDEX_BYTES, CONTEXT_INDEX_SECTION.NODE_TABLE);
  const groups = sectionBytes(KERNEL_INDEX_BYTES, CONTEXT_INDEX_SECTION.GROUP_TABLE);
  const nodeView = new DataView(nodes.payload.buffer, nodes.payload.byteOffset, nodes.payload.byteLength);
  const groupView = new DataView(groups.payload.buffer, groups.payload.byteOffset, groups.payload.byteLength);
  for (let row = 0; row < nodes.count; row += 1) {
    if (row === GATE) continue;
    nodeView.setUint32(row * CONTEXT_INDEX_NODE_ROW_BYTES + NODE_GROUP_OFFSET, 0, true);
    groupView.setUint32(row * 4, 0, true);
  }
  return openContextIndex(rewriteSections(KERNEL_INDEX_BYTES, new Map([
    [CONTEXT_INDEX_SECTION.NODE_TABLE, nodes],
    [CONTEXT_INDEX_SECTION.GROUP_TABLE, groups],
  ])));
}

/**
 * Counts every reader call the kernel makes, so a test can assert what the hot
 * path did *not* do. `hydrateNode` in particular must never be called: hydration
 * is CG2-10's, over the selected set only.
 */
export interface ReaderCallLog {
  readonly reader: ContextIndexReader;
  readonly calls: Map<string, number>;
}

export function countingReader(inner: ContextIndexReader): ReaderCallLog {
  const calls = new Map<string, number>();
  const reader = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const name = String(property);
      return (...args: unknown[]): unknown => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { reader, calls };
}
