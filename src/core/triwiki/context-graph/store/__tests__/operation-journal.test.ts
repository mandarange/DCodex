import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_OPERATION_JOURNAL_REPAIR_COMMAND,
  CONTEXT_OPERATION_JOURNAL_SCHEMA,
  CONTEXT_OPERATION_MAX_BLOCKERS,
  CONTEXT_OPERATION_PHASES,
  ContextOperationJournalError,
  advanceContextOperationPhase,
  buildContextOperationJournal,
  contextOperationPhaseRank,
  deriveContextOperationId,
  parseContextOperationJournal,
  planContextOperationRecovery,
  readContextOperationJournalFile,
  recordContextOperationBlockers,
  removeContextOperationJournalFile,
  writeContextOperationJournalFile,
  type ContextOperationJournal,
} from '../operation-journal.js';

/**
 * The journal is the only evidence a crashed compile leaves behind. Everything
 * below is a way it could lie: a phase that walks backwards, a temp path that
 * points outside the workspace, a fingerprint that no longer describes the
 * sources the temp index was built from. Each one, believed, ends with a stale
 * or partial index becoming current.
 */

const BASE = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const CONFIG = 'c'.repeat(32);
const SOURCE = 'd'.repeat(32);
const CHECKSUM = '00112233445566ff';
const TEMP_INDEX = '.sneakoscope/cache/context-graph/operations/0123456789abcdef.idx';
const STARTED_AT = '2026-01-01T00:00:00.000Z';

function journalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseSnapshotHash: BASE,
    targetSnapshotHash: TARGET,
    configFingerprint: CONFIG,
    sourceFingerprint: SOURCE,
    tempIndex: TEMP_INDEX,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}): ContextOperationJournal {
  return buildContextOperationJournal(
    journalInput(overrides) as unknown as Parameters<typeof buildContextOperationJournal>[0],
  );
}

function rejects(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ContextOperationJournalError, `expected journal error, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.publicCode, 'context_operation_journal_corrupt');
    assert.equal(error.repairCommand, CONTEXT_OPERATION_JOURNAL_REPAIR_COMMAND);
    for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
    return true;
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-crk2-journal-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('phase sequence is the contract order and ranks strictly increase', () => {
  assert.deepEqual(
    [...CONTEXT_OPERATION_PHASES],
    ['prepared', 'extracted', 'merged', 'indexed', 'committed', 'cleaned'],
  );
  for (let index = 1; index < CONTEXT_OPERATION_PHASES.length; index += 1) {
    const previous = CONTEXT_OPERATION_PHASES[index - 1] as (typeof CONTEXT_OPERATION_PHASES)[number];
    const current = CONTEXT_OPERATION_PHASES[index] as (typeof CONTEXT_OPERATION_PHASES)[number];
    assert.ok(contextOperationPhaseRank(current) > contextOperationPhaseRank(previous));
  }
});

test('operation id is a digest: deterministic, hex only, and carries no path', () => {
  const identity = {
    baseSnapshotHash: BASE,
    targetSnapshotHash: TARGET,
    configFingerprint: CONFIG,
    sourceFingerprint: SOURCE,
  };
  const first = deriveContextOperationId(identity);
  assert.equal(first, deriveContextOperationId(identity));
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, deriveContextOperationId({ ...identity, sourceFingerprint: 'e'.repeat(32) }));
  assert.notEqual(first, deriveContextOperationId({ ...identity, baseSnapshotHash: null }));
});

test('a built journal starts at prepared with an empty blocker list', () => {
  const journal = build();
  assert.equal(journal.schema, CONTEXT_OPERATION_JOURNAL_SCHEMA);
  assert.equal(journal.phase, 'prepared');
  assert.deepEqual(journal.blockers, []);
  assert.equal(journal.indexChecksum, null);
  assert.equal(journal.operationId, deriveContextOperationId(journal));
});

test('every unsafe temp path shape is refused', () => {
  for (const tempIndex of [
    '/tmp/sks/index.idx',
    '../../etc/passwd',
    '~/Library/Caches/index.idx',
    'C:/Users/x/index.idx',
    '.sneakoscope\\cache\\index.idx',
    '.sneakoscope/cache/../../../index.idx',
    '   ',
  ]) {
    assert.throws(() => build({ tempIndex }), rejects('temp_index_unsafe'), tempIndex);
  }
});

test('hash fields refuse anything that is not a hash', () => {
  assert.throws(() => build({ targetSnapshotHash: 'not-a-hash' }), rejects('hash_malformed'));
  assert.throws(() => build({ targetSnapshotHash: 'abc' }), rejects('hash_malformed'));
  assert.throws(() => build({ targetSnapshotHash: 'A'.repeat(64) }), rejects('hash_malformed'));
  assert.throws(() => build({ configFingerprint: 42 }), rejects('hash_malformed'));
  assert.throws(() => build({ indexChecksum: 'zz' }), rejects('hash_malformed'));
  assert.equal(build({ baseSnapshotHash: null }).baseSnapshotHash, null);
});

test('blockers are machine codes, deduped, and bounded', () => {
  assert.throws(() => build({ blockers: ['lint failed: src/a.ts line 3'] }), rejects('blockers_malformed'));
  assert.throws(() => build({ blockers: 'lint_error' }), rejects('blockers_malformed'));
  assert.throws(
    () => build({ blockers: new Array(CONTEXT_OPERATION_MAX_BLOCKERS + 1).fill('lint_error') }),
    rejects('blockers_malformed'),
  );
  assert.deepEqual(build({ blockers: ['lint_error', 'lint_error'] }).blockers, ['lint_error']);
});

test('startedAt is validated so free text cannot ride in on an informational field', () => {
  assert.throws(() => build({ startedAt: 'right after the failed deploy' }), rejects('timestamp_malformed'));
  assert.throws(() => build({ startedAt: 12345 }), rejects('timestamp_malformed'));
});

test('parse refuses every shape a corrupt journal can take', () => {
  assert.throws(() => parseContextOperationJournal(null), rejects('journal_not_object'));
  assert.throws(() => parseContextOperationJournal([build()]), rejects('journal_not_object'));
  assert.throws(
    () => parseContextOperationJournal({ ...build(), schema: 'sks.context-graph-operation.v1' }),
    rejects('schema_mismatch'),
  );
  assert.throws(() => parseContextOperationJournal({ ...build(), phase: 'finished' }), rejects('phase_unknown'));
  assert.throws(
    () => parseContextOperationJournal({ ...build(), operationId: '../../escape' }),
    rejects('operation_id_malformed'),
  );
  assert.throws(
    () => parseContextOperationJournal({ ...build(), tempIndex: '/var/folders/x/index.idx' }),
    rejects('temp_index_unsafe'),
  );
});

test('a journal only moves forward', () => {
  const indexed = advanceContextOperationPhase(build(), 'indexed', { indexChecksum: CHECKSUM });
  assert.equal(indexed.phase, 'indexed');
  assert.equal(indexed.indexChecksum, CHECKSUM);
  assert.throws(() => advanceContextOperationPhase(indexed, 'indexed'), rejects('phase_regression'));
  assert.throws(() => advanceContextOperationPhase(indexed, 'merged'), rejects('phase_regression'));
  const committed = advanceContextOperationPhase(indexed, 'committed');
  assert.throws(() => advanceContextOperationPhase(committed, 'indexed'), rejects('phase_regression'));
  assert.equal(committed.indexChecksum, CHECKSUM);
});

test('blockers are recorded without moving the phase', () => {
  const blocked = recordContextOperationBlockers(build({ phase: 'merged' }), ['lint_error', 'lint_error']);
  assert.equal(blocked.phase, 'merged');
  assert.deepEqual(blocked.blockers, ['lint_error']);
});

test('recovery planning: nothing in flight means start', () => {
  const plan = planContextOperationRecovery(null, {
    targetSnapshotHash: TARGET,
    configFingerprint: CONFIG,
    sourceFingerprint: SOURCE,
  });
  assert.equal(plan.action, 'start');
  assert.equal(plan.reason, 'no_operation');
});

test('recovery planning: only the indexed phase is a resume candidate', () => {
  const expectation = { targetSnapshotHash: TARGET, configFingerprint: CONFIG, sourceFingerprint: SOURCE };
  for (const phase of ['prepared', 'extracted', 'merged'] as const) {
    const plan = planContextOperationRecovery(build({ phase }), expectation);
    assert.equal(plan.action, 'discard_temp', phase);
    assert.equal(plan.reason, 'phase_not_resumable', phase);
  }
  const resumable = planContextOperationRecovery(
    build({ phase: 'indexed', indexChecksum: CHECKSUM }),
    expectation,
  );
  assert.equal(resumable.action, 'resume_index');
  assert.equal(resumable.reason, 'resume_candidate');
});

test('recovery planning: an indexed journal without a checksum is not resumable', () => {
  const plan = planContextOperationRecovery(build({ phase: 'indexed' }), {
    targetSnapshotHash: TARGET,
    configFingerprint: CONFIG,
    sourceFingerprint: SOURCE,
  });
  assert.equal(plan.action, 'discard_temp');
  assert.equal(plan.reason, 'phase_not_resumable');
});

test('recovery planning: any fingerprint drift discards the temp artifact', () => {
  const indexed = build({ phase: 'indexed', indexChecksum: CHECKSUM });
  const drifts = [
    { targetSnapshotHash: 'e'.repeat(64), configFingerprint: CONFIG, sourceFingerprint: SOURCE },
    { targetSnapshotHash: TARGET, configFingerprint: 'e'.repeat(32), sourceFingerprint: SOURCE },
    { targetSnapshotHash: TARGET, configFingerprint: CONFIG, sourceFingerprint: 'e'.repeat(32) },
  ];
  for (const expectation of drifts) {
    const plan = planContextOperationRecovery(indexed, expectation);
    assert.equal(plan.action, 'discard_temp');
    assert.equal(plan.reason, 'fingerprint_drift');
  }
});

test('recovery planning: a committed operation is finished, never re-decided by fingerprint', () => {
  const committed = build({ phase: 'committed', indexChecksum: CHECKSUM });
  const plan = planContextOperationRecovery(committed, {
    targetSnapshotHash: 'e'.repeat(64),
    configFingerprint: 'e'.repeat(32),
    sourceFingerprint: 'e'.repeat(32),
  });
  assert.equal(plan.action, 'finish_commit');
  assert.equal(plan.reason, 'commit_completed');
});

test('recovery planning: a cleaned journal outlived its operation', () => {
  const plan = planContextOperationRecovery(build({ phase: 'cleaned' }), {
    targetSnapshotHash: TARGET,
    configFingerprint: CONFIG,
    sourceFingerprint: SOURCE,
  });
  assert.equal(plan.action, 'clear_journal');
  assert.equal(plan.reason, 'stale_journal');
});

test('journal file round-trips and an absent file is the only benign absence', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'context-graph-operation.json');
    assert.equal(await readContextOperationJournalFile(journalPath), null);
    const written = await writeContextOperationJournalFile(journalPath, build({ phase: 'merged' }));
    const read = await readContextOperationJournalFile(journalPath);
    assert.deepEqual(read, written);
    await removeContextOperationJournalFile(journalPath);
    assert.equal(await readContextOperationJournalFile(journalPath), null);
  });
});

test('an unparseable journal throws instead of reading as absent', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'context-graph-operation.json');
    await fsp.writeFile(journalPath, '{"schema":"sks.context-graph-operation.v2"', 'utf8');
    await assert.rejects(readContextOperationJournalFile(journalPath), rejects('journal_unreadable'));
    await fsp.writeFile(journalPath, '"a string is not a journal"', 'utf8');
    await assert.rejects(readContextOperationJournalFile(journalPath), rejects('journal_not_object'));
  });
});

test('the write path re-validates, so an unsafe journal never reaches disk', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'context-graph-operation.json');
    const forged = { ...build(), tempIndex: path.join(dir, 'index.idx') } as ContextOperationJournal;
    await assert.rejects(writeContextOperationJournalFile(journalPath, forged), rejects('temp_index_unsafe'));
    assert.equal(await readContextOperationJournalFile(journalPath), null);
  });
});

test('the journal on disk holds no absolute path, no home path, and no temp path', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'context-graph-operation.json');
    await writeContextOperationJournalFile(journalPath, build({ phase: 'indexed', indexChecksum: CHECKSUM }));
    const text = await fsp.readFile(journalPath, 'utf8');
    assert.ok(!text.includes(os.tmpdir()));
    assert.ok(!text.includes(os.homedir()));
    assert.ok(!text.includes(dir));
    assert.ok(!/"[^"]*\/(?:var|tmp|Users|home)\//.test(text));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string') assert.ok(!value.startsWith('/'), value);
    }
  });
});
