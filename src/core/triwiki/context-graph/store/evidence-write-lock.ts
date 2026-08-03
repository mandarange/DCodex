import { createHash } from 'node:crypto';
import path from 'node:path';
import { withFileLock } from '../../../locks/file-lock.js';

export const EVIDENCE_WRITER_DEFAULT_WAIT_MS = 10_000;
export const EVIDENCE_WRITER_DEFAULT_STALE_MS = 120_000;

export interface EvidenceWriterLockReceipt {
  readonly schema: 'sks.evidence-writer-lock-receipt.v1';
  readonly project_id_hash: string;
  readonly acquired: true;
  readonly wait_ms: number;
}

export async function withEvidenceWriterLock<T>(input: {
  root: string;
  projectId: string;
  waitMs?: number;
  staleMs?: number;
  run(receipt: EvidenceWriterLockReceipt): Promise<T>;
}): Promise<T> {
  const projectIdHash = createHash('sha256').update(input.projectId).digest('hex');
  const lockPath = path.join(
    path.resolve(input.root),
    '.sneakoscope',
    'cache',
    'context-graph',
    'evidence-writers',
    `${projectIdHash}.lock`
  );
  const waitMs = Math.max(1, Math.min(30_000, input.waitMs ?? EVIDENCE_WRITER_DEFAULT_WAIT_MS));
  const started = Date.now();
  try {
    return await withFileLock({
      lockPath,
      timeoutMs: waitMs,
      staleMs: Math.max(1, input.staleMs ?? EVIDENCE_WRITER_DEFAULT_STALE_MS)
    }, async () => input.run({
      schema: 'sks.evidence-writer-lock-receipt.v1',
      project_id_hash: projectIdHash,
      acquired: true,
      wait_ms: Date.now() - started
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('file_lock_timeout:')) {
      throw new Error('evidence_writer_lock_timeout');
    }
    throw error;
  }
}
