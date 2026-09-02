import path from 'node:path';
import { ensureDir, nowIso, readText, writeTextAtomic } from '../fsx.js';
import { CODEX_HOOK_EVENTS, type CodexHookEventName } from '../codex-compat/codex-hook-events.js';
import { postToolEvidenceEnabled } from '../verification-profile.js';
import { buildCodexCommandHookToml, matcherApplies } from './codex-hook-config-writer.js';
import { readCodexHookActualState } from './codex-hook-actual-discovery.js';
import { writeTrustedHashStateForHooksFile } from './codex-hook-state-writer.js';

export interface CodexManagedHookInstallOptions {
  managedDir?: string | null;
  requirementsPath?: string | null;
  binCommand?: string | null;
  dryRun?: boolean;
}

const HOOK_SUBCOMMANDS: Record<CodexHookEventName, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  Stop: 'stop',
  SubagentStop: 'subagent-stop',
  SubagentStart: 'subagent-start',
  PreCompact: 'pre-compact',
  PostCompact: 'post-compact',
  PermissionRequest: 'permission-request'
};

export async function installManagedCodexHooks(root: string, opts: CodexManagedHookInstallOptions = {}) {
  const managedDir = path.resolve(root, opts.managedDir || path.join('.codex', 'managed-hooks'));
  const requirementsPath = path.resolve(root, opts.requirementsPath || path.join('.codex', 'requirements.toml'));
  const scriptPath = path.join(managedDir, 'sks-managed-hook.sh');
  const tomlPath = path.join(managedDir, 'sks-managed-hooks.toml');
  const binCommand = opts.binCommand || 'sks hook';
  // The essential profile installs no PostToolUse hook: it only ever wrote
  // proof evidence nothing in that profile reads, at one cold process per call.
  const installedEvents = CODEX_HOOK_EVENTS.filter((event) => event !== 'PostToolUse' || postToolEvidenceEnabled(root));
  const hooksToml = installedEvents.map((event) => buildCodexCommandHookToml({
    event,
    matcher: matcherApplies(event) ? '*' : null,
    command: `${scriptPath} ${HOOK_SUBCOMMANDS[event] || event}`,
    timeout: event === 'Stop' ? 60 : 30,
    statusMessage: event === 'Stop' ? 'SKS checking done gate' : null
  })).join('\n');
  const requirementsToml = mergeRequirementsToml(await readText(requirementsPath, ''), {
    managedDir,
    windowsManagedDir: opts.managedDir ? null : null
  });
  if (opts.dryRun !== true) {
    await ensureDir(managedDir);
    await writeTextAtomic(scriptPath, managedHookScript(binCommand));
    await chmodExecutable(scriptPath);
    await writeTextAtomic(tomlPath, hooksToml);
    await writeTextAtomic(requirementsPath, requirementsToml);
  }
  const trust = opts.dryRun === true
    ? null
    : await writeTrustedHashStateForHooksFile({ hooksFilePath: tomlPath, managed: true }, { allowSksHashFallback: true });
  const actual = opts.dryRun === true
    ? null
    : await readCodexHookActualState(root);
  const managedEntries = actual?.entries.filter((entry) => (entry as any).managed === true) || [];
  return {
    schema: 'sks.codex-hooks-managed-install.v1',
    ok: opts.dryRun === true || managedEntries.length >= CODEX_HOOK_EVENTS.length,
    created_at: nowIso(),
    root,
    mode: 'managed',
    dry_run: opts.dryRun === true,
    requirements_path: requirementsPath,
    managed_dir: managedDir,
    managed_hook_file: tomlPath,
    managed_script: scriptPath,
    installed_events: CODEX_HOOK_EVENTS,
    installed_event_count: CODEX_HOOK_EVENTS.length,
    actual_trust: actual ? {
      managed: managedEntries.length,
      unsupported_handlers: actual.unsupported_handlers.length,
      dual_representation: actual.dual_representation.length,
      blockers: actual.blockers
    } : null,
    trust,
    policy: {
      official_hash_available: false,
      trusted_hash_writer_policy: 'managed_install_required_when_official_hash_is_unavailable',
      allow_managed_hooks_only_location: 'requirements.toml'
    },
    blockers: actual?.blockers || []
  };
}

function managedHookScript(binCommand: string) {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'subcommand="${1:-}"',
    'shift || true',
    `exec ${binCommand} "$subcommand" "$@"`
  ].join('\n') + '\n';
}

function mergeRequirementsToml(existing: string, opts: { managedDir: string; windowsManagedDir: string | null }) {
  const withoutManagedOnly = String(existing || '')
    .replace(/^\s*allow_managed_hooks_only\s*=.*$/gm, '')
    .replace(/^\s*\[hooks\]\s*$(?:\n\s*(?:managed_dir|windows_managed_dir)\s*=.*$)*/gm, '')
    .trim();
  const block = [
    'allow_managed_hooks_only = true',
    '',
    '[hooks]',
    `managed_dir = ${JSON.stringify(opts.managedDir)}`,
    ...(opts.windowsManagedDir ? [`windows_managed_dir = ${JSON.stringify(opts.windowsManagedDir)}`] : [])
  ].join('\n');
  return `${withoutManagedOnly ? `${withoutManagedOnly}\n\n` : ''}${block}\n`;
}

async function chmodExecutable(file: string) {
  try {
    await import('node:fs/promises').then((fs) => fs.chmod(file, 0o755));
  } catch {}
}
