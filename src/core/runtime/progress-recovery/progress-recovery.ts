import { createHash, randomBytes } from 'node:crypto';

export type ProgressSignalKind = 'evidence' | 'file' | 'test' | 'model' | 'tool';
export type PauseCause = 'network' | 'auth' | 'mode' | 'account' | 'external-config' | 'integrity' | 'unknown';

export interface ProgressSignal {
  readonly kind: ProgressSignalKind;
  readonly id: string;
  readonly digest: string;
  readonly observed_at: string;
}

export interface ProgressRecoveryState {
  readonly schema: 'sks.progress-recovery-state.v1';
  readonly status: 'running' | 'paused' | 'completed' | 'failed';
  readonly progress: readonly ProgressSignal[];
  readonly last_progress_at: string | null;
  readonly warning_time_budget_exceeded: boolean;
  readonly pause_cause: PauseCause | null;
  readonly pause_reason: string | null;
  readonly retry_count: number;
  readonly integrity_snapshot_hash: string;
  readonly resume_token_hash: string | null;
}

export interface RetrySafeExecutorPort<T> {
  run(attempt: number): Promise<T>;
  classify(error: unknown): { cause: PauseCause; reason: string };
}

export function initialProgressRecoveryState(integritySnapshotHash: string): ProgressRecoveryState {
  if (!/^[a-f0-9]{64}$/.test(integritySnapshotHash)) throw new Error('progress_integrity_snapshot_invalid');
  return {
    schema: 'sks.progress-recovery-state.v1', status: 'running', progress: [], last_progress_at: null,
    warning_time_budget_exceeded: false, pause_cause: null, pause_reason: null, retry_count: 0,
    integrity_snapshot_hash: integritySnapshotHash, resume_token_hash: null
  };
}

export function recordProgress(state: ProgressRecoveryState, signal: ProgressSignal): ProgressRecoveryState {
  if (state.status !== 'running') throw new Error('progress_signal_requires_running_state');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(signal.id)) throw new Error('progress_signal_id_invalid');
  if (!/^[a-f0-9]{64}$/.test(signal.digest) || !Number.isFinite(Date.parse(signal.observed_at))) throw new Error('progress_signal_invalid');
  const byIdentity = new Map(state.progress.map((entry) => [`${entry.kind}:${entry.id}:${entry.digest}`, entry]));
  byIdentity.set(`${signal.kind}:${signal.id}:${signal.digest}`, signal);
  return { ...state, progress: [...byIdentity.values()], last_progress_at: signal.observed_at };
}

export function applyTimeBudgetWarning(
  state: ProgressRecoveryState,
  input: { startedAtMs: number; nowMs: number; budgetMs: number }
): ProgressRecoveryState {
  if (input.budgetMs <= 0) throw new Error('progress_time_budget_invalid');
  return { ...state, warning_time_budget_exceeded: input.nowMs - input.startedAtMs > input.budgetMs };
}

export function classifyRecoveryCause(error: unknown): { cause: PauseCause; reason: string } {
  const code = safeCode(error);
  if (/^(?:econnreset|econnrefused|etimedout|enotfound|network_|upstream_network_)/.test(code)) return { cause: 'network', reason: code };
  if (/^(?:auth_|credential_|unauthorized|forbidden)/.test(code)) return { cause: 'auth', reason: code };
  if (/^mode_/.test(code)) return { cause: 'mode', reason: code };
  if (/^account_/.test(code)) return { cause: 'account', reason: code };
  if (/^(?:external_config_|catalog_)/.test(code)) return { cause: 'external-config', reason: code };
  if (/^integrity_/.test(code)) return { cause: 'integrity', reason: code };
  return { cause: 'unknown', reason: 'unknown_failure' };
}

export async function runWithProgressRecovery<T>(input: {
  state: ProgressRecoveryState;
  port: RetrySafeExecutorPort<T>;
  maxNetworkRetries?: number;
}): Promise<{ value: T | null; state: ProgressRecoveryState }> {
  const maxRetries = Math.max(0, Math.min(2, input.maxNetworkRetries ?? 2));
  let state = input.state;
  let firstNetworkReason: string | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const value = await input.port.run(attempt);
      return { value, state: { ...state, status: 'completed', pause_cause: null, pause_reason: null, resume_token_hash: null } };
    } catch (error) {
      const failure = input.port.classify(error);
      const sameNetworkCause = failure.cause === 'network' && (firstNetworkReason === null || firstNetworkReason === failure.reason);
      if (failure.cause === 'network' && firstNetworkReason === null) firstNetworkReason = failure.reason;
      if (sameNetworkCause && attempt < maxRetries) {
        state = { ...state, retry_count: attempt + 1 };
        continue;
      }
      return { value: null, state: pauseState(state, failure.cause, failure.reason, attempt) };
    }
  }
  return { value: null, state: pauseState(state, 'unknown', 'retry_loop_exhausted', maxRetries) };
}

export function issueManualResume(state: ProgressRecoveryState): { state: ProgressRecoveryState; token: string } {
  if (state.status !== 'paused') throw new Error('progress_resume_requires_paused_state');
  const token = randomBytes(24).toString('base64url');
  return { state: { ...state, resume_token_hash: hash(token) }, token };
}

export function confirmManualResume(state: ProgressRecoveryState, token: string): ProgressRecoveryState {
  if (state.status !== 'paused' || !state.resume_token_hash || hash(token) !== state.resume_token_hash) {
    throw new Error('progress_resume_token_invalid');
  }
  return { ...state, status: 'running', pause_cause: null, pause_reason: null, resume_token_hash: null };
}

function pauseState(state: ProgressRecoveryState, cause: PauseCause, reason: string, retryCount: number): ProgressRecoveryState {
  return { ...state, status: 'paused', pause_cause: cause, pause_reason: safeReason(reason), retry_count: retryCount, resume_token_hash: null };
}

function safeCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const normalized = raw.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{1,99}$/.test(normalized) ? normalized : 'unknown_failure';
}

function safeReason(value: string): string {
  return /^[a-z][a-z0-9_]{1,99}$/.test(value) ? value : 'unknown_failure';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
