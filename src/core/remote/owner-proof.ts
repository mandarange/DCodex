import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, readJson, runProcess, sha256, writeTextAtomic } from '../fsx.js';
import { guardedProcessKill, guardContextForRoute } from '../safety/mutation-guard.js';
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js';
import {
  REMOTE_OWNER_PROOF_SCHEMA,
  REMOTE_R2_APPROVAL_SCHEMA,
  type RemoteCancelPayloadV1,
  type RemoteCommandEnvelopeV1,
  type RemoteOwnerProofV1,
  type RemoteProcessIdentityV1
} from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

export class RemoteOwnerProofError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RemoteOwnerProofError';
  }
}

export interface RemoteProcessInspector {
  (pid: number): Promise<RemoteProcessIdentityV1 | null>;
}

export class RemoteOwnerProofStore {
  constructor(private readonly directory: string) {}

  async register(proof: RemoteOwnerProofV1): Promise<void> {
    validateOwnerProof(proof);
    const file = this.pathFor(proof.session_id);
    await writeTextAtomic(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  }

  async read(sessionId: string): Promise<RemoteOwnerProofV1 | null> {
    const file = this.pathFor(sessionId);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RemoteOwnerProofError('owner_proof_file_invalid');
    if ((stat.mode & 0o077) !== 0) throw new RemoteOwnerProofError('owner_proof_permissions_must_be_0600');
    const proof = await readJson<RemoteOwnerProofV1>(file);
    validateOwnerProof(proof);
    if (proof.session_id !== sessionId) throw new RemoteOwnerProofError('owner_proof_session_mismatch');
    return proof;
  }

  pathFor(sessionId: string): string {
    const key = sha256(assertBoundedString(sessionId, 'session_id', 160)).slice(0, 24);
    return path.join(path.resolve(this.directory), `${key}.json`);
  }
}

export async function inspectRemoteProcess(pid: number): Promise<RemoteProcessIdentityV1 | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const ps = await runProcess('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    timeoutMs: 3_000,
    maxOutputBytes: 64 * 1024
  }).catch(() => null);
  if (!ps || ps.code !== 0 || !ps.stdout.trim()) return null;
  const lines = ps.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const combined = lines.join(' ');
  const startMatch = combined.match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!startMatch?.[1] || !startMatch[2]) return null;
  const cwd = await runProcess('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    timeoutMs: 3_000,
    maxOutputBytes: 64 * 1024
  }).catch(() => null);
  if (!cwd || cwd.code !== 0) return null;
  const cwdLine = cwd.stdout.split(/\r?\n/).find((line) => line.startsWith('n'));
  if (!cwdLine?.slice(1)) return null;
  const projectRoot = await fsp.realpath(cwdLine.slice(1)).catch(() => null);
  if (!projectRoot) return null;
  return {
    pid,
    process_start_time: normalizeSpace(startMatch[1]),
    command: normalizeCommand(startMatch[2]),
    project_root: projectRoot
  };
}

export async function cancelOwnedSession(input: {
  readonly root: string;
  readonly envelope: RemoteCommandEnvelopeV1;
  readonly payload: RemoteCancelPayloadV1;
  readonly store: RemoteOwnerProofStore;
  readonly currentGeneration: number;
  readonly inspectProcess?: RemoteProcessInspector;
  readonly killProcess?: (pid: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<{ readonly pid: number; readonly signal: 'SIGTERM'; readonly owner_proof: 'verified' }> {
  const sessionId = input.envelope.session_id;
  if (!sessionId) throw new RemoteOwnerProofError('cancel_session_id_required');
  validateR2Approval(input.envelope, input.payload, input.now?.() ?? Date.now());
  const owner = await input.store.read(sessionId);
  if (!owner) throw new RemoteOwnerProofError('owner_proof_missing');
  const expectedRoot = await fsp.realpath(path.resolve(input.payload.expected_project_root)).catch(() => null);
  if (!expectedRoot) throw new RemoteOwnerProofError('expected_project_root_unreadable');
  const ownerRoot = await fsp.realpath(path.resolve(owner.project_root)).catch(() => null);
  if (!ownerRoot) throw new RemoteOwnerProofError('owner_project_root_unreadable');

  assertEqual(owner.session_id, sessionId, 'owner_session_mismatch');
  assertEqual(owner.project_id, input.envelope.project_id, 'owner_project_mismatch');
  assertEqual(owner.pid, input.payload.expected_pid, 'owner_pid_mismatch');
  assertEqual(normalizeSpace(owner.process_start_time), normalizeSpace(input.payload.expected_process_start_time), 'owner_start_time_mismatch');
  assertEqual(normalizeCommand(owner.expected_command), normalizeCommand(input.payload.expected_command), 'owner_command_mismatch');
  assertEqual(ownerRoot, expectedRoot, 'owner_project_root_mismatch');
  assertEqual(owner.active_generation, input.payload.expected_generation, 'owner_generation_mismatch');
  assertEqual(owner.active_generation, input.currentGeneration, 'active_generation_mismatch');
  if (!timingSafeEqual(owner.owner_nonce, input.payload.owner_nonce)) throw new RemoteOwnerProofError('owner_nonce_mismatch');

  const live = await (input.inspectProcess ?? inspectRemoteProcess)(owner.pid);
  if (!live) throw new RemoteOwnerProofError('owned_process_not_running_or_uninspectable');
  assertEqual(live.pid, owner.pid, 'live_pid_mismatch');
  assertEqual(normalizeSpace(live.process_start_time), normalizeSpace(owner.process_start_time), 'process_start_time_mismatch');
  assertEqual(normalizeCommand(live.command), normalizeCommand(owner.expected_command), 'foreign_process_command_refused');
  const liveRoot = await fsp.realpath(path.resolve(live.project_root)).catch(() => null);
  if (!liveRoot || liveRoot !== expectedRoot) throw new RemoteOwnerProofError('foreign_process_project_root_refused');

  await (input.killProcess ?? defaultKill(input.root, expectedRoot))(owner.pid);
  return { pid: owner.pid, signal: 'SIGTERM', owner_proof: 'verified' };
}

export function parseRemoteCancelPayload(value: unknown): RemoteCancelPayloadV1 {
  const record = asRecord(value);
  if (!record) throw new RemoteOwnerProofError('cancel_payload_object_required');
  const approval = asRecord(record.approval);
  const parsed: RemoteCancelPayloadV1 = {
    owner_nonce: assertBoundedString(record.owner_nonce, 'owner_nonce', 256),
    expected_pid: assertPositiveInteger(record.expected_pid, 'expected_pid'),
    expected_process_start_time: assertBoundedString(record.expected_process_start_time, 'expected_process_start_time', 160),
    expected_command: assertBoundedString(record.expected_command, 'expected_command', 4096),
    expected_project_root: assertBoundedString(record.expected_project_root, 'expected_project_root', 4096),
    expected_generation: assertPositiveInteger(record.expected_generation, 'expected_generation'),
    approval: {
      schema: approval?.schema === REMOTE_R2_APPROVAL_SCHEMA ? REMOTE_R2_APPROVAL_SCHEMA : invalid('approval_schema_invalid'),
      approval_id: assertBoundedString(approval?.approval_id, 'approval_id', 160),
      approved_by: approval?.approved_by === 'telegram-owner' ? 'telegram-owner' : invalid('approval_actor_invalid'),
      approved_at: assertBoundedString(approval?.approved_at, 'approved_at', 64),
      expires_at: assertBoundedString(approval?.expires_at, 'approval_expires_at', 64),
      machine_id: assertBoundedString(approval?.machine_id, 'approval_machine_id', 160),
      project_id: assertBoundedString(approval?.project_id, 'approval_project_id', 160),
      session_id: assertBoundedString(approval?.session_id, 'approval_session_id', 160),
      kind: approval?.kind === 'cancel' ? 'cancel' : invalid('approval_kind_invalid'),
      command_id: assertBoundedString(approval?.command_id, 'approval_command_id', 160)
    }
  };
  return parsed;
}

function validateR2Approval(envelope: RemoteCommandEnvelopeV1, payload: RemoteCancelPayloadV1, now: number): void {
  const approval = payload.approval;
  assertEqual(approval.schema, REMOTE_R2_APPROVAL_SCHEMA, 'approval_schema_invalid');
  assertEqual(approval.approved_by, 'telegram-owner', 'approval_actor_invalid');
  assertEqual(approval.machine_id, envelope.machine_id, 'approval_machine_mismatch');
  assertEqual(approval.project_id, envelope.project_id, 'approval_project_mismatch');
  assertEqual(approval.session_id, envelope.session_id, 'approval_session_mismatch');
  assertEqual(approval.kind, envelope.kind, 'approval_kind_mismatch');
  assertEqual(approval.command_id, envelope.command_id, 'approval_command_mismatch');
  const approvedAt = Date.parse(approval.approved_at);
  const expiresAt = Date.parse(approval.expires_at);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) throw new RemoteOwnerProofError('approval_timestamp_invalid');
  if (approvedAt > now + 30_000) throw new RemoteOwnerProofError('approval_from_future');
  if (expiresAt <= now) throw new RemoteOwnerProofError('approval_expired');
  if (expiresAt - approvedAt > 10 * 60_000) throw new RemoteOwnerProofError('approval_ttl_exceeds_10m');
}

function validateOwnerProof(value: RemoteOwnerProofV1): void {
  if (!value || value.schema !== REMOTE_OWNER_PROOF_SCHEMA) throw new RemoteOwnerProofError('owner_proof_schema_invalid');
  assertBoundedString(value.session_id, 'session_id', 160);
  assertBoundedString(value.project_id, 'project_id', 160);
  if (!path.isAbsolute(value.project_root)) throw new RemoteOwnerProofError('owner_project_root_absolute_required');
  assertPositiveInteger(value.pid, 'pid');
  assertBoundedString(value.process_start_time, 'process_start_time', 160);
  assertBoundedString(value.expected_command, 'expected_command', 4096);
  assertBoundedString(value.owner_nonce, 'owner_nonce', 256);
  assertPositiveInteger(value.active_generation, 'active_generation');
  if (!Number.isFinite(Date.parse(value.registered_at))) throw new RemoteOwnerProofError('registered_at_invalid');
}

function defaultKill(root: string, projectRoot: string): (pid: number) => Promise<void> {
  const contract = createRequestedScopeContract({
    route: 'remote:cancel',
    userRequest: 'Cancel only the exact owner-proof SKS remote session process.',
    projectRoot,
    overrides: { codex_app_process: true }
  });
  return async (pid: number) => guardedProcessKill(
    guardContextForRoute(root, contract, 'R2 owner-proof remote cancel'),
    pid,
    { confirmed: true, signal: 'SIGTERM' }
  );
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertEqual(left: unknown, right: unknown, code: string): void {
  if (left !== right) throw new RemoteOwnerProofError(code);
}

function assertBoundedString(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || Buffer.byteLength(text) > max) throw new RemoteOwnerProofError(`${field}_invalid`);
  return text;
}

function assertPositiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new RemoteOwnerProofError(`${field}_invalid`);
  return number;
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeCommand(value: string): string {
  return value.trim();
}

function invalid(code: string): never {
  throw new RemoteOwnerProofError(code);
}

export function newOwnerNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function ownerProofRegisteredAt(): string {
  return nowIso();
}
