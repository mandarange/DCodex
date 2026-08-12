import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContextGraphSnapshot } from '../../contracts.js';
import { CONTEXT_OPERATION_PHASES } from '../../store/operation-journal.js';
import { CONTEXT_INDEX_COMMIT_BLOCKED } from '../../store/generation-errors.js';
import { fuzzBaseSnapshot } from '../crk2-fuzz-index.js';
import { runCrk2OperationFaults, type Crk2FaultSnapshots } from '../crk2-fault-operations.js';

/**
 * Every root is an `fsp.mkdtemp` under `os.tmpdir()` and is removed in a
 * `finally`. Nothing here reads or writes the real `$HOME`: the generation store
 * resolves entirely from the root it is handed.
 */

const ROOTS: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-crk2-fault-'));
  ROOTS.push(root);
  return root;
}

/** Three generations that differ in content, so their snapshot hashes differ. */
function snapshots(): Crk2FaultSnapshots {
  const base = fuzzBaseSnapshot();
  const variant = (suffix: string, hash: string): ContextGraphSnapshot => ({
    ...base,
    snapshotHash: hash,
    nodes: base.nodes.map((node, index) => (index === 0 ? { ...node, contentHash: `sha256:${suffix}` } : node)),
  });
  return {
    base,
    next: variant('next', 'b0'.repeat(32)),
    recovery: variant('recovery', 'c0'.repeat(32)),
  };
}

test('a compile killed at any journal phase leaves the previous pointer byte-identical', async (t) => {
  t.after(async () => {
    for (const root of ROOTS.splice(0)) await fsp.rm(root, { recursive: true, force: true });
  });

  const report = await runCrk2OperationFaults(makeRoot, snapshots());
  assert.equal(report.phases, CONTEXT_OPERATION_PHASES.length, 'every declared phase gets a fixture');
  assert.deepEqual(report.failures, [], 'fail-closed recovery is the floor, not the goal');
  assert.equal(report.ok, true);

  for (const outcome of report.outcomes) {
    // A refusal to publish is a compile-side blocker. Reporting it as a reader
    // error would tell a user to rebuild an index that is intact and serving.
    assert.equal(
      outcome.concurrentPublishPublicCode,
      CONTEXT_INDEX_COMMIT_BLOCKED,
      `${outcome.phase}: an in-flight operation must block a publish, not a read`
    );
    assert.equal(outcome.concurrentPublishCode, 'operation_in_flight', `${outcome.phase}: wrong blocker`);
  }
});

test('the pointer moves at the commit boundary and recovery never rolls it back', async (t) => {
  t.after(async () => {
    for (const root of ROOTS.splice(0)) await fsp.rm(root, { recursive: true, force: true });
  });

  const report = await runCrk2OperationFaults(makeRoot, snapshots());
  const byPhase = new Map(report.outcomes.map((outcome) => [outcome.phase, outcome]));

  for (const phase of ['prepared', 'extracted', 'merged', 'indexed'] as const) {
    assert.equal(byPhase.get(phase)?.pointerExpectation, 'previous', `${phase} is before the pointer replace`);
  }
  // A recovery that undid a committed pointer would be discarding durable work
  // in the name of tidying up, which is worse than the crash it is recovering.
  for (const phase of ['committed', 'cleaned'] as const) {
    assert.equal(byPhase.get(phase)?.pointerExpectation, 'advanced', `${phase} is at or after the pointer replace`);
  }

  assert.equal(byPhase.get('indexed')?.recoveryAction, 'resume_index', 'a verified temp index is a resume candidate');
  assert.equal(byPhase.get('indexed')?.recoveryReason, 'resume_candidate');
  assert.equal(byPhase.get('committed')?.recoveryAction, 'finish_commit');
  assert.equal(byPhase.get('cleaned')?.recoveryAction, 'clear_journal');
  for (const phase of ['prepared', 'extracted', 'merged'] as const) {
    assert.equal(byPhase.get(phase)?.recoveryAction, 'discard_temp', `${phase} has no index to resume`);
    assert.equal(byPhase.get(phase)?.recoveryReason, 'phase_not_resumable');
  }
});

test('a crashed workspace still answers, and still accepts the next compile', async (t) => {
  t.after(async () => {
    for (const root of ROOTS.splice(0)) await fsp.rm(root, { recursive: true, force: true });
  });

  const report = await runCrk2OperationFaults(makeRoot, snapshots());
  for (const outcome of report.outcomes) {
    // Fail-closed is only half the contract. An operation that refuses forever
    // is also fail-closed, and it is still a broken workspace.
    assert.equal(outcome.readableAfterRecovery, true, `${outcome.phase}: the pointed generation no longer opens`);
    assert.equal(outcome.publishableAfterRecovery, true, `${outcome.phase}: the store is wedged after recovery`);
    assert.equal(outcome.journalCleared, true, `${outcome.phase}: an operation was left in flight`);
  }
});
