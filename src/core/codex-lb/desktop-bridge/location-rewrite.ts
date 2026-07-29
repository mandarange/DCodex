import { DesktopBridgeError } from './types.js';

export function rewriteLocationHeader(
  value: string,
  remoteBaseUrl: string,
  localOrigin: string,
): string {
  const remote = new URL(remoteBaseUrl);
  const location = new URL(value, remote.origin);
  const remoteWebSocketProtocol = remote.protocol === 'https:' ? 'wss:' : 'ws:';
  const allowedProtocol = location.protocol === remote.protocol || location.protocol === remoteWebSocketProtocol;
  const remotePort = remote.port || (remote.protocol === 'https:' ? '443' : '80');
  const locationPort = location.port
    || (location.protocol === 'https:' || location.protocol === 'wss:' ? '443' : '80');
  if (
    !allowedProtocol
    || location.hostname.toLowerCase() !== remote.hostname.toLowerCase()
    || locationPort !== remotePort
  ) {
    throw new DesktopBridgeError('bridge_location_origin_forbidden');
  }

  const local = new URL(localOrigin);
  local.pathname = location.pathname;
  local.search = location.search;
  local.hash = '';
  if (location.protocol === 'wss:' || location.protocol === 'ws:') local.protocol = 'ws:';
  else if (location.protocol === 'https:' || location.protocol === 'http:') local.protocol = 'http:';
  else {
    throw new DesktopBridgeError('bridge_location_protocol_forbidden');
  }
  return local.toString();
}
