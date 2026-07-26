import type { McpServerMutationInput } from './types.js';
import { escapeRegExp } from '../text/regex.js';

interface TableSpan {
  readonly start: number;
  readonly headerEnd: number;
  readonly end: number;
  readonly path: string[];
  readonly array: boolean;
}

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

type MultilineState = 'normal' | 'multiline-basic' | 'multiline-literal';

export function replaceOrAppendMcpServer(text: string, name: string, block: string): string {
  const source = String(text || '');
  const range = serverRange(source, name);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = block.replace(/\r?\n/g, newline).replace(new RegExp(`${escapeRegExp(newline)}*$`), newline);
  if (!range) {
    const prefix = source.trim() ? source.replace(/\s*$/, `${newline}${newline}`) : '';
    return `${prefix}${normalized}`;
  }
  return `${source.slice(0, range.start)}${normalized}${source.slice(range.end).replace(/^(?:\r?\n)+/, '')}`;
}

export function removeMcpServerText(text: string, name: string): string | null {
  const range = serverRange(String(text || ''), name);
  if (!range) return null;
  const source = String(text || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const before = source.slice(0, range.start).replace(/[ \t\r\n]+$/, '');
  const after = source.slice(range.end).replace(/^(?:\r?\n)+/, '');
  return `${before}${before && after ? `${newline}${newline}` : ''}${after}`;
}

export function setMcpServerEnabledText(text: string, name: string, enabled: boolean): string | null {
  const source = String(text || '');
  const span = tableSpans(source).find((candidate) => !candidate.array && isServerRoot(candidate.path, name));
  if (!span) return null;
  let state: MultilineState = 'normal';
  for (const line of sourceLines(source, span.headerEnd, span.end)) {
    if (state === 'normal') {
      const match = line.content.match(/^([ \t]*enabled[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)$/);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        const valueStart = line.start + match[1].length;
        return `${source.slice(0, valueStart)}${enabled ? 'true' : 'false'}${source.slice(valueStart + match[2].length)}`;
      }
    }
    state = advanceState(line.content, state);
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source.slice(0, span.headerEnd)}enabled = ${enabled ? 'true' : 'false'}${newline}${source.slice(span.headerEnd)}`;
}

export function renderMcpServerBlock(input: McpServerMutationInput, legacyEnv: Readonly<Record<string, string>> = {}): string {
  const lines = [`[mcp_servers.${tomlKey(input.name)}]`, `enabled = ${input.enabled !== false}`];
  if (input.transport === 'streamable-http') {
    lines.push(`url = ${tomlString(input.url || '')}`);
    if (input.bearer_token_env_var) lines.push(`bearer_token_env_var = ${tomlString(input.bearer_token_env_var)}`);
    if (input.oauth_client_id) lines.push(`oauth_client_id = ${tomlString(input.oauth_client_id)}`);
    if (input.oauth_resource) lines.push(`oauth_resource = ${tomlString(input.oauth_resource)}`);
  } else {
    lines.push(`command = ${tomlString(input.command || '')}`);
    if (input.args?.length) lines.push(`args = ${tomlArray(input.args)}`);
    if (input.env_vars?.length) lines.push(`env_vars = ${tomlArray(input.env_vars)}`);
    if (input.cwd) lines.push(`cwd = ${tomlString(input.cwd)}`);
    if (input.experimental_environment) lines.push(`experimental_environment = ${tomlString(input.experimental_environment)}`);
    if (Object.keys(legacyEnv).length) {
      const pairs = Object.entries(legacyEnv).sort(([left], [right]) => left.localeCompare(right));
      lines.push(`env = { ${pairs.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ')} }`);
    }
  }
  lines.push(`startup_timeout_sec = ${input.startup_timeout_sec ?? 10}`);
  lines.push(`tool_timeout_sec = ${input.tool_timeout_sec ?? 60}`);
  if (input.enabled_tools) lines.push(`enabled_tools = ${tomlArray(input.enabled_tools)}`);
  if (input.disabled_tools) lines.push(`disabled_tools = ${tomlArray(input.disabled_tools)}`);
  if (input.default_tools_approval_mode) lines.push(`default_tools_approval_mode = ${tomlString(input.default_tools_approval_mode)}`);
  if (input.required !== undefined) lines.push(`required = ${input.required}`);
  for (const [tool, mode] of Object.entries(input.tool_approval_modes || {}).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push('', `[mcp_servers.${tomlKey(input.name)}.tools.${tomlKey(tool)}]`, `approval_mode = ${tomlString(mode)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function extractMcpServerBlock(text: string, name: string): string | null {
  const range = serverRange(String(text || ''), name);
  return range ? String(text || '').slice(range.start, range.end) : null;
}

function serverRange(source: string, name: string): { start: number; end: number } | null {
  const spans = tableSpans(source).filter((span) => isServerPath(span.path, name));
  if (!spans.length) return null;
  return { start: spans[0]?.start ?? 0, end: spans[spans.length - 1]?.end ?? source.length };
}

function tableSpans(text: string): TableSpan[] {
  const headers: Array<Omit<TableSpan, 'end'>> = [];
  let state: MultilineState = 'normal';
  for (const line of sourceLines(text)) {
    if (state === 'normal') {
      const header = parseHeader(line.content);
      if (header) headers.push({ start: line.start, headerEnd: line.end, path: header.path, array: header.array });
    }
    state = advanceState(line.content, state);
  }
  return headers.map((header, index) => ({ ...header, end: headers[index + 1]?.start ?? text.length }));
}

function sourceLines(text: string, start = 0, end = text.length): SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = start;
  while (cursor < end) {
    const found = text.indexOf('\n', cursor);
    const lineEnd = found === -1 || found >= end ? end : found + 1;
    let contentEnd = found === -1 || found >= end ? lineEnd : found;
    if (contentEnd > cursor && text[contentEnd - 1] === '\r') contentEnd -= 1;
    lines.push({ start: cursor, end: lineEnd, content: text.slice(cursor, contentEnd) });
    cursor = lineEnd;
  }
  return lines;
}

function advanceState(line: string, initial: MultilineState): MultilineState {
  let state = initial;
  let quote: 'basic' | 'literal' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] || '';
    if (state === 'multiline-basic') {
      if (line.startsWith('"""', index) && !escapedAt(line, index)) { state = 'normal'; index += 2; }
      continue;
    }
    if (state === 'multiline-literal') {
      if (line.startsWith("'''", index)) { state = 'normal'; index += 2; }
      continue;
    }
    if (quote === 'basic') {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') quote = null;
      continue;
    }
    if (quote === 'literal') { if (char === "'") quote = null; continue; }
    if (char === '#') break;
    if (line.startsWith('"""', index)) { state = 'multiline-basic'; index += 2; continue; }
    if (line.startsWith("'''", index)) { state = 'multiline-literal'; index += 2; continue; }
    if (char === '"') quote = 'basic';
    if (char === "'") quote = 'literal';
  }
  return state;
}

function parseHeader(line: string): { path: string[]; array: boolean } | null {
  const arrayMatch = line.match(/^\s*\[\[([^\[\]]+)\]\]\s*(?:#.*)?$/);
  const tableMatch = arrayMatch ? null : line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
  const source = arrayMatch?.[1] || tableMatch?.[1];
  if (!source) return null;
  const path = splitTomlPath(source);
  return path ? { path, array: Boolean(arrayMatch) } : null;
}

function splitTomlPath(source: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of source) {
    if (quote) {
      current += char;
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '.') {
      const decoded = decodeKey(current);
      if (decoded === null) return null;
      parts.push(decoded); current = ''; continue;
    }
    current += char;
  }
  if (quote) return null;
  const decoded = decodeKey(current);
  if (decoded === null) return null;
  parts.push(decoded);
  return parts;
}

function decodeKey(value: string): string | null {
  const token = value.trim();
  if (!token) return null;
  if (token.startsWith('"') && token.endsWith('"')) {
    try { return JSON.parse(token) as string; } catch { return null; }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

function isServerRoot(path: readonly string[], name: string): boolean {
  return path.length === 2 && path[0] === 'mcp_servers' && path[1] === name;
}

function isServerPath(path: readonly string[], name: string): boolean {
  return path.length >= 2 && path[0] === 'mcp_servers' && path[1] === name;
}

function escapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function tomlString(value: string): string { return JSON.stringify(String(value)); }
function tomlKey(value: string): string { return tomlString(value); }
function tomlArray(values: readonly string[]): string { return `[${values.map(tomlString).join(', ')}]`; }
