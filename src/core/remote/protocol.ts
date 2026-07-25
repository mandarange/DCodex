import { once } from 'node:events';
import {
  REMOTE_COMMAND_SCHEMA,
  REMOTE_WORKER_REQUEST_SCHEMA,
  REMOTE_WORKER_RESPONSE_SCHEMA,
  type RemoteCommandEnvelopeV1,
  type RemoteWorkerErrorV1,
  type RemoteWorkerRequestType,
  type WorkerRequestV1,
  type WorkerResponseV1
} from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

export const DEFAULT_REMOTE_MAX_LINE_BYTES = 64 * 1024;
export const DEFAULT_REMOTE_MAX_RESPONSE_BYTES = 512 * 1024;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REMOTE_READ_VIEWS = new Set(['status', 'tail', 'diff', 'gates', 'trust', 'proof', 'artifacts', 'refresh', 'open']);

export class RemoteProtocolError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'RemoteProtocolError';
  }
}

export function parseWorkerRequestLine(line: string, now: number = Date.now()): WorkerRequestV1 {
  if (Buffer.byteLength(line) > DEFAULT_REMOTE_MAX_LINE_BYTES) throw new RemoteProtocolError('request_line_too_large');
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new RemoteProtocolError('request_json_invalid');
  }
  return validateWorkerRequest(value, now);
}

export function validateWorkerRequest(value: unknown, now: number = Date.now()): WorkerRequestV1 {
  const record = asRecord(value);
  if (!record || record.schema !== REMOTE_WORKER_REQUEST_SCHEMA) throw new RemoteProtocolError('request_schema_invalid');
  const id = identifier(record.id, 'request_id');
  const type = record.type;
  if (type === 'hello') {
    exactKeys(record, ['schema', 'id', 'type']);
    return { schema: REMOTE_WORKER_REQUEST_SCHEMA, id, type };
  }
  if (type === 'list_sessions') {
    exactKeys(record, ['schema', 'id', 'type']);
    return { schema: REMOTE_WORKER_REQUEST_SCHEMA, id, type };
  }
  if (type === 'read_snapshot') {
    exactKeys(record, ['schema', 'id', 'type', 'session_id']);
    return { schema: REMOTE_WORKER_REQUEST_SCHEMA, id, type, session_id: identifier(record.session_id, 'session_id') };
  }
  if (type === 'watch') {
    exactKeys(record, ['schema', 'id', 'type', 'after_seq', 'session_id']);
    const afterSeq = nonNegativeInteger(record.after_seq, 'after_seq');
    const sessionId = record.session_id === undefined ? undefined : identifier(record.session_id, 'session_id');
    return sessionId === undefined
      ? { schema: REMOTE_WORKER_REQUEST_SCHEMA, id, type, after_seq: afterSeq }
      : { schema: REMOTE_WORKER_REQUEST_SCHEMA, id, type, after_seq: afterSeq, session_id: sessionId };
  }
  if (type === 'prepare_cancel') {
    exactKeys(record, ['schema', 'id', 'type', 'session_id', 'command_id']);
    return {
      schema: REMOTE_WORKER_REQUEST_SCHEMA,
      id,
      type,
      session_id: identifier(record.session_id, 'session_id'),
      command_id: identifier(record.command_id, 'command_id')
    };
  }
  if (type === 'command') {
    exactKeys(record, ['schema', 'id', 'type', 'envelope']);
    return { schema: REMOTE_WORKER_REQUEST_SCHEMA, id, type, envelope: validateRemoteCommandEnvelope(record.envelope, now) };
  }
  throw new RemoteProtocolError('request_type_unsupported', { type: String(type ?? '') });
}

export function validateRemoteCommandEnvelope(value: unknown, now: number = Date.now()): RemoteCommandEnvelopeV1 {
  const record = asRecord(value);
  if (!record || record.schema !== REMOTE_COMMAND_SCHEMA) throw new RemoteProtocolError('command_schema_invalid');
  exactKeys(record, [
    'schema', 'command_id', 'issued_at', 'expires_at', 'actor', 'machine_id', 'project_id',
    'session_id', 'kind', 'risk', 'payload', 'idempotency_key'
  ]);
  const commandId = identifier(record.command_id, 'command_id');
  const issuedAt = timestamp(record.issued_at, 'issued_at');
  const expiresAt = timestamp(record.expires_at, 'expires_at');
  if (issuedAt > now + 30_000) throw new RemoteProtocolError('command_issued_from_future');
  if (expiresAt <= now) throw new RemoteProtocolError('command_expired');
  if (expiresAt <= issuedAt) throw new RemoteProtocolError('command_expiry_precedes_issue');
  if (expiresAt - issuedAt > 15 * 60_000) throw new RemoteProtocolError('command_ttl_exceeds_15m');
  if (record.actor !== 'telegram-owner') throw new RemoteProtocolError('command_actor_invalid');
  const machineId = identifier(record.machine_id, 'machine_id');
  const projectId = identifier(record.project_id, 'project_id');
  const sessionId = record.session_id === null ? null : identifier(record.session_id, 'session_id');
  const kind = record.kind;
  const risk = record.risk;
  if (kind !== 'input' && kind !== 'verify' && kind !== 'cancel' && kind !== 'read') throw new RemoteProtocolError('command_kind_invalid');
  if (risk !== 'R0' && risk !== 'R1' && risk !== 'R2') throw new RemoteProtocolError('command_risk_invalid_or_r3_denied');
  const expectedRisk = kind === 'read' ? 'R0' : kind === 'cancel' ? 'R2' : 'R1';
  if (risk !== expectedRisk) throw new RemoteProtocolError('command_risk_kind_mismatch', { expected_risk: expectedRisk });
  if (kind !== 'read' && !sessionId) throw new RemoteProtocolError('command_session_id_required');
  const payload = asRecord(record.payload);
  if (!payload) throw new RemoteProtocolError('command_payload_object_required');
  if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024) throw new RemoteProtocolError('command_payload_too_large');
  if (kind === 'input') boundedString(payload.text, 'input_text', 16 * 1024);
  if (kind === 'read' && payload.view !== undefined) {
    const view = boundedString(payload.view, 'read_view', 32);
    if (!REMOTE_READ_VIEWS.has(view)) throw new RemoteProtocolError('command_read_view_unsupported');
  }
  const idempotencyKey = identifier(record.idempotency_key, 'idempotency_key');
  return {
    schema: REMOTE_COMMAND_SCHEMA,
    command_id: commandId,
    issued_at: String(record.issued_at),
    expires_at: String(record.expires_at),
    actor: 'telegram-owner',
    machine_id: machineId,
    project_id: projectId,
    session_id: sessionId,
    kind,
    risk,
    payload,
    idempotency_key: idempotencyKey
  };
}

export function workerSuccessResponse(request: WorkerRequestV1, data: unknown, extras: Pick<WorkerResponseV1, 'receipt'> = {}): WorkerResponseV1 {
  const base: WorkerResponseV1 = {
    schema: REMOTE_WORKER_RESPONSE_SCHEMA,
    id: request.id,
    type: request.type,
    ok: true,
    data
  };
  return extras.receipt ? { ...base, receipt: extras.receipt } : base;
}

export function workerErrorResponse(
  id: string,
  type: RemoteWorkerRequestType,
  code: string,
  options: { message?: string; retryable?: boolean; delivery?: RemoteWorkerErrorV1['delivery']; details?: Record<string, unknown> } = {}
): WorkerResponseV1 {
  const error: RemoteWorkerErrorV1 = {
    code,
    message: options.message ?? code,
    retryable: options.retryable === true,
    delivery: options.delivery ?? 'acknowledged',
    ...(options.details ? { details: options.details } : {})
  };
  return { schema: REMOTE_WORKER_RESPONSE_SCHEMA, id, type, ok: false, error };
}

export async function runRemoteWorkerJsonl(options: {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly handle: (request: WorkerRequestV1) => Promise<WorkerResponseV1>;
  readonly maxLineBytes?: number;
  readonly maxResponseBytes?: number;
  readonly now?: () => number;
}): Promise<void> {
  const maxLineBytes = Math.max(1024, options.maxLineBytes ?? DEFAULT_REMOTE_MAX_LINE_BYTES);
  const maxResponseBytes = Math.max(4096, options.maxResponseBytes ?? DEFAULT_REMOTE_MAX_RESPONSE_BYTES);
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  let ended = false;

  const processLine = (lineBuffer: Buffer) => {
    queue = queue.then(async () => {
      if (lineBuffer.length === 0) return;
      if (lineBuffer.length > maxLineBytes) {
        await writeResponse(options.output, workerErrorResponse('unknown', 'hello', 'request_line_too_large'), maxResponseBytes);
        return;
      }
      let request: WorkerRequestV1;
      try {
        request = validateWorkerRequest(JSON.parse(lineBuffer.toString('utf8')), options.now?.() ?? Date.now());
      } catch (err: unknown) {
        const code = err instanceof RemoteProtocolError ? err.code : 'request_json_invalid';
        const details = err instanceof RemoteProtocolError ? err.details : undefined;
        await writeResponse(options.output, workerErrorResponse('unknown', 'hello', code, details ? { details } : {}), maxResponseBytes);
        return;
      }
      let response: WorkerResponseV1;
      try {
        response = await options.handle(request);
      } catch (err: unknown) {
        const code = err instanceof RemoteProtocolError ? err.code : 'worker_handler_failed';
        response = workerErrorResponse(request.id, request.type, code, {
          message: code,
          ...(err instanceof RemoteProtocolError && Object.keys(err.details).length ? { details: err.details } : {})
        });
      }
      await writeResponse(options.output, response, maxResponseBytes);
    });
  };

  options.input.on('data', (chunk: Buffer | string) => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, incoming]);
    let newline = buffer.indexOf(0x0a);
    while (newline >= 0) {
      let line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      processLine(line);
      newline = buffer.indexOf(0x0a);
    }
    if (buffer.length > maxLineBytes) {
      const oversized = buffer;
      buffer = Buffer.alloc(0);
      processLine(oversized);
    }
  });
  options.input.once('end', () => {
    ended = true;
    if (buffer.length > 0) processLine(buffer);
    buffer = Buffer.alloc(0);
  });
  options.input.once('error', () => {
    ended = true;
  });
  if (!ended) await Promise.race([once(options.input, 'end'), once(options.input, 'error')]);
  await queue;
}

async function writeResponse(output: NodeJS.WritableStream, response: WorkerResponseV1, maxBytes: number): Promise<void> {
  let line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line) > maxBytes) {
    line = `${JSON.stringify(workerErrorResponse(response.id, response.type, 'response_output_limit_exceeded'))}\n`;
  }
  if (!output.write(line)) await once(output, 'drain');
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length) throw new RemoteProtocolError('unexpected_request_fields', { fields: unexpected });
}

function identifier(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value : '';
  if (!IDENTIFIER_RE.test(text)) throw new RemoteProtocolError(`${field}_invalid`);
  return text;
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || Buffer.byteLength(text) > maxBytes) throw new RemoteProtocolError(`${field}_invalid`);
  return text;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RemoteProtocolError(`${field}_invalid`);
  return number;
}

function timestamp(value: unknown, field: string): number {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  if (!Number.isFinite(parsed)) throw new RemoteProtocolError(`${field}_invalid`);
  return parsed;
}
