import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../../fsx.js';

export const ARCHITECTURE_STATE_SCHEMA = 'sks.architecture-state.v1' as const;
export const APPLY_RECEIPTS_SCHEMA = 'sks.apply-receipts.v1' as const;
export const APPLY_STAGE_RECEIPT_SCHEMA = 'sks.apply-stage-receipt.v1' as const;
export const APPLY_STAGE_ORDER = [
  'config_saved',
  'proxy_applied',
  'catalog_refreshed',
  'new_session_ready'
] as const;

export type ApplyStageName = (typeof APPLY_STAGE_ORDER)[number];
export type ArchitectureStateJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ArchitectureStateJsonValue[]
  | { readonly [key: string]: ArchitectureStateJsonValue };
export type ArchitectureStateRecord = Readonly<Record<string, ArchitectureStateJsonValue>>;

export interface ApplyStageReceipt {
  readonly schema: typeof APPLY_STAGE_RECEIPT_SCHEMA;
  readonly stage: ApplyStageName;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly reason_code: string | null;
  readonly updated_at: string;
}

export interface ArchitectureStateProjection<TState extends object = ArchitectureStateRecord> {
  readonly schema: typeof ARCHITECTURE_STATE_SCHEMA;
  readonly draft: TState | null;
  readonly last_known_good: TState | null;
  readonly receipts: readonly ApplyStageReceipt[];
  readonly new_session_default: TState | null;
}

export interface StateApplyPorts<TState extends object = ArchitectureStateRecord> {
  applyProxy(configuration: TState): Promise<void>;
  refreshCatalog(configuration: TState): Promise<void>;
  makeNewSessionReady(configuration: TState): Promise<void>;
  afterStage?(stage: ApplyStageName): Promise<void> | void;
}

export interface StateCommitResult {
  readonly ok: boolean;
  readonly status: 'committed' | 'failed';
  readonly receipts: readonly ApplyStageReceipt[];
  readonly blocker: string | null;
}

/**
 * Atomic persistence for an arbitrary JSON-safe architecture configuration.
 *
 * The caller owns the storage root and the apply operations. This service does
 * not select a provider mode, create a runtime, or infer an exclusive session;
 * it only separates staged state from the last successfully applied state.
 */
export class ArchitectureStateService<TState extends object = ArchitectureStateRecord> {
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

  async stage(configuration: TState): Promise<TState> {
    const validated = cloneJsonState(configuration);
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.draftPath, validated, { mode: 0o600 });
    return validated;
  }

  async commit(ports: StateApplyPorts<TState>, now: () => Date = () => new Date()): Promise<StateCommitResult> {
    const draft = await readState<TState>(this.draftPath);
    if (!draft) return { ok: false, status: 'failed', receipts: [], blocker: 'state_draft_missing' };

    const receipts = APPLY_STAGE_ORDER.map((stage) => receipt(stage, 'pending', null, now));
    const persist = async (): Promise<void> => {
      await writeJsonAtomic(this.receiptPath, { schema: APPLY_RECEIPTS_SCHEMA, stages: receipts }, { mode: 0o600 });
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

  async read(): Promise<ArchitectureStateProjection<TState>> {
    const [draft, lastKnownGood, receipts] = await Promise.all([
      readState<TState>(this.draftPath),
      readState<TState>(this.lastKnownGoodPath),
      readReceipts(this.receiptPath)
    ]);
    return {
      schema: ARCHITECTURE_STATE_SCHEMA,
      draft,
      last_known_good: lastKnownGood,
      receipts,
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

async function readState<TState extends object>(file: string): Promise<TState | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return cloneJsonState(JSON.parse(raw) as TState);
}

async function readReceipts(file: string): Promise<ApplyStageReceipt[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { schema?: unknown; stages?: unknown };
    if (parsed.schema !== APPLY_RECEIPTS_SCHEMA || !Array.isArray(parsed.stages)) return [];
    return parsed.stages.filter(isReceipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function receipt(
  stage: ApplyStageName,
  status: ApplyStageReceipt['status'],
  reasonCode: string | null,
  now: () => Date
): ApplyStageReceipt {
  return {
    schema: APPLY_STAGE_RECEIPT_SCHEMA,
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
  return row.schema === APPLY_STAGE_RECEIPT_SCHEMA
    && APPLY_STAGE_ORDER.includes(row.stage as ApplyStageName)
    && ['pending', 'running', 'succeeded', 'failed'].includes(String(row.status))
    && (row.reason_code === null || typeof row.reason_code === 'string')
    && typeof row.updated_at === 'string';
}

function cloneJsonState<TState extends object>(value: TState): TState {
  validateJsonValue(value, true, new Set<object>());
  return JSON.parse(JSON.stringify(value)) as TState;
}

function validateJsonValue(value: unknown, root: boolean, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new StateApplyError('state_configuration_not_json_safe');
  }
  if (typeof value !== 'object') throw new StateApplyError('state_configuration_not_json_safe');
  if (root && Array.isArray(value)) throw new StateApplyError('state_configuration_not_json_object');
  if (ancestors.has(value)) throw new StateApplyError('state_configuration_not_json_safe');

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) validateJsonValue(entry, false, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StateApplyError('state_configuration_not_json_safe');
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
      throw new StateApplyError('state_configuration_not_json_safe');
    }
    for (const entry of Object.values(value)) validateJsonValue(entry, false, ancestors);
  }
  ancestors.delete(value);
}

function safeFailureCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{2,99}$/.test(candidate) ? candidate : 'state_apply_failed';
}
