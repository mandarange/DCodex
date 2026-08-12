/**
 * The publish join, asserted on the properties that make it a join rather than a
 * call sequence.
 *
 * Three of these tests exist because the failure they describe was real, not
 * hypothetical:
 *
 * - **The lexicon must be threaded.** Omitting it writes the four dictionary
 *   sections zero-length, and every query except a pasted path returns nothing.
 *   The test asserts term counts on the *published* file, not on the writer's
 *   return value, because the return value would still be right if the bytes on
 *   disk were not.
 * - **A lint failure must not publish**, and must be reported as a refusal to
 *   publish rather than as damage to an index a reader is holding.
 * - **A failure must leave `current.json` byte-identical**, which is the only
 *   observable promise the store makes to a query running concurrently.
 *
 * Every workspace is an `fsp.mkdtemp` directory under `os.tmpdir()`, removed in
 * `finally`. Nothing here touches the real `$HOME`.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContextGraphEdge, ContextGraphNode, ContextGraphSnapshot } from '../../contracts.js';
import { openContextIndex } from '../../runtime-index/reader.js';
import { CONTEXT_INDEX_SECTION, readContextIndexHeader, readSectionTable } from '../../runtime-index/format.js';
import { ContextIndexStoreError } from '../../store/generation-errors.js';
import {
  contextIndexOperationJournalPath,
  contextIndexPointerPath,
} from '../../store/generation-layout.js';
import { listContextIndexGenerations } from '../../store/generation-retention.js';
import { resolveCurrentContextIndex } from '../../store/generation-resolve.js';
import {
  CONTEXT_INDEX_CONFIG_FINGERPRINT,
  publishContextIndexGeneration,
} from '../publish-index.js';

function node(id: string, overrides: Partial<ContextGraphNode> = {}): ContextGraphNode {
  return {
    id,
    kind: 'file',
    label: id,
    trust: 0.5,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 10,
    metadata: {},
    ...overrides,
  };
}

function edge(from: string, to: string): ContextGraphEdge {
  return {
    id: `edge:${from}->${to}`,
    from,
    to,
    type: 'imports',
    confidence: 'exact',
    provenance: { path: 'src/runner.ts', hash: 'deadbeef', extractor: 'code' },
    observedAt: '2026-08-12T00:00:00.000Z',
  };
}

function snapshotOf(hash: string, nodes: ContextGraphNode[]): ContextGraphSnapshot {
  const edges = nodes.length > 1 ? [edge(nodes[0]!.id, nodes[1]!.id)] : [];
  return {
    schema: 'sks.context-graph.v1',
    schemaRevision: '1.0.0',
    snapshotHash: hash,
    nodes,
    edges,
    cycles: [],
    extractors: [],
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

/** Carries an identifier-shaped label and a Korean one, so both lanes have something to find. */
function fixtureSnapshot(hash = 'a'.repeat(64)): ContextGraphSnapshot {
  return snapshotOf(hash, [
    node('symbol:runService', {
      kind: 'symbol',
      label: 'runService',
      path: 'src/runner.ts',
      contentHash: 'hash-runner',
    }),
    node('file:runner', { path: 'src/runner.ts', contentHash: 'hash-runner' }),
    node('doc:ko', { kind: 'wiki_claim', label: '컨텍스트 예산 정책', path: 'docs/budget-ko.md' }),
  ]);
}

const SOURCE_FINGERPRINT = 'b'.repeat(64);

async function workspace(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sks-publish-index-'));
}

async function sectionCounts(root: string): Promise<Record<string, number>> {
  const resolved = await resolveCurrentContextIndex(root);
  const bytes = await fsp.readFile(resolved.generationPath);
  const header = readContextIndexHeader(bytes);
  const sections = readSectionTable(bytes, header);
  const counts: Record<string, number> = {};
  for (const descriptor of sections) counts[String(descriptor.kind)] = descriptor.count;
  return counts;
}

test('publishing threads the lexicon, so the dictionary lanes reach the file', async () => {
  const root = await workspace();
  try {
    const published = await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot(),
      sourceFingerprint: SOURCE_FINGERPRINT,
      fragmentManifestHash: null,
    });

    assert.equal(published.committed, true);
    assert.equal(published.reason, 'committed');
    assert.ok(published.lexicon, 'a published generation always carries a lexicon result');
    assert.ok(published.lexicon.termCount > 0, 'lexical lane must not be empty');
    assert.ok(published.lexicon.coarseTermCount > 0, 'coarse lane must not be empty');

    // Asserted on the bytes rather than on the writer's own report: a return
    // value describing sections that never reached disk is exactly the failure
    // this join exists to close.
    const counts = await sectionCounts(root);
    assert.ok((counts[String(CONTEXT_INDEX_SECTION.LEXICON_TABLE)] ?? 0) > 0);
    assert.ok((counts[String(CONTEXT_INDEX_SECTION.LEXICON_POSTINGS)] ?? 0) > 0);
    assert.ok((counts[String(CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE)] ?? 0) > 0);
    assert.ok((counts[String(CONTEXT_INDEX_SECTION.COARSE_POSTINGS)] ?? 0) > 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the pointer, the meta and the header agree on one config identity', async () => {
  const root = await workspace();
  try {
    const published = await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot(),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    assert.equal(published.configFingerprint, CONTEXT_INDEX_CONFIG_FINGERPRINT);

    const resolved = await resolveCurrentContextIndex(root, { expectedSourceFingerprint: SOURCE_FINGERPRINT });
    assert.equal(resolved.meta.configFingerprint, CONTEXT_INDEX_CONFIG_FINGERPRINT);
    const bytes = await fsp.readFile(resolved.generationPath);
    // The reader is the arbiter: it refuses to open under a config hash the file
    // was not built with, so this passing is the agreement.
    const reader = openContextIndex(bytes, {
      expectedSnapshotHash: resolved.pointer.snapshotHash,
      expectedConfigHash: resolved.pointer.configFingerprint,
    });
    assert.equal(reader.configHash, CONTEXT_INDEX_CONFIG_FINGERPRINT);
    assert.equal(published.indexBytes, bytes.byteLength);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the operation journal does not outlive a successful publish', async () => {
  const root = await workspace();
  try {
    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot(),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    const journal = await fsp.stat(contextIndexOperationJournalPath(root)).catch(() => null);
    assert.equal(journal, null, 'a finished compile leaves no journal for the next one to trip over');
    assert.deepEqual([...(await listContextIndexGenerations(root))].length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('republishing the same snapshot is a no-op, not a second generation', async () => {
  const root = await workspace();
  try {
    const first = await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot(),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    const before = await fsp.readFile(contextIndexPointerPath(root));

    const second = await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot(),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    assert.equal(second.committed, false);
    assert.equal(second.reason, 'already_current');
    assert.equal(second.snapshotHash, first.snapshotHash);
    assert.deepEqual(await fsp.readFile(contextIndexPointerPath(root)), before);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('two generations survive a rebuild, and only two', async () => {
  const root = await workspace();
  try {
    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('a'.repeat(64)),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('b'.repeat(64)),
      sourceFingerprint: 'c'.repeat(64),
    });
    const second = await resolveCurrentContextIndex(root);
    assert.equal(second.pointer.snapshotHash, 'b'.repeat(64));
    assert.equal(second.pointer.previousSnapshotHash, 'a'.repeat(64));
    assert.deepEqual([...(await listContextIndexGenerations(root))], ['a'.repeat(64), 'b'.repeat(64)]);

    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('d'.repeat(64)),
      sourceFingerprint: 'e'.repeat(64),
    });
    // The first generation is gone: retention is current plus previous, and the
    // previous one is for merge and audit, never a rollback target.
    assert.deepEqual([...(await listContextIndexGenerations(root))], ['b'.repeat(64), 'd'.repeat(64)]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a lint failure is a refusal to publish, and leaves current.json byte-identical', async () => {
  const root = await workspace();
  try {
    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('a'.repeat(64)),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    const before = await fsp.readFile(contextIndexPointerPath(root));

    const error = await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('b'.repeat(64)),
      sourceFingerprint: 'c'.repeat(64),
      lintErrors: ['lint:dangling_provenance'],
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof ContextIndexStoreError, `expected a store error, got ${String(error)}`);
    assert.equal(error.code, 'lint_not_passed');
    // Not a reader code. Telling a user to rebuild an index that is intact and
    // still serving is a wrong instruction, not merely an imprecise one.
    assert.equal(error.publicCode, 'context_index_commit_blocked');

    assert.deepEqual(await fsp.readFile(contextIndexPointerPath(root)), before);
    assert.deepEqual([...(await listContextIndexGenerations(root))], ['a'.repeat(64)]);
    assert.equal(await fsp.stat(contextIndexOperationJournalPath(root)).catch(() => null), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a refused publish leaves the previous generation openable', async () => {
  const root = await workspace();
  try {
    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('a'.repeat(64)),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });
    await publishContextIndexGeneration({
      root,
      snapshot: fixtureSnapshot('b'.repeat(64)),
      sourceFingerprint: 'c'.repeat(64),
      lintErrors: ['lint:absolute_path'],
    }).catch(() => undefined);

    const resolved = await resolveCurrentContextIndex(root, { expectedSourceFingerprint: SOURCE_FINGERPRINT });
    const reader = openContextIndex(await fsp.readFile(resolved.generationPath), {
      expectedSnapshotHash: resolved.pointer.snapshotHash,
      expectedConfigHash: resolved.pointer.configFingerprint,
    });
    assert.equal(reader.snapshotHash, 'a'.repeat(64));
    assert.equal(reader.nodeCount, 3);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
