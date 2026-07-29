import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCodexAppServerV2Client } from '../codex-control/codex-app-server-v2-client.js';
import {
  CodexAppServerRuntimeEnvError,
  prepareCodexAppServerRuntimeEnv
} from '../codex-control/codex-app-server-runtime-env.js';
import {
  RemoteAuditLog,
  RemoteCommandLedger,
  RemoteEventJournal,
  remoteRuntimePaths
} from './audit-idempotency.js';
import {
  cancelOwnedSession,
  parseRemoteCancelPayload,
  RemoteOwnerProofError,
  RemoteOwnerProofStore,
  type RemoteProcessInspector
} from './owner-proof.js';
import { RemoteProtocolError, workerErrorResponse, workerSuccessResponse } from './protocol.js';
import {
  listRemoteSessionRows,
  readRemoteSessionView,
  readRemoteSessionSnapshot,
  remoteSessionGeneration,
  remoteSessionRecord
} from './session-snapshot.js';
import {
  REMOTE_COMMAND_RECEIPT_SCHEMA,
  type RemoteCommandEnvelopeV1,
  type RemoteCommandReceiptV1,
  type RemoteMachineV1,
  type RemoteOwnerProofV1,
  type WorkerRequestV1,
  type WorkerResponseV1
} from './types.js';

type JsonObject = Record<string, unknown>;

export interface RemoteCodexControlClient {
  readonly initialize: () => Promise<unknown>;
  readonly steerTurn?: (params: JsonObject) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export class RemoteWorkerExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly delivery: 'not_dispatched' | 'unknown' | 'acknowledged' = 'not_dispatched',
    readonly retryable: boolean = false
  ) {
    super(code);
    this.name = 'RemoteWorkerExecutionError';
  }
}

export interface RemoteWorkerOptions {
  readonly root: string;
  readonly machine: RemoteMachineV1;
  readonly projectId: string;
  readonly commandLedger?: RemoteCommandLedger;
  readonly audit?: RemoteAuditLog;
  readonly events?: RemoteEventJournal;
  readonly owners?: RemoteOwnerProofStore;
  readonly codexClientFactory?: (cwd: string) => Promise<RemoteCodexControlClient>;
  readonly inspectProcess?: RemoteProcessInspector;
  readonly killProcess?: (pid: number) => Promise<void>;
  readonly now?: () => number;
}

export class RemoteWorker {
  private readonly root: string;
  private readonly machine: RemoteMachineV1;
  private readonly projectId: string;
  private readonly commands: RemoteCommandLedger;
  private readonly audit: RemoteAuditLog;
  private readonly events: RemoteEventJournal;
  private readonly owners: RemoteOwnerProofStore;
  private readonly codexClientFactory: (cwd: string) => Promise<RemoteCodexControlClient>;
  private readonly inspectProcess: RemoteProcessInspector | undefined;
  private readonly killProcess: ((pid: number) => Promise<void>) | undefined;
  private readonly now: () => number;

  constructor(options: RemoteWorkerOptions) {
    this.root = path.resolve(options.root);
    this.machine = options.machine;
    this.projectId = options.projectId;
    const paths = remoteRuntimePaths(this.root);
    this.commands = options.commandLedger ?? new RemoteCommandLedger(paths.commands, { lockPath: paths.commandLock });
    this.audit = options.audit ?? new RemoteAuditLog(paths.audit);
    this.events = options.events ?? new RemoteEventJournal(paths.events, {
      lockPath: paths.eventLock,
      healthPath: paths.eventHealth
    });
    this.owners = options.owners ?? new RemoteOwnerProofStore(paths.owners);
    this.codexClientFactory = options.codexClientFactory ?? defaultCodexClientFactory;
    this.inspectProcess = options.inspectProcess;
    this.killProcess = options.killProcess;
    this.now = options.now ?? Date.now;
  }

  async handle(request: WorkerRequestV1): Promise<WorkerResponseV1> {
    if (request.type === 'hello') {
      return workerSuccessResponse(request, {
        schema: 'sks.remote-worker-hello.v1',
        protocol: 'jsonl-stdio',
        machine_id: this.machine.id,
        project_id: this.projectId,
        capabilities: ['list_sessions', 'read_snapshot', 'watch', 'typed_input', 'typed_verify', 'owner_proof_cancel'],
        max_line_bytes: 64 * 1024,
        max_response_bytes: 512 * 1024,
        official_remote_transport_owned: false,
        official_remote_session_ids_are_sks_session_ids: false
      });
    }
    if (request.type === 'list_sessions') {
      return workerSuccessResponse(request, {
        sessions: await listRemoteSessionRows(this.root)
      });
    }
    if (request.type === 'read_snapshot') {
      try {
        return workerSuccessResponse(request, await this.readSnapshot(request.session_id));
      } catch (err: unknown) {
        const code = errorCode(err);
        return workerErrorResponse(request.id, request.type, code, { message: code });
      }
    }
    if (request.type === 'watch') {
      const watched = await this.events.watch(request.after_seq, request.session_id);
      if (watched.cursor.gap) {
        return workerErrorResponse(request.id, request.type, 'event_cursor_gap', {
          message: 'event_cursor_gap:read_snapshot_required',
          details: { cursor: watched.cursor }
        });
      }
      const snapshot = request.session_id ? await this.readSnapshot(request.session_id).catch(() => null) : null;
      return workerSuccessResponse(request, snapshot ? { ...watched, snapshot } : watched);
    }
    if (request.type === 'prepare_cancel') {
      try {
        return workerSuccessResponse(request, await this.prepareCancel(request.session_id, request.command_id));
      } catch (err: unknown) {
        const code = errorCode(err);
        return workerErrorResponse(request.id, request.type, code, { message: code });
      }
    }
    return this.handleCommand(request);
  }

  private async handleCommand(request: Extract<WorkerRequestV1, { type: 'command' }>): Promise<WorkerResponseV1> {
    const envelope = request.envelope;
    if (envelope.machine_id !== this.machine.id) {
      return workerErrorResponse(request.id, request.type, 'command_machine_mismatch');
    }
    if (envelope.project_id !== this.projectId) {
      return workerErrorResponse(request.id, request.type, 'command_project_mismatch');
    }
    const claim = await this.commands.claim(envelope);
    if (claim.status === 'idempotency_conflict') {
      return workerErrorResponse(request.id, request.type, 'idempotency_key_conflict');
    }
    if (claim.status === 'duplicate_inflight') {
      return workerErrorResponse(request.id, request.type, 'command_already_inflight', {
        delivery: 'unknown',
        message: 'command_already_inflight:no_automatic_replay'
      });
    }
    if (claim.status === 'duplicate_completed') {
      const receipt = claim.receipt;
      return receipt.status === 'completed'
        ? workerSuccessResponse(request, { duplicate: true, result: receipt.result ?? null }, { receipt })
        : { ...workerErrorResponse(request.id, request.type, receipt.error?.code ?? 'duplicate_failed_command', {
            ...(receipt.error?.message ? { message: receipt.error.message } : {}),
            retryable: false,
            delivery: receipt.error?.delivery ?? 'acknowledged'
          }), receipt };
    }

    await this.audit.append({
      event: 'command_received',
      command_id: envelope.command_id,
      idempotency_key_hash: claim.request_hash,
      machine_id: envelope.machine_id,
      project_id: envelope.project_id,
      session_id: envelope.session_id,
      kind: envelope.kind,
      risk: envelope.risk
    });
    let receipt: RemoteCommandReceiptV1;
    try {
      const executed = await this.executeCommand(envelope);
      receipt = {
        schema: REMOTE_COMMAND_RECEIPT_SCHEMA,
        command_id: envelope.command_id,
        idempotency_key: envelope.idempotency_key,
        machine_id: envelope.machine_id,
        project_id: envelope.project_id,
        session_id: envelope.session_id,
        kind: envelope.kind,
        status: 'completed',
        side_effect_applied: executed.sideEffectApplied,
        completed_at: new Date(this.now()).toISOString(),
        result: executed.result
      };
    } catch (err: unknown) {
      const executionError = normalizeExecutionError(err);
      receipt = {
        schema: REMOTE_COMMAND_RECEIPT_SCHEMA,
        command_id: envelope.command_id,
        idempotency_key: envelope.idempotency_key,
        machine_id: envelope.machine_id,
        project_id: envelope.project_id,
        session_id: envelope.session_id,
        kind: envelope.kind,
        status: 'failed',
        side_effect_applied: executionError.delivery === 'not_dispatched' ? false : 'unknown',
        completed_at: new Date(this.now()).toISOString(),
        error: {
          code: executionError.code,
          message: executionError.message,
          retryable: executionError.retryable,
          delivery: executionError.delivery
        }
      };
    }
    await this.commands.complete(envelope, receipt);
    await this.audit.append({
      event: 'command_completed',
      command_id: envelope.command_id,
      session_id: envelope.session_id,
      kind: envelope.kind,
      status: receipt.status,
      side_effect_applied: receipt.side_effect_applied,
      error_code: receipt.error?.code ?? null
    });
    await this.events.append({
      type: `remote.command.${receipt.status}`,
      session_id: envelope.session_id,
      command_id: envelope.command_id,
      summary: {
        kind: envelope.kind,
        risk: envelope.risk,
        status: receipt.status,
        side_effect_applied: receipt.side_effect_applied,
        error_code: receipt.error?.code ?? null
      }
    });
    if (receipt.status === 'failed') {
      return {
        ...workerErrorResponse(request.id, request.type, receipt.error?.code ?? 'remote_command_failed', {
          ...(receipt.error?.message ? { message: receipt.error.message } : {}),
          ...(receipt.error?.retryable === undefined ? {} : { retryable: receipt.error.retryable }),
          ...(receipt.error?.delivery === undefined ? {} : { delivery: receipt.error.delivery })
        }),
        receipt
      };
    }
    return workerSuccessResponse(request, receipt.result ?? null, { receipt });
  }

  private async executeCommand(envelope: RemoteCommandEnvelopeV1): Promise<{ readonly result: unknown; readonly sideEffectApplied: boolean }> {
    if (envelope.kind === 'read') {
      const result = envelope.session_id
        ? await readRemoteSessionView({
          root: this.root,
          machineId: this.machine.id,
          projectId: this.projectId,
          sessionId: envelope.session_id,
          view: String(envelope.payload.view ?? 'status')
        })
        : { sessions: await listRemoteSessionRows(this.root) };
      return { result, sideEffectApplied: false };
    }
    const sessionId = envelope.session_id;
    if (!sessionId) throw new RemoteWorkerExecutionError('command_session_id_required');
    const session = await remoteSessionRecord(this.root, sessionId).catch((err: unknown) => {
      throw new RemoteWorkerExecutionError(errorMessage(err));
    });
    if (envelope.kind === 'verify') {
      return {
        result: await readRemoteSessionView({
          root: this.root,
          machineId: this.machine.id,
          projectId: this.projectId,
          sessionId,
          view: 'verify'
        }),
        sideEffectApplied: false
      };
    }
    const owner = await this.owners.read(sessionId);
    if (!owner) throw new RemoteWorkerExecutionError('remote_session_binding_missing');
    await this.assertSessionBinding(owner, session.state);
    if (envelope.kind === 'input') {
      const text = String(envelope.payload.text ?? '').trim();
      if (!text || Buffer.byteLength(text) > 16 * 1024) throw new RemoteWorkerExecutionError('input_text_invalid');
      if (!owner.codex_thread_id || !owner.active_turn_id) throw new RemoteWorkerExecutionError('codex_turn_binding_missing');
      const client = await this.codexClientFactory(this.root).catch((err: unknown) => {
        if (err instanceof CodexAppServerRuntimeEnvError) {
          throw new RemoteWorkerExecutionError(err.code, 'not_dispatched', true);
        }
        throw new RemoteWorkerExecutionError('codex_app_server_unavailable', 'not_dispatched', true);
      });
      try {
        await client.initialize();
        if (!client.steerTurn) throw new Error('codex_turn_steer_unavailable');
        await client.steerTurn({
          threadId: owner.codex_thread_id,
          clientUserMessageId: crypto.randomUUID(),
          expectedTurnId: owner.active_turn_id,
          input: [{ type: 'text', text }]
        });
      } catch (err: unknown) {
        void err;
        throw new RemoteWorkerExecutionError('input_delivery_unknown', 'unknown', false);
      } finally {
        await client.close().catch(() => undefined);
      }
      return {
        result: { accepted: true, control: 'codex_app_server_v2', expected_turn_precondition: true },
        sideEffectApplied: true
      };
    }
    const payload = parseRemoteCancelPayload(envelope.payload);
    const cancelOptions: Parameters<typeof cancelOwnedSession>[0] = {
      root: this.root,
      envelope,
      payload,
      store: this.owners,
      currentGeneration: remoteSessionGeneration(session.state),
      now: this.now,
      ...(this.inspectProcess === undefined ? {} : { inspectProcess: this.inspectProcess }),
      ...(this.killProcess === undefined ? {} : { killProcess: this.killProcess })
    };
    const result = await cancelOwnedSession(cancelOptions);
    return { result, sideEffectApplied: true };
  }

  private async assertSessionBinding(owner: RemoteOwnerProofV1, state: JsonObject): Promise<void> {
    if (owner.project_id !== this.projectId) throw new RemoteWorkerExecutionError('session_binding_project_mismatch');
    const ownerRoot = await fsp.realpath(owner.project_root).catch(() => null);
    const workerRoot = await fsp.realpath(this.root).catch(() => null);
    if (!ownerRoot || !workerRoot || ownerRoot !== workerRoot) throw new RemoteWorkerExecutionError('session_binding_root_mismatch');
    if (owner.active_generation !== remoteSessionGeneration(state)) throw new RemoteWorkerExecutionError('session_binding_generation_stale');
  }

  private async prepareCancel(sessionId: string, commandId: string): Promise<JsonObject> {
    const session = await remoteSessionRecord(this.root, sessionId).catch((err: unknown) => {
      throw new RemoteWorkerExecutionError(errorMessage(err));
    });
    const owner = await this.owners.read(sessionId);
    if (!owner) throw new RemoteWorkerExecutionError('remote_session_binding_missing');
    await this.assertSessionBinding(owner, session.state);
    return {
      schema: 'sks.remote-cancel-challenge.v1',
      command_id: commandId,
      session_id: sessionId,
      owner_nonce: owner.owner_nonce,
      expected_pid: owner.pid,
      expected_process_start_time: owner.process_start_time,
      expected_command: owner.expected_command,
      expected_project_root: owner.project_root,
      expected_generation: owner.active_generation
    };
  }

  private async readSnapshot(sessionId: string): Promise<JsonObject> {
    return readRemoteSessionSnapshot({
      root: this.root,
      machineId: this.machine.id,
      projectId: this.projectId,
      sessionId
    });
  }
}

async function defaultCodexClientFactory(cwd: string): Promise<RemoteCodexControlClient> {
  const env = await prepareCodexAppServerRuntimeEnv();
  const created = await createCodexAppServerV2Client({
    cwd,
    env,
    requestedBy: 'remote-worker'
  });
  return created.client;
}

function normalizeExecutionError(err: unknown): RemoteWorkerExecutionError {
  if (err instanceof RemoteWorkerExecutionError) return err;
  if (err instanceof RemoteOwnerProofError) return new RemoteWorkerExecutionError(err.code);
  if (err instanceof RemoteProtocolError) return new RemoteWorkerExecutionError(err.code);
  return new RemoteWorkerExecutionError('remote_command_failed', 'unknown');
}

function errorCode(err: unknown): string {
  if (err instanceof RemoteWorkerExecutionError || err instanceof RemoteOwnerProofError || err instanceof RemoteProtocolError) return err.code;
  return 'remote_worker_failed';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

