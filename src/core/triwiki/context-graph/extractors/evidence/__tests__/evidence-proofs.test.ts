import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextGraphFragment, ContextGraphNode } from '../../../contracts.js';
import { PROOF_INDEX_REL } from '../index.js';
import {
  OBSERVED_AT,
  edgesOfType,
  hasIssue,
  makeWorkspace,
  proofCard,
  removeWorkspace,
  runExtractor,
  writeProofCard,
  writeProofIndex
} from './fixtures.js';

const FAKE_KEY = 'sk-proj-AAAABBBBCCCCDDDD1234';
const FAKE_HOME_PATH = '/Users/example/.config/sneakoscope/secrets.env';

function proofNode(fragment: ContextGraphFragment, proofId: string): ContextGraphNode {
  const found = fragment.nodes.find((node) => node.kind === 'proof' && node.label === proofId);
  assert.ok(found, `expected a proof node for ${proofId}`);
  return found;
}

test('a healthy proof verifies its gate; the bounded directory scan is reported', async () => {
  const root = makeWorkspace();
  try {
    writeProofCard(root, proofCard());
    const fragment = await runExtractor(root);

    const proof = proofNode(fragment, 'proof-abc123');
    assert.equal(proof.freshness, 'fresh');
    assert.equal(proof.trust, 0.9);
    assert.equal(proof.metadata.discovery, 'scan');
    assert.equal(proof.metadata.reusable, true);
    assert.equal(proof.metadata.schema_class, 'current');
    assert.equal(proof.metadata.evidence_key_count, 1);
    assert.ok(!('checks' in proof.metadata), 'raw evidence payload must never be copied');

    const verified = edgesOfType(fragment, 'verified_by');
    assert.equal(verified.length, 1);
    assert.equal(verified[0]?.from, proof.id);
    assert.equal(verified[0]?.to, 'gate:release-gate-ok');
    assert.equal(verified[0]?.confidence, 'exact');
    assert.equal(verified[0]?.provenance.path, proof.path);
    assert.equal(verified[0]?.observedAt, OBSERVED_AT);
    assert.equal(edgesOfType(fragment, 'invalidates').length, 0);

    assert.ok(fragment.nodes.some((node) => node.kind === 'gate' && node.id === 'gate:release-gate-ok'));
    assert.ok(fragment.nodes.some((node) => node.kind === 'risk_domain' && node.label === 'proof-subject/gate'));
    assert.ok(
      fragment.issues.some((issue) => issue.code === 'extractor_skipped_input' && issue.message.includes('proof index manifest is absent')),
      'the fallback discovery path must be recorded'
    );
  } finally {
    removeWorkspace(root);
  }
});

test('invalidated, expired, and corrupt proofs never produce a strong verified_by edge', async () => {
  const root = makeWorkspace();
  try {
    writeProofCard(
      root,
      proofCard({
        proof_id: 'proof-invalidated',
        subject_id: 'gate-invalidated',
        reusable: false,
        invalidation_reasons: ['gate_impl_changed']
      })
    );
    writeProofCard(
      root,
      proofCard({ proof_id: 'proof-expired', subject_id: 'gate-expired', expires_at: '2025-01-01T00:00:00.000Z' })
    );
    const corruptRel = writeProofCard(root, proofCard({ proof_id: 'proof-corrupt', subject_id: 'gate-corrupt' }));
    fs.writeFileSync(path.join(root, ...corruptRel.split('/')), '{ truncated');

    const fragment = await runExtractor(root);
    assert.equal(edgesOfType(fragment, 'verified_by').length, 0, 'no unhealthy proof may claim verification');

    const invalidated = proofNode(fragment, 'proof-invalidated');
    assert.equal(invalidated.freshness, 'stale');
    assert.equal(invalidated.metadata.reusable, false);
    assert.equal(invalidated.metadata.declared_reusable, false);
    assert.deepEqual(invalidated.metadata.invalidation_reasons, ['gate_impl_changed']);
    assert.equal(invalidated.metadata.health_reason, 'invalidated');
    assert.ok(invalidated.trust <= 0.15);

    const expired = proofNode(fragment, 'proof-expired');
    assert.equal(expired.metadata.expired, true);
    assert.equal(expired.metadata.health_reason, 'expired');
    assert.equal(expired.freshness, 'stale');

    const invalidates = edgesOfType(fragment, 'invalidates');
    assert.equal(invalidates.length, 2);
    assert.ok(invalidates.some((edge) => edge.from === invalidated.id && edge.to === 'gate:gate-invalidated' && edge.confidence === 'manifest'));
    assert.ok(invalidates.some((edge) => edge.from === expired.id && edge.to === 'gate:gate-expired' && edge.confidence === 'observed'));

    const corrupt = fragment.nodes.find((node) => node.kind === 'proof' && node.metadata.corrupt === true);
    assert.ok(corrupt, 'a corrupt proof card must still be represented explicitly');
    assert.equal(corrupt.freshness, 'stale');
    assert.equal(corrupt.metadata.schema_class, 'invalid');
    assert.equal(corrupt.metadata.subject_id, 'unknown');
    assert.equal(
      fragment.edges.filter((edge) => edge.from === corrupt.id && (edge.type === 'verified_by' || edge.type === 'invalidates')).length,
      0,
      'a corrupt card names no trustworthy subject, so it may not point at one'
    );
  } finally {
    removeWorkspace(root);
  }
});

test('a proof card carrying a fake API key and a home path is redacted, and a secret-bearing subject is refused', async () => {
  const root = makeWorkspace();
  try {
    writeProofCard(
      root,
      proofCard({
        proof_id: 'proof-dirty',
        subject_id: 'gate-dirty',
        reusable: false,
        invalidation_reasons: [`env_leak ${FAKE_KEY}`, `bank ${FAKE_HOME_PATH}`],
        evidence: { transcript: `Authorization: Bearer ${FAKE_KEY}`, home: FAKE_HOME_PATH }
      })
    );
    writeProofCard(root, proofCard({ proof_id: 'proof-hostile', subject_id: `gate-${FAKE_KEY}` }), 'gates', 'gate-hostile');

    const fragment = await runExtractor(root);
    const serialized = JSON.stringify(fragment);
    assert.ok(!serialized.includes(FAKE_KEY), 'no fake API key may reach the fragment');
    assert.ok(!serialized.includes('/Users/example'), 'no absolute home path may reach the fragment');
    assert.ok(!serialized.includes('Bearer '), 'no bearer token may reach the fragment');

    const dirty = proofNode(fragment, 'proof-dirty');
    assert.equal(dirty.metadata.redacted, true);
    assert.ok(Number(dirty.metadata.redacted_field_count) >= 1);
    assert.equal(dirty.metadata.invalidation_reason_count, 2);

    assert.ok(
      fragment.issues.some((issue) => issue.code === 'secret_like_value' && issue.severity === 'error'),
      'a secret-bearing node identity must be refused with a lint error'
    );
    assert.equal(fragment.nodes.filter((node) => node.kind === 'gate' && node.id.includes('sk-proj')).length, 0);
    for (const edge of fragment.edges) {
      assert.ok(fragment.nodes.some((node) => node.id === edge.to), `edge ${edge.id} must not dangle after refusal`);
    }
  } finally {
    removeWorkspace(root);
  }
});

test('the proof index manifest is preferred over a directory scan and marks its edges as declared', async () => {
  const root = makeWorkspace();
  try {
    const healthyRel = writeProofCard(root, proofCard({ proof_id: 'proof-indexed', subject_id: 'gate-indexed' }));
    const staleRel = writeProofCard(root, proofCard({ proof_id: 'proof-indexed-stale', subject_id: 'gate-indexed-stale' }));
    writeProofIndex(root, [
      {
        proof_id: 'proof-indexed',
        subject_type: 'gate',
        subject_id: 'gate-indexed',
        cache_key: 'cache-key-indexed',
        reusable: true,
        expires_at: null,
        path: healthyRel,
        hash: 'a'.repeat(64),
        invalidation_reasons: []
      },
      {
        proof_id: 'proof-indexed-stale',
        subject_type: 'gate',
        subject_id: 'gate-indexed-stale',
        cache_key: 'cache-key-stale',
        reusable: false,
        expires_at: null,
        path: staleRel,
        hash: 'b'.repeat(64),
        invalidation_reasons: ['package_lock_changed']
      }
    ]);

    const fragment = await runExtractor(root);
    assert.deepEqual(Object.keys(fragment.inputHashes), [PROOF_INDEX_REL], 'index mode must not read proof cards');
    assert.ok(!hasIssue(fragment, 'extractor_skipped_input') || !fragment.issues.some((issue) => issue.message.includes('fell back')));

    const indexed = proofNode(fragment, 'proof-indexed');
    assert.equal(indexed.metadata.discovery, 'index');
    assert.equal(indexed.metadata.schema_class, 'unread');
    assert.equal(indexed.metadata.card_present, true);
    assert.equal(indexed.contentHash, 'a'.repeat(64));

    const verified = edgesOfType(fragment, 'verified_by');
    assert.equal(verified.length, 1);
    assert.equal(verified[0]?.confidence, 'manifest', 'a declared hash is manifest evidence, never exact');
    assert.equal(verified[0]?.to, 'gate:gate-indexed');

    const stale = proofNode(fragment, 'proof-indexed-stale');
    assert.equal(stale.freshness, 'stale');
    assert.deepEqual(stale.metadata.invalidation_reasons, ['package_lock_changed']);
    assert.equal(edgesOfType(fragment, 'invalidates').length, 1);
  } finally {
    removeWorkspace(root);
  }
});

test('hash-pinned release inputs become derived_from edges only when the file really exists', async () => {
  const root = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeProofCard(root, proofCard({ proof_id: 'proof-inputs', subject_id: 'gate-inputs' }));

    const fragment = await runExtractor(root);
    const derived = edgesOfType(fragment, 'derived_from');
    assert.equal(derived.length, 1, 'release-gates.v2.json is absent so only the lockfile may be linked');
    assert.equal(derived[0]?.to, 'file:package-lock.json');
    assert.equal(derived[0]?.confidence, 'manifest');
    assert.equal(derived[0]?.provenance.path, proofNode(fragment, 'proof-inputs').path);

    const lockNode = fragment.nodes.find((node) => node.id === 'file:package-lock.json');
    assert.ok(lockNode);
    assert.equal(lockNode.kind, 'file');
    assert.equal(lockNode.metadata.evidence_stub, true);
  } finally {
    removeWorkspace(root);
  }
});

test('proof extraction is deterministic across repeated runs', async () => {
  const root = makeWorkspace();
  try {
    writeProofCard(root, proofCard({ proof_id: 'proof-b', subject_id: 'gate-b' }));
    writeProofCard(root, proofCard({ proof_id: 'proof-a', subject_id: 'gate-a', reusable: false, invalidation_reasons: ['x'] }));
    writeProofCard(root, proofCard({ proof_id: 'proof-c', subject_id: 'module-c', subject_type: 'module' }), 'modules');

    const first = await runExtractor(root);
    const second = await runExtractor(root);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.ok(first.nodes.some((node) => node.kind === 'module' && node.id === 'module:module-c'));
    assert.deepEqual(
      [...first.nodes].map((node) => node.id),
      [...first.nodes].map((node) => node.id).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    );
  } finally {
    removeWorkspace(root);
  }
});
