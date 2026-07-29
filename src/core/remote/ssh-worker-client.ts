import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { runProcess } from '../fsx.js';
import { isLexicallyWithinAllowedRoot, validateSshAlias } from './machine-registry.js';
import {
  REMOTE_WORKER_REQUEST_SCHEMA,
  REMOTE_WORKER_RESPONSE_SCHEMA,
  type RemoteMachineV1,
  type RemoteSshClientStatusV1,
  type SksRemoteSessionState,
  type WorkerRequestV1,
  type WorkerResponseV1
} from './types.js';

const SSH_REMOTE_COMMAND_SAFE_PATH_RE = /^\/[A-Za-z0-9._\/-]*$/;

export class RemoteSshClientError extends Error {
  constructor(
    readonly code: string,
    readonly delivery: 'not_dispatched' | 'unknown' | 'acknowledged',
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'RemoteSshClientError';
  }
}

interface PendingResponse {
  readonly request: WorkerRequestV1;
  readonly resolve: (response: WorkerResponseV1) => void;
  readonly reject: (error: RemoteSshClientError) => void;
  readonly timer: NodeJS.Timeout;
  dispatched: boolean;
}

export interface RemoteSshWorkerClientOptions {
  readonly machine: RemoteMachineV1;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sshCommand?: string;
  readonly requestTimeoutMs?: number;
  readonly commandRequestTimeoutMs?: number;
  readonly maxResponseLineBytes?: number;
  readonly maxConnectionOutputBytes?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly spawnProcess?: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
  readonly loadSshConfig?: (command: string, alias: string) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RemoteSshWorkerClient {
  private readonly machine: RemoteMachineV1;
  private readonly projectRoot: string;
  private readonly projectId: string;
  private readonly sshCommand: string;
  private readonly requestTimeoutMs: number;
  private readonly commandRequestTimeoutMs: number;
  private readonly maxResponseLineBytes: number;
  private readonly maxConnectionOutputBytes: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly spawnProcess: NonNullable<RemoteSshWorkerClientOptions['spawnProcess']>;
  private readonly loadSshConfig: NonNullable<RemoteSshWorkerClientOptions['loadSshConfig']>;
  private readonly sleep: NonNullable<RemoteSshWorkerClientOptions['sleep']>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingResponse>();
  private stdoutBuffer = Buffer.alloc(0);
  private outputBytes = 0;
  private connectionState: RemoteSshClientStatusV1['connection_state'] = 'idle';
  private sessionState: SksRemoteSessionState = 'unknown';
  private reconnectAttempt = 0;
  private lastError: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private requestCounter = 0;

  constructor(options: RemoteSshWorkerClientOptions) {
    this.machine = options.machine;
    this.projectRoot = path.resolve(options.projectRoot);
    this.projectId = options.projectId;
    this.sshCommand = options.sshCommand ?? 'ssh';
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 30_000);
    this.commandRequestTimeoutMs = Math.max(
      1_000,
      options.commandRequestTimeoutMs
        ?? (options.requestTimeoutMs === undefined ? 31 * 60_000 : options.requestTimeoutMs)
    );
    this.maxResponseLineBytes = Math.max(4_096, options.maxResponseLineBytes ?? 512 * 1024);
    this.maxConnectionOutputBytes = Math.max(this.maxResponseLineBytes, options.maxConnectionOutputBytes ?? 8 * 1024 * 1024);
    this.reconnectAttempts = Math.max(1, Math.min(10, options.reconnectAttempts ?? 4));
    this.reconnectBaseMs = Math.max(10, options.reconnectBaseMs ?? 250);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, options.reconnectMaxMs ?? 4_000);
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.loadSshConfig = options.loadSshConfig ?? defaultLoadSshConfig;
    this.sleep = options.sleep ?? defaultSleep;
  }

  status(): RemoteSshClientStatusV1 {
    return {
      schema: 'sks.remote-ssh-client-status.v1',
      connection_state: this.connectionState,
      session_state: this.sessionState,
      reconnect_attempt: this.reconnectAttempt,
      last_error: this.lastError
    };
  }

  async connect(): Promise<void> {
    if (this.connectionState === 'connected' && this.child) return;
    if (this.connectionState === 'closed') throw new RemoteSshClientError('ssh_client_closed', 'not_dispatched', false);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithBackoff().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async request(request: WorkerRequestV1): Promise<WorkerResponseV1> {
    await this.connect();
    if (this.connectionState !== 'connected' || !this.child || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new RemoteSshClientError('disconnected_before_dispatch', 'not_dispatched', true);
    }
    return this.sendConnected(request);
  }

  async hello(): Promise<WorkerResponseV1> {
    return this.request({ schema: REMOTE_WORKER_REQUEST_SCHEMA, id: this.nextRequestId('hello'), type: 'hello' });
  }

  async close(): Promise<void> {
    this.connectionState = 'closed';
    const child = this.child;
    this.child = null;
    this.rejectPending('ssh_client_closed');
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
  }

  private async connectWithBackoff(): Promise<void> {
    this.connectionState = 'validating';
    if (!validateSshAlias(this.machine.ssh_alias)) throw new RemoteSshClientError('ssh_alias_invalid', 'not_dispatched', false);
    if (!isSshRemoteCommandSafePath(this.projectRoot)) {
      throw new RemoteSshClientError('project_root_ssh_unsafe', 'not_dispatched', false);
    }
    if (!isLexicallyWithinAllowedRoot(this.machine, this.projectRoot)) {
      throw new RemoteSshClientError('project_root_not_allowlisted', 'not_dispatched', false);
    }
    const config = await this.loadSshConfig(this.sshCommand, this.machine.ssh_alias).catch(() => {
      throw new RemoteSshClientError('ssh_config_probe_failed', 'not_dispatched', true);
    });
    const policy = validateSshHostKeyPolicy(config);
    if (!policy.ok) throw new RemoteSshClientError(`ssh_host_key_policy_invalid:${policy.issues.join(',')}`, 'not_dispatched', false);

    let last: RemoteSshClientError | null = null;
    for (let attempt = 1; attempt <= this.reconnectAttempts; attempt += 1) {
      this.reconnectAttempt = attempt;
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
        this.lastError = null;
        return;
      } catch (err: unknown) {
        last = err instanceof RemoteSshClientError
          ? err
          : new RemoteSshClientError('ssh_connect_failed', 'not_dispatched', true);
        this.lastError = last.code;
        this.connectionState = 'disconnected';
        this.terminateChild();
        if (attempt < this.reconnectAttempts) {
          const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** (attempt - 1)));
          await this.sleep(delay);
        }
      }
    }
    throw last ?? new RemoteSshClientError('ssh_connect_failed', 'not_dispatched', true);
  }

  private async connectOnce(): Promise<void> {
    this.connectionState = 'connecting';
    this.stdoutBuffer = Buffer.alloc(0);
    this.outputBytes = 0;
    const child = this.spawnProcess(this.sshCommand, buildSshWorkerArgs(this.machine, this.projectRoot, this.projectId));
    this.child = child;
    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdout(child, chunk));
    child.stderr.on('data', () => undefined);
    child.once('error', () => this.handleDisconnect(child, 'ssh_process_error'));
    child.once('close', (code, signal) => this.handleDisconnect(child, `ssh_worker_closed:${code ?? signal ?? 'unknown'}`));
    this.connectionState = 'connected';
    const hello: WorkerRequestV1 = { schema: REMOTE_WORKER_REQUEST_SCHEMA, id: this.nextRequestId('connect'), type: 'hello' };
    const response = await this.sendConnected(hello);
    if (!response.ok) throw new RemoteSshClientError(`ssh_worker_hello_failed:${response.error?.code ?? 'unknown'}`, 'acknowledged', true);
  }

  private sendConnected(request: WorkerRequestV1): Promise<WorkerResponseV1> {
    const child = this.child;
    if (!child || this.connectionState !== 'connected' || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new RemoteSshClientError('disconnected_before_dispatch', 'not_dispatched', true));
    }
    if (this.pending.has(request.id)) {
      return Promise.reject(new RemoteSshClientError('duplicate_request_id', 'not_dispatched', false));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.id);
        this.pending.delete(request.id);
        const delivery = pending?.dispatched ? 'unknown' : 'not_dispatched';
        reject(new RemoteSshClientError(
          delivery === 'unknown' ? 'delivery_unknown' : 'disconnected_before_dispatch',
          delivery,
          delivery === 'not_dispatched' || request.type !== 'command'
        ));
        this.abortConnection('ssh_request_timeout');
      }, request.type === 'command' ? this.commandRequestTimeoutMs : this.requestTimeoutMs);
      timer.unref?.();
      const pending: PendingResponse = { request, resolve, reject, timer, dispatched: false };
      this.pending.set(request.id, pending);
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
        pending.dispatched = true;
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        void err;
        reject(new RemoteSshClientError('disconnected_before_dispatch', 'not_dispatched', true));
      }
    });
  }

  private handleStdout(source: ChildProcessWithoutNullStreams, chunk: Buffer | string): void {
    if (this.child !== source) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.outputBytes += incoming.length;
    if (this.outputBytes > this.maxConnectionOutputBytes) {
      this.abortConnection('ssh_worker_output_cap_exceeded');
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, incoming]);
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > this.maxResponseLineBytes) {
        this.abortConnection('ssh_worker_response_line_too_large');
        return;
      }
      this.handleResponseLine(line.toString('utf8'));
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
    if (this.stdoutBuffer.length > this.maxResponseLineBytes) {
      this.abortConnection('ssh_worker_response_line_too_large');
    }
  }

  private handleResponseLine(line: string): void {
    if (!line.trim()) return;
    let response: WorkerResponseV1;
    try {
      response = JSON.parse(line) as WorkerResponseV1;
    } catch {
      this.abortConnection('ssh_worker_response_json_invalid');
      return;
    }
    if (response.schema !== REMOTE_WORKER_RESPONSE_SCHEMA || typeof response.id !== 'string') {
      this.abortConnection('ssh_worker_response_schema_invalid');
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type !== pending.request.type) {
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.reject(new RemoteSshClientError('ssh_worker_response_type_mismatch', 'acknowledged', false));
      return;
    }
    if (pending.request.type === 'command' && !response.receipt) {
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.reject(new RemoteSshClientError('side_effect_receipt_missing', 'unknown', false));
      this.abortConnection('side_effect_receipt_missing');
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    this.updateSessionState(response);
    pending.resolve(response);
  }

  private updateSessionState(response: WorkerResponseV1): void {
    const data = response.data;
    if (!data || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    const direct = String(record.session_state ?? '');
    if (direct === 'idle' || direct === 'active' || direct === 'terminal' || direct === 'blocked') {
      this.sessionState = direct;
      return;
    }
    const sessions = Array.isArray(record.sessions) ? record.sessions : [];
    const states = sessions.map((row) => String((row as Record<string, unknown>)?.session_state ?? ''));
    if (states.includes('active')) this.sessionState = 'active';
    else if (states.includes('blocked')) this.sessionState = 'blocked';
    else if (states.includes('terminal')) this.sessionState = 'terminal';
    else if (states.includes('idle')) this.sessionState = 'idle';
  }

  private handleDisconnect(source: ChildProcessWithoutNullStreams, code: string): void {
    if (this.connectionState === 'closed') return;
    if (this.child !== source) return;
    this.lastError = code;
    this.connectionState = 'disconnected';
    this.child = null;
    this.rejectPending(code);
  }

  private abortConnection(code: string): void {
    if (this.connectionState === 'closed') return;
    const child = this.child;
    this.lastError = code;
    this.connectionState = 'disconnected';
    this.child = null;
    this.rejectPending(code);
    if (child && !child.killed) child.kill('SIGTERM');
  }

  private rejectPending(code: string): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const delivery = pending.dispatched ? 'unknown' : 'not_dispatched';
      pending.reject(new RemoteSshClientError(
        delivery === 'unknown' ? 'delivery_unknown' : code,
        delivery,
        delivery === 'not_dispatched' || pending.request.type !== 'command'
      ));
    }
  }

  private terminateChild(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}:${this.requestCounter}`;
  }
}

export function buildSshWorkerArgs(machine: RemoteMachineV1, projectRoot: string, projectId: string): string[] {
  if (!validateSshAlias(machine.ssh_alias)) throw new RemoteSshClientError('ssh_alias_invalid', 'not_dispatched', false);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(machine.id)) throw new RemoteSshClientError('machine_id_invalid', 'not_dispatched', false);
  if (!isLexicallyWithinAllowedRoot(machine, projectRoot)) throw new RemoteSshClientError('project_root_not_allowlisted', 'not_dispatched', false);
  const resolvedProjectRoot = path.resolve(projectRoot);
  if (!isSshRemoteCommandSafePath(resolvedProjectRoot)) {
    throw new RemoteSshClientError('project_root_ssh_unsafe', 'not_dispatched', false);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(projectId)) throw new RemoteSshClientError('project_id_invalid', 'not_dispatched', false);
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ClearAllForwardings=yes',
    '--', machine.ssh_alias,
    'sks', 'remote', 'worker', '--stdio',
    '--machine', machine.id,
    '--project-root', resolvedProjectRoot,
    '--project-id', projectId
  ];
}

function isSshRemoteCommandSafePath(value: string): boolean {
  // OpenSSH joins arguments after the host into one command interpreted by the
  // remote login shell. Restrict the unquoted dynamic path to shell-neutral
  // ASCII bytes so it remains exactly one argument after that serialization.
  return SSH_REMOTE_COMMAND_SAFE_PATH_RE.test(value);
}

export function validateSshHostKeyPolicy(configText: string): { readonly ok: boolean; readonly issues: readonly string[] } {
  const values = new Map<string, string[]>();
  for (const line of configText.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    const key = match[1].toLowerCase();
    const list = values.get(key) ?? [];
    list.push(match[2].trim());
    values.set(key, list);
  }
  const issues: string[] = [];
  const strict = values.get('stricthostkeychecking')?.at(-1)?.toLowerCase();
  if (!strict) issues.push('strict_host_key_checking_missing');
  else if (strict === 'no' || strict === 'off' || strict === 'false') issues.push('strict_host_key_checking_disabled');
  const userKnown = values.get('userknownhostsfile') ?? [];
  const globalKnown = values.get('globalknownhostsfile') ?? [];
  const hasUsableKnownHosts = [...userKnown, ...globalKnown]
    .flatMap((value) => value.split(/\s+/))
    .some((value) => value !== '/dev/null' && value.toLowerCase() !== 'none');
  if (!hasUsableKnownHosts) issues.push('known_hosts_storage_disabled');
  return { ok: issues.length === 0, issues };
}

async function defaultLoadSshConfig(command: string, alias: string): Promise<string> {
  const result = await runProcess(command, ['-G', '--', alias], { timeoutMs: 10_000, maxOutputBytes: 512 * 1024 });
  if (result.code !== 0) throw new Error('ssh_config_probe_nonzero');
  return result.stdout;
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
