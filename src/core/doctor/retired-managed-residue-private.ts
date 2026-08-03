import path from 'node:path';
import {
  inspectConfinedPath,
  moveConfinedPath,
  removeEmptyTreeVerified,
  uniqueConfinedPath,
  walkConfinedEntries,
  type ConfinedWalkResult,
  type EmptyTreeRemovalResult
} from '../managed-path-safety.js';
import { escapeRegExp } from '../text/regex.js';

/** Cleanup-only inventory. These names are never registered, listed, or redirected. */
export const REMOVED_PUBLIC_COMMANDS = ['team', 'mad-db', 'tmux', 'xai', 'swarm', 'agent', 'ralph', 'ui', 'glm'] as const;

const RETIRED_COMMAND_TOMBSTONES = new Set<string>(REMOVED_PUBLIC_COMMANDS);
const RETIRED_MISSION_MODES = new Set<string>([
  ...REMOVED_PUBLIC_COMMANDS,
  'agent',
  'shadowclone',
  'shadow-clone',
  'kagebunshin',
  'kage-bunshin'
].map(normalizeRetiredToken));
const RETIRED_ROUTE_BLACKBOX_KINDS = new Set([
  'actual_agent_command',
  'actual_team_command'
]);

export type MutableCounters = {
  detected: number;
  removed: number;
  rewrittenState: number;
  preserved: number;
  remaining: number;
  errors: number;
};

export function isRetiredMissionMode(value: unknown): boolean {
  return RETIRED_MISSION_MODES.has(normalizeRetiredToken(value));
}

export function isRetiredPublicValue(value: unknown): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const normalized = normalizeRetiredToken(raw);
  if (RETIRED_MISSION_MODES.has(normalized)) return true;
  const command = raw.replace(/^\$+/, '').trim().toLowerCase();
  for (const name of RETIRED_MISSION_MODES) {
    if (command === name || command.startsWith(`${name} `)) return true;
    if (new RegExp(`^sks\\s+${escapeRegExp(name)}(?:\\s|$)`).test(command)) return true;
  }
  const retiredMultiplexerName = ['zel', 'lij'].join('');
  if (new RegExp(`^sks\\s+--(?:agent|naruto|clones|${retiredMultiplexerName}-dashboard|glm)(?:[=\\s]|$)`).test(command)) return true;
  if (new RegExp(`^sks\\s+${retiredMultiplexerName}\\s+dashboard(?:\\s|$)`).test(command)) return true;
  return false;
}

export function isRetiredMissionIdentity(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (isRetiredMissionMode(value.mode)) return true;
  if (['route', 'route_command', 'command'].some((field) => isRetiredPublicValue(value[field]))) return true;
  return RETIRED_ROUTE_BLACKBOX_KINDS.has(String(value.route_blackbox_kind || '').trim().toLowerCase());
}

export function isRetiredCommandTombstone(value: string): boolean {
  return RETIRED_COMMAND_TOMBSTONES.has(value);
}

export function normalizeRetiredToken(value: unknown): string {
  return String(value || '').trim().replace(/^\$+/, '').replace(/_/g, '-').toLowerCase();
}

export async function quarantineUserPath(root: string, source: string, quarantineRoot: string): Promise<void> {
  const inspected = await inspectConfinedPath(root, source);
  if (!inspected.exists) return;
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('retired_residue_quarantine_source_invalid');
  const destination = await uniqueConfinedPath(root, path.join(quarantineRoot, relative));
  await moveConfinedPath(root, source, destination);
}

export async function walkEntries(boundary: string, root: string): Promise<ConfinedWalkResult> {
  return walkConfinedEntries(boundary, root);
}

export async function removeEmptyTree(boundary: string, root: string): Promise<EmptyTreeRemovalResult> {
  return removeEmptyTreeVerified(boundary, root);
}
