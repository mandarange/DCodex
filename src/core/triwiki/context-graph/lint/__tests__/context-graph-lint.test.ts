import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import type { ContextGraphEdge, ContextGraphLintIssue, ContextGraphNode, ContextGraphSnapshot } from '../../contracts.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { contextGraphNodeId } from '../../ids.js';
import { runContextGraphLint } from '../index.js';
import {
  edgeBetween,
  fileNode,
  makeFixtureRoot,
  plainNode,
  removeFixtureRoot,
  writeFixtureFile
} from '../../compiler/__tests__/graph-test-fixtures.js';

const A_HASH = sha256('a');
const B_HASH = sha256('b');

function snapshotOf(nodes: readonly ContextGraphNode[], edges: readonly ContextGraphEdge[]): ContextGraphSnapshot {
  return buildContextGraphSnapshot({ nodes, edges, cycles: [], extractors: [] });
}

function codes(issues: readonly ContextGraphLintIssue[]): string[] {
  return [...new Set(issues.map((issue) => issue.code))].sort();
}

function pair(): { a: ContextGraphNode; b: ContextGraphNode } {
  return { a: fileNode('src/a.ts', A_HASH), b: fileNode('src/b.ts', B_HASH) };
}

test('a well-formed snapshot passes lint with no errors', () => {
  const root = makeFixtureRoot('cgl-clean');
  try {
    const { a, b } = pair();
    const snapshot = snapshotOf([a, b], [edgeBetween(a.id, b.id, { path: 'src/a.ts', hash: A_HASH })]);
    const result = runContextGraphLint({ root, snapshot, env: {} });
    assert.equal(result.ok, true, codes(result.errors).join(','));
    assert.equal(result.errorCount, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a dangling edge and an edge without provenance are both hard errors', () => {
  const root = makeFixtureRoot('cgl-edges');
  try {
    const { a, b } = pair();
    const dangling = edgeBetween(a.id, 'file:src/missing.ts', { path: 'src/a.ts', hash: A_HASH });
    const unprovenanced = edgeBetween(a.id, b.id, { type: 'references', path: 'src/a.ts', hash: A_HASH });
    const stripped: ContextGraphEdge = {
      ...unprovenanced,
      provenance: { ...unprovenanced.provenance, path: '', hash: '' }
    };
    const result = runContextGraphLint({ root, snapshot: snapshotOf([a, b], [dangling, stripped]), env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('dangling_edge'), codes(result.errors).join(','));
    assert.ok(codes(result.errors).includes('edge_without_provenance'), codes(result.errors).join(','));
  } finally {
    removeFixtureRoot(root);
  }
});

test('an absolute path is a hard error', () => {
  const root = makeFixtureRoot('cgl-abs');
  try {
    const node = fileNode('src/a.ts', A_HASH, { path: '/etc/passwd' });
    const result = runContextGraphLint({ root, snapshot: snapshotOf([node], []), env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('absolute_or_escaping_path'));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a symlink that leaves the workspace is a hard error', () => {
  const root = makeFixtureRoot('cgl-symlink');
  const outside = makeFixtureRoot('cgl-outside');
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
    const node = fileNode('linked.txt', A_HASH);
    const result = runContextGraphLint({ root, snapshot: snapshotOf([node], []), env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('symlink_escape'), codes(result.errors).join(','));
  } finally {
    removeFixtureRoot(root);
    removeFixtureRoot(outside);
  }
});

test('a secret-like value and a raw environment value are both hard errors', () => {
  const root = makeFixtureRoot('cgl-secret');
  try {
    const secretNode = fileNode('src/a.ts', A_HASH, {
      metadata: { note: 'api_key=AKIA1234567890abcdefghijklmn' }
    });
    const secretResult = runContextGraphLint({ root, snapshot: snapshotOf([secretNode], []), env: {} });
    assert.equal(secretResult.ok, false);
    assert.ok(codes(secretResult.errors).includes('secret_like_value'));

    const envValue = 'zzzz-fixture-value-0123456789';
    const envNode = fileNode('src/a.ts', A_HASH, { metadata: { note: `derived from ${envValue}` } });
    const envResult = runContextGraphLint({
      root,
      snapshot: snapshotOf([envNode], []),
      env: { FIXTURE_VALUE: envValue }
    });
    assert.equal(envResult.ok, false);
    assert.ok(codes(envResult.errors).includes('secret_like_value'));
  } finally {
    removeFixtureRoot(root);
  }
});

test('the exact public Codex origin label is not treated as a leaked environment value', () => {
  const root = makeFixtureRoot('cgl-public-origin');
  try {
    const node = fileNode('src/a.ts', A_HASH, {
      metadata: { purpose: 'Codex Desktop integration constants.' }
    });
    const result = runContextGraphLint({
      root,
      snapshot: snapshotOf([node], []),
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }
    });
    assert.equal(result.ok, true, result.errors.map((issue) => issue.message).join(','));

    const arbitraryOverride = runContextGraphLint({
      root,
      snapshot: snapshotOf([node], []),
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop integration constants.' }
    });
    assert.equal(arbitraryOverride.ok, false);
    assert.ok(codes(arbitraryOverride.errors).includes('secret_like_value'));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a duplicate node id is a hard error', () => {
  const root = makeFixtureRoot('cgl-duplicate');
  try {
    const node = fileNode('src/a.ts', A_HASH);
    const snapshot = snapshotOf([node, { ...node, contentHash: B_HASH }], []);
    const result = runContextGraphLint({ root, snapshot, env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('duplicate_node_conflict'));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a cycle among manifest relations is a hard error', () => {
  const root = makeFixtureRoot('cgl-cycle');
  try {
    const first = plainNode('module:first');
    const second = plainNode('module:second');
    const snapshot = snapshotOf(
      [first, second],
      [
        edgeBetween(first.id, second.id, { type: 'depends_on', confidence: 'manifest', path: 'src/a.ts', hash: A_HASH }),
        edgeBetween(second.id, first.id, { type: 'depends_on', confidence: 'manifest', path: 'src/b.ts', hash: B_HASH })
      ]
    );
    const result = runContextGraphLint({ root, snapshot, env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('manifest_dag_cycle'));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a protected gate with no relation to a repository source is a hard error', () => {
  const root = makeFixtureRoot('cgl-gate');
  try {
    const gate = plainNode(contextGraphNodeId({ kind: 'gate', gateId: 'release' }), {
      kind: 'gate',
      risk: 'protected',
      freshness: 'fresh'
    });
    const lonely = runContextGraphLint({ root, snapshot: snapshotOf([gate], []), env: {} });
    assert.equal(lonely.ok, false);
    assert.ok(codes(lonely.errors).includes('protected_gate_without_source_relation'));

    const file = fileNode('src/a.ts', A_HASH);
    const grounded = runContextGraphLint({
      root,
      snapshot: snapshotOf(
        [gate, file],
        [edgeBetween(file.id, gate.id, { type: 'gated_by', confidence: 'manifest', path: 'src/a.ts', hash: A_HASH })]
      ),
      env: {}
    });
    assert.equal(codes(grounded.errors).includes('protected_gate_without_source_relation'), false);
  } finally {
    removeFixtureRoot(root);
  }
});

test('a fresh marking that disagrees with the current source hash is a hard error', () => {
  const root = makeFixtureRoot('cgl-freshness');
  try {
    const onDisk = writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
    const node = fileNode('src/a.ts', A_HASH, { freshness: 'fresh' });
    const result = runContextGraphLint({
      root,
      snapshot: snapshotOf([node], []),
      sourceHashes: { 'src/a.ts': onDisk },
      env: {}
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('freshness_claim_mismatch'), codes(result.errors).join(','));

    const agreeing = runContextGraphLint({
      root,
      snapshot: snapshotOf([fileNode('src/a.ts', onDisk, { freshness: 'fresh' })], []),
      sourceHashes: { 'src/a.ts': onDisk },
      env: {}
    });
    assert.equal(codes(agreeing.errors).includes('freshness_claim_mismatch'), false);
  } finally {
    removeFixtureRoot(root);
  }
});

test('an out-of-order node array is a non-deterministic serialization error', () => {
  const root = makeFixtureRoot('cgl-order');
  try {
    const { a, b } = pair();
    const sorted = snapshotOf([a, b], []);
    const shuffled: ContextGraphSnapshot = { ...sorted, nodes: [...sorted.nodes].reverse() };
    const result = runContextGraphLint({ root, snapshot: shuffled, env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('non_deterministic_serialization'), codes(result.errors).join(','));
  } finally {
    removeFixtureRoot(root);
  }
});

test('a snapshot hash that does not match the canonical serialization is a hard error', () => {
  const root = makeFixtureRoot('cgl-hash');
  try {
    const { a } = pair();
    const snapshot = snapshotOf([a], []);
    const tampered: ContextGraphSnapshot = { ...snapshot, snapshotHash: sha256('not the right hash') };
    const result = runContextGraphLint({ root, snapshot: tampered, env: {} });
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('hash_mismatch'));
  } finally {
    removeFixtureRoot(root);
  }
});

test('an orphan wiki claim and an unknown freshness are warnings, not blockers', () => {
  const root = makeFixtureRoot('cgl-warnings');
  try {
    const claim = plainNode(contextGraphNodeId({ kind: 'wiki_claim', claimHash: sha256('claim') }), {
      kind: 'wiki_claim',
      freshness: 'unknown',
      trust: 0.3
    });
    const result = runContextGraphLint({ root, snapshot: snapshotOf([claim], []), env: {} });
    assert.equal(result.ok, true, codes(result.errors).join(','));
    const warningCodes = codes(result.warnings);
    assert.ok(warningCodes.includes('orphan_wiki_claim'), warningCodes.join(','));
    assert.ok(warningCodes.includes('unknown_freshness'), warningCodes.join(','));
    assert.ok(warningCodes.includes('unreachable_in_profile'), warningCodes.join(','));
  } finally {
    removeFixtureRoot(root);
  }
});
