import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { CodexProxyProviderMode } from '../../codex-app/provider-mode.js';
import type {
  ChildPolicySnapshot,
  CredentialReadiness,
  ProviderPolicySnapshot,
  SessionPin,
} from '../../architecture-hardening/contracts/contracts.js';

export const DESKTOP_BRIDGE_STATE_SCHEMA = 'sks.codex-lb-desktop-bridge.v1' as const;

export const DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES = [
  '/backend-api/codex/',
  '/backend-api/files',
  '/backend-api/transcribe',
  '/backend-api/wham/',
  '/api/v1/',
  '/v1/',
] as const;

export type DesktopBridgeGatewayAuthTransport =
  | 'x-codex-lb-api-key'
  | 'authorization-bearer-compat';

export interface DesktopBridgeConfig {
  /** Present for every managed runtime. Omitted only by legacy direct callers. */
  providerMode?: CodexProxyProviderMode;
  /** Exact provider-mode catalog accepted on Responses requests. */
  allowedModels?: readonly string[];
  /** Managed callers seal these snapshots before the bridge starts. */
  providerPolicy?: ProviderPolicySnapshot;
  credentialReadiness?: CredentialReadiness;
  childPolicy?: ChildPolicySnapshot;
  sessionPins?: readonly SessionPin[];
  /** Enabled only when the Codex caller supplies the sealed session headers. */
  requireSessionPin?: boolean;
  listenHost: '127.0.0.1' | '::1';
  listenPort: number;
  remoteBaseUrl: string;
  gatewayKey: string;
  gatewayAuthTransport: DesktopBridgeGatewayAuthTransport;
  allowedPathPrefixes: readonly string[];
  allowedOrigins: readonly string[];
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface DesktopBridgeRemoteTarget {
  baseUrl: string;
  origin: string;
  hostname: string;
  port: number;
  secure: boolean;
  address: string;
  family: 4 | 6;
  tlsServername?: string;
}

export interface PreparedDesktopBridgeConfig extends DesktopBridgeConfig {
  remote: DesktopBridgeRemoteTarget;
}

export interface DesktopBridgePublicState {
  schema: typeof DESKTOP_BRIDGE_STATE_SCHEMA;
  pid: number;
  started_at: string;
  listen_origin: string;
  codex_base_url: string;
  /** Added for managed v1 states; optional only for typed legacy fixtures. */
  provider_mode?: CodexProxyProviderMode;
  allowed_models_sha256?: string;
  provider_policy_sha256?: string;
  child_policy_sha256?: string;
  session_pin_enforcement?: 'required' | 'compatibility';
  remote_origin_sha256: string;
  gateway_auth_transport: DesktopBridgeGatewayAuthTransport;
  config_generation: string;
}

export interface DesktopBridgeHandle {
  server: Server;
  state: DesktopBridgePublicState;
  statePath: string | null;
  sockets: ReadonlySet<Socket>;
  stop(): Promise<void>;
}

export interface DesktopBridgeStartOptions {
  statePath?: string;
  writeState?: boolean;
  now?: Date;
  pid?: number;
}

export type DesktopBridgeStatus =
  | { status: 'missing'; state: null }
  | { status: 'invalid'; state: null; blocker: string }
  | { status: 'stale'; state: DesktopBridgePublicState; blocker: 'bridge_process_not_running' }
  | { status: 'configuration_mismatch'; state: DesktopBridgePublicState; blocker: 'bridge_config_generation_mismatch' }
  | { status: 'running'; state: DesktopBridgePublicState };

export class DesktopBridgeError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'DesktopBridgeError';
    this.code = code;
  }
}
