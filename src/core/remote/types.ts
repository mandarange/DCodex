export const REMOTE_MACHINE_REGISTRY_SCHEMA = 'sks.remote-machines.v1' as const;
export const REMOTE_READINESS_SCHEMA = 'sks.remote-readiness.v1' as const;
export const REMOTE_WORKER_REQUEST_SCHEMA = 'sks.remote-worker.request.v1' as const;
export const REMOTE_WORKER_RESPONSE_SCHEMA = 'sks.remote-worker.response.v1' as const;
export const REMOTE_COMMAND_SCHEMA = 'sks.remote-command.v2' as const;
export const REMOTE_COMMAND_RECEIPT_SCHEMA = 'sks.remote-command-receipt.v1' as const;
export const REMOTE_OWNER_PROOF_SCHEMA = 'sks.remote-owner-proof.v1' as const;
export const REMOTE_R2_APPROVAL_SCHEMA = 'sks.remote-r2-approval.v2' as const;
export const REMOTE_EVENT_SCHEMA = 'sks.remote-event.v1' as const;
export const REMOTE_SESSION_INDEX_SCHEMA = 'sks.remote-session-index.v1' as const;

export type RemoteRisk = 'R0' | 'R1' | 'R2';
export type RemoteCommandKind = 'input' | 'verify' | 'cancel' | 'read';
export type RemoteWorkerRequestType = 'hello' | 'list_sessions' | 'read_snapshot' | 'watch' | 'prepare_cancel' | 'command';

export interface RemoteMachineV1 {
  readonly id: string;
  readonly display_name: string;
  readonly transport: 'local' | 'ssh-stdio';
  readonly ssh_alias?: string | null;
  readonly allowed_roots: readonly string[];
  readonly enabled: boolean;
}

export interface RemoteMachineRegistryV1 {
  readonly schema: typeof REMOTE_MACHINE_REGISTRY_SCHEMA;
  readonly machines: readonly RemoteMachineV1[];
}

export interface RemoteMachineRegistryValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly registry: RemoteMachineRegistryV1 | null;
}

export interface RemoteSessionTargetV1 {
  readonly machine_id: string;
  readonly project_id: string;
  readonly project_root: string;
}

export interface RemoteSessionIndexV1 {
  readonly schema: typeof REMOTE_SESSION_INDEX_SCHEMA;
  readonly targets: readonly RemoteSessionTargetV1[];
}

export interface RemoteSessionIndexValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly index: RemoteSessionIndexV1 | null;
}

export interface RemoteReadinessV1 {
  readonly schema: typeof REMOTE_READINESS_SCHEMA;
  readonly ok: boolean;
  readonly host: {
    readonly platform: string;
    readonly awake_hint: string | null;
    readonly codex_app_found: boolean;
    readonly codex_cli_found: boolean;
    readonly codex_cli_path: string | null;
  };
  readonly project: {
    readonly root: string;
    readonly git_repo: boolean;
    readonly branch: string | null;
    readonly dirty: boolean;
    readonly worktree: boolean;
    readonly allowed: boolean;
  };
  readonly mcp: {
    readonly effective_count: number;
    readonly failed_count: number;
  };
  readonly sks: {
    readonly version: string;
    readonly proof_surfaces_ready: boolean;
  };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface RemoteR2ApprovalV1 {
  readonly schema: typeof REMOTE_R2_APPROVAL_SCHEMA;
  readonly approval_id: string;
  readonly approved_by: 'remote-owner';
  readonly approved_at: string;
  readonly expires_at: string;
  readonly machine_id: string;
  readonly project_id: string;
  readonly session_id: string;
  readonly kind: 'cancel';
  readonly command_id: string;
}

export interface RemoteCommandEnvelopeV1 {
  readonly schema: typeof REMOTE_COMMAND_SCHEMA;
  readonly command_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly actor: 'remote-owner';
  readonly machine_id: string;
  readonly project_id: string;
  readonly session_id: string | null;
  readonly kind: RemoteCommandKind;
  readonly risk: RemoteRisk;
  readonly payload: Record<string, unknown>;
  readonly idempotency_key: string;
}

export type WorkerRequestV1 =
  | { readonly schema: typeof REMOTE_WORKER_REQUEST_SCHEMA; readonly id: string; readonly type: 'hello' }
  | { readonly schema: typeof REMOTE_WORKER_REQUEST_SCHEMA; readonly id: string; readonly type: 'list_sessions' }
  | { readonly schema: typeof REMOTE_WORKER_REQUEST_SCHEMA; readonly id: string; readonly type: 'read_snapshot'; readonly session_id: string }
  | { readonly schema: typeof REMOTE_WORKER_REQUEST_SCHEMA; readonly id: string; readonly type: 'watch'; readonly after_seq: number; readonly session_id?: string }
  | { readonly schema: typeof REMOTE_WORKER_REQUEST_SCHEMA; readonly id: string; readonly type: 'prepare_cancel'; readonly session_id: string; readonly command_id: string }
  | { readonly schema: typeof REMOTE_WORKER_REQUEST_SCHEMA; readonly id: string; readonly type: 'command'; readonly envelope: RemoteCommandEnvelopeV1 };

export type RemoteDeliveryState = 'not_dispatched' | 'unknown' | 'acknowledged';
export type RemoteSideEffectApplied = boolean | 'unknown';

export interface RemoteWorkerErrorV1 {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly delivery: RemoteDeliveryState;
  readonly details?: Record<string, unknown>;
}

export interface WorkerResponseV1 {
  readonly schema: typeof REMOTE_WORKER_RESPONSE_SCHEMA;
  readonly id: string;
  readonly type: RemoteWorkerRequestType;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: RemoteWorkerErrorV1;
  readonly receipt?: RemoteCommandReceiptV1;
}

export interface RemoteCommandReceiptV1 {
  readonly schema: typeof REMOTE_COMMAND_RECEIPT_SCHEMA;
  readonly command_id: string;
  readonly idempotency_key: string;
  readonly machine_id: string;
  readonly project_id: string;
  readonly session_id: string | null;
  readonly kind: RemoteCommandKind;
  readonly status: 'completed' | 'failed';
  readonly side_effect_applied: RemoteSideEffectApplied;
  readonly completed_at: string;
  readonly result?: unknown;
  readonly error?: RemoteWorkerErrorV1;
}

export interface RemoteOwnerProofV1 {
  readonly schema: typeof REMOTE_OWNER_PROOF_SCHEMA;
  readonly session_id: string;
  readonly project_id: string;
  readonly project_root: string;
  readonly pid: number;
  readonly process_start_time: string;
  readonly expected_command: string;
  readonly owner_nonce: string;
  readonly active_generation: number;
  readonly codex_thread_id?: string | null;
  readonly active_turn_id?: string | null;
  readonly registered_at: string;
}

export interface RemoteCancelPayloadV1 {
  readonly owner_nonce: string;
  readonly expected_pid: number;
  readonly expected_process_start_time: string;
  readonly expected_command: string;
  readonly expected_project_root: string;
  readonly expected_generation: number;
  readonly approval: RemoteR2ApprovalV1;
}

export interface RemoteProcessIdentityV1 {
  readonly pid: number;
  readonly process_start_time: string;
  readonly command: string;
  readonly project_root: string;
}

export interface RemoteEventV1 {
  readonly schema: typeof REMOTE_EVENT_SCHEMA;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly session_id: string | null;
  readonly command_id: string | null;
  readonly summary: Record<string, unknown>;
}

export interface RemoteEventCursorV1 {
  readonly requested_after_seq: number;
  readonly first_available_seq: number;
  readonly last_available_seq: number;
  readonly next_after_seq: number;
  readonly gap: boolean;
}

export type SshConnectionState = 'idle' | 'validating' | 'connecting' | 'connected' | 'disconnected' | 'closed';
export type SksRemoteSessionState = 'unknown' | 'idle' | 'active' | 'terminal' | 'blocked';

export interface RemoteSshClientStatusV1 {
  readonly schema: 'sks.remote-ssh-client-status.v1';
  readonly connection_state: SshConnectionState;
  readonly session_state: SksRemoteSessionState;
  readonly reconnect_attempt: number;
  readonly last_error: string | null;
}
