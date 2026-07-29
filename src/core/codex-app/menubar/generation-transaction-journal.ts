import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../fsx.js';
import type {
  SksMenuBarGenerationArtifact,
  SksMenuBarGenerationPairOutcome,
  SksMenuBarGenerationPurpose,
  SksMenuBarGenerationTransactionOutcome
} from './types.js';

export { messageOf as errorMessage } from '../../errors/message.js';

export const JOURNAL_SCHEMA = 'sks.menubar-generation-transaction.v1' as const;
const OUTCOME_SCHEMA = 'sks.menubar-generation-transaction-outcome.v1' as const;

type PairMode = 'activate_staged' | 'swap';
export type PairStep =
  | 'pending'
  | 'backup_to_displaced_intent'
  | 'backup_to_displaced_done'
  | 'staged_to_backup_intent'
  | 'staged_to_backup_done'
  | 'active_to_temp_intent'
  | 'active_to_temp_done'
  | 'backup_to_active_intent'
  | 'backup_to_active_done'
  | 'temp_to_backup_intent'
  | 'temp_to_backup_done';

interface GenerationPairPlanState {
  kind: SksMenuBarGenerationArtifact;
  mode: PairMode;
  active: string;
  backup: string;
  staged: string | null;
}

export interface GenerationJournalPair extends GenerationPairPlanState {
  temporary: string;
  displaced: string | null;
  active_initially_present: boolean;
  backup_initially_present: boolean;
  step: PairStep;
}

export interface GenerationJournal {
  schema: typeof JOURNAL_SCHEMA;
  id: string;
  purpose: SksMenuBarGenerationPurpose;
  phase: 'prepared' | 'applying' | 'applied' | 'recovering' | 'committed';
  created_at: string;
  updated_at: string;
  failure_point: string | null;
  failure_pair: SksMenuBarGenerationArtifact | null;
  origin_failure_point: string | null;
  origin_failure_pair: SksMenuBarGenerationArtifact | null;
  error: string | null;
  pairs: GenerationJournalPair[];
}

export async function loadJournal(input: {
  purpose: SksMenuBarGenerationPurpose;
  journalPath: string;
  pairs: GenerationPairPlanState[];
}): Promise<GenerationJournal> {
  const journal = await readJson<GenerationJournal | null>(input.journalPath, null);
  if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.purpose !== input.purpose || !journal.id || journal.pairs.length !== input.pairs.length) {
    throw new Error('generation_transaction_journal_schema_invalid');
  }
  for (let index = 0; index < input.pairs.length; index += 1) {
    const expected = input.pairs[index]!;
    const actual = journal.pairs[index]!;
    const expectedTemporary = `${expected.active}.generation-${journal.id}.temporary`;
    const expectedDisplaced = expected.mode === 'activate_staged' ? `${expected.backup}.generation-${journal.id}.displaced` : null;
    if (actual.kind !== expected.kind || actual.mode !== expected.mode || path.resolve(actual.active) !== path.resolve(expected.active)
        || path.resolve(actual.backup) !== path.resolve(expected.backup) || resolveNullable(actual.staged) !== resolveNullable(expected.staged)
        || path.resolve(actual.temporary) !== path.resolve(expectedTemporary) || resolveNullable(actual.displaced) !== resolveNullable(expectedDisplaced)) {
      throw new Error(`generation_transaction_journal_path_invalid:${expected.kind}`);
    }
  }
  return journal;
}

export async function persistJournal(journalPath: string, journal: GenerationJournal): Promise<void> {
  journal.updated_at = new Date().toISOString();
  await writeJsonAtomic(journalPath, journal);
  await fs.chmod(journalPath, 0o600).catch(() => undefined);
}

export async function outcomeFromJournal(
  journal: GenerationJournal,
  journalPath: string,
  ok: boolean,
  status: SksMenuBarGenerationTransactionOutcome['status'],
  error: string | null
): Promise<SksMenuBarGenerationTransactionOutcome> {
  return {
    schema: OUTCOME_SCHEMA,
    ok,
    purpose: journal.purpose,
    status,
    journal_path: journalPath,
    failure_point: journal.origin_failure_point || journal.failure_point,
    failure_pair: journal.origin_failure_pair || journal.failure_pair,
    recovery_failure_point: journal.phase === 'recovering' ? journal.failure_point : null,
    recovery_failure_pair: journal.phase === 'recovering' ? journal.failure_pair : null,
    error,
    pairs: await Promise.all(journal.pairs.map(pairOutcome))
  };
}

export async function outcomeFromPlans(
  purpose: SksMenuBarGenerationPurpose,
  journalPath: string,
  pairs: GenerationPairPlanState[],
  ok: boolean,
  status: SksMenuBarGenerationTransactionOutcome['status'],
  error: string | null
): Promise<SksMenuBarGenerationTransactionOutcome> {
  return {
    schema: OUTCOME_SCHEMA,
    ok,
    purpose,
    status,
    journal_path: journalPath,
    failure_point: null,
    failure_pair: null,
    recovery_failure_point: null,
    recovery_failure_pair: null,
    error,
    pairs: await Promise.all(pairs.map(async (pair): Promise<SksMenuBarGenerationPairOutcome> => ({
      kind: pair.kind,
      step: 'pending',
      active: pair.active,
      backup: pair.backup,
      staged: pair.staged,
      temporary: '',
      displaced: null,
      active_exists: await existsNoFollow(pair.active),
      backup_exists: await existsNoFollow(pair.backup),
      staged_exists: pair.staged ? await existsNoFollow(pair.staged) : false,
      temporary_exists: false,
      displaced_exists: false
    })))
  };
}

export async function outcomeFromUnknownJournal(
  purpose: SksMenuBarGenerationPurpose,
  journalPath: string,
  status: SksMenuBarGenerationTransactionOutcome['status'],
  error: string
): Promise<SksMenuBarGenerationTransactionOutcome> {
  return {
    schema: OUTCOME_SCHEMA,
    ok: false,
    purpose,
    status,
    journal_path: journalPath,
    failure_point: null,
    failure_pair: null,
    recovery_failure_point: null,
    recovery_failure_pair: null,
    error,
    pairs: []
  };
}

export async function existsNoFollow(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true).catch(() => false);
}

async function pairOutcome(pair: GenerationJournalPair): Promise<SksMenuBarGenerationPairOutcome> {
  return {
    kind: pair.kind,
    step: pair.step,
    active: pair.active,
    backup: pair.backup,
    staged: pair.staged,
    temporary: pair.temporary,
    displaced: pair.displaced,
    active_exists: await existsNoFollow(pair.active),
    backup_exists: await existsNoFollow(pair.backup),
    staged_exists: pair.staged ? await existsNoFollow(pair.staged) : false,
    temporary_exists: await existsNoFollow(pair.temporary),
    displaced_exists: pair.displaced ? await existsNoFollow(pair.displaced) : false
  };
}

function resolveNullable(value: string | null): string | null {
  return value === null ? null : path.resolve(value);
}
