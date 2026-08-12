/**
 * Operation fault fixtures: crash a publish at each journal phase and measure
 * what a reader could observe afterwards.
 *
 * The store lane covers the phase algebra in its own tests. This is the
 * end-to-end version: the crash is constructed on disk exactly as a killed
 * process would leave it, and every assertion afterwards is made against
 * `publishContextIndexGeneration` — the compiler's publish entry point — and
 * against the pointer file's bytes, never against a store internal. That
 * boundary is the point. A store test can prove `planContextOperationRecovery`
 * returns the right verdict; only this can prove that a workspace whose compiler
 * died mid-publish still answers from the generation it had, and that the next
 * compile is not wedged.
 *
 * Three invariants are measured per phase, and the third is the one a store
 * test structurally cannot reach:
 *
 * 1. **Fail-closed while in flight.** A second publish started over an
 *    unrecovered operation is refused with `context_index_commit_blocked`, not
 *    allowed to race.
 * 2. **The previous pointer is byte-identical.** Not "equivalent", not "parses
 *    to the same fields" — the same bytes. `current.json` is the only file a
 *    reader consults to find the current generation, so anything short of byte
 *    equality is a generation a reader could resolve differently.
 * 3. **The store is usable again after recovery.** Fail-closed is only half the
 *    contract: an operation that refuses forever is also fail-closed, and it is
 *    still a broken workspace.
 *
 * The phases split at the pointer replace. Before it, the pointer must not have
 * moved; at `committed` and after, the pointer legitimately names the new
 * generation and recovery must *not* roll it back — a recovery that undid a
 * committed pointer would be losing durable work in the name of tidiness.
 */
import fsp from 'node:fs/promises';
import type { ContextGraphSnapshot } from '../contracts.js';
import {
  CONTEXT_INDEX_CONFIG_FINGERPRINT,
  CONTEXT_INDEX_CONFIG_HASH,
  publishContextIndexGeneration,
} from '../compiler/publish-index.js';
import { encodeContextIndex } from '../runtime-index/writer.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../query/ranking-config.js';
import { openContextIndex } from '../runtime-index/reader.js';
import {
  advanceContextIndexOperation,
  beginContextIndexOperation,
  commitContextIndexGeneration,
  stageContextIndexGeneration,
} from '../store/generation-commit.js';
import { ContextIndexStoreError } from '../store/generation-errors.js';
import { contextIndexOperationJournalPath, contextIndexPointerPath } from '../store/generation-layout.js';
import { readContextIndexPointer } from '../store/generation-pointer.js';
import { recoverContextIndexOperation } from '../store/generation-recovery.js';
import { cleanContextIndexOperation } from '../store/generation-retention.js';
import {
  CONTEXT_OPERATION_PHASES,
  type ContextOperationPhase,
  type ContextOperationRecoveryAction,
  type ContextOperationRecoveryReason,
} from '../store/operation-journal.js';

/** Phases at or after which the pointer has legitimately moved. */
const POINTER_ADVANCED_PHASES: ReadonlySet<ContextOperationPhase> = new Set(['committed', 'cleaned']);

export type Crk2PointerExpectation = 'previous' | 'advanced';

export interface Crk2FaultOutcome {
  readonly phase: ContextOperationPhase;
  readonly pointerExpectation: Crk2PointerExpectation;
  /** A publish started over the unrecovered operation was refused. */
  readonly concurrentPublishRefused: boolean;
  /** Store code of that refusal; `null` when it was not refused. */
  readonly concurrentPublishCode: string | null;
  /** Public code a caller would report. Must be a commit blocker, never a reader error. */
  readonly concurrentPublishPublicCode: string | null;
  /** `current.json` bytes after the crash, before recovery, against the expectation. */
  readonly pointerIdenticalAfterCrash: boolean;
  /** `current.json` bytes after recovery, against the same expectation. */
  readonly pointerIdenticalAfterRecovery: boolean;
  readonly recoveryAction: ContextOperationRecoveryAction;
  readonly recoveryReason: ContextOperationRecoveryReason;
  /** The generation the pointer names still opens and still answers. */
  readonly readableAfterRecovery: boolean;
  /** A fresh publish succeeded after recovery, so the store is not wedged. */
  readonly publishableAfterRecovery: boolean;
  /** The journal is gone or resolved; no operation is left in flight. */
  readonly journalCleared: boolean;
  readonly failClosed: boolean;
}

export interface Crk2FaultReport {
  readonly phases: number;
  readonly outcomes: readonly Crk2FaultOutcome[];
  readonly failures: readonly string[];
  readonly ok: boolean;
}

export interface Crk2FaultSnapshots {
  /** Generation A: published successfully before any crash. */
  readonly base: ContextGraphSnapshot;
  /** Generation B: the one whose publish is killed. Must differ in `snapshotHash`. */
  readonly next: ContextGraphSnapshot;
  /** Generation C: published after recovery, to prove the store is usable. */
  readonly recovery: ContextGraphSnapshot;
}

function encode(snapshot: ContextGraphSnapshot): Uint8Array {
  return encodeContextIndex({
    snapshot,
    configHash: CONTEXT_INDEX_CONFIG_HASH,
    schemaRevision: 1,
    lexicon: CONTEXT_GRAPH_LEXICON_CONFIG,
  }).bytes;
}

async function pointerBytes(root: string): Promise<Uint8Array | null> {
  return fsp.readFile(contextIndexPointerPath(root)).then((buffer) => new Uint8Array(buffer)).catch(() => null);
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function journalPresent(root: string): Promise<boolean> {
  return fsp.stat(contextIndexOperationJournalPath(root)).then(() => true).catch(() => false);
}

/**
 * Drive a publish up to `phase` and stop, leaving the store exactly as a killed
 * process would.
 *
 * `extracted` and `merged` are compile-side phases the publish path never
 * writes; they are advanced explicitly so the fixture covers a journal a
 * *compile driver* could have left behind, which is the state recovery would
 * otherwise never be asked about.
 */
async function crashAt(
  root: string,
  snapshot: ContextGraphSnapshot,
  sourceFingerprint: string,
  phase: ContextOperationPhase,
  now: string
): Promise<void> {
  const journal = await beginContextIndexOperation(root, {
    targetSnapshotHash: snapshot.snapshotHash,
    configFingerprint: CONTEXT_INDEX_CONFIG_FINGERPRINT,
    sourceFingerprint,
    fragmentManifestHash: null,
    now,
  });
  if (phase === 'prepared') return;

  if (phase === 'extracted' || phase === 'merged') {
    await advanceContextIndexOperation(root, journal, phase);
    return;
  }

  const staged = await stageContextIndexGeneration(root, journal, encode(snapshot));
  if (phase === 'indexed') return;

  const commit = await commitContextIndexGeneration(root, staged, {
    lint: { passed: true, errorCount: 0, warningCount: 0 },
    now,
  });
  if (phase === 'committed') return;

  // `cleaned` is the window between the retention sweep writing the phase and
  // the journal file being removed. `cleanContextIndexOperation` closes both in
  // one call, so the state is rebuilt by advancing and stopping.
  await advanceContextIndexOperation(root, commit.journal, 'cleaned');
}

async function readable(root: string): Promise<boolean> {
  try {
    const pointer = await readContextIndexPointer(root);
    if (!pointer) return false;
    const bytes = await fsp.readFile(`${root}/${pointer.generationPath}`);
    const reader = openContextIndex(new Uint8Array(bytes));
    return reader.nodeCount > 0;
  } catch {
    return false;
  }
}

async function attemptConcurrentPublish(
  root: string,
  snapshot: ContextGraphSnapshot,
  sourceFingerprint: string,
  now: string
): Promise<{ refused: boolean; code: string | null; publicCode: string | null }> {
  try {
    await publishContextIndexGeneration({ root, snapshot, sourceFingerprint, now });
    return { refused: false, code: null, publicCode: null };
  } catch (error: unknown) {
    if (error instanceof ContextIndexStoreError) {
      return { refused: true, code: error.code, publicCode: error.publicCode };
    }
    return { refused: true, code: 'untyped', publicCode: null };
  }
}

/**
 * Run one phase's fixture against a freshly prepared root.
 *
 * The caller supplies a clean root per phase rather than reusing one: a store
 * carrying the residue of the previous phase's crash would make the next phase's
 * "the pointer did not move" trivially true for the wrong reason.
 */
export async function runCrk2OperationFault(
  root: string,
  snapshots: Crk2FaultSnapshots,
  phase: ContextOperationPhase,
  now = '2026-01-01T00:00:00.000Z'
): Promise<Crk2FaultOutcome> {
  // Fingerprints are hex digests by contract; the journal refuses anything else
  // with `hash_malformed`, which is the right refusal and not the one under test.
  const baseFingerprint = 'a1'.repeat(32);
  const nextFingerprint = 'a2'.repeat(32);

  await publishContextIndexGeneration({
    root,
    snapshot: snapshots.base,
    sourceFingerprint: baseFingerprint,
    now,
  });
  const beforeCrash = await pointerBytes(root);

  await crashAt(root, snapshots.next, nextFingerprint, phase, now);
  const advanced = POINTER_ADVANCED_PHASES.has(phase);
  const afterCrash = await pointerBytes(root);
  const expectation: Crk2PointerExpectation = advanced ? 'advanced' : 'previous';
  const pointerIdenticalAfterCrash = advanced
    ? !sameBytes(afterCrash, beforeCrash)
    : sameBytes(afterCrash, beforeCrash);

  const concurrent = await attemptConcurrentPublish(root, snapshots.recovery, 'a3'.repeat(32), now);

  const recovery = await recoverContextIndexOperation(root, {
    targetSnapshotHash: snapshots.next.snapshotHash,
    configFingerprint: CONTEXT_INDEX_CONFIG_FINGERPRINT,
    sourceFingerprint: nextFingerprint,
  });
  if (recovery.journal && (recovery.action === 'finish_commit' || recovery.action === 'resume_index')) {
    await cleanContextIndexOperation(root, recovery.journal);
  }

  const afterRecovery = await pointerBytes(root);
  const pointerIdenticalAfterRecovery = advanced
    ? sameBytes(afterRecovery, afterCrash)
    : sameBytes(afterRecovery, beforeCrash);

  const readableAfterRecovery = await readable(root);
  let publishableAfterRecovery = false;
  try {
    await publishContextIndexGeneration({
      root,
      snapshot: snapshots.recovery,
      sourceFingerprint: 'a4'.repeat(32),
      now,
    });
    publishableAfterRecovery = true;
  } catch {
    publishableAfterRecovery = false;
  }

  const journalCleared = !(await journalPresent(root));
  return {
    phase,
    pointerExpectation: expectation,
    concurrentPublishRefused: concurrent.refused,
    concurrentPublishCode: concurrent.code,
    concurrentPublishPublicCode: concurrent.publicCode,
    pointerIdenticalAfterCrash,
    pointerIdenticalAfterRecovery,
    recoveryAction: recovery.action,
    recoveryReason: recovery.reason,
    readableAfterRecovery,
    publishableAfterRecovery,
    journalCleared,
    failClosed:
      concurrent.refused
      && pointerIdenticalAfterCrash
      && pointerIdenticalAfterRecovery
      && readableAfterRecovery
      && publishableAfterRecovery
      && journalCleared,
  };
}

/** Every phase, each against its own root. `makeRoot` must return an empty directory. */
export async function runCrk2OperationFaults(
  makeRoot: () => Promise<string>,
  snapshots: Crk2FaultSnapshots,
  now?: string
): Promise<Crk2FaultReport> {
  const outcomes: Crk2FaultOutcome[] = [];
  for (const phase of CONTEXT_OPERATION_PHASES) {
    outcomes.push(await runCrk2OperationFault(await makeRoot(), snapshots, phase, now));
  }
  const failures: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.concurrentPublishRefused) failures.push(`${outcome.phase}:concurrent_publish_admitted`);
    if (!outcome.pointerIdenticalAfterCrash) failures.push(`${outcome.phase}:pointer_moved_on_crash`);
    if (!outcome.pointerIdenticalAfterRecovery) failures.push(`${outcome.phase}:pointer_moved_on_recovery`);
    if (!outcome.readableAfterRecovery) failures.push(`${outcome.phase}:generation_unreadable`);
    if (!outcome.publishableAfterRecovery) failures.push(`${outcome.phase}:store_wedged`);
    if (!outcome.journalCleared) failures.push(`${outcome.phase}:journal_survived`);
  }
  return {
    phases: outcomes.length,
    outcomes,
    failures: failures.sort(),
    ok: failures.length === 0,
  };
}
