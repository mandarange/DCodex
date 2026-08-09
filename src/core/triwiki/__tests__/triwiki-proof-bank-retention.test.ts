import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTriWikiProofCard } from '../triwiki-proof-card.js';
import {
  proofCardsPerSubjectLimit,
  readReusableTriWikiProofCard,
  triWikiProofBankDir,
  writeTriWikiProofCard
} from '../triwiki-proof-bank.js';
import { readTriWikiProofIndex, serializeTriWikiProofIndexDocument } from '../triwiki-proof-bank-index.js';

test('a subject keeps only its newest proof generations, manifest included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-proof-retention-'));
  try {
    fs.mkdirSync(path.join(root, '.sneakoscope', 'triwiki', 'proof-bank'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sneakoscope', 'triwiki', 'proof-bank', 'index.json'), serializeTriWikiProofIndexDocument([]));
    const limit = proofCardsPerSubjectLimit();
    const generations = limit + 8;
    for (let index = 0; index < generations; index += 1) {
      writeTriWikiProofCard(root, card(`key-${index}`));
    }

    const dir = path.join(triWikiProofBankDir(root), 'gates', 'typecheck');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, limit, `expected ${limit} retained cards, saw ${files.length}`);

    // Retention must never leave the manifest describing cards that are gone:
    // the manifest exists so nothing walks the bank, and dead rows would make
    // every reader pay for proofs that cannot be reused.
    const index = readTriWikiProofIndex(root);
    assert.equal(index.ok, true, index.detail || '');
    assert.equal(index.entry_count, limit);
    for (const entry of index.entries) {
      assert.equal(fs.existsSync(path.join(root, entry.path)), true, `manifest row without a card: ${entry.path}`);
    }

    // The newest generation still reuses, and a retired one simply misses.
    const newest = readReusableTriWikiProofCard({ root, subjectId: 'typecheck', cacheKey: `key-${generations - 1}` });
    assert.equal(newest.hit, true, newest.invalidation_reasons.join(','));
    const retired = readReusableTriWikiProofCard({ root, subjectId: 'typecheck', cacheKey: 'key-0' });
    assert.equal(retired.hit, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function card(cacheKey: string) {
  return createTriWikiProofCard({
    subject_type: 'gate',
    subject_id: 'typecheck',
    cache_key: cacheKey,
    input_hash: 'a'.repeat(64),
    implementation_hash: 'b'.repeat(64),
    gate_impl_hash: 'b'.repeat(64),
    package_lock_hash: 'c'.repeat(64),
    release_gates_hash: 'd'.repeat(64),
    env_allowlist_hash: 'e'.repeat(64),
    tool_versions: { node: process.version },
    tool_version: process.version,
    fixture_version: 'sks-test',
    result: 'passed',
    reusable: true,
    duration_ms: 1,
    evidence: { command: 'tsc --noEmit' },
    invalidation_reasons: []
  });
}
