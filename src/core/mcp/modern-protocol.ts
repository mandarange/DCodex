export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const MCP_CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
export const MCP_CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const MCP_SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

export interface McpImplementationInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpModernRequestOptions {
  clientInfo: McpImplementationInfo;
  clientCapabilities?: Record<string, unknown>;
}

export const MCP_LIST_PAGE_LIMIT = 100;
export const MCP_LIST_ITEM_LIMIT = 10_000;

export async function collectMcpListPages<T = unknown>(
  itemKey: string,
  requestPage: (params: Record<string, unknown>, pageIndex: number) => Promise<unknown>,
  options: {
    maxPages?: number;
    maxItems?: number;
    requireModernResult?: boolean;
  } = {}
): Promise<T[]> {
  const maxPages = options.maxPages ?? MCP_LIST_PAGE_LIMIT;
  const maxItems = options.maxItems ?? MCP_LIST_ITEM_LIMIT;
  const seenCursors = new Set<string>();
  const items: T[] = [];
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const raw = await requestPage(cursor === null ? {} : { cursor }, pageIndex);
    const result = options.requireModernResult === false
      ? requireRecordResult(raw)
      : requireModernCompleteResult(raw);
    const pageItems = result[itemKey];
    if (!Array.isArray(pageItems)) throw new Error('mcp_list_items_invalid');
    items.push(...pageItems as T[]);
    if (items.length > maxItems) throw new Error('mcp_pagination_item_limit_exceeded');

    const nextCursor = result.nextCursor;
    if (nextCursor === undefined || nextCursor === null) return items;
    if (typeof nextCursor !== 'string') throw new Error('mcp_pagination_cursor_invalid');
    if (seenCursors.has(nextCursor)) throw new Error('mcp_pagination_cursor_repeated');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('mcp_pagination_page_limit_exceeded');
}

export function modernMcpParams(
  params: Record<string, unknown>,
  options: McpModernRequestOptions
): Record<string, unknown> {
  const authoredMeta = isRecord(params._meta) ? params._meta : {};
  return {
    ...params,
    _meta: {
      ...authoredMeta,
      [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
      [MCP_CLIENT_INFO_META_KEY]: options.clientInfo,
      [MCP_CLIENT_CAPABILITIES_META_KEY]: options.clientCapabilities ?? {}
    }
  };
}

export function modernMcpRequest(
  id: string | number,
  method: string,
  params: Record<string, unknown>,
  options: McpModernRequestOptions
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params: modernMcpParams(params, options) };
}

export function modernMcpResult(
  value: Record<string, unknown>,
  serverInfo: McpImplementationInfo,
  cacheable = false
): Record<string, unknown> {
  const authoredMeta = isRecord(value._meta) ? value._meta : {};
  return {
    ...value,
    resultType: 'complete',
    ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}),
    _meta: {
      ...authoredMeta,
      [MCP_SERVER_INFO_META_KEY]: serverInfo
    }
  };
}

export function requireModernCompleteResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('mcp_result_invalid');
  if (value.resultType !== 'complete') {
    if (value.resultType === 'input_required') throw new Error('mcp_input_required_not_supported');
    throw new Error('mcp_result_type_invalid');
  }
  return value;
}

function requireRecordResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('mcp_result_invalid');
  return value;
}

export function modernServerInfo(value: unknown): McpImplementationInfo | null {
  if (!isRecord(value) || !isRecord(value._meta)) return null;
  const info = value._meta[MCP_SERVER_INFO_META_KEY];
  if (!isRecord(info) || typeof info.name !== 'string' || typeof info.version !== 'string') return null;
  return {
    name: info.name,
    version: info.version,
    ...(typeof info.title === 'string' ? { title: info.title } : {})
  };
}

export function modernRequestVersion(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params._meta)) return null;
  const value = params._meta[MCP_PROTOCOL_VERSION_META_KEY];
  return typeof value === 'string' ? value : null;
}

export function hasModernClientCapabilities(params: unknown): boolean {
  return isRecord(params)
    && isRecord(params._meta)
    && isRecord(params._meta[MCP_CLIENT_CAPABILITIES_META_KEY]);
}

export function isRecognizedModernError(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  return [-32020, -32021, -32022].includes(Number(value.error.code));
}

export function modernHttpHeaders(
  method: string,
  params: Record<string, unknown>,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'Mcp-Method': method,
    ...extra
  };
  const name = method === 'resources/read' ? params.uri : params.name;
  if (['tools/call', 'resources/read', 'prompts/get'].includes(method) && typeof name === 'string') {
    headers['Mcp-Name'] = encodeMcpHeaderValue(name);
  }
  return headers;
}

export function encodeMcpHeaderValue(value: string | number | boolean): string {
  const text = String(value);
  const plain = /^[\x20-\x7e]+$/.test(text)
    && text.trim() === text
    && !(text.startsWith('=?base64?') && text.endsWith('?='));
  return plain ? text : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
