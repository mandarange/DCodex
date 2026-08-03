import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../../fsx.js';
import type { ProgressRecoveryState } from '../../runtime/progress-recovery/progress-recovery.js';

export interface ArchitectureSafeProjection {
  readonly schema: 'sks.architecture-safe-projection.v1';
  readonly verification_time_ms: number;
  readonly critical_path: readonly string[];
  readonly cache: { readonly status: 'HIT' | 'MISS' | 'BYPASS' | 'EXPIRED'; readonly reason: string };
  readonly retry_count: number;
  readonly intent: { readonly risk: 'FAST' | 'HEAVY' | 'ULTRA'; readonly reason: string };
  readonly progress_signal: string | null;
  readonly pause_cause: string | null;
  readonly recovery_attempt: number;
  readonly next_action: string;
}

const FORBIDDEN = new Set(['key', 'api_key', 'secret', 'account', 'account_id', 'body', 'request_body', 'fingerprint', 'credential_fingerprint', 'authorization', 'token']);

export function createArchitectureSafeProjection(input: {
  verificationTimeMs: number;
  criticalPath: readonly string[];
  cacheStatus: ArchitectureSafeProjection['cache']['status'];
  cacheReason: string;
  intentRisk: ArchitectureSafeProjection['intent']['risk'];
  intentReason: string;
  recovery: ProgressRecoveryState;
  nextAction: string;
  internalDiagnostic?: unknown;
}): ArchitectureSafeProjection {
  if (!Number.isFinite(input.verificationTimeMs) || input.verificationTimeMs < 0) throw new Error('safe_projection_verification_time_invalid');
  if (input.internalDiagnostic !== undefined) assertNoForbiddenFields(input.internalDiagnostic);
  const criticalPath = input.criticalPath.map((entry) => safeCode(entry, 'safe_projection_critical_path_invalid'));
  const latest = input.recovery.progress[input.recovery.progress.length - 1];
  return {
    schema: 'sks.architecture-safe-projection.v1', verification_time_ms: Math.round(input.verificationTimeMs),
    critical_path: criticalPath, cache: { status: input.cacheStatus, reason: safeCode(input.cacheReason, 'safe_projection_cache_reason_invalid') },
    retry_count: input.recovery.retry_count,
    intent: { risk: input.intentRisk, reason: safeCode(input.intentReason, 'safe_projection_intent_reason_invalid') },
    progress_signal: latest ? `${latest.kind}:${latest.id}` : null,
    pause_cause: input.recovery.pause_cause,
    recovery_attempt: input.recovery.retry_count,
    next_action: safeCode(input.nextAction, 'safe_projection_next_action_invalid')
  };
}

export async function writeSafeProjection(file: string, projection: ArchitectureSafeProjection): Promise<void> {
  assertNoForbiddenFields(projection);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, projection, { mode: 0o600 });
}

export async function readLastSafeProjection(file: string): Promise<ArchitectureSafeProjection | null> {
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8')) as ArchitectureSafeProjection;
    if (value.schema !== 'sks.architecture-safe-projection.v1') throw new Error('safe_projection_schema_invalid');
    assertNoForbiddenFields(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function serializeSafeProjection(projection: ArchitectureSafeProjection): string {
  assertNoForbiddenFields(projection);
  return JSON.stringify(projection);
}

function assertNoForbiddenFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenFields(entry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(key.toLowerCase())) throw new Error('safe_projection_prohibited_field');
    assertNoForbiddenFields(child);
  }
}

function safeCode(value: string, error: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) throw new Error(error);
  return normalized;
}
