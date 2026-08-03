import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../../fsx.js';
import {
  validateArchitectureConfiguration,
  type ApplyStageName,
  type ApplyStageReceipt,
  type ArchitectureConfiguration,
  type SessionPin
} from '../contracts/contracts.js';

export const ARCHITECTURE_STATE_SCHEMA = 'sks.architecture-state.v1' as const;
export const APPLY_STAGE_ORDER: readonly ApplyStageName[] = [
  'config_saved',
  'proxy_applied',
  'catalog_refreshed',
  'new_session_ready'
];

export interface ArchitectureStateProjection {
  readonly schema: typeof ARCHITECTURE_STATE_SCHEMA;
  readonly draft: ArchitectureConfiguration | null;
  readonly last_known_good: ArchitectureConfiguration | null;
  readonly receipts: readonly ApplyStageReceipt[];
  readonly existing_session: SessionPin | null;
  readonly new_session_default: ArchitectureConfiguration | null;
}

export interface StateApplyPorts {
  applyProxy(configuration: ArchitectureConfiguration): Promise<void>;
  refreshCatalog(configuration: ArchitectureConfiguration): Promise<void>;
  makeNewSessionReady(configuration: ArchitectureConfiguration): Promise<void>;
  afterStage?(stage: ApplyStageName): Promise<void> | void;
}

export interface StateCommitResult {
  readonly ok: boolean;
  readonly status: 'committed' | 'failed';
  readonly receipts: readonly ApplyStageReceipt[];
  readonly blocker: string | null;
}

export class ArchitectureStateService {
  readonly root: string;
  readonly draftPath: string;
  readonly lastKnownGoodPath: string;
  readonly receiptPath: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.draftPath = path.join(this.root, 'draft.json');
    this.lastKnownGoodPath = path.join(this.root, 'last-known-good.json');
    this.receiptPath = path.join(this.root, 'apply-receipt.json');
  }

  async stage(configuration: ArchitectureConfiguration): Promise<ArchitectureConfiguration> {
    const validated = validateArchitectureConfiguration(configuration);
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.draftPath, validated, { mode: 0o600 });
    return validated;
  }

  async commit(ports: StateApplyPorts, now: () => Date = () => new Date()): Promise<StateCommitResult> {
    const draft = await readConfiguration(this.draftPath);
    if (!draft) return { ok: false, status: 'failed', receipts: [], blocker: 'state_draft_missing' };
    const receipts = APPLY_STAGE_ORDER.map((stage) => receipt(stage, 'pending', null, now));
    const persist = async (): Promise<void> => {
      await writeJsonAtomic(this.receiptPath, { schema: 'sks.apply-receipts.v1', stages: receipts }, { mode: 0o600 });
    };
    await persist();

    const runStage = async (stage: ApplyStageName, action: () => Promise<void>): Promise<void> => {
      replaceReceipt(receipts, receipt(stage, 'running', null, now));
      await persist();
      try {
        await action();
        await ports.afterStage?.(stage);
        replaceReceipt(receipts, receipt(stage, 'succeeded', null, now));
        await persist();
      } catch (error) {
        const code = safeFailureCode(error);
        replaceReceipt(receipts, receipt(stage, 'failed', code, now));
        await persist();
        throw new StateApplyError(code);
      }
    };

    try {
      await runStage('config_saved', async () => undefined);
      await runStage('proxy_applied', () => ports.applyProxy(draft));
      await runStage('catalog_refreshed', () => ports.refreshCatalog(draft));
      await runStage('new_session_ready', () => ports.makeNewSessionReady(draft));
      await writeJsonAtomic(this.lastKnownGoodPath, draft, { mode: 0o600 });
      await fsp.rm(this.draftPath, { force: true });
      return { ok: true, status: 'committed', receipts, blocker: null };
    } catch (error) {
      const blocker = error instanceof StateApplyError ? error.code : 'state_apply_failed';
      return { ok: false, status: 'failed', receipts, blocker };
    }
  }

  async rollbackDraft(): Promise<boolean> {
    try {
      await fsp.unlink(this.draftPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async read(existingSession: SessionPin | null = null): Promise<ArchitectureStateProjection> {
    const [draft, lastKnownGood, receipts] = await Promise.all([
      readConfiguration(this.draftPath),
      readConfiguration(this.lastKnownGoodPath),
      readReceipts(this.receiptPath)
    ]);
    return {
      schema: ARCHITECTURE_STATE_SCHEMA,
      draft,
      last_known_good: lastKnownGood,
      receipts,
      existing_session: existingSession,
      new_session_default: lastKnownGood
    };
  }
}

class StateApplyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function readConfiguration(file: string): Promise<ArchitectureConfiguration | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return validateArchitectureConfiguration(JSON.parse(raw) as unknown);
}

async function readReceipts(file: string): Promise<ApplyStageReceipt[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { schema?: unknown; stages?: unknown };
    if (parsed.schema !== 'sks.apply-receipts.v1' || !Array.isArray(parsed.stages)) return [];
    return parsed.stages.filter(isReceipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function receipt(stage: ApplyStageName, status: ApplyStageReceipt['status'], reasonCode: string | null, now: () => Date): ApplyStageReceipt {
  return {
    schema: 'sks.apply-stage-receipt.v1',
    stage,
    status,
    reason_code: reasonCode,
    updated_at: now().toISOString()
  };
}

function replaceReceipt(receipts: ApplyStageReceipt[], next: ApplyStageReceipt): void {
  const index = receipts.findIndex((entry) => entry.stage === next.stage);
  if (index < 0) throw new StateApplyError('state_receipt_stage_missing');
  receipts[index] = next;
}

function isReceipt(value: unknown): value is ApplyStageReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ApplyStageReceipt>;
  return row.schema === 'sks.apply-stage-receipt.v1'
    && APPLY_STAGE_ORDER.includes(row.stage as ApplyStageName)
    && ['pending', 'running', 'succeeded', 'failed'].includes(String(row.status))
    && (row.reason_code === null || typeof row.reason_code === 'string')
    && typeof row.updated_at === 'string';
}

function safeFailureCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{2,99}$/.test(candidate) ? candidate : 'state_apply_failed';
}
