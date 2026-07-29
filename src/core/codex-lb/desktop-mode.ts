export const CODEX_LB_DESKTOP_MODES = [
  'desktop-native-bridge',
  'desktop-dual-auth-compat',
  'cli-provider',
  'disabled'
] as const;

export type CodexLbDesktopMode = (typeof CODEX_LB_DESKTOP_MODES)[number];

export const CODEX_LB_GATEWAY_AUTH_TRANSPORTS = [
  'x-codex-lb-api-key',
  'authorization-bearer-compat'
] as const;

export type CodexLbGatewayAuthTransport = (typeof CODEX_LB_GATEWAY_AUTH_TRANSPORTS)[number];

export const DEFAULT_CODEX_LB_DESKTOP_MODE: CodexLbDesktopMode = 'desktop-native-bridge';
export const DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT: CodexLbGatewayAuthTransport = 'x-codex-lb-api-key';

export function parseCodexLbDesktopMode(value: unknown): CodexLbDesktopMode {
  const normalized = String(value ?? '').trim();
  if ((CODEX_LB_DESKTOP_MODES as readonly string[]).includes(normalized)) {
    return normalized as CodexLbDesktopMode;
  }
  throw new Error(`unsupported_codex_lb_desktop_mode:${normalized || 'empty'}`);
}

export function parseCodexLbGatewayAuthTransport(value: unknown): CodexLbGatewayAuthTransport {
  const normalized = String(value ?? '').trim();
  if ((CODEX_LB_GATEWAY_AUTH_TRANSPORTS as readonly string[]).includes(normalized)) {
    return normalized as CodexLbGatewayAuthTransport;
  }
  throw new Error(`unsupported_codex_lb_gateway_auth_transport:${normalized || 'empty'}`);
}

export function modeRequiresChatGptOAuth(mode: CodexLbDesktopMode): boolean {
  return mode === 'desktop-native-bridge' || mode === 'desktop-dual-auth-compat';
}

export function modeMayMutateSharedAuth(_mode: CodexLbDesktopMode): boolean {
  return false;
}
