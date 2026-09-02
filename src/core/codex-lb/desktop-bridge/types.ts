import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type {
  BridgeProviderId,
  BridgeRouteTargetId,
  BridgeRoutingPolicy,
  CapabilityRequestedLevel,
  ProviderSessionPin,
  WebSocketProbeResult,
} from '../bridge-contracts.js';

export const DESKTOP_BRIDGE_STATE_SCHEMA = 'sks.desktop-bridge-state.v2' as const;
export const DESKTOP_BRIDGE_REGISTRY_SCHEMA = 'sks.desktop-bridge-provider-registry.v1' as const;
export const DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH = '/__sks/diagnostics/health' as const;
export const DESKTOP_BRIDGE_DIAGNOSTIC_PATH = '/__sks/diagnostics/websocket' as const;
export const DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL = 'sks.desktop-bridge.probe.v2' as const;
export const DESKTOP_BRIDGE_CLIENT_PATH_PREFIX = '/__sks/client' as const;

export const DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES = [
  '/backend-api/codex/',
  '/backend-api/files',
  '/backend-api/transcribe',
  '/backend-api/wham/',
  '/api/v1/',
  '/v1/',
] as const;

/**
 * Where official ChatGPT identity passthrough forwards to. The base carries the
 * `/backend-api/codex` prefix so provider-relative path translation lands on the
 * same absolute path the client addressed — and non-codex backend-api paths
 * (files, wham, transcribe, alpha endpoints) pass through verbatim against the
 * same origin.
 */
export const DESKTOP_BRIDGE_OFFICIAL_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex' as const;

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
  /** Provider-source catalog generation; distinct from routePolicy.catalog_generation. */
  source_catalog_generation: string | null;
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
  provider_id: BridgeRouteTargetId;
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

export type DesktopBridgeSessionPinPersister = (
  providerSessionPins: readonly ProviderSessionPin[],
) => Promise<void>;

export interface DesktopBridgeConfig {
  providerRegistry: DesktopBridgeProviderRegistrySnapshot;
  routePolicy: BridgeRoutingPolicy;
  providerSessionPins: readonly ProviderSessionPin[];
  /**
   * Official ChatGPT identity passthrough. When set, requests the route policy
   * does not claim for a provider — unknown models, non-Responses backend-api
   * endpoints, unpinned WebSocket upgrades — and routes explicitly targeting
   * `openai` are forwarded to this base URL carrying the CLIENT's own
   * Authorization and account headers instead of a substituted provider key.
   * Absent/null preserves the legacy fail-closed behavior.
   */
  officialPassthrough?: { baseUrl: string } | null;
  resolveRequestRoute?: DesktopBridgeRouteResolver;
  persistProviderSessionPins?: DesktopBridgeSessionPinPersister;
  resolveProviderCredential: DesktopBridgeCredentialResolver;
  clientCapabilitySha256: string;
  listenHost: '127.0.0.1' | '::1';
  listenPort: number;
  allowedPathPrefixes: readonly string[];
  allowedOrigins: readonly string[];
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxRequestBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  maxConnections?: number;
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
  /**
   * True when DNS was unavailable at prepare time and the address is a
   * placeholder: the bridge serves anyway and resolves on first use, so a
   * login-time network race never crash-loops the service.
   */
  unresolved?: boolean;
}

export type DesktopBridgeLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export interface PreparedDesktopBridgeProvider extends DesktopBridgeProviderSnapshot {
  remote: DesktopBridgeRemoteTarget;
}

export interface PreparedDesktopBridgeConfig extends DesktopBridgeConfig {
  providers: Record<BridgeProviderId, PreparedDesktopBridgeProvider>;
  /** DNS-resolved official passthrough target; null when passthrough is off. */
  officialRemote?: DesktopBridgeRemoteTarget | null;
  /** Lookup the targets were resolved with; runtime re-resolution reuses it. */
  remoteLookup?: DesktopBridgeLookup;
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
  /**
   * SKS version of the process actually serving. The bridge is a long-lived
   * launchd service, so upgrading the package replaces the files on disk while
   * the running process keeps executing the old code — and without this field
   * nothing could tell. Optional so a state written by an older bridge still
   * validates; absence is itself treated as "older than the installed package".
   */
  sks_version?: string;
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
  /**
   * Self-convergence for a supervised bridge.
   *
   * The bridge is a long-lived launchd service, and upgrading the package
   * replaces the files on disk without restarting it — so every bridge fix
   * stayed invisible until someone happened to run a repair. When this option
   * is supplied, the server periodically reads the installed package version
   * and, once it observes the same mismatched version twice in a row (never on
   * a single read: an npm install writes package.json mid-flight), calls
   * `onSkew` exactly once. The caller decides what convergence means — under
   * launchd that is drain-and-exit-nonzero, which `KeepAlive.SuccessfulExit =
   * false` answers by relaunching the service on the new code.
   */
  versionSkew?: {
    readInstalledVersion: () => Promise<string | null>;
    onSkew: (installedVersion: string) => void;
    intervalMs?: number;
  };
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
