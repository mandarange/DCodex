import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, sha256, writeJsonAtomic } from '../../fsx.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  moveConfinedPath,
  uniqueConfinedPath
} from '../../managed-path-safety.js';
import { sessionStateKey } from '../../mission.js';
import type { UpdateMigrationStageRun } from '../update-migration-state.js';

const LEGACY_CURRENT_STATE_MAX_BYTES = 1024 * 1024;
type StageOutcome = Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>;

export async function runSessionStateSplitStage(root: string): Promise<StageOutcome> {
  const legacyCurrent = path.join(root, '.sneakoscope', 'current.json');
  const stateCurrent = path.join(root, '.sneakoscope', 'state', 'current.json');
  const sessionsDir = path.join(root, '.sneakoscope', 'state', 'sessions');
  await ensureConfinedDirectory(root, sessionsDir);
  const actions: string[] = [];
  const legacyRead = await readBoundedUpdateState(root, legacyCurrent, { requireLegacyShape: true });
  if (legacyRead.blocker) {
    return {
      ok: false,
      status: 'failed',
      actions: ['legacy_current_state_preserved'],
      blockers: [legacyRead.blocker],
      warnings: [],
      detail: { legacy_present: legacyRead.present }
    };
  }
  const currentRead = await readBoundedUpdateState(root, stateCurrent);
  if (currentRead.blocker) {
    return {
      ok: false,
      status: 'failed',
      actions: ['current_state_preserved'],
      blockers: [currentRead.blocker],
      warnings: [],
      detail: { legacy_present: legacyRead.present }
    };
  }
  let current = currentRead.value;
  if (!current && legacyRead.value) {
    current = legacyRead.value;
    await writeJsonAtomic(stateCurrent, current);
    const verified = await readBoundedUpdateState(root, stateCurrent);
    if (verified.blocker || !verified.value || updateStateDigest(verified.value) !== legacyRead.sha256) {
      return {
        ok: false,
        status: 'failed',
        actions: ['copy_legacy_current_json_failed_verification'],
        blockers: [verified.blocker || 'legacy_current_state_copy_verification_failed'],
        warnings: [],
        detail: { legacy_present: true }
      };
    }
    actions.push('copied_legacy_current_json_to_state_current');
  }
  const missionId = typeof current?.mission_id === 'string'
    ? current.mission_id
    : typeof current?.mission === 'string'
      ? current.mission
      : null;
  const rawSessionKey = typeof current?._session_key === 'string' && current._session_key.trim()
    ? current._session_key
    : null;
  const canonicalSessionKey = rawSessionKey ? sessionStateKey(rawSessionKey) : null;
  if (canonicalSessionKey) {
    const sessionPath = path.join(sessionsDir, `${canonicalSessionKey}.json`);
    const sessionRead = await readBoundedUpdateState(root, sessionPath);
    if (sessionRead.blocker) {
      return {
        ok: false,
        status: 'failed',
        actions,
        blockers: [sessionRead.blocker],
        warnings: [],
        detail: { legacy_present: legacyRead.present, mission_id: missionId, session_key: canonicalSessionKey }
      };
    }
    if (!sessionRead.present) {
      await writeJsonAtomic(sessionPath, {
        ...current,
        _session_key: canonicalSessionKey,
        migrated_from: path.relative(root, stateCurrent),
        migrated_at: nowIso()
      });
      const verifiedSession = await readBoundedUpdateState(root, sessionPath);
      if (
        verifiedSession.blocker
        || verifiedSession.value?._session_key !== canonicalSessionKey
        || verifiedSession.value?.mission_id !== current?.mission_id
      ) {
        return {
          ok: false,
          status: 'failed',
          actions,
          blockers: [verifiedSession.blocker || 'legacy_session_state_copy_verification_failed'],
          warnings: [],
          detail: { legacy_present: legacyRead.present, mission_id: missionId, session_key: canonicalSessionKey }
        };
      }
      actions.push('wrote_state_session_alias');
    }
  }
  let quarantinePath: string | null = null;
  if (legacyRead.present) {
    const quarantineBase = path.join(
      root,
      '.sneakoscope',
      'quarantine',
      'update-legacy-state',
      `current-${legacyRead.sha256?.slice(0, 12) || 'unknown'}.json`
    );
    quarantinePath = await uniqueConfinedPath(root, quarantineBase);
    await moveConfinedPath(root, legacyCurrent, quarantinePath);
    const quarantined = await readBoundedUpdateState(root, quarantinePath, { requireLegacyShape: true });
    const legacyAfter = await inspectConfinedPath(root, legacyCurrent);
    if (
      legacyAfter.exists
      || quarantined.blocker
      || !quarantined.value
      || quarantined.sha256 !== legacyRead.sha256
    ) {
      const sourceAfter = await inspectConfinedPath(root, legacyCurrent);
      if (!sourceAfter.exists && (await inspectConfinedPath(root, quarantinePath)).exists) {
        await moveConfinedPath(root, quarantinePath, legacyCurrent).catch(() => undefined);
      }
      return {
        ok: false,
        status: 'failed',
        actions: [...actions, 'legacy_current_state_quarantine_rolled_back'],
        blockers: [quarantined.blocker || 'legacy_current_state_quarantine_verification_failed'],
        warnings: [],
        detail: { legacy_present: true, mission_id: missionId }
      };
    }
    actions.push('quarantined_legacy_current_json');
  }
  if (!actions.length) actions.push('session_state_current');
  return {
    ok: true,
    status: 'ok',
    actions,
    blockers: [],
    warnings: [],
    detail: {
      legacy_present: legacyRead.present,
      mission_id: missionId,
      session_key: canonicalSessionKey,
      legacy_quarantine_path: quarantinePath ? path.relative(root, quarantinePath) : null
    }
  };
}

async function readBoundedUpdateState(
  root: string,
  file: string,
  opts: { requireLegacyShape?: boolean } = {}
): Promise<{
  present: boolean;
  value: Record<string, unknown> | null;
  sha256: string | null;
  blocker: string | null;
}> {
  let inspected;
  try {
    inspected = await inspectConfinedPath(root, file);
  } catch (error: any) {
    return {
      present: true,
      value: null,
      sha256: null,
      blocker: `update_state_path_unsafe:${error?.code || error?.message || String(error)}`
    };
  }
  if (!inspected.exists) return { present: false, value: null, sha256: null, blocker: null };
  if (inspected.leafSymlink) {
    return { present: true, value: null, sha256: null, blocker: 'update_state_symlink_refused' };
  }
  if (!inspected.stat?.isFile()) {
    return { present: true, value: null, sha256: null, blocker: 'update_state_non_regular_refused' };
  }
  if (inspected.stat.size > LEGACY_CURRENT_STATE_MAX_BYTES) {
    return { present: true, value: null, sha256: null, blocker: 'update_state_size_limit_exceeded' };
  }
  let text: string;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    handle = await fsp.open(file, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile()) {
      return { present: true, value: null, sha256: null, blocker: 'update_state_non_regular_refused' };
    }
    if (before.size > LEGACY_CURRENT_STATE_MAX_BYTES) {
      return { present: true, value: null, sha256: null, blocker: 'update_state_size_limit_exceeded' };
    }
    const buffer = Buffer.alloc(LEGACY_CURRENT_STATE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const pathAfter = await inspectConfinedPath(root, file);
    if (
      bytesRead > LEGACY_CURRENT_STATE_MAX_BYTES
      || bytesRead !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || !pathAfter.exists
      || pathAfter.leafSymlink
      || pathAfter.stat?.dev !== after.dev
      || pathAfter.stat?.ino !== after.ino
    ) {
      return { present: true, value: null, sha256: null, blocker: 'update_state_changed_during_safe_read' };
    }
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error: any) {
    return {
      present: true,
      value: null,
      sha256: null,
      blocker: `update_state_read_failed:${error?.code || error?.message || String(error)}`
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { present: true, value: null, sha256: null, blocker: 'update_state_json_invalid' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { present: true, value: null, sha256: null, blocker: 'update_state_object_required' };
  }
  const record = value as Record<string, unknown>;
  if (opts.requireLegacyShape && !isRecognizedLegacyCurrentState(record)) {
    return { present: true, value: null, sha256: null, blocker: 'legacy_current_state_ownership_unproven' };
  }
  return {
    present: true,
    value: record,
    sha256: updateStateDigest(record),
    blocker: null
  };
}

function isRecognizedLegacyCurrentState(value: Record<string, unknown>): boolean {
  const mission = typeof value.mission_id === 'string'
    ? value.mission_id.trim()
    : typeof value.mission === 'string'
      ? value.mission.trim()
      : '';
  if (/^M-[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(mission)) return true;

  const mode = typeof value.mode === 'string' ? value.mode.trim() : '';
  const phase = typeof value.phase === 'string' ? value.phase.trim() : '';
  if (mode === 'IDLE' && phase === 'IDLE') return true;
  if (!mode || !phase) return false;

  const sessionKey = typeof value._session_key === 'string' && value._session_key.trim().length > 0;
  const routeCommand = typeof value.route_command === 'string' && value.route_command.trim().startsWith('$');
  const managedStopGate = ['stop_gate', 'stop_gate_abs_path']
    .some((key) => typeof value[key] === 'string' && String(value[key]).trim().length > 0);
  return sessionKey || routeCommand || managedStopGate;
}

function updateStateDigest(value: Record<string, unknown>): string {
  return sha256(JSON.stringify(value));
}
