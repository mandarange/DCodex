import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../fsx.js';
import {
  REMOTE_MACHINE_REGISTRY_SCHEMA,
  type RemoteMachineRegistryV1,
  type RemoteMachineRegistryValidation,
  type RemoteMachineV1
} from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

const MACHINE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function remoteMachineRegistryPath(globalRoot: string): string {
  return path.join(path.resolve(globalRoot), 'remote', 'machines.json');
}

export function validateSshAlias(value: unknown): value is string {
  return typeof value === 'string' && SSH_ALIAS_RE.test(value);
}

export function validateRemoteMachineRegistry(value: unknown): RemoteMachineRegistryValidation {
  const issues: string[] = [];
  const record = asRecord(value);
  if (!record || record.schema !== REMOTE_MACHINE_REGISTRY_SCHEMA) issues.push('invalid_registry_schema');
  const rawMachines = Array.isArray(record?.machines) ? record.machines : [];
  if (!Array.isArray(record?.machines)) issues.push('machines_array_required');
  if (rawMachines.length > 128) issues.push('machine_count_exceeds_128');
  const ids = new Set<string>();
  const aliases = new Set<string>();
  const machines: RemoteMachineV1[] = [];

  rawMachines.forEach((raw, index) => {
    const machine = asRecord(raw);
    const prefix = `machine_${index}`;
    if (!machine) {
      issues.push(`${prefix}:object_required`);
      return;
    }
    const id = stringValue(machine.id);
    const displayName = stringValue(machine.display_name);
    const sshAlias = stringValue(machine.ssh_alias);
    const transport = machine.transport;
    const enabled = machine.enabled;
    if (!MACHINE_ID_RE.test(id)) issues.push(`${prefix}:invalid_id`);
    if (ids.has(id)) issues.push(`${prefix}:duplicate_id`);
    if (id) ids.add(id);
    if (!displayName || displayName.length > 120) issues.push(`${prefix}:invalid_display_name`);
    if (transport !== 'local' && transport !== 'ssh-stdio') issues.push(`${prefix}:unsupported_transport`);
    if (transport === 'ssh-stdio') {
      if (!validateSshAlias(sshAlias)) issues.push(`${prefix}:invalid_ssh_alias`);
      if (aliases.has(sshAlias)) issues.push(`${prefix}:duplicate_ssh_alias`);
      if (sshAlias) aliases.add(sshAlias);
    } else if (sshAlias) {
      issues.push(`${prefix}:local_ssh_alias_forbidden`);
    }
    if (typeof enabled !== 'boolean') issues.push(`${prefix}:enabled_boolean_required`);
    const roots = Array.isArray(machine.allowed_roots) ? machine.allowed_roots.map(stringValue) : [];
    if (!Array.isArray(machine.allowed_roots) || roots.length === 0) issues.push(`${prefix}:allowed_roots_required`);
    if (roots.length > 32) issues.push(`${prefix}:allowed_roots_exceeds_32`);
    const uniqueRoots = new Set<string>();
    roots.forEach((root, rootIndex) => {
      const issue = validateAllowedRoot(root);
      if (issue) issues.push(`${prefix}:root_${rootIndex}:${issue}`);
      const normalized = path.normalize(root);
      if (uniqueRoots.has(normalized)) issues.push(`${prefix}:root_${rootIndex}:duplicate_root`);
      uniqueRoots.add(normalized);
    });
    const transportValid = transport === 'local' || (transport === 'ssh-stdio' && validateSshAlias(sshAlias));
    if (MACHINE_ID_RE.test(id) && displayName && transportValid && typeof enabled === 'boolean') {
      machines.push({
        id,
        display_name: displayName,
        transport,
        ...(transport === 'ssh-stdio' ? { ssh_alias: sshAlias } : {}),
        allowed_roots: roots,
        enabled
      });
    }
  });

  return {
    ok: issues.length === 0,
    issues,
    registry: issues.length === 0 ? { schema: REMOTE_MACHINE_REGISTRY_SCHEMA, machines } : null
  };
}

export async function loadRemoteMachineRegistry(file: string): Promise<RemoteMachineRegistryV1> {
  const validation = validateRemoteMachineRegistry(await readJson<unknown>(path.resolve(file), null));
  if (!validation.ok || !validation.registry) throw new Error(`remote_machine_registry_invalid:${validation.issues.join(',')}`);
  return validation.registry;
}

export function findRemoteMachine(registry: RemoteMachineRegistryV1, machineId: string): RemoteMachineV1 {
  const machine = registry.machines.find((candidate) => candidate.id === machineId && candidate.enabled);
  if (!machine) throw new Error(`remote_machine_unknown_or_disabled:${machineId}`);
  return machine;
}

export function selectWorkerMachine(
  registry: RemoteMachineRegistryV1,
  explicitMachineId: string | null,
  hostname: string = os.hostname()
): RemoteMachineV1 {
  if (explicitMachineId) return findRemoteMachine(registry, explicitMachineId);
  const hostnameMatch = registry.machines.find((machine) => machine.enabled && machine.id === hostname);
  if (hostnameMatch) return hostnameMatch;
  const enabled = registry.machines.filter((machine) => machine.enabled);
  if (enabled.length === 1 && enabled[0]) return enabled[0];
  throw new Error('remote_worker_machine_id_required');
}

export async function resolveAllowedProjectRoot(machine: RemoteMachineV1, candidateRoot: string): Promise<string> {
  if (!path.isAbsolute(candidateRoot)) throw new Error('remote_project_root_must_be_absolute');
  const candidateReal = await fsp.realpath(path.resolve(candidateRoot)).catch(() => null);
  if (!candidateReal) throw new Error('remote_project_root_unreadable');
  const candidateStat = await fsp.stat(candidateReal).catch(() => null);
  if (!candidateStat?.isDirectory()) throw new Error('remote_project_root_not_directory');

  for (const configuredRoot of machine.allowed_roots) {
    const rootStat = await fsp.lstat(configuredRoot).catch(() => null);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
    const allowedReal = await fsp.realpath(configuredRoot).catch(() => null);
    if (!allowedReal) continue;
    if (isWithinRoot(allowedReal, candidateReal)) return candidateReal;
  }
  throw new Error('remote_project_root_not_allowlisted_or_symlink_escape');
}

export function isLexicallyWithinAllowedRoot(machine: RemoteMachineV1, candidateRoot: string): boolean {
  if (!path.isAbsolute(candidateRoot)) return false;
  const candidate = path.resolve(candidateRoot);
  return machine.allowed_roots.some((root) => isWithinRoot(path.resolve(root), candidate));
}

export function validateAllowedRoot(root: string): string | null {
  if (!root || !path.isAbsolute(root)) return 'absolute_path_required';
  if (path.normalize(root) !== root || root.includes(`${path.sep}..${path.sep}`) || root.endsWith(`${path.sep}..`)) return 'normalized_path_required';
  const parsedRoot = path.parse(root).root;
  if (root === parsedRoot) return 'filesystem_root_forbidden';
  const normalized = root.replace(/\/+$/, '');
  if (normalized === os.homedir().replace(/\/+$/, '')) return 'home_root_forbidden';
  if (/^\/Users\/[^/]+$/.test(normalized) || /^\/home\/[^/]+$/.test(normalized) || normalized === '/root') return 'home_root_forbidden';
  return null;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
