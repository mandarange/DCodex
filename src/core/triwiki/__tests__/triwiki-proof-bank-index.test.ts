import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createTriWikiProofCard } from '../triwiki-proof-card.js';
import type { TriWikiProofCard, TriWikiProofCardInput } from '../triwiki-proof-card.js';
import { writeTriWikiProofCard } from '../triwiki-proof-bank.js';
import {
  PROOF_INDEX_REL,
  TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
  TRIWIKI_PROOF_INDEX_SCHEMA,
  readTriWikiProofIndex,
  repairTriWikiProofIndex,
  summarizeTriWikiProofBankIndexed,
  triWikiProofIndexPath,
  updateTriWikiProofIndexEntry,
  type TriWikiProofIndexFs
} from '../triwiki-proof-bank-index.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sks-proof-index-'));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function proofCard(overrides: Partial<TriWikiProofCardInput> = {}): TriWikiProofCard {
  return createTriWikiProofCard({
    subject_type: 'gate',
    subject_id: 'gate-alpha',
    cache_key: 'cache-alpha',
    input_hash: 'input-alpha',
    gate_impl_hash: 'impl-alpha',
    package_lock_hash: 'lock-alpha',
    release_gates_hash: 'gates-alpha',
    env_allowlist_hash: 'env-alpha',
    tool_versions: { sks: 'test' },
    fixture_version: 'fixture-1',
    result: 'passed',
    reusable: true,
    evidence: { checked: true },
    ...overrides
  });
}

interface CountingFs {
  calls: { readFileSync: number; statSync: number; readdirSync: number };
  facade: TriWikiProofIndexFs;
}

function countingFs(): CountingFs {
  const calls = { readFileSync: 0, statSync: 0, readdirSync: 0 };
  const facade: TriWikiProofIndexFs = {
    readFileSync: (target) => {
      calls.readFileSync += 1;
      return fs.readFileSync(target);
    },
    statSync: (target) => {
      calls.statSync += 1;
      try {
        return fs.statSync(target);
      } catch {
        return null;
      }
    },
    readdirSync: (target) => {
      calls.readdirSync += 1;
      return fs.readdirSync(target, { withFileTypes: true });
    }
  };
  return { calls, facade };
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('a missing index is reported, not silently rebuilt by a walk', () => {
  const root = workspace();
  try {
    const card = proofCard();
    const file = writeTriWikiProofCard(root, card);

    const counted = countingFs();
    const read = readTriWikiProofIndex(root, { fs: counted.facade });
    assert.equal(read.status, 'index_missing');
    assert.equal(read.ok, false);
    assert.equal(read.entry_count, 0);
    assert.equal(read.repair_entry_point, TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT);
    assert.equal(read.index_path, PROOF_INDEX_REL);

    const summary = summarizeTriWikiProofBankIndexed(root, { fs: counted.facade });
    assert.equal(summary.status, 'index_missing');
    assert.equal(summary.repair_entry_point, TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT);

    const update = updateTriWikiProofIndexEntry(root, card, file, { fs: counted.facade });
    assert.equal(update.ok, false);
    assert.equal(update.status, 'index_missing');
    assert.equal(update.repair_entry_point, TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT);

    assert.equal(counted.calls.readdirSync, 0, 'the normal path must never list a directory');
    assert.equal(fs.existsSync(triWikiProofIndexPath(root)), false, 'refusal must not create a manifest');
  } finally {
    cleanup(root);
  }
});

test('indexed summary answers from the manifest with zero directory reads', () => {
  const root = workspace();
  try {
    const alpha = proofCard();
    const beta = proofCard({ subject_id: 'gate-beta', cache_key: 'cache-beta', reusable: false, result: 'failed' });
    const alphaFile = writeTriWikiProofCard(root, alpha);
    writeTriWikiProofCard(root, beta);
    repairTriWikiProofIndex(root);

    const counted = countingFs();
    const summary = summarizeTriWikiProofBankIndexed(root, { fs: counted.facade });
    assert.equal(summary.status, 'ok');
    assert.equal(summary.proof_count, 2);
    assert.equal(summary.reusable_count, 1);
    assert.equal(summary.invalidated_count, 1);
    assert.equal(summary.indeterminate_count, 0);
    assert.equal(summary.missing_card_count, null);
    assert.equal(counted.calls.readdirSync, 0, 'index-first summary must not walk');
    assert.equal(counted.calls.readFileSync, 1, 'index-first summary reads only the manifest');

    const presence = summarizeTriWikiProofBankIndexed(root, { fs: counted.facade, verifyPresence: true });
    assert.equal(presence.missing_card_count, 0);
    assert.equal(counted.calls.readdirSync, 0, 'presence checks stat, never readdir');

    const read = readTriWikiProofIndex(root);
    const entry = read.entries.find((row) => row.subject_id === 'gate-alpha');
    assert.ok(entry, 'alpha must be indexed');
    assert.equal(entry.path, `${PROOF_INDEX_REL.replace('/index.json', '')}/gates/gate-alpha/${alpha.proof_id}.json`);
    assert.equal(entry.hash, sha256File(alphaFile), 'hash must be the real content hash of the card bytes');
    assert.equal(entry.result, 'passed');
    assert.equal(entry.schema_class, 'current');
    assert.equal(path.isAbsolute(entry.path), false);
    assert.equal(entry.path.includes('\\'), false);
  } finally {
    cleanup(root);
  }
});

test('a corrupt manifest demands explicit repair and never degrades to a walk', () => {
  const root = workspace();
  try {
    const card = proofCard();
    const file = writeTriWikiProofCard(root, card);
    repairTriWikiProofIndex(root);
    const indexFile = triWikiProofIndexPath(root);
    fs.writeFileSync(indexFile, '{ this is not json');

    const counted = countingFs();
    const read = readTriWikiProofIndex(root, { fs: counted.facade });
    assert.equal(read.status, 'index_corrupt');
    assert.equal(read.detail, 'proof_index_unparseable');
    assert.equal(read.entry_count, 0);

    const summary = summarizeTriWikiProofBankIndexed(root, { fs: counted.facade });
    assert.equal(summary.status, 'index_corrupt');
    assert.equal(summary.proof_count, 0);

    const refused = updateTriWikiProofIndexEntry(root, card, file, { fs: counted.facade });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'index_corrupt');
    assert.equal(counted.calls.readdirSync, 0, 'refusal must not walk');
    assert.equal(fs.readFileSync(indexFile, 'utf8'), '{ this is not json', 'refusal must leave the manifest untouched');

    const repaired = repairTriWikiProofIndex(root);
    assert.equal(repaired.previous_status, 'index_corrupt');
    assert.equal(repaired.indexed_count, 1);
    assert.equal(readTriWikiProofIndex(root).status, 'ok');

    fs.writeFileSync(indexFile, `${JSON.stringify({ schema: 'sks.other.v1', proofs: [] }, null, 2)}\n`);
    assert.equal(readTriWikiProofIndex(root).detail, 'proof_index_schema_mismatch');
    fs.writeFileSync(indexFile, `${JSON.stringify({ schema: TRIWIKI_PROOF_INDEX_SCHEMA, proofs: [{ proof_id: 'p' }] }, null, 2)}\n`);
    assert.equal(readTriWikiProofIndex(root).detail, 'proof_index_entry_incomplete:0');
  } finally {
    cleanup(root);
  }
});

test('repair rebuilds from disk, counts corrupt cards and skips bookkeeping files', () => {
  const root = workspace();
  try {
    const cards = [
      proofCard(),
      proofCard({ subject_id: 'gate-beta', cache_key: 'cache-beta' }),
      proofCard({ subject_type: 'module', subject_id: 'module-gamma', cache_key: 'cache-gamma' })
    ];
    for (const card of cards) writeTriWikiProofCard(root, card);
    const bankDir = path.join(root, '.sneakoscope', 'triwiki', 'proof-bank');
    fs.mkdirSync(path.join(bankDir, 'gates', 'gate-broken'), { recursive: true });
    fs.writeFileSync(path.join(bankDir, 'gates', 'gate-broken', 'proof-broken.json'), '{"not":"a proof card"}');
    fs.writeFileSync(path.join(bankDir, 'gates', 'gate-alpha', 'stale.corrupt-1.json'), 'garbage');
    fs.mkdirSync(path.join(bankDir, '.locks', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(bankDir, '.locks', 'gates', 'ignored.json'), '{}');

    const counted = countingFs();
    const result = repairTriWikiProofIndex(root, { fs: counted.facade });
    assert.equal(result.ok, true);
    assert.equal(result.indexed_count, 3);
    assert.equal(result.corrupt_card_count, 1);
    assert.ok(counted.calls.readdirSync > 0, 'repair is the one place that walks');

    const read = readTriWikiProofIndex(root);
    assert.equal(read.status, 'ok');
    assert.deepEqual(
      read.entries.map((entry) => entry.subject_id),
      ['gate-alpha', 'gate-beta', 'module-gamma']
    );
    assert.deepEqual([...read.entries].sort((left, right) => (left.path < right.path ? -1 : 1)).map((row) => row.path), read.entries.map((row) => row.path));
    for (const entry of read.entries) {
      assert.match(entry.hash, /^[0-9a-f]{64}$/);
      assert.equal(entry.path.startsWith('.sneakoscope/triwiki/proof-bank/'), true);
    }
  } finally {
    cleanup(root);
  }
});

test('an invalidated card replaces its own entry instead of adding one', () => {
  const root = workspace();
  try {
    const card = proofCard();
    const file = writeTriWikiProofCard(root, card);
    const bootstrapped = updateTriWikiProofIndexEntry(root, card, file, { bootstrap: 'repair' });
    assert.equal(bootstrapped.ok, true);
    assert.equal(bootstrapped.bootstrapped, true);
    assert.equal(bootstrapped.entry_count, 1);
    const originalHash = bootstrapped.entry?.hash;
    assert.ok(originalHash);

    const invalidated: TriWikiProofCard = { ...card, reusable: false, invalidation_reasons: ['gate_impl_changed'] };
    fs.writeFileSync(file, `${JSON.stringify(invalidated, null, 2)}\n`);
    const update = updateTriWikiProofIndexEntry(root, invalidated, file);
    assert.equal(update.ok, true);
    assert.equal(update.bootstrapped, false);
    assert.equal(update.entry_count, 1, 'the same card must not produce a second row');
    assert.equal(update.entry?.reusable, false);
    assert.deepEqual(update.entry?.invalidation_reasons, ['gate_impl_changed']);
    assert.notEqual(update.entry?.hash, originalHash, 'the hash must follow the new bytes');
    assert.equal(update.entry?.hash, sha256File(file));

    const summary = summarizeTriWikiProofBankIndexed(root);
    assert.equal(summary.proof_count, 1);
    assert.equal(summary.reusable_count, 0);
    assert.equal(summary.invalidated_count, 1);
  } finally {
    cleanup(root);
  }
});

test('a proof path outside the bank is refused', () => {
  const root = workspace();
  try {
    const card = proofCard();
    writeTriWikiProofCard(root, card);
    repairTriWikiProofIndex(root);
    const outside = path.join(root, 'elsewhere.json');
    fs.writeFileSync(outside, `${JSON.stringify(card, null, 2)}\n`);
    const update = updateTriWikiProofIndexEntry(root, card, outside);
    assert.equal(update.ok, false);
    assert.equal(update.status, 'path_outside_proof_bank');
    assert.equal(update.entry, null);
    assert.equal(readTriWikiProofIndex(root).entry_count, 1);
  } finally {
    cleanup(root);
  }
});

test('concurrent writers do not corrupt or lose manifest rows', async () => {
  const root = workspace();
  try {
    const seed = proofCard({ subject_id: 'gate-seed', cache_key: 'cache-seed' });
    writeTriWikiProofCard(root, seed);
    repairTriWikiProofIndex(root);

    const driver = path.join(root, 'update-driver.mjs');
    fs.writeFileSync(
      driver,
      [
        "import fs from 'node:fs';",
        'const [, , moduleUrl, root, file] = process.argv;',
        'const mod = await import(moduleUrl);',
        "const card = JSON.parse(fs.readFileSync(file, 'utf8'));",
        'const result = mod.updateTriWikiProofIndexEntry(root, card, file);',
        'process.exit(result.ok ? 0 : 3);',
        ''
      ].join('\n')
    );
    const moduleUrl = new URL('../triwiki-proof-bank-index.js', import.meta.url).href;
    const files = [0, 1, 2, 3].map((index) =>
      writeTriWikiProofCard(root, proofCard({ subject_id: `gate-worker-${index}`, cache_key: `cache-worker-${index}` }))
    );
    const codes = await Promise.all(
      files.map(
        (file) =>
          new Promise<number>((resolve, reject) => {
            const child = spawn(process.execPath, [driver, moduleUrl, root, file], { stdio: 'ignore' });
            child.on('error', reject);
            child.on('exit', (code) => resolve(code ?? -1));
          })
      )
    );
    assert.deepEqual(codes, [0, 0, 0, 0], 'every concurrent writer must succeed');

    const read = readTriWikiProofIndex(root);
    assert.equal(read.status, 'ok', 'the manifest must remain parseable after concurrent writes');
    assert.equal(read.entry_count, 5);
    assert.deepEqual(
      read.entries.map((entry) => entry.subject_id).sort(),
      ['gate-seed', 'gate-worker-0', 'gate-worker-1', 'gate-worker-2', 'gate-worker-3']
    );
    const leftovers = fs
      .readdirSync(path.join(root, '.sneakoscope', 'triwiki', 'proof-bank'))
      .filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'atomic writes must not leave temp files behind');
  } finally {
    cleanup(root);
  }
});
