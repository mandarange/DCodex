import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCodexAppServerV2Client } from '../codex-control/codex-app-server-v2-client.js';
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
  RemoteCodexSessionBindingStore,
  readRemoteCodexBindingSnapshot,
  remoteCodexBindingSessionRow,
  remoteCodexSessionBindingsPath
} from './session-binding.js';
import {
  listRemoteSessionRows,
  readRemoteSessionView,
  readRemoteSessionSnapshot,
  remoteSessionGeneration,
  remoteSessionRecord
} from './session-snapshot.js';
import {
  REMOTE_COMMAND_RECEIPT_SCHEMA,
  type RemoteCodexSessionBindingV1,
  type RemoteCommandEnvelopeV1,
  type RemoteCommandReceiptV1,
  type RemoteMachineV1,
  type RemoteOwnerProofV1,
  type WorkerRequestV1,
  type WorkerResponseV1
} from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

type JsonObject = Record<string, unknown>;

export interface RemoteCodexControlClient {
  readonly initialize: () => Promise<unknown>;
  readonly startThread?: (params: JsonObject) => Promise<unknown>;
  readonly resumeThread?: (params: JsonObject) => Promise<unknown>;
  readonly startTurn?: (params: JsonObject) => Promise<unknown>;
  readonly readThread?: (threadId: string, includeTurns?: boolean) => Promise<unknown>;
  readonly waitForTurnCompletion?: (threadId: string, turnId?: string | null, timeoutMs?: number) => Promise<JsonObject>;
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
  readonly bindings?: RemoteCodexSessionBindingStore;
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
  private readonly bindings: RemoteCodexSessionBindingStore;
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
    this.events = options.events ?? new RemoteEventJournal(paths.events, { lockPath: paths.eventLock });
    this.owners = options.owners ?? new RemoteOwnerProofStore(paths.owners);
    this.bindings = options.bindings ?? new RemoteCodexSessionBindingStore(remoteCodexSessionBindingsPath(this.root));
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
      const [sessions, bindings] = await Promise.all([
        listRemoteSessionRows(this.root),
        this.bindings.list()
      ]);
      const bindingRows: JsonObject[] = [];
      for (const binding of bindings) {
        try {
          await this.assertCodexBinding(binding);
          bindingRows.push(remoteCodexBindingSessionRow(binding));
        } catch {}
      }
      const bindingIds = new Set(bindingRows.map((row) => String(row.session_id)));
      return workerSuccessResponse(request, {
        sessions: [...bindingRows, ...sessions.filter((row) => !bindingIds.has(String(row.session_id)))]
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
      const binding = envelope.session_id ? await this.bindings.find(envelope.session_id) : null;
      let result: unknown;
      if (binding) {
        await this.assertCodexBinding(binding);
        result = {
          ...(await readRemoteCodexBindingSnapshot(binding)),
          requested_view: String(envelope.payload.view ?? 'status')
        };
      } else {
        result = envelope.session_id
          ? await readRemoteSessionView({
            root: this.root,
            machineId: this.machine.id,
            projectId: this.projectId,
            sessionId: envelope.session_id,
            view: String(envelope.payload.view ?? 'status')
          })
          : { sessions: await listRemoteSessionRows(this.root) };
      }
      return { result, sideEffectApplied: false };
    }
    const sessionId = envelope.session_id;
    if (!sessionId) throw new RemoteWorkerExecutionError('command_session_id_required');
    const binding = await this.bindings.find(sessionId);
    if (binding) {
      await this.assertCodexBinding(binding);
      if (envelope.kind === 'verify') {
        return {
          result: { ...(await readRemoteCodexBindingSnapshot(binding)), requested_view: 'verify' },
          sideEffectApplied: false
        };
      }
      if (envelope.kind === 'input') {
        const text = String(envelope.payload.text ?? '').trim();
        if (!text || Buffer.byteLength(text) > 16 * 1024) throw new RemoteWorkerExecutionError('input_text_invalid');
        return {
          result: await this.runDedicatedCodexTurn(binding, text),
          sideEffectApplied: true
        };
      }
      throw new RemoteWorkerExecutionError('dedicated_codex_cancel_unavailable');
    }
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
        void err;
        throw new RemoteWorkerExecutionError('codex_app_server_unavailable', 'not_dispatched', true);
      });
      try {
        await client.initialize();
        if (!client.steerTurn) throw new Error('codex_turn_steer_unavailable');
        await client.steerTurn({
          threadId: owner.codex_thread_id,
          clientUserMessageId: crypto.randomUUID(),
          expectedTurnId: owner.active_turn_id,
          input: [{ type: 'text', text, text_elements: [] }]
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
    const binding = await this.bindings.find(sessionId);
    if (binding) {
      await this.assertCodexBinding(binding);
      throw new RemoteWorkerExecutionError('dedicated_codex_cancel_unavailable');
    }
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
    const binding = await this.bindings.find(sessionId);
    if (binding) {
      await this.assertCodexBinding(binding);
      return readRemoteCodexBindingSnapshot(binding);
    }
    return readRemoteSessionSnapshot({
      root: this.root,
      machineId: this.machine.id,
      projectId: this.projectId,
      sessionId
    });
  }

  private async assertCodexBinding(binding: {
    readonly machine_id: string;
    readonly project_id: string;
    readonly project_root: string;
  }): Promise<void> {
    if (binding.machine_id !== this.machine.id) throw new RemoteWorkerExecutionError('session_binding_machine_mismatch');
    if (binding.project_id !== this.projectId) throw new RemoteWorkerExecutionError('session_binding_project_mismatch');
    const [bindingRoot, workerRoot] = await Promise.all([
      fsp.realpath(binding.project_root).catch(() => null),
      fsp.realpath(this.root).catch(() => null)
    ]);
    if (!bindingRoot || !workerRoot || bindingRoot !== workerRoot) {
      throw new RemoteWorkerExecutionError('session_binding_root_mismatch');
    }
  }

  private async runDedicatedCodexTurn(binding: RemoteCodexSessionBindingV1, text: string): Promise<JsonObject> {
    const client = await this.codexClientFactory(this.root).catch(() => {
      throw new RemoteWorkerExecutionError('codex_app_server_unavailable', 'not_dispatched', true);
    });
    const threadWasPersisted = Boolean(binding.codex_thread_id);
    let threadId = binding.codex_thread_id;
    let turnId: string | null = null;
    try {
      await client.initialize();
      if (!client.resumeThread || !client.startTurn || !client.readThread || !client.waitForTurnCompletion) {
        throw new RemoteWorkerExecutionError('codex_app_server_session_api_unavailable', 'not_dispatched', false);
      }
      if (threadId) {
        try {
          const resumed = asRecord(await client.resumeThread({
            threadId,
            cwd: this.root,
            approvalPolicy: 'never',
            sandbox: 'workspace-write'
          }));
          const resumedThread = asRecord(resumed?.thread);
          if (String(resumedThread?.id ?? '') !== threadId) throw new Error('codex_thread_resume_mismatch');
          const status = asRecord(resumedThread?.status);
          const statusType = String(status?.type ?? '');
          if (statusType === 'active') {
            throw new RemoteWorkerExecutionError('codex_thread_busy', 'not_dispatched', true);
          }
          if (statusType !== 'idle') {
            throw new RemoteWorkerExecutionError('codex_thread_not_ready', 'not_dispatched', true);
          }
        } catch (err: unknown) {
          if (err instanceof RemoteWorkerExecutionError) throw err;
          const missingRollout = isMissingCodexRolloutError(err);
          if (binding.last_turn_id) {
            throw new RemoteWorkerExecutionError(
              missingRollout ? 'codex_thread_history_missing' : 'codex_thread_resume_failed',
              'not_dispatched',
              !missingRollout
            );
          }
          if (!missingRollout) {
            throw new RemoteWorkerExecutionError('codex_thread_resume_failed', 'not_dispatched', true);
          }
          threadId = null;
        }
      }
      if (!threadId) {
        if (!client.startThread) {
          throw new RemoteWorkerExecutionError('codex_app_server_session_api_unavailable', 'not_dispatched', false);
        }
        const started = asRecord(await client.startThread({
          cwd: this.root,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          threadSource: 'sks-telegram',
          baseInstructions: 'This is a dedicated private Telegram coding thread. Work only inside the configured project workspace, never expose secrets, and return a concise user-facing final response for each turn.'
        }).catch(() => {
          throw new RemoteWorkerExecutionError('codex_thread_start_failed', 'not_dispatched', true);
        }));
        threadId = stringValue(asRecord(started?.thread)?.id);
        if (!threadId) throw new Error('codex_thread_start_missing_id');
      }
      const started = asRecord(await client.startTurn({
        threadId,
        cwd: this.root,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [this.root],
          networkAccess: false
        },
        clientUserMessageId: crypto.randomUUID(),
        input: [{ type: 'text', text, text_elements: [] }]
      }));
      turnId = stringValue(asRecord(started?.turn)?.id);
      if (!turnId) throw new Error('codex_turn_id_missing');
      await client.waitForTurnCompletion(threadId, turnId, 30 * 60_000);
      const read = asRecord(await client.readThread(threadId, true));
      const thread = asRecord(read?.thread);
      if (String(thread?.id ?? '') !== threadId) throw new Error('codex_thread_read_mismatch');
      const turns = Array.isArray(thread?.turns) ? thread.turns.map(asRecord).filter(Boolean) as JsonObject[] : [];
      const turn = turns.find((candidate) => String(candidate.id ?? '') === turnId);
      if (!turn) throw new Error('codex_completed_turn_missing');
      const turnStatus = String(turn.status ?? '');
      if (turnStatus !== 'completed') {
        if (threadWasPersisted) {
          await this.bindings.recordTurn(
            binding.session_id,
            threadId,
            turnId,
            turnStatus === 'interrupted' ? 'interrupted' : 'failed'
          );
        }
        throw new RemoteWorkerExecutionError('codex_turn_failed', 'acknowledged', false);
      }
      const items = Array.isArray(turn.items) ? turn.items.map(asRecord).filter(Boolean) as JsonObject[] : [];
      const agentMessages = items
        .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
        .map((item) => ({ phase: String(item.phase ?? ''), text: String(item.text).trim() }))
        .filter((item) => Boolean(item.text));
      const finalMessage = agentMessages
        .filter((item) => item.phase === 'final_answer')
        .map((item) => item.text)
        .at(-1) ?? agentMessages
        .map((item) => item.text)
        .filter(Boolean)
        .at(-1);
      if (!finalMessage) throw new Error('codex_final_agent_message_missing');
      await this.bindings.recordTurn(binding.session_id, threadId, turnId, 'completed');
      return {
        accepted: true,
        control: 'codex_app_server_v2',
        thread_id: threadId,
        turn_id: turnId,
        turn_status: 'completed',
        final_response: finalMessage.slice(0, 16_000)
      };
    } catch (err: unknown) {
      if (err instanceof RemoteWorkerExecutionError) throw err;
      if (threadWasPersisted && turnId && threadId) {
        await this.bindings.recordTurn(binding.session_id, threadId, turnId, 'failed').catch(() => undefined);
      }
      throw new RemoteWorkerExecutionError(
        turnId ? 'codex_turn_failed' : 'input_delivery_unknown',
        turnId ? 'acknowledged' : 'unknown',
        false
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

async function defaultCodexClientFactory(cwd: string): Promise<RemoteCodexControlClient> {
  const created = await createCodexAppServerV2Client({ cwd, requestedBy: 'remote-worker' });
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

function stringValue(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function isMissingCodexRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id|thread(?:\/resume)?:? (?:thread )?(?:not found|not loaded)/i.test(message);
}
