import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { nowIso, PACKAGE_VERSION } from '../fsx.js';
import { resolveCodexRuntime, type CodexRuntimeIdentity } from '../codex-runtime/resolve-codex-runtime.js';
import { prepareCodexAppServerRuntimeEnv } from './codex-app-server-runtime-env.js';

type JsonRpcId = number | string;
type JsonObject = Record<string, unknown>;

export type CodexAppServerRequestErrorKind =
  | 'rpc_rejection'
  | 'timeout'
  | 'transport'
  | 'process_exit'
  | 'protocol_overflow';

export class CodexAppServerRequestError extends Error {
  constructor(
    readonly method: string,
    readonly kind: CodexAppServerRequestErrorKind,
    message: string,
    readonly rpcCode: number | null = null
  ) {
    super(message);
    this.name = 'CodexAppServerRequestError';
  }
}

export interface CodexAppServerApprovalPolicy {
  readonly commandExecution?: (params: JsonObject) => JsonObject;
  readonly fileChange?: (params: JsonObject) => JsonObject;
  readonly permissions?: (params: JsonObject) => JsonObject;
  readonly toolRequestUserInput?: (params: JsonObject) => JsonObject;
  // Async host execution does not enable model-side Responses async tool calling.
  readonly dynamicToolCall?: (params: JsonObject, context: { readonly signal: AbortSignal }) => JsonObject | Promise<JsonObject>;
  readonly mcpElicitation?: (params: JsonObject) => JsonObject;
  readonly attestation?: (params: JsonObject) => JsonObject;
  readonly chatgptAuthTokensRefresh?: (params: JsonObject) => JsonObject;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export interface CodexAppServerCurrentTime {
  readonly utcIso: string;
  readonly unixTimeSeconds: number;
  readonly unixTimeMilliseconds: number;
  readonly timezone: 'UTC';
}

export interface CodexAppServerV2ClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxNotifications?: number;
  readonly maxNotificationBytes?: number;
  readonly maxPendingDynamicToolCalls?: number;
  readonly dynamicToolCallTimeoutMs?: number;
  readonly currentTimeProvider?: () => Date;
  readonly approvalPolicy?: CodexAppServerApprovalPolicy;
}

export interface CodexAppServerThreadListParams {
  readonly archived?: boolean | null;
  readonly cursor?: string | null;
  readonly cwd?: string | readonly string[] | null;
  readonly limit?: number | null;
  readonly modelProviders?: readonly string[] | null;
  readonly searchTerm?: string | null;
  readonly sortDirection?: 'asc' | 'desc' | null;
  readonly sortKey?: string | null;
  readonly sourceKinds?: readonly string[] | null;
  readonly useStateDbOnly?: boolean;
}

export interface CodexAppServerThreadTurnsListParams {
  readonly cursor?: string | null;
  readonly itemsView?: 'notLoaded' | 'summary' | 'full' | null;
  readonly limit?: number | null;
  readonly sortDirection?: 'asc' | 'desc' | null;
}

export interface CodexAppServerV2ClientFactoryOptions extends Omit<CodexAppServerV2ClientOptions, 'command'> {
  readonly codexBin?: string | null;
  readonly requestedBy?: string;
}

export class CodexAppServerV2Client {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxNotifications: number;
  readonly maxNotificationBytes: number;
  readonly maxPendingDynamicToolCalls: number;
  readonly dynamicToolCallTimeoutMs: number;
  readonly currentTimeProvider: () => Date;
  readonly approvalPolicy: CodexAppServerApprovalPolicy;
  child: ChildProcessWithoutNullStreams | null = null;
  nextId = 1;
  pending = new Map<JsonRpcId, PendingRequest>();
  notifications: JsonObject[] = [];
  notificationBytes = 0;
  listeners = new Set<(event: JsonObject) => void>();
  stdoutBuffer = '';
  stderr = '';
  private stopped = false;
  private processExited = false;
  private readonly dynamicToolCalls = new Set<{ cancel: () => void }>();

  constructor(options: CodexAppServerV2ClientOptions) {
    this.command = options.command;
    this.args = options.args || ['app-server', '--stdio'];
    this.env = options.env || process.env;
    this.cwd = options.cwd || process.cwd();
    this.timeoutMs = Number(options.timeoutMs || 20_000);
    this.maxFrameBytes = Math.max(1_024, Math.min(32 * 1024 * 1024, options.maxFrameBytes ?? 8 * 1024 * 1024));
    this.maxNotifications = Math.max(16, Math.min(8_192, options.maxNotifications ?? 2_048));
    this.maxNotificationBytes = Math.max(
      1_024,
      Math.min(64 * 1024 * 1024, options.maxNotificationBytes ?? 4 * 1024 * 1024)
    );
    this.currentTimeProvider = options.currentTimeProvider || (() => new Date());
    this.maxPendingDynamicToolCalls = boundedInteger(options.maxPendingDynamicToolCalls, 32, 256);
    this.dynamicToolCallTimeoutMs = boundedInteger(options.dynamicToolCallTimeoutMs, 20_000, 600_000);
    this.approvalPolicy = options.approvalPolicy || {};
  }

  async initialize(): Promise<unknown> {
    this.start();
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'sneakoscope-codex-app-server-v2',
        title: 'Sneakoscope Codex app-server v2',
        version: PACKAGE_VERSION
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
    this.notify('initialized', {});
    return result;
  }

  async listThreads(params: CodexAppServerThreadListParams = {}): Promise<unknown> {
    return await this.request('thread/list', normalizeThreadListParams(params));
  }

  async startThread(params: JsonObject = {}): Promise<unknown> {
    return await this.request('thread/start', params);
  }

  async resumeThread(params: JsonObject = {}): Promise<unknown> {
    return await this.request('thread/resume', params);
  }

  async searchThreads(searchTerm: string, params: Omit<CodexAppServerThreadListParams, 'searchTerm'> = {}): Promise<unknown> {
    return await this.listThreads({ ...params, searchTerm });
  }

  async readThread(threadId: string, includeTurns = false): Promise<unknown> {
    return await this.request('thread/read', { threadId, includeTurns });
  }

  async listThreadTurns(
    threadId: string,
    params: CodexAppServerThreadTurnsListParams = {}
  ): Promise<unknown> {
    return await this.request('thread/turns/list', {
      threadId,
      ...normalizeThreadListParams(params)
    });
  }

  async startTurn(params: JsonObject = {}): Promise<unknown> {
    return await this.request('turn/start', params);
  }

  async steerTurn(params: JsonObject = {}): Promise<unknown> {
    return await this.request('turn/steer', params);
  }

  async interruptTurn(params: JsonObject = {}): Promise<unknown> {
    return await this.request('turn/interrupt', params);
  }

  onEvent(listener: (event: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForNotification(methods: string | readonly string[], timeoutMs = this.timeoutMs): Promise<JsonObject> {
    const expected = new Set(Array.isArray(methods) ? methods.map(String) : [String(methods)]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`Timed out waiting for app-server notification: ${Array.from(expected).join(', ')}`));
      }, timeoutMs);
      timer.unref?.();
      const dispose = this.onEvent((event) => {
        if (event && expected.has(String(event.method || ''))) {
          clearTimeout(timer);
          dispose();
          resolve(event);
        }
      });
    });
  }

  async waitForTurnCompletion(threadId: string, turnId?: string | null, timeoutMs = this.timeoutMs): Promise<JsonObject> {
    const buffered = this.notifications.find((event) => isTurnCompletionEvent(event, threadId, turnId));
    if (buffered) return buffered;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`Timed out waiting for app-server turn completion: ${threadId}:${turnId ?? '*'}`));
      }, timeoutMs);
      timer.unref?.();
      const dispose = this.onEvent((event) => {
        const method = String(event.method || '');
        const params = event.params && typeof event.params === 'object'
          ? event.params as JsonObject
          : {};
        if (method === 'thread/closed' && String(params.threadId || '') === threadId) {
          clearTimeout(timer);
          dispose();
          reject(new Error(`Codex thread closed before turn completion: ${threadId}`));
          return;
        }
        if (!isTurnCompletionEvent(event, threadId, turnId)) return;
        clearTimeout(timer);
        dispose();
        resolve(event);
      });
    });
  }

  start(): void {
    if (this.stopped || this.processExited) throw new Error('Codex app-server client is closed');
    if (this.child) return;
    this.child = spawn(this.command, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: this.env,
      cwd: this.cwd
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-64 * 1024);
    });
    this.child.stdin.on('error', (err: Error) => this.stop(err, 'transport'));
    this.child.on('error', (err: Error) => this.stop(err, 'transport'));
    this.child.on('exit', () => {
      this.processExited = true;
      this.cancelDynamicToolCalls();
    });
    // Drain final stdout responses before rejecting remaining outbound requests.
    this.child.on('close', (code, signal) => {
      this.stop(
        new Error(`Codex app-server exited before response (code ${code ?? signal ?? 'unknown'}). ${this.stderr.trim()}`.trim()),
        'process_exit'
      );
    });
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.stopped || this.processExited) return Promise.reject(new CodexAppServerRequestError(method, 'transport', 'Codex app-server client is closed'));
    this.start();
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerRequestError(
          method,
          'timeout',
          `Codex app-server request timed out: ${method}. ${this.stderr.trim()}`.trim()
        ));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(message);
    });
  }

  notify(method: string, params: JsonObject): void {
    this.start();
    this.write({ jsonrpc: '2.0', method, params });
  }

  handleStdout(chunk: Buffer): void {
    if (this.stopped) return;
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxFrameBytes) {
      this.abortProtocol('codex_app_server_frame_too_large');
      return;
    }
    for (const line of lines) {
      if (this.stopped) return;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.abortProtocol('codex_app_server_frame_too_large');
        return;
      }
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      if (message.id !== undefined && typeof message.method === 'string') {
        void this.respondToServerRequest(message);
      } else if (message.id !== undefined && this.pending.has(message.id as JsonRpcId)) {
        this.resolvePending(message);
      } else {
        const event = { ...message, received_at: nowIso() };
        const eventBytes = notificationByteLength(event);
        if (eventBytes <= this.maxNotificationBytes) {
          this.notifications.push(event);
          this.notificationBytes += eventBytes;
          while (
            this.notifications.length > this.maxNotifications
            || this.notificationBytes > this.maxNotificationBytes
          ) {
            const removed = this.notifications.shift();
            if (!removed) break;
            this.notificationBytes = Math.max(0, this.notificationBytes - notificationByteLength(removed));
          }
        }
        for (const listener of this.listeners) {
          try { listener(event); } catch {}
        }
      }
    }
  }

  async respondToServerRequest(message: JsonObject): Promise<void> {
    if (this.stopped || this.processExited) return;
    const id = message.id as JsonRpcId;
    const method = String(message.method || '');
    try {
      if (method === 'currentTime/read') {
        this.write({ jsonrpc: '2.0', id, result: currentTimeResponse(this.currentTimeProvider()) });
        return;
      }
      if (method === 'item/commandExecution/requestApproval' || method === 'commandExecution/requestApproval') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.commandExecution?.(message.params as JsonObject) || { decision: 'cancel' } });
        return;
      }
      if (method === 'item/fileChange/requestApproval' || method === 'fileChange/requestApproval') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.fileChange?.(message.params as JsonObject) || { decision: 'cancel' } });
        return;
      }
      if (method === 'item/permissions/requestApproval' || method === 'permissions/requestApproval') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.permissions?.(message.params as JsonObject) || { permissions: { network: { enabled: false }, fileSystem: { read: [], write: [], entries: [] } }, scope: 'turn', strictAutoReview: true } });
        return;
      }
      if (method === 'item/tool/requestUserInput') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.toolRequestUserInput?.(message.params as JsonObject) || { answers: {} } });
        return;
      }
      if (method === 'item/tool/call') {
        await this.respondToDynamicToolCall(id, message.params as JsonObject);
        return;
      }
      if (method === 'mcpServer/elicitation/request') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.mcpElicitation?.(message.params as JsonObject) || { contentItems: [], success: false } });
        return;
      }
      if (method === 'attestation/generate') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.attestation?.(message.params as JsonObject) || { decision: 'cancel' } });
        return;
      }
      if (method === 'account/chatgptAuthTokens/refresh') {
        this.write({ jsonrpc: '2.0', id, result: this.approvalPolicy.chatgptAuthTokensRefresh?.(message.params as JsonObject) || { ok: false } });
        return;
      }
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unsupported Codex app-server request: ${method}` }
      });
    } catch (err: unknown) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
      });
    }
  }

  resolvePending(message: JsonObject): void {
    const id = message.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CodexAppServerRequestError(
        pending.method,
        'rpc_rejection',
        jsonRpcErrorMessage(pending.method, message.error),
        jsonRpcErrorCode(message.error)
      ));
    }
    else pending.resolve(message.result);
  }

  rejectAll(
    err: Error,
    kind: Extract<CodexAppServerRequestErrorKind, 'transport' | 'process_exit' | 'protocol_overflow'>
  ): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerRequestError(
        pending.method,
        kind,
        err.message
      ));
      this.pending.delete(id);
    }
  }

  async close(): Promise<void> {
    this.stop(new Error('Codex app-server client is closed'), 'transport');
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.stdin.end();
    child.kill('SIGTERM');
  }

  private write(message: JsonObject): void {
    if (this.stopped || this.processExited) return;
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private respondToDynamicToolCall(id: JsonRpcId, params: JsonObject): Promise<void> {
    const handler = this.approvalPolicy.dynamicToolCall;
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, result: { contentItems: [], success: false } });
      return Promise.resolve();
    }
    if (this.dynamicToolCalls.size >= this.maxPendingDynamicToolCalls) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Codex dynamic tool call capacity exceeded' } });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const controller = new AbortController();
      let completed = false;
      const finish = (response?: JsonObject): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        try {
          if (response) this.write({ jsonrpc: '2.0', id, ...response });
        } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error)), 'transport');
        } finally {
          resolve();
        }
      };
      const operation = { cancel: () => { finish(); controller.abort(); } };
      const timer = setTimeout(() => {
        finish({ error: { code: -32603, message: 'Codex dynamic tool call timed out' } });
        controller.abort();
      }, this.dynamicToolCallTimeoutMs);
      timer.unref?.();
      this.dynamicToolCalls.add(operation);
      const settled = (response: JsonObject): void => {
        this.dynamicToolCalls.delete(operation);
        finish(response);
      };
      try {
        Promise.resolve(handler(params, { signal: controller.signal })).then(
          (result) => settled({ result: result || { contentItems: [], success: false } }),
          (error: unknown) => settled({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
        );
      } catch (error) {
        settled({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
      // A timed-out handler keeps its slot until it settles, bounding work even
      // when the handler ignores cancellation.
    });
  }

  private stop(err: Error, kind: Extract<CodexAppServerRequestErrorKind, 'transport' | 'process_exit' | 'protocol_overflow'>): void {
    this.stopped = true;
    this.rejectAll(err, kind);
    this.cancelDynamicToolCalls();
  }

  private cancelDynamicToolCalls(): void {
    for (const operation of this.dynamicToolCalls) operation.cancel();
    this.dynamicToolCalls.clear();
  }

  private abortProtocol(code: string): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = '';
    this.stop(new Error(code), 'protocol_overflow');
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

export async function createCodexAppServerV2Client(
  options: CodexAppServerV2ClientFactoryOptions = {}
): Promise<{ client: CodexAppServerV2Client; runtimeIdentity: CodexRuntimeIdentity }> {
  const runtime = await resolveCodexRuntime({
    explicitPath: options.codexBin || null,
    requestedBy: options.requestedBy || 'codex-app-server-v2-client'
  });
  if (!runtime.identity) throw new Error(`Codex runtime not found: ${runtime.blockers.join(',')}`);
  const runtimeEnv = await prepareCodexAppServerRuntimeEnv({ env: options.env || process.env });
  const clientOptions: {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxFrameBytes?: number;
    maxNotifications?: number;
    maxNotificationBytes?: number;
    maxPendingDynamicToolCalls?: number;
    dynamicToolCallTimeoutMs?: number;
    currentTimeProvider?: () => Date;
    approvalPolicy?: CodexAppServerApprovalPolicy;
  } = { command: runtime.identity.realpath, env: runtimeEnv };
  if (options.args !== undefined) clientOptions.args = options.args;
  if (options.cwd !== undefined) clientOptions.cwd = options.cwd;
  if (options.timeoutMs !== undefined) clientOptions.timeoutMs = options.timeoutMs;
  if (options.maxFrameBytes !== undefined) clientOptions.maxFrameBytes = options.maxFrameBytes;
  if (options.maxNotifications !== undefined) clientOptions.maxNotifications = options.maxNotifications;
  if (options.maxNotificationBytes !== undefined) clientOptions.maxNotificationBytes = options.maxNotificationBytes;
  if (options.maxPendingDynamicToolCalls !== undefined) clientOptions.maxPendingDynamicToolCalls = options.maxPendingDynamicToolCalls;
  if (options.dynamicToolCallTimeoutMs !== undefined) clientOptions.dynamicToolCallTimeoutMs = options.dynamicToolCallTimeoutMs;
  if (options.currentTimeProvider !== undefined) clientOptions.currentTimeProvider = options.currentTimeProvider;
  if (options.approvalPolicy !== undefined) clientOptions.approvalPolicy = options.approvalPolicy;
  return {
    client: new CodexAppServerV2Client(clientOptions),
    runtimeIdentity: runtime.identity
  };
}

export function currentTimeResponse(date: Date): CodexAppServerCurrentTime {
  return {
    utcIso: date.toISOString(),
    unixTimeSeconds: Math.floor(date.getTime() / 1000),
    unixTimeMilliseconds: date.getTime(),
    timezone: 'UTC'
  };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
}

function normalizeThreadListParams<T extends object>(params: T): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function jsonRpcErrorMessage(method: string, error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return `${method}: ${String(error.message)}`;
  return `${method}: ${JSON.stringify(error)}`;
}

function jsonRpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = Number(error.code);
  return Number.isSafeInteger(code) ? code : null;
}

function isTurnCompletionEvent(event: JsonObject, threadId: string, turnId?: string | null): boolean {
  if (String(event.method || '') !== 'turn/completed') return false;
  const params = event.params && typeof event.params === 'object'
    ? event.params as JsonObject
    : {};
  const completedTurn = params.turn && typeof params.turn === 'object'
    ? params.turn as JsonObject
    : {};
  return String(params.threadId || '') === threadId
    && (!turnId || String(completedTurn.id || params.turnId || '') === turnId);
}

function notificationByteLength(event: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}
