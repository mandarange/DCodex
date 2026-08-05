import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type {
  BridgeProviderId,
  BridgeRoutingPolicy,
  CapabilityRequestedLevel,
  ProviderSessionPin,
  WebSocketProbeResult,
} from '../bridge-contracts.js';

export const DESKTOP_BRIDGE_STATE_SCHEMA = 'sks.codex-lb-desktop-bridge.v2' as const;
export const DESKTOP_BRIDGE_REGISTRY_SCHEMA = 'sks.desktop-bridge-provider-registry.v1' as const;
export const DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH = '/__sks/diagnostics/health' as const;
export const DESKTOP_BRIDGE_DIAGNOSTIC_PATH = '/__sks/diagnostics/websocket' as const;
export const DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL = 'sks.desktop-bridge.probe.v2' as const;

export const DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES = [
  '/backend-api/codex/',
  '/backend-api/files',
  '/backend-api/transcribe',
  '/backend-api/wham/',
  '/api/v1/',
  '/v1/',
] as const;

export type DesktopBridgeProviderAuthTransport =
  | 'x-codex-lb-api-key'
  | 'authorization-bearer'
  | 'openrouter-bearer';

export interface DesktopBridgeProviderSnapshot {
  provider_id: BridgeProviderId;
  enabled: boolean;
  base_url: string;
  allowed_origins: readonly string[];
  auth_transport: DesktopBridgeProviderAuthTransport;
  credential_state: 'not_configured' | 'configured_unverified' | 'validating' | 'ready' | 'rejected' | 'unavailable' | 'stale';
  credential_fingerprint: string | null;
  credential_generation: string;
  catalog_generation: string | null;
}

export interface DesktopBridgeProviderRegistrySnapshot {
  schema: typeof DESKTOP_BRIDGE_REGISTRY_SCHEMA;
  generation: string;
  created_at: string;
  providers: Record<BridgeProviderId, DesktopBridgeProviderSnapshot>;
}

export interface DesktopBridgeResolvedCredential {
  provider_id: BridgeProviderId;
  value: string;
  source: string;
  fingerprint: string;
  generation: string;
}

export interface DesktopBridgeRouteRequest {
  public_model: string;
  session_id: string | null;
  pathname: string;
  transport: 'http' | 'websocket';
  headers: Readonly<NodeJS.Dict<string | string[]>>;
}

export interface DesktopBridgeRouteContext {
  provider_id: BridgeProviderId;
  public_model: string;
  upstream_model: string;
  catalog_generation: string;
  route_policy_generation: string;
  session_pin: ProviderSessionPin | null;
}

export type DesktopBridgeRouteResolver = (
  request: DesktopBridgeRouteRequest,
  policy: BridgeRoutingPolicy,
  providerSessionPins: readonly ProviderSessionPin[],
) => DesktopBridgeRouteContext;

export type DesktopBridgeCredentialResolver = (
  providerId: BridgeProviderId,
  expectedGeneration: string,
) => Promise<DesktopBridgeResolvedCredential>;

export interface DesktopBridgeConfig {
  providerRegistry: DesktopBridgeProviderRegistrySnapshot;
  routePolicy: BridgeRoutingPolicy;
  providerSessionPins: readonly ProviderSessionPin[];
  resolveRequestRoute?: DesktopBridgeRouteResolver;
  resolveProviderCredential: DesktopBridgeCredentialResolver;
  listenHost: '127.0.0.1' | '::1';
  listenPort: number;
  allowedPathPrefixes: readonly string[];
  allowedOrigins: readonly string[];
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxRequestBodyBytes?: number;
  stateFreshnessMs?: number;
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

export interface PreparedDesktopBridgeProvider extends DesktopBridgeProviderSnapshot {
  remote: DesktopBridgeRemoteTarget;
}

export interface PreparedDesktopBridgeConfig extends DesktopBridgeConfig {
  providers: Record<BridgeProviderId, PreparedDesktopBridgeProvider>;
}

export interface DesktopBridgePublicStateV2 {
  schema: typeof DESKTOP_BRIDGE_STATE_SCHEMA;
  runtime: 'desktop-bridge';
  pid: number;
  started_at: string;
  updated_at: string;
  stale_after: string;
  listen_origin: string;
  codex_base_url: string;
  process_generation: string;
  provider_registry_generation: string;
  route_policy_generation: string;
  catalog_generation: string;
  enabled_providers: BridgeProviderId[];
  provider_credential_generations: Record<BridgeProviderId, string>;
  last_verified_probe_ids: string[];
  config_generation: string;
}

export type DesktopBridgePublicState = DesktopBridgePublicStateV2;

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
  | { status: 'stale'; state: DesktopBridgePublicState; blocker: 'bridge_process_not_running' | 'bridge_state_stale' }
  | { status: 'configuration_mismatch'; state: DesktopBridgePublicState; blocker: 'bridge_config_generation_mismatch' }
  | { status: 'running'; state: DesktopBridgePublicState };

export interface DesktopBridgeWebSocketProbeOptions {
  url: string;
  origin?: string;
  protocol?: string;
  framePayload?: string | Buffer;
  handshakeOnly?: boolean;
  requestedLevel?: CapabilityRequestedLevel;
  connectTimeoutMs?: number;
  stageTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetries?: number;
  jitter?: () => number;
}

export type DesktopBridgeWebSocketProbe = WebSocketProbeResult;

export class DesktopBridgeError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'DesktopBridgeError';
    this.code = code;
  }
}
