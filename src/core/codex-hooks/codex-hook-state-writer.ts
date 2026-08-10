import path from 'node:path';
import { readJson, readText, writeTextAtomic } from '../fsx.js';
import { CODEX_HOOK_EVENTS } from '../codex-compat/codex-hook-events.js';
import { codexCommandHookCurrentHash, codexHookStateKey } from './codex-hook-hash.js';
import { entriesFromInlineHooksToml } from './codex-hook-actual-discovery.js';
import { isUnmanagedProjectCodexConfig } from '../codex/codex-config-guard.js';

export interface WriteTrustedHashStateInput {
  root?: string;
  hooksFilePath?: string;
  hooksPath?: string;
  statePath?: string;
  managed?: boolean;
}

export interface WriteTrustedHashStateOptions {
  allowSksHashFallback?: boolean;
  reason?: string;
  managed?: boolean;
}

export async function writeTrustedHashStateForHooksFile(
  input: string | WriteTrustedHashStateInput,
  hooksPathOrOpts?: string | WriteTrustedHashStateOptions,
  statePath?: string,
  opts: WriteTrustedHashStateOptions = {}
) {
  const resolved = resolveWriterInput(input, hooksPathOrOpts, statePath, opts);
  const isSksManagedHook = resolved.managed === true || resolved.hooksPath.includes('sks-managed-hooks');
  if (resolved.opts.allowSksHashFallback !== true && !isSksManagedHook) {
    return {
      schema: 'sks.codex-hook-state-writer.v2',
      ok: false,
      hooks_path: resolved.hooksPath,
      state_path: resolved.statePath,
      updated: 0,
      blocks: [],
      blocked: true,
      blocker: 'official_codex_hook_hash_unavailable',
      policy: 'use_sks_hooks_install_managed_instead_of_writing_sks_only_trusted_hashes',
      repair_action: 'sks hooks install --managed --json',
      reason: resolved.opts.reason || 'SKS refuses to write trusted_hash values from its own canonicalJson hash unless official Codex hash parity is proven.'
    };
  }
  const existingState = await readText(resolved.statePath, '');
  if (isUnmanagedProjectCodexConfig(resolved.root, resolved.statePath, existingState)) {
    return {
      schema: 'sks.codex-hook-state-writer.v2',
      ok: false,
      hooks_path: resolved.hooksPath,
      state_path: resolved.statePath,
      updated: 0,
      blocks: [],
      blocked: true,
      blocker: 'user_owned_file_without_sks_marker',
      blockers: ['user_owned_file_without_sks_marker'],
      policy: 'preserve_user_owned_project_codex_config_without_sks_marker',
      repair_action: 'Add an SKS-managed marker or run SKS setup before doctor --fix can write hook trust state.'
    };
  }
  const blocks = await trustedHashBlocksForHooksPath(resolved.hooksPath, isSksManagedHook);
  const next = upsertTrustBlocks(existingState, blocks);
  await writeTextAtomic(resolved.statePath, next);
  return {
    schema: 'sks.codex-hook-state-writer.v1',
    ok: true,
    hooks_path: resolved.hooksPath,
    state_path: resolved.statePath,
    updated: blocks.length,
    blocks
  };
}

function resolveWriterInput(
  input: string | WriteTrustedHashStateInput,
  hooksPathOrOpts: string | WriteTrustedHashStateOptions | undefined,
  statePath: string | undefined,
  opts: WriteTrustedHashStateOptions
) {
  if (typeof input === 'string') {
    const root = path.resolve(input);
    const resolvedOpts = typeof hooksPathOrOpts === 'object' && hooksPathOrOpts !== null
      ? hooksPathOrOpts
      : opts;
    const hooksPath = typeof hooksPathOrOpts === 'string'
      ? hooksPathOrOpts
      : path.join(root, '.codex', 'hooks.json');
    return {
      root,
      hooksPath: path.resolve(hooksPath),
      statePath: path.resolve(statePath || path.join(root, '.codex', 'config.toml')),
      managed: resolvedOpts.managed === true,
      opts: resolvedOpts
    };
  }
  const hooksPath = path.resolve(input.hooksFilePath || input.hooksPath || path.join(input.root || process.cwd(), '.codex', 'hooks.json'));
  const root = path.resolve(input.root || rootFromHooksPath(hooksPath));
  const resolvedOpts = typeof hooksPathOrOpts === 'object' && hooksPathOrOpts !== null
    ? hooksPathOrOpts
    : opts;
  return {
    root,
    hooksPath,
    statePath: path.resolve(input.statePath || statePathForHooksPath(root, hooksPath)),
    managed: input.managed === true || resolvedOpts.managed === true,
    opts: resolvedOpts
  };
}

function rootFromHooksPath(hooksPath: string): string {
  const dir = path.dirname(hooksPath);
  if (path.basename(dir) === '.codex') return path.dirname(dir);
  if (path.basename(dir) === 'managed-hooks') return path.dirname(path.dirname(dir));
  return process.cwd();
}

function statePathForHooksPath(root: string, hooksPath: string): string {
  const dir = path.dirname(hooksPath);
  if (path.basename(dir) === '.codex' || path.basename(dir) === 'managed-hooks') {
    return path.join(path.basename(dir) === '.codex' ? dir : path.dirname(dir), 'config.toml');
  }
  return path.join(root, '.codex', 'config.toml');
}

async function trustedHashBlocksForHooksPath(hooksPath: string, managed: boolean): Promise<Array<{ key: string; trusted_hash: string; block: string }>> {
  if (/\.toml$/i.test(hooksPath)) {
    const parsed = entriesFromInlineHooksToml(hooksPath, 'project', await readText(hooksPath, ''), {}, managed, managed ? 'managed_dir_toml' : 'config_toml');
    return parsed.entries.map((entry) => ({
      key: entry.key,
      trusted_hash: entry.current_hash,
      block: `[hooks.state."${tomlQuotedKey(entry.key)}"]\ntrusted_hash = "${entry.current_hash}"`
    }));
  }
  const hooksFile = await readJson(hooksPath, {});
  return trustedHashBlocksForHooksFile(hooksPath, hooksFile);
}

export function trustedHashBlocksForHooksFile(hooksPath: string, hooksFile: any): Array<{ key: string; trusted_hash: string; block: string }> {
  const blocks: Array<{ key: string; trusted_hash: string; block: string }> = [];
  const hooksRoot = hooksFile?.hooks && typeof hooksFile.hooks === 'object' && !Array.isArray(hooksFile.hooks) ? hooksFile.hooks : {};
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
    groups.forEach((group: any, groupIndex: number) => {
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
      handlers.forEach((handler: any, handlerIndex: number) => {
        if (!handler || typeof handler !== 'object' || handler.type !== 'command') return;
        const key = codexHookStateKey(hooksPath, event, groupIndex, handlerIndex);
        const trustedHash = codexCommandHookCurrentHash({
          event,
          matcher: typeof group.matcher === 'string' ? group.matcher : null,
          command: String(handler.command || ''),
          timeout: Number(handler.timeout || 600),
          async: handler.async === true,
          statusMessage: typeof handler.statusMessage === 'string' ? handler.statusMessage : null,
          commandWindows: typeof handler.commandWindows === 'string' ? handler.commandWindows : typeof handler.command_windows === 'string' ? handler.command_windows : null
        });
        blocks.push({
          key,
          trusted_hash: trustedHash,
          block: `[hooks.state."${tomlQuotedKey(key)}"]\ntrusted_hash = "${trustedHash}"`
        });
      });
    });
  }
  return blocks;
}

export function upsertTrustBlocks(existing: string, blocks: Array<{ key: string; block: string }>): string {
  let next = String(existing || '').trimEnd();
  for (const block of blocks) {
    next = upsertTomlTable(next, `hooks.state."${tomlQuotedKey(block.key)}"`, block.block);
  }
  return `${next.trim()}\n`;
}

function upsertTomlTable(text: string, table: string, block: string): string {
  let lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') lines = [];
  const header = `[${table}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  const blockLines = String(block || '').trim().split('\n');
  if (start === -1) return [...lines, ...(lines.length ? [''] : []), ...blockLines].join('\n').replace(/\n{3,}/g, '\n\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  // Keep the blank separator that precedes the next header: it lives inside
  // [start, end) and was being swallowed, so this writer and
  // splitCodexProjectConfigPolicy (which re-adds it) rewrote the managed hook
  // tables against each other forever. Same fix as init.ts's copy.
  while (end > start + 1 && !String(lines[end - 1] || '').trim()) end -= 1;
  lines.splice(start, end - start, ...blockLines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function tomlQuotedKey(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
