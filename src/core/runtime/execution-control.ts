import { nowIso, sha256 } from '../fsx.js';

export const EXECUTION_CONTROL_SCHEMA = 'sks.execution-control.v1';

export type ExecutionStopReason =
  | 'completed'
  | 'attempt_budget_exhausted'
  | 'time_budget_exhausted'
  | 'tool_budget_exhausted'
  | 'token_budget_exhausted'
  | 'no_progress'
  | 'user_input_required'
  | 'unverified_completion'
  | 'explicit_stop';

export interface ExecutionControlBudget {
  readonly max_attempts: number;
  readonly max_elapsed_ms: number;
  readonly max_tool_calls: number | null;
  readonly max_tokens: number | null;
  readonly max_no_progress: number;
}

export interface ExecutionControlState {
  readonly schema: typeof EXECUTION_CONTROL_SCHEMA;
  readonly status: 'running' | 'completed' | 'stopped';
  readonly stop_reason: ExecutionStopReason | null;
  readonly stop_detail: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly attempts: number;
  readonly elapsed_ms: number;
  readonly tool_calls: number;
  readonly tokens: number;
  readonly no_progress_streak: number;
  readonly last_progress_fingerprint: string | null;
  readonly seen_idempotency_keys: readonly string[];
}

export interface ExecutionObservation {
  readonly fingerprint: unknown;
  readonly idempotencyKey?: string | null;
  readonly madeProgress?: boolean;
  readonly elapsedMs?: number;
  readonly toolCalls?: number;
  readonly tokens?: number;
  readonly countAttempt?: boolean;
  readonly userInputRequired?: boolean;
}

export interface ExecutionControlDecision {
  readonly allowed: boolean;
  readonly state: ExecutionControlState;
  readonly stop_reason: ExecutionStopReason | null;
  readonly remaining_time_ms: number;
  readonly remaining_attempts: number;
}

const MAX_TRACKED_IDEMPOTENCY_KEYS = 128;

export function normalizeExecutionControlBudget(input: Partial<ExecutionControlBudget> = {}): ExecutionControlBudget {
  return {
    max_attempts: boundedInteger(input.max_attempts, 1, 10_000, 1),
    max_elapsed_ms: boundedInteger(input.max_elapsed_ms, 1, 7 * 24 * 60 * 60 * 1000, 30 * 60 * 1000),
    max_tool_calls: nullableBoundedInteger(input.max_tool_calls, 1, 1_000_000),
    max_tokens: nullableBoundedInteger(input.max_tokens, 1, Number.MAX_SAFE_INTEGER),
    max_no_progress: boundedInteger(input.max_no_progress, 1, 100, 2)
  };
}

export function normalizeExecutionControlState(value: unknown, at = nowIso()): ExecutionControlState {
  const row = record(value);
  if (row?.schema !== EXECUTION_CONTROL_SCHEMA) return newExecutionControlState(at);
  const status = row.status === 'completed' || row.status === 'stopped' ? row.status : 'running';
  const stopReason = isExecutionStopReason(row.stop_reason) ? row.stop_reason : null;
  return {
    schema: EXECUTION_CONTROL_SCHEMA,
    status,
    stop_reason: status === 'running' ? null : stopReason,
    stop_detail: status === 'running' ? null : nonEmptyString(row.stop_detail),
    created_at: nonEmptyString(row.created_at) || at,
    updated_at: nonEmptyString(row.updated_at) || at,
    attempts: nonNegativeInteger(row.attempts),
    elapsed_ms: nonNegativeInteger(row.elapsed_ms),
    tool_calls: nonNegativeInteger(row.tool_calls),
    tokens: nonNegativeInteger(row.tokens),
    no_progress_streak: nonNegativeInteger(row.no_progress_streak),
    last_progress_fingerprint: nonEmptyString(row.last_progress_fingerprint),
    seen_idempotency_keys: uniqueStrings(row.seen_idempotency_keys).slice(-MAX_TRACKED_IDEMPOTENCY_KEYS)
  };
}

export function preflightExecutionControl(
  current: unknown,
  rawBudget: Partial<ExecutionControlBudget>,
  at = nowIso()
): ExecutionControlDecision {
  const budget = normalizeExecutionControlBudget(rawBudget);
  let state = normalizeExecutionControlState(current, at);
  if (state.status !== 'running') return decision(false, state, budget);
  if (state.elapsed_ms >= budget.max_elapsed_ms) state = stopExecutionControl(state, 'time_budget_exhausted', null, at);
  else if (budget.max_tool_calls !== null && state.tool_calls >= budget.max_tool_calls) state = stopExecutionControl(state, 'tool_budget_exhausted', null, at);
  else if (budget.max_tokens !== null && state.tokens >= budget.max_tokens) state = stopExecutionControl(state, 'token_budget_exhausted', null, at);
  else if (state.attempts >= budget.max_attempts) state = stopExecutionControl(state, 'attempt_budget_exhausted', null, at);
  return decision(state.status === 'running', state, budget);
}

export function recordExecutionObservation(
  current: unknown,
  rawBudget: Partial<ExecutionControlBudget>,
  observation: ExecutionObservation,
  at = nowIso()
): ExecutionControlState {
  const budget = normalizeExecutionControlBudget(rawBudget);
  const state = normalizeExecutionControlState(current, at);
  if (state.status !== 'running') return state;

  const fingerprint = executionProgressFingerprint(observation.fingerprint);
  const idempotencyKey = nonEmptyString(observation.idempotencyKey);
  const duplicate = Boolean(idempotencyKey && state.seen_idempotency_keys.includes(idempotencyKey));
  const fingerprintChanged = state.last_progress_fingerprint === null || state.last_progress_fingerprint !== fingerprint;
  const madeProgress = observation.madeProgress === true
    || (observation.madeProgress !== false && fingerprintChanged && !duplicate);
  const noProgressStreak = madeProgress ? 0 : state.no_progress_streak + 1;
  const seenIdempotencyKeys = idempotencyKey && !duplicate
    ? [...state.seen_idempotency_keys, idempotencyKey].slice(-MAX_TRACKED_IDEMPOTENCY_KEYS)
    : [...state.seen_idempotency_keys];
  let next: ExecutionControlState = {
    ...state,
    updated_at: at,
    attempts: state.attempts + (observation.countAttempt === false ? 0 : 1),
    elapsed_ms: state.elapsed_ms + nonNegativeInteger(observation.elapsedMs),
    tool_calls: state.tool_calls + nonNegativeInteger(observation.toolCalls),
    tokens: state.tokens + nonNegativeInteger(observation.tokens),
    no_progress_streak: noProgressStreak,
    last_progress_fingerprint: fingerprint,
    seen_idempotency_keys: seenIdempotencyKeys
  };

  if (observation.userInputRequired === true) {
    return stopExecutionControl(next, 'user_input_required', 'execution cannot advance without user input', at);
  }
  if (next.no_progress_streak >= budget.max_no_progress) {
    return stopExecutionControl(next, 'no_progress', `same semantic result repeated ${next.no_progress_streak} time(s)`, at);
  }
  if (next.elapsed_ms >= budget.max_elapsed_ms) return stopExecutionControl(next, 'time_budget_exhausted', null, at);
  if (budget.max_tool_calls !== null && next.tool_calls >= budget.max_tool_calls) return stopExecutionControl(next, 'tool_budget_exhausted', null, at);
  if (budget.max_tokens !== null && next.tokens >= budget.max_tokens) return stopExecutionControl(next, 'token_budget_exhausted', null, at);
  if (next.attempts >= budget.max_attempts) return stopExecutionControl(next, 'attempt_budget_exhausted', null, at);
  return next;
}

export function completeExecutionControl(
  current: unknown,
  verified: boolean,
  detail: string | null = null,
  at = nowIso()
): ExecutionControlState {
  const state = normalizeExecutionControlState(current, at);
  if (!verified) return stopExecutionControl(state, 'unverified_completion', detail || 'completion lacked applicable runtime proof', at);
  return {
    ...state,
    status: 'completed',
    stop_reason: 'completed',
    stop_detail: detail,
    no_progress_streak: 0,
    updated_at: at
  };
}

export function stopExecutionControl(
  current: unknown,
  reason: ExecutionStopReason,
  detail: string | null = null,
  at = nowIso()
): ExecutionControlState {
  const state = normalizeExecutionControlState(current, at);
  return {
    ...state,
    status: reason === 'completed' ? 'completed' : 'stopped',
    stop_reason: reason,
    stop_detail: detail,
    updated_at: at
  };
}

export function resumeExecutionControl(
  current: unknown,
  rawBudget: Partial<ExecutionControlBudget>,
  currentFingerprint: unknown,
  at = nowIso()
): ExecutionControlState {
  const budget = normalizeExecutionControlBudget(rawBudget);
  const state = normalizeExecutionControlState(current, at);
  if (state.status === 'completed') return state;
  const hasBudget = state.attempts < budget.max_attempts
    && state.elapsed_ms < budget.max_elapsed_ms
    && (budget.max_tool_calls === null || state.tool_calls < budget.max_tool_calls)
    && (budget.max_tokens === null || state.tokens < budget.max_tokens);
  if (!hasBudget) return state;
  const fingerprintChanged = state.last_progress_fingerprint !== executionProgressFingerprint(currentFingerprint);
  const budgetExpanded = ['attempt_budget_exhausted', 'tool_budget_exhausted', 'token_budget_exhausted'].includes(String(state.stop_reason || ''));
  if (!fingerprintChanged && !budgetExpanded) return state;
  return {
    ...state,
    status: 'running',
    stop_reason: null,
    stop_detail: null,
    no_progress_streak: fingerprintChanged ? 0 : state.no_progress_streak,
    updated_at: at
  };
}

export function executionProgressFingerprint(value: unknown): string {
  return `sha256:${sha256(stableJson(value))}`;
}

function newExecutionControlState(at: string): ExecutionControlState {
  return {
    schema: EXECUTION_CONTROL_SCHEMA,
    status: 'running',
    stop_reason: null,
    stop_detail: null,
    created_at: at,
    updated_at: at,
    attempts: 0,
    elapsed_ms: 0,
    tool_calls: 0,
    tokens: 0,
    no_progress_streak: 0,
    last_progress_fingerprint: null,
    seen_idempotency_keys: []
  };
}

function decision(allowed: boolean, state: ExecutionControlState, budget: ExecutionControlBudget): ExecutionControlDecision {
  return {
    allowed,
    state,
    stop_reason: state.stop_reason,
    remaining_time_ms: Math.max(0, budget.max_elapsed_ms - state.elapsed_ms),
    remaining_attempts: Math.max(0, budget.max_attempts - state.attempts)
  };
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? '"__unserializable__"' : encoded;
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function nullableBoundedInteger(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function nonEmptyString(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nonEmptyString).filter((item): item is string => Boolean(item)))];
}

function isExecutionStopReason(value: unknown): value is ExecutionStopReason {
  return new Set<ExecutionStopReason>([
    'completed',
    'attempt_budget_exhausted',
    'time_budget_exhausted',
    'tool_budget_exhausted',
    'token_budget_exhausted',
    'no_progress',
    'user_input_required',
    'unverified_completion',
    'explicit_stop'
  ]).has(String(value || '') as ExecutionStopReason);
}
