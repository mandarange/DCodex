import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../../triwiki/context-graph/contracts.js';
import type { ContextGraphCacheKeyParts, ContextGraphMeta, ContextGraphStaleReason } from '../../triwiki/context-graph/contracts.js';
import { contextGraphCacheKey, type ContextGraphCacheKeyResult } from '../../triwiki/context-graph/compiler/cache-key.js';
import { compileContextGraph } from '../../triwiki/context-graph/compiler/index.js';
import { contextGraphExtractors } from '../../triwiki/context-graph/extractors/index.js';
import { readContextGraphMeta } from '../../triwiki/context-graph/store/snapshot-store.js';
import {
  contextGraphFreshnessNoteFor,
  contextGraphFreshnessPreflight
} from '../context-graph-freshness-preflight.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sks-graph-preflight-'));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Content manifest of the whole workspace, used to prove the preflight mutates nothing. */
function fingerprint(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const stack: string[] = [''];
  while (stack.length) {
    const current = stack.pop();
    if (current === undefined) break;
    const absolute = current ? path.join(root, current) : root;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const rel = current ? `${current}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push([rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]);
    }
  }
  return out.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

async function buildGraph(root: string): Promise<void> {
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'core', 'sample.ts'), 'export const sample = 1;\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`);
  const result = await compileContextGraph({ root, extractors: contextGraphExtractors(), observedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(result.wrote, true, `fixture compile must write a snapshot (blockers: ${result.blockers.join(',')})`);
  normalizeFixtureGitState(root);
}

/**
 * The fixture is a bare temp directory, so the compile records `gitState: unknown`
 * — which the cache-key contract always treats as stale. Normalize it to what a
 * clean checkout records so the fixture can express a genuinely fresh graph.
 */
function normalizeFixtureGitState(root: string): void {
  const file = path.join(root, '.sneakoscope', 'wiki', 'context-graph.meta.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as ContextGraphMeta;
  meta.cacheKeyParts = { ...meta.cacheKeyParts, gitState: 'clean', head: '0'.repeat(40) };
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
}

async function loadMeta(root: string): Promise<ContextGraphMeta> {
  const load = await readContextGraphMeta(root);
  assert.equal(load.status, 'ok');
  assert.ok(load.meta);
  return load.meta;
}

function cacheKeyFrom(parts: ContextGraphCacheKeyParts, reusable = true): ContextGraphCacheKeyResult {
  return { key: contextGraphCacheKey(parts), parts, reusable, reasons: [], dirtyPaths: [] };
}

test('a freshly compiled graph is usable and the preflight leaves the workspace untouched', async () => {
  const root = workspace();
  try {
    await buildGraph(root);
    const before = fingerprint(root);
    const preflight = await contextGraphFreshnessPreflight(root);
    // The fixture is not a git repository. Had the preflight computed a cache key
    // it would have shelled out to git, got `gitState: unknown`, and reported
    // stale — so a `fresh` verdict here is the proof that no process was spawned.
    assert.equal(preflight.status, 'fresh');
    assert.equal(preflight.usable, true);
    assert.deepEqual(preflight.reasons, []);
    assert.equal(preflight.error_code, null);
    assert.equal(preflight.repair_command, CONTEXT_GRAPH_REPAIR_COMMAND);
    assert.equal(preflight.coverage, 'artifacts_and_sources');
    assert.ok(preflight.snapshot_hash);
    assert.ok(preflight.node_count >= 0);
    assert.equal(contextGraphFreshnessNoteFor(preflight), null, 'a fresh graph must not nag');
    assert.deepEqual(
      preflight.unverified_reasons,
      [
        'head_changed',
        'dirty_fingerprint_changed',
        'schema_revision_changed',
        'tsconfig_changed',
        'command_manifest_changed',
        'gate_manifest_changed',
        'proof_index_changed',
        'wiki_context_changed',
        'git_state_unknown',
        'cache_key_changed'
      ],
      'the spawn-free run must declare what it did not check'
    );
    assert.deepEqual(fingerprint(root), before, 'the preflight must not modify the workspace');

    const again = await contextGraphFreshnessPreflight(root);
    assert.deepEqual(again, preflight, 'the verdict must be deterministic');
  } finally {
    cleanup(root);
  }
});

test('a changed source file makes the graph stale without any spawn', async () => {
  const root = workspace();
  try {
    await buildGraph(root);
    fs.writeFileSync(path.join(root, 'src', 'core', 'sample.ts'), 'export const sample = 2;\n');
    const before = fingerprint(root);
    const preflight = await contextGraphFreshnessPreflight(root);
    assert.equal(preflight.status, 'stale');
    assert.equal(preflight.usable, false);
    assert.deepEqual(preflight.reasons, ['source_hash_mismatch']);
    assert.equal(preflight.error_code, 'context_graph_stale');
    assert.equal(preflight.unverified_reasons.includes('source_hash_mismatch'), false);
    const note = contextGraphFreshnessNoteFor(preflight);
    assert.ok(note);
    assert.ok(note.includes('context_graph_stale'));
    assert.ok(note.includes(CONTEXT_GRAPH_REPAIR_COMMAND));
    assert.deepEqual(fingerprint(root), before);
  } finally {
    cleanup(root);
  }
});

test('skipping source verification is reported instead of being passed off as fresh', async () => {
  const root = workspace();
  try {
    await buildGraph(root);
    fs.writeFileSync(path.join(root, 'src', 'core', 'sample.ts'), 'export const sample = 3;\n');
    const preflight = await contextGraphFreshnessPreflight(root, { verifySources: false });
    assert.equal(preflight.coverage, 'artifacts_only');
    assert.equal(preflight.unverified_reasons.includes('source_hash_mismatch'), true);
    const capped = await contextGraphFreshnessPreflight(root, { maxVerifiedSources: 0 });
    assert.equal(capped.unverified_reasons.includes('source_hash_mismatch'), true);
  } finally {
    cleanup(root);
  }
});

test('every cache-key derived stale reason is surfaced when a caller supplies a cache key', async () => {
  const root = workspace();
  try {
    await buildGraph(root);
    const meta = await loadMeta(root);
    const cases: Array<[keyof ContextGraphCacheKeyParts, ContextGraphStaleReason]> = [
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
    const before = fingerprint(root);
    for (const [part, reason] of cases) {
      const parts: ContextGraphCacheKeyParts = { ...meta.cacheKeyParts, [part]: `moved-${part}` };
      const preflight = await contextGraphFreshnessPreflight(root, { cacheKey: cacheKeyFrom(parts) });
      assert.equal(preflight.status, 'stale', `${part} must make the graph stale`);
      assert.equal(preflight.reasons.includes(reason), true, `${part} must report ${reason}`);
      assert.equal(preflight.coverage, 'full');
      assert.deepEqual(preflight.unverified_reasons, [], 'a supplied cache key leaves nothing unchecked');
    }
    const unknownGit = await contextGraphFreshnessPreflight(root, { cacheKey: cacheKeyFrom(meta.cacheKeyParts, false) });
    assert.equal(unknownGit.status, 'stale');
    assert.deepEqual(unknownGit.reasons, ['git_state_unknown']);
    assert.deepEqual(fingerprint(root), before, 'stale detection must not touch the workspace');
  } finally {
    cleanup(root);
  }
});

test('a missing graph is reported with its error code and repair command', async () => {
  const root = workspace();
  try {
    const before = fingerprint(root);
    const preflight = await contextGraphFreshnessPreflight(root);
    assert.equal(preflight.status, 'missing');
    assert.equal(preflight.usable, false);
    assert.equal(preflight.error_code, 'context_graph_missing');
    assert.equal(preflight.snapshot_hash, null);
    assert.equal(preflight.node_count, 0);
    assert.equal(preflight.edge_count, 0);
    assert.deepEqual(preflight.reasons, []);
    const note = contextGraphFreshnessNoteFor(preflight);
    assert.ok(note);
    assert.ok(note.includes('context_graph_missing'));
    assert.ok(note.includes(CONTEXT_GRAPH_REPAIR_COMMAND));
    assert.deepEqual(fingerprint(root), before, 'a missing graph must not be built by the preflight');
    assert.deepEqual(await contextGraphFreshnessPreflight(root), preflight);
  } finally {
    cleanup(root);
  }
});

test('a corrupt meta is reported as corrupt; a corrupt JSON snapshot is inert', async () => {
  const root = workspace();
  try {
    await buildGraph(root);

    // This assertion used to read the other way: damaging `context-graph.json`
    // was what produced `corrupt`. Under ADR §8 that file is retired, and the
    // preflight no longer parses it, so damaging it cannot move the verdict.
    // The check did not weaken — it moved onto the artifact the v2 path really
    // depends on, which is asserted immediately below rather than assumed.
    fs.writeFileSync(path.join(root, '.sneakoscope', 'wiki', 'context-graph.json'), '{ truncated');
    assert.equal((await contextGraphFreshnessPreflight(root)).usable, true,
      'the retired JSON store is not an input to the verdict');

    fs.writeFileSync(path.join(root, '.sneakoscope', 'wiki', 'context-graph.meta.json'), '{ truncated');
    const before = fingerprint(root);
    const corrupt = await contextGraphFreshnessPreflight(root);
    assert.equal(corrupt.status, 'corrupt');
    assert.equal(corrupt.usable, false);
    assert.equal(corrupt.error_code, 'context_graph_corrupt');
    const note = contextGraphFreshnessNoteFor(corrupt);
    assert.ok(note);
    assert.ok(note.includes('context_graph_corrupt'));
    assert.ok(note.includes(CONTEXT_GRAPH_REPAIR_COMMAND));
    assert.deepEqual(fingerprint(root), before, 'a corrupt graph must not be repaired behind the caller');
  } finally {
    cleanup(root);
  }
});

test('an absent meta is never quietly fresh', async () => {
  const root = workspace();
  try {
    await buildGraph(root);
    fs.rmSync(path.join(root, '.sneakoscope', 'wiki', 'context-graph.meta.json'), { force: true });

    // No meta and no published v2 generation: there is no index for a verdict
    // to be about, so `missing` is the honest answer and `sks align run` is the
    // repair either way. The other half of the distinction — an absent meta
    // *with* a published pointer, which is `corrupt`/`meta_mismatch` — is
    // covered in `store/__tests__/index-freshness.test.ts`.
    const preflight = await contextGraphFreshnessPreflight(root);
    assert.equal(preflight.status, 'missing');
    assert.equal(preflight.usable, false);
    assert.equal(preflight.error_code, 'context_graph_missing');
    const note = contextGraphFreshnessNoteFor(preflight);
    assert.ok(note?.includes(CONTEXT_GRAPH_REPAIR_COMMAND), 'a missing graph still names its repair');
  } finally {
    cleanup(root);
  }
});
