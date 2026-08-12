import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_GRAPH_SCHEMA,
  type ContextGraphNode,
  type ContextGraphSnapshot,
} from '../../contracts.js';
import { openContextIndex, type ContextIndexReader } from '../../runtime-index/reader.js';
import { encodeContextIndex } from '../../runtime-index/writer.js';
import {
  CONTEXT_INDEX_CACHE_DEFAULT_BUDGET,
  ContextIndexCache,
  contextIndexWorkspaceKey,
  setSharedContextIndexCache,
  sharedContextIndexCache,
} from '../cache.js';

/**
 * The cache is a memory-safety device, so every test here is about a bound:
 * what is resident, what leaves when a rebuild lands, what leaves under
 * pressure, and what never gets stored. Byte counts come from real buffers —
 * an estimated size would make the whole budget advisory.
 */

const CONFIG_HASH = new Uint8Array(32).fill(0xb2);
const WORKSPACE_A = '/Users/canary/workspaces/alpha';
const WORKSPACE_B = '/Users/canary/workspaces/beta';
const WORKSPACE_C = '/Users/canary/workspaces/gamma';

function makeReader(snapshotHash: string, nodeCount: number): ContextIndexReader {
  const nodes: ContextGraphNode[] = Array.from({ length: nodeCount }, (_, index) => ({
    id: `file:src/f${String(index).padStart(4, '0')}.ts`,
    kind: 'file',
    label: `f${index}.ts`,
    path: `src/f${String(index).padStart(4, '0')}.ts`,
    contentHash: `sha256:${index}`,
    trust: 0.5,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 10,
    metadata: {},
  }));
  const snapshot: ContextGraphSnapshot = {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash,
    nodes,
    edges: [],
    cycles: [],
    extractors: [],
    nodeCount: nodes.length,
    edgeCount: 0,
  };
  return openContextIndex(encodeContextIndex({ snapshot, configHash: CONFIG_HASH, schemaRevision: 1 }).bytes);
}

const HASH_1 = '11'.repeat(32);
const HASH_2 = '22'.repeat(32);
const HASH_3 = '33'.repeat(32);

test('a workspace key is a digest, never a path', () => {
  const key = contextIndexWorkspaceKey(WORKSPACE_A);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(key.includes('/'), false);
  assert.equal(key.includes('canary'), false);
  assert.notEqual(key, contextIndexWorkspaceKey(WORKSPACE_B));
  // Resolution happens before hashing, so two spellings of one root are one key.
  assert.equal(contextIndexWorkspaceKey(`${WORKSPACE_A}/`), key);
});

test('a miss, then a store, then a hit — with resident bytes taken from the buffer', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  assert.equal(cache.getReader(WORKSPACE_A, HASH_1), null);
  assert.equal(cache.stats().misses, 1);

  const reader = makeReader(HASH_1, 8);
  cache.setReader(WORKSPACE_A, HASH_1, reader);
  assert.equal(cache.stats().residentBytes, reader.byteLength);
  assert.equal(cache.stats().generations, 1);
  assert.equal(cache.stats().workspaces, 1);

  assert.equal(cache.getReader(WORKSPACE_A, HASH_1), reader);
  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.5);
  assert.equal(cache.getReader(WORKSPACE_A, HASH_2), null, 'another generation is a different key');
});

test('an empty snapshot hash is a miss and is never stored', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  assert.equal(cache.getReader(WORKSPACE_A, ''), null);
  cache.setReader(WORKSPACE_A, '', makeReader(HASH_1, 4));
  assert.equal(cache.stats().generations, 0);
  assert.equal(cache.stats().residentBytes, 0);
});

test('a reader stored under a hash it does not carry is refused', () => {
  // The pointer and the index must agree, or a rebuild can be served from the
  // generation it replaced.
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  assert.throws(() => cache.setReader(WORKSPACE_A, HASH_2, makeReader(HASH_1, 4)), /snapshot hash/);
  assert.equal(cache.stats().generations, 0);
});

test('a new generation evicts the workspace previous generation immediately', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  const first = makeReader(HASH_1, 8);
  const second = makeReader(HASH_2, 8);
  cache.setReader(WORKSPACE_A, HASH_1, first);
  cache.setReader(WORKSPACE_A, HASH_2, second);

  const stats = cache.stats();
  assert.equal(stats.generations, 1, 'a workspace holds one generation, not two');
  assert.equal(stats.superseded, 1);
  assert.equal(stats.evictions, 0, 'superseding is not budget pressure');
  assert.equal(stats.residentBytes, second.byteLength);
  assert.equal(cache.getReader(WORKSPACE_A, HASH_1), null);
  assert.equal(cache.getReader(WORKSPACE_A, HASH_2), second);
});

test('an index larger than the whole budget is never retained', () => {
  const cache = new ContextIndexCache({ maxBytes: 128, maxWorkspaces: 4 });
  const reader = makeReader(HASH_1, 32);
  assert.ok(reader.byteLength > 128);
  cache.setReader(WORKSPACE_A, HASH_1, reader);
  const stats = cache.stats();
  assert.equal(stats.generations, 0);
  assert.equal(stats.residentBytes, 0);
  assert.equal(stats.rejected, 1);
  assert.equal(cache.getReader(WORKSPACE_A, HASH_1), null);
});

test('byte pressure evicts least-recently-used generations, deterministically', () => {
  const readers = [makeReader(HASH_1, 8), makeReader(HASH_2, 8), makeReader(HASH_3, 8)];
  const budget = (readers[0] as ContextIndexReader).byteLength + (readers[1] as ContextIndexReader).byteLength;

  const run = (): string => {
    const cache = new ContextIndexCache({ maxBytes: budget, maxWorkspaces: 8 });
    cache.setReader(WORKSPACE_A, HASH_1, readers[0] as ContextIndexReader);
    cache.setReader(WORKSPACE_B, HASH_2, readers[1] as ContextIndexReader);
    // Touching A makes B the least recently used, so B is what leaves.
    cache.getReader(WORKSPACE_A, HASH_1);
    cache.setReader(WORKSPACE_C, HASH_3, readers[2] as ContextIndexReader);
    const stats = cache.stats();
    return JSON.stringify({
      generations: stats.generations,
      evictions: stats.evictions,
      a: cache.getReader(WORKSPACE_A, HASH_1) !== null,
      b: cache.getReader(WORKSPACE_B, HASH_2) !== null,
      c: cache.getReader(WORKSPACE_C, HASH_3) !== null,
      residentBytes: stats.residentBytes,
    });
  };

  const first = run();
  assert.equal(
    first,
    JSON.stringify({
      generations: 2,
      evictions: 1,
      a: true,
      b: false,
      c: true,
      residentBytes: budget,
    }),
  );
  // Deterministic eviction is what makes a benchmark's eviction count a fact
  // rather than a property of the machine it ran on.
  assert.equal(run(), first);
  assert.equal(run(), first);
});

test('the workspace ceiling holds even when the byte budget is not reached', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 1 });
  const first = makeReader(HASH_1, 4);
  const second = makeReader(HASH_2, 4);
  cache.setReader(WORKSPACE_A, HASH_1, first);
  cache.setReader(WORKSPACE_B, HASH_2, second);
  const stats = cache.stats();
  assert.equal(stats.workspaces, 1);
  assert.equal(stats.evictions, 1);
  assert.equal(cache.getReader(WORKSPACE_A, HASH_1), null);
  assert.equal(cache.getReader(WORKSPACE_B, HASH_2), second);
});

test('a zero workspace budget retains nothing rather than one thing', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 0 });
  cache.setReader(WORKSPACE_A, HASH_1, makeReader(HASH_1, 4));
  assert.equal(cache.stats().generations, 0);
  assert.equal(cache.stats().residentBytes, 0);
});

test('a response lives inside the generation that produced it', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  const reader = makeReader(HASH_1, 8);
  cache.setReader(WORKSPACE_A, HASH_1, reader);

  assert.equal(cache.getResponse(WORKSPACE_A, HASH_1, 'query:auth'), null);
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:auth', { selected: 3 }, 512);
  assert.deepEqual(cache.getResponse(WORKSPACE_A, HASH_1, 'query:auth'), { selected: 3 });

  const stats = cache.stats();
  assert.equal(stats.responseEntries, 1);
  assert.equal(stats.responseBytes, 512);
  assert.equal(stats.residentBytes, reader.byteLength + 512);
  assert.equal(stats.responseHits, 1);
  assert.equal(stats.responseMisses, 1);

  // Re-storing the same key replaces rather than accumulates.
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:auth', { selected: 4 }, 256);
  assert.equal(cache.stats().responseBytes, 256);
  assert.deepEqual(cache.getResponse(WORKSPACE_A, HASH_1, 'query:auth'), { selected: 4 });
});

test('a response for an index that is not resident is dropped, not orphaned', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:auth', { selected: 3 }, 512);
  assert.equal(cache.stats().responseEntries, 0);
  assert.equal(cache.getResponse(WORKSPACE_A, HASH_1, 'query:auth'), null);
  assert.equal(cache.stats().responseBytes, 0);
});

test('a rebuild takes the previous generation responses with it', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  cache.setReader(WORKSPACE_A, HASH_1, makeReader(HASH_1, 8));
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:auth', { selected: 3 }, 512);
  cache.setReader(WORKSPACE_A, HASH_2, makeReader(HASH_2, 8));

  const stats = cache.stats();
  assert.equal(stats.responseEntries, 0);
  assert.equal(stats.responseBytes, 0);
  assert.equal(cache.getResponse(WORKSPACE_A, HASH_1, 'query:auth'), null);
});

test('response bytes count against the same budget the index does', () => {
  const reader = makeReader(HASH_1, 8);
  const cache = new ContextIndexCache({ maxBytes: reader.byteLength + 1_000, maxWorkspaces: 4 });
  cache.setReader(WORKSPACE_A, HASH_1, reader);
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:one', { selected: 1 }, 400);
  assert.equal(cache.stats().generations, 1);
  // One budget, not two: a response big enough to overflow it evicts the
  // generation rather than being kept alongside an index it no longer fits with.
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:two', { selected: 2 }, 900);
  const stats = cache.stats();
  assert.equal(stats.generations, 0);
  assert.equal(stats.residentBytes, 0);
  assert.equal(stats.evictions, 1);
});

test('stats carry counts and digests only, never a path', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 2 });
  cache.setReader(WORKSPACE_A, HASH_1, makeReader(HASH_1, 4));
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:auth', { selected: 1 }, 64);
  const rendered = JSON.stringify(cache.stats());
  assert.equal(rendered.includes('/'), false, 'a stat block must not carry a path fragment');
  assert.equal(rendered.includes('canary'), false);
  assert.equal(rendered.includes('Users'), false);
  for (const [key, value] of Object.entries(cache.stats())) {
    assert.equal(typeof value, 'number', `${key} must be a number`);
  }
});

test('clear returns the cache to its opening state', () => {
  const cache = new ContextIndexCache({ maxBytes: 1 << 24, maxWorkspaces: 4 });
  cache.setReader(WORKSPACE_A, HASH_1, makeReader(HASH_1, 8));
  cache.setResponse(WORKSPACE_A, HASH_1, 'query:auth', { selected: 1 }, 64);
  cache.getReader(WORKSPACE_A, HASH_1);
  cache.clear();
  const stats = cache.stats();
  assert.equal(stats.generations, 0);
  assert.equal(stats.residentBytes, 0);
  assert.equal(stats.responseBytes, 0);
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);
  assert.equal(stats.evictions, 0);
  assert.equal(stats.superseded, 0);
  assert.equal(stats.rejected, 0);
  assert.equal(stats.hitRate, 0);
});

test('the shared cache is one cache, because residency is a process property', () => {
  setSharedContextIndexCache(null);
  const first = sharedContextIndexCache();
  assert.equal(sharedContextIndexCache(), first);
  assert.equal(first.stats().maxBytes, CONTEXT_INDEX_CACHE_DEFAULT_BUDGET.maxBytes);
  assert.equal(first.stats().maxWorkspaces, CONTEXT_INDEX_CACHE_DEFAULT_BUDGET.maxWorkspaces);

  const replacement = new ContextIndexCache({ maxBytes: 1_024, maxWorkspaces: 1 });
  setSharedContextIndexCache(replacement);
  assert.equal(sharedContextIndexCache(), replacement);
  setSharedContextIndexCache(null);
});
