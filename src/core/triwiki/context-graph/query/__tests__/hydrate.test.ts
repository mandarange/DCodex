import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contextGraphEdgeId } from '../../ids.js';
import { CONTEXT_INDEX_NODE_FLAG } from '../../runtime-index/writer.js';
import type { ContextGraphNodeView, ContextIndexReader } from '../../runtime-index/reader.js';
import { fixedKernelClock, runContextKernel, type KernelRequest, type SelectedCandidate } from '../kernel.js';
import { CONTEXT_GRAPH_RANKING_CONFIG } from '../ranking-config.js';
import {
  CONTEXT_HYDRATION_SCHEMA,
  contextHydrationCoverage,
  hydrateSelectedCandidates,
  type HydratedNode,
} from '../hydrate.js';
import { GATE_ID, KERNEL_PATH, countingReader, openKernelIndex } from './kernel-fixtures.js';

const clock = fixedKernelClock(0);
const BROAD: KernelRequest = { query: `${KERNEL_PATH} ${GATE_ID} kernel retrieval`, profile: 'review', risk: 'high' };
const FRESH = { indexFresh: true } as const;

function select(reader: ContextIndexReader, request: KernelRequest = BROAD): readonly SelectedCandidate[] {
  return runContextKernel(reader, request, { clock }).selected;
}

/** Records which node each `hydrateNode` call materialized, not just how many. */
function tracingReader(inner: ContextIndexReader): { reader: ContextIndexReader; ids: string[]; nodes: number[] } {
  const ids: string[] = [];
  const nodes: number[] = [];
  const reader = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'hydrateNode' || typeof value !== 'function') return value;
      return (node: number): ContextGraphNodeView => {
        const view = (value as (index: number) => ContextGraphNodeView).call(target, node);
        nodes.push(node);
        ids.push(view.id);
        return view;
      };
    },
  });
  return { reader, ids, nodes };
}

test('nothing outside the answer is materialized, and no node is materialized twice', () => {
  const trace = tracingReader(openKernelIndex());
  const selected = select(trace.reader, { ...BROAD, maxSelected: 2 });
  const result = hydrateSelectedCandidates(trace.reader, selected, FRESH);

  assert.equal(result.schema, CONTEXT_HYDRATION_SCHEMA);
  assert.ok(result.nodes.length > 0);
  assert.ok(result.nodes.length <= selected.length, 'hydrated count must not exceed selected count');

  // Every id the pass materialized has to appear in the answer it produced —
  // either as a selected node or as a hop the reason path names. Anything else
  // is a node hydration this card exists to delete.
  const answered = new Set<string>();
  for (const node of result.nodes) {
    answered.add(node.nodeId);
    for (const entry of node.reasonPath) answered.add(entry);
  }
  for (const id of trace.ids) assert.ok(answered.has(id), `${id} was hydrated but is not in the answer`);

  assert.equal(trace.nodes.length, new Set(trace.nodes).size, 'the memo must make a repeat hop free');
  assert.equal(trace.nodes.length, result.hydratedNodes);
  assert.ok(trace.nodes.length < 11, 'a two-node answer must not materialize the whole fixture');
});

test('ranking is untouched: the kernel still hydrates nothing, hydration does it all', () => {
  const log = countingReader(openKernelIndex());
  const selected = select(log.reader);
  assert.equal(log.calls.get('hydrateNode'), undefined);
  assert.equal(log.calls.get('provenance'), undefined);

  hydrateSelectedCandidates(log.reader, selected, FRESH);
  assert.ok((log.calls.get('hydrateNode') ?? 0) > 0);
  assert.equal(log.calls.get('provenance'), selected.length);
  // `sourceHashes` is the validation path's whole-section read. Hydration is not
  // the validation path, so it stays untouched here too.
  assert.equal(log.calls.get('sourceHashes'), undefined);
});

/**
 * ADR §7. `hydrated` used to assert a per-node `stat`; it now asserts a fresh
 * index plus the compile-time `GROUNDABLE` stamp. Both halves are checked,
 * because a flag that ignored either one would be the old claim wearing the new
 * name — the exact failure the semantic change was written down to prevent.
 */
test('hydrated means fresh index plus compile-verified groundable, and says so', () => {
  const reader = openKernelIndex();
  const selected = select(reader);

  const fresh = hydrateSelectedCandidates(reader, selected, FRESH);
  assert.ok(fresh.nodes.length > 0);
  for (const node of fresh.nodes) {
    const groundable = (reader.nodeFlags(node.node) & CONTEXT_INDEX_NODE_FLAG.GROUNDABLE) !== 0;
    assert.equal(node.hydrated, groundable, `${node.nodeId} must inherit the writer's stamp`);
    assert.equal(node.grounding, groundable ? 'fresh_index' : 'unverified');
    assert.notEqual(node.grounding, 'filesystem_verified', 'only the validate path may make that claim');
  }

  const stale = hydrateSelectedCandidates(reader, selected, { indexFresh: false });
  for (const node of stale.nodes) {
    assert.equal(node.hydrated, false, 'a stamp on a non-fresh index proves nothing');
    assert.equal(node.grounding, 'unverified');
  }
});

test('the query path cannot stat: it links no filesystem module at all', () => {
  for (const name of ['hydrate.js', 'hydrate-chain.js']) {
    const code = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/node:fs|['"]fs['"]/.test(code), `${name} must not import a filesystem module`);
    assert.ok(!/\bstat\b|realpath|readFile/.test(code), `${name} must not name a filesystem call`);
    assert.ok(!code.includes('hydrate-verify'), `${name} must not link the validate path`);
  }
});

test('provenance coverage is 1.0 as an equality, and every node carries a record', () => {
  const reader = openKernelIndex();
  const result = hydrateSelectedCandidates(reader, select(reader), FRESH);
  const selected = select(reader);
  assert.equal(result.provenanceCoverage, 1);
  assert.equal(contextHydrationCoverage(result.nodes), 1);
  for (const node of result.nodes) assert.ok(node.provenance.length > 0, `${node.nodeId} is ungrounded`);
  // Every selected candidate is accounted for exactly once. A third path — a
  // candidate that is neither hydrated nor recorded as omitted — is how a
  // coverage equality quietly becomes a coverage average.
  assert.equal(result.nodes.length + result.omitted.length, selected.length);

  // The gate carries neither a path nor a content hash, so its only grounding is
  // an incident edge. It is in the answer, which is what makes the equality real
  // rather than an artefact of a fixture where every node has a file.
  const gate = result.nodes.find((node) => node.nodeId === GATE_ID);
  assert.ok(gate, 'the protected gate must be selected on a high-risk review');
  assert.equal(gate.path, undefined);
  assert.ok(gate.provenance.length > 0);
});

test('provenance is deduplicated and capped, and the cap is the ranking config', () => {
  const reader = openKernelIndex();
  const selected = select(reader);
  const capped = hydrateSelectedCandidates(reader, selected, {
    indexFresh: true,
    config: { ...CONTEXT_GRAPH_RANKING_CONFIG, maxProvenancePerNode: 1 },
  });
  for (const node of capped.nodes) assert.equal(node.provenance.length, 1);

  const wide = hydrateSelectedCandidates(reader, selected, FRESH);
  for (const node of wide.nodes) {
    assert.ok(node.provenance.length <= CONTEXT_GRAPH_RANKING_CONFIG.maxProvenancePerNode);
    const keys = node.provenance.map((ref) => `${ref.path} ${ref.line ?? ''} ${ref.hash}`);
    assert.equal(keys.length, new Set(keys).size, `${node.nodeId} lists one fact twice`);
  }
});

test('a hop names the edge, not the walk: reverse hops are labelled and endpoints are not swapped', () => {
  const reader = openKernelIndex();
  const result = hydrateSelectedCandidates(reader, select(reader), FRESH);
  const byId = new Map(result.nodes.map((node) => [node.nodeId, node]));

  let reversed = 0;
  for (const node of result.nodes) {
    assert.equal(node.reasonPath.length, node.explanation.length * 2 + 1);
    for (let at = 0; at < node.explanation.length; at += 1) {
      const step = node.explanation[at];
      assert.ok(step);
      const label = node.reasonPath[at * 2 + 1] as string;
      assert.ok(label === step.type || label === `${step.type}:reverse`);
      if (label.endsWith(':reverse')) reversed += 1;
      // The step's endpoints are the edge's own, so a reverse hop's reason path
      // walks from `to` to `from` while the step still reads in graph order.
      const walkedTo = node.reasonPath[at * 2 + 2];
      assert.equal(walkedTo, label.endsWith(':reverse') ? step.from : step.to);
      assert.equal(step.edgeId, contextGraphEdgeId({ type: step.type, from: step.from, to: step.to }));
      assert.ok(step.path.length > 0);
    }
    if (node.reasonPath.length > 1) assert.ok(byId.has(node.nodeId));
  }
  // `tests` and `contains` reach the kernel file only against their direction.
  assert.ok(reversed > 0, 'the fixture must exercise at least one reverse hop');
});

/** A real edge that touches neither end of `node`, found rather than guessed. */
function strangerEdge(reader: ContextIndexReader, node: number): number {
  const incident = new Set<number>();
  for (const cursor of [reader.outgoing(node, 0xffff), reader.incoming(node, 0xffff)]) {
    while (cursor.next()) incident.add(cursor.edge);
  }
  for (let edge = 0; edge < reader.edgeCount; edge += 1) if (!incident.has(edge)) return edge;
  throw new Error('the fixture has no non-incident edge to test with');
}

test('a broken parent or edge is dropped from the answer and recorded as an omission', () => {
  const reader = openKernelIndex();
  const selected = select(reader);
  const walked = selected.find((entry) => entry.parentEdges.length > 0);
  const seeded = selected.find((entry) => entry.parentEdges.length === 0);
  assert.ok(walked && seeded);

  const cases: ReadonlyArray<readonly [string, SelectedCandidate]> = [
    // An edge index past the edge table.
    ['out of range', { ...walked, parentEdges: Object.freeze([9999]) }],
    // A real edge that is not incident to the node it claims to have reached.
    ['not incident', { ...seeded, parentEdges: Object.freeze([strangerEdge(reader, seeded.candidate.node)]) }],
    // The table's parent pointer disagreeing with the index's topology.
    ['parent disagrees', { ...walked, candidate: { ...walked.candidate, parentNode: reader.nodeCount - 1 } }],
  ];

  for (const [name, broken] of cases) {
    const result = hydrateSelectedCandidates(reader, [broken], FRESH);
    assert.equal(result.nodes.length, 0, `${name} must not reach the answer`);
    assert.deepEqual(result.omitted.map((entry) => entry.reason), ['broken_chain'], name);
    assert.equal(result.omitted[0]?.node, broken.candidate.node);
    assert.equal(result.omissions.no_provenance, 1, name);
    // An omission is a code and an integer. Nothing here carries a string path.
    for (const entry of result.omitted) assert.equal(typeof entry.node, 'number');
    assert.equal(result.provenanceCoverage, 1, 'coverage is over what shipped, not what was tried');
  }
});

test('no absolute path, home path or backslash reaches a hydrated view', () => {
  const reader = openKernelIndex();
  const result = hydrateSelectedCandidates(reader, select(reader), FRESH);
  assert.equal(result.refusedPaths, 0, 'the fixture index must already be clean');

  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  walk(result.nodes as unknown as HydratedNode[]);
  assert.ok(strings.length > 0);
  for (const value of strings) {
    assert.ok(!value.startsWith('/'), `absolute path in a hydrated view: ${value}`);
    assert.ok(!value.startsWith('~'), `home path in a hydrated view: ${value}`);
    assert.ok(!value.includes('\\'), `non-POSIX separator in a hydrated view: ${value}`);
    assert.ok(!/^[A-Za-z]:\//.test(value), `drive-letter path in a hydrated view: ${value}`);
  }
});

test('hydration is byte-identical over 50 runs and hands back a frozen answer', () => {
  const reader = openKernelIndex();
  const selected = select(reader);
  const shape = (): string => {
    const result = hydrateSelectedCandidates(reader, selected, FRESH);
    return result.nodes
      .map((node) => [
        node.node,
        node.nodeId,
        node.score.toString(),
        node.grounding,
        node.reasonPath.join('>'),
        node.provenance.map((ref) => `${ref.path}@${ref.hash}`).join(','),
      ].join(':'))
      .join('|');
  };
  const first = shape();
  assert.notEqual(first, '');
  for (let run = 1; run < 50; run += 1) assert.equal(shape(), first, `run ${run} diverged`);

  const result = hydrateSelectedCandidates(reader, selected, FRESH);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.nodes));
  for (const node of result.nodes) assert.ok(Object.isFrozen(node));
});

test('an empty selection hydrates nothing and still reports full coverage', () => {
  const result = hydrateSelectedCandidates(openKernelIndex(), [], FRESH);
  assert.deepEqual(result.nodes, []);
  assert.equal(result.provenanceCoverage, 1);
  assert.equal(result.hydratedNodes, 0);
  assert.equal(result.hydratedEdges, 0);
  assert.equal(result.explanationPathCount, 0);
});
