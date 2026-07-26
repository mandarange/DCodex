import path from 'node:path';
import { readJson } from '../fsx.js';
import { findRemoteMachine, isLexicallyWithinAllowedRoot } from './machine-registry.js';
import {
  REMOTE_SESSION_INDEX_SCHEMA,
  type RemoteMachineRegistryV1,
  type RemoteSessionIndexV1,
  type RemoteSessionIndexValidation,
  type RemoteSessionTargetV1
} from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function remoteSessionIndexPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.sneakoscope', 'remote', 'session-index.json');
}

export function validateRemoteSessionIndex(value: unknown, registry: RemoteMachineRegistryV1): RemoteSessionIndexValidation {
  const issues: string[] = [];
  const record = asRecord(value);
  if (!record || record.schema !== REMOTE_SESSION_INDEX_SCHEMA) issues.push('invalid_session_index_schema');
  const rawTargets = Array.isArray(record?.targets) ? record.targets : [];
  if (!Array.isArray(record?.targets)) issues.push('session_targets_array_required');
  if (rawTargets.length > 256) issues.push('session_target_count_exceeds_256');
  const targets: RemoteSessionTargetV1[] = [];
  const keys = new Set<string>();

  rawTargets.forEach((raw, index) => {
    const target = asRecord(raw);
    const prefix = `target_${index}`;
    if (!target) {
      issues.push(`${prefix}:object_required`);
      return;
    }
    const machineId = stringValue(target.machine_id);
    const projectId = stringValue(target.project_id);
    const projectRoot = stringValue(target.project_root);
    if (!IDENTIFIER_RE.test(machineId)) issues.push(`${prefix}:machine_id_invalid`);
    if (!IDENTIFIER_RE.test(projectId)) issues.push(`${prefix}:project_id_invalid`);
    if (!path.isAbsolute(projectRoot) || path.normalize(projectRoot) !== projectRoot) issues.push(`${prefix}:project_root_invalid`);
    const key = `${machineId}:${projectId}`;
    if (keys.has(key)) issues.push(`${prefix}:duplicate_machine_project`);
    keys.add(key);
    try {
      const machine = findRemoteMachine(registry, machineId);
      if (projectRoot && !isLexicallyWithinAllowedRoot(machine, projectRoot)) issues.push(`${prefix}:project_root_not_allowlisted`);
    } catch {
      issues.push(`${prefix}:machine_unknown_or_disabled`);
    }
    if (IDENTIFIER_RE.test(machineId) && IDENTIFIER_RE.test(projectId) && path.isAbsolute(projectRoot)) {
      targets.push({ machine_id: machineId, project_id: projectId, project_root: path.normalize(projectRoot) });
    }
  });

  return {
    ok: issues.length === 0,
    issues,
    index: issues.length === 0 ? { schema: REMOTE_SESSION_INDEX_SCHEMA, targets } : null
  };
}

export async function loadRemoteSessionIndex(file: string, registry: RemoteMachineRegistryV1): Promise<RemoteSessionIndexV1> {
  const validation = validateRemoteSessionIndex(await readJson<unknown>(path.resolve(file), null), registry);
  if (!validation.ok || !validation.index) throw new Error(`remote_session_index_invalid:${validation.issues.join(',')}`);
  return validation.index;
}

export function findRemoteSessionTarget(index: RemoteSessionIndexV1, machineId: string, projectId: string): RemoteSessionTargetV1 {
  const target = index.targets.find((candidate) => candidate.machine_id === machineId && candidate.project_id === projectId);
  if (!target) throw new Error(`remote_session_target_unknown:${machineId}:${projectId}`);
  return target;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
