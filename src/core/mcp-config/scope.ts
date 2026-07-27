import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorCodeOf } from '../errors/message.js';
import type { McpScopeOptions, McpWritableScope } from './types.js';

export class McpScopeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'McpScopeError';
  }
}

export interface ResolvedMcpScope {
  readonly scope: McpWritableScope;
  readonly configPath: string;
  readonly codexHome: string;
  readonly root: string;
}

export async function resolveMcpScope(scope: McpWritableScope, options: McpScopeOptions = {}): Promise<ResolvedMcpScope> {
  if (scope === 'global') {
    const requestedHome = path.resolve(options.home || process.env.HOME || os.homedir());
    const home = await fsp.realpath(requestedHome).catch(() => requestedHome);
    const codexHome = path.join(home, '.codex');
    await assertSafeDirectory(codexHome, home, false);
    const configPath = path.join(codexHome, 'config.toml');
    await assertSafeConfig(configPath, home);
    return { scope, configPath, codexHome, root: home };
  }

  if (options.projectTrusted !== true) throw new McpScopeError('mcp_project_not_trusted');
  if (!options.projectRoot) throw new McpScopeError('mcp_project_root_required');
  const requestedRoot = path.resolve(options.projectRoot);
  const root = await fsp.realpath(requestedRoot).catch(() => {
    throw new McpScopeError('mcp_project_root_unreadable');
  });
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new McpScopeError('mcp_project_root_invalid');
  const codexHome = path.join(root, '.codex');
  await assertSafeDirectory(codexHome, root, true);
  const configPath = path.join(codexHome, 'config.toml');
  await assertSafeConfig(configPath, root);
  return { scope, configPath, codexHome, root };
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertSafeDirectory(directory: string, boundary: string, strictNoSymlink: boolean): Promise<void> {
  const stat = await fsp.lstat(directory).catch((error: unknown) => errorCodeOf(error) === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  if (strictNoSymlink && stat.isSymbolicLink()) throw new McpScopeError('mcp_project_codex_home_symlink_refused');
  if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new McpScopeError('mcp_codex_home_not_directory');
  const resolved = await fsp.realpath(directory).catch(() => null);
  if (!resolved || !isPathInside(boundary, resolved)) throw new McpScopeError('mcp_codex_home_escape_refused');
}

async function assertSafeConfig(configPath: string, boundary: string): Promise<void> {
  const stat = await fsp.lstat(configPath).catch((error: unknown) => errorCodeOf(error) === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new McpScopeError('mcp_config_symlink_refused');
  if (!stat.isFile()) throw new McpScopeError('mcp_config_not_regular_file');
  const resolved = await fsp.realpath(configPath).catch(() => null);
  if (!resolved || !isPathInside(boundary, resolved)) throw new McpScopeError('mcp_config_escape_refused');
}
