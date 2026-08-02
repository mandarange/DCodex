import path from 'node:path';
import { ensureDir, nowIso, randomId, writeJsonAtomic, appendJsonl, readJson, exists, sha256, type JsonData } from './fsx.js';
import { withFileLock } from './locks/file-lock.js';
import { buildRequestIntake, REQUEST_INTAKE_ARTIFACT } from './questions.js';

export function missionId() {
  const d = new Date();
  const pad = (n: any) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `M-${stamp}-${randomId(4)}`;
}

export function sineDir(root: any) { return path.join(root, '.sneakoscope'); }
export function missionsDir(root: any) { return path.join(sineDir(root), 'missions'); }
export function missionDir(root: any, id: any) { return path.join(missionsDir(root), id); }
export function stateFile(root: any) { return path.join(sineDir(root), 'state', 'current.json'); }
export function stateSessionsDir(root: any) { return path.join(sineDir(root), 'state', 'sessions'); }
export function stateLockPath(root: any) { return path.join(sineDir(root), 'state', 'current.lock'); }
export function sessionStateKey(sessionKey: any = 'default') {
  const value = String(sessionKey || 'default');
  return /^[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : sha256(value).slice(0, 12);
}
export function stateFileForSession(root: any, sessionKey: any) {
  return path.join(stateSessionsDir(root), `${sessionStateKey(sessionKey)}.json`);
}

export function validateExternallyReservedMissionId(rawId: unknown): { ok: true; id: string } | { ok: false; reason: string } {
  const id = String(rawId ?? '');
  if (!id.startsWith('M-')) return { ok: false, reason: 'missing_m_prefix' };
  if (id.length < 3 || id.length > 160) return { ok: false, reason: 'length' };
  if (id.trim() !== id) return { ok: false, reason: 'normalization' };
  if (id.includes('/') || id.includes('\\') || id.includes('\0') || /\s/.test(id) || id.includes('..')) {
    return { ok: false, reason: 'path' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, reason: 'charset' };
  return { ok: true, id };
}

export async function createMission(root: any, { mode, prompt, sessionKey, requestedId }: any): Promise<JsonData> {
  return withStateLock(root, () => createMissionUnlocked(root, { mode, prompt, sessionKey, requestedId }));
}

export async function getOrCreateExplicitNarutoMission(root: any, input: {
  requestedId: string;
  prompt: string;
  sessionKey?: string | null;
}): Promise<{ ok: true; id: string; dir: string } | { ok: false; blockers: string[] }> {
  const validated = validateExternallyReservedMissionId(input.requestedId);
  if (!validated.ok) {
    return { ok: false, blockers: [`naruto_mission_id_invalid:${validated.reason}`] };
  }
  const normalizedPrompt = String(input.prompt || '').trim();
  return withStateLock(root, async () => {
    let loaded = await loadMission(root, validated.id).catch(() => null);
    if (!loaded) {
      try {
        const created = await createMissionUnlocked(root, {
          mode: 'naruto',
          prompt: normalizedPrompt,
          sessionKey: input.sessionKey,
          requestedId: validated.id
        });
        return { ok: true, id: String(created.id), dir: String(created.dir) };
      } catch (error: any) {
        if (error?.code !== 'mission_already_exists') throw error;
        loaded = await loadMission(root, validated.id).catch(() => null);
        if (!loaded) {
          return { ok: false, blockers: [`naruto_mission_not_found:${validated.id}`] };
        }
      }
    }
    if (String(loaded.mission?.mode || '') !== 'naruto') {
      return { ok: false, blockers: ['naruto_mission_identity_conflict:mission_mode'] };
    }
    if (String(loaded.mission?.prompt || '').trim() !== normalizedPrompt) {
      return { ok: false, blockers: ['naruto_mission_identity_conflict:mission_prompt'] };
    }
    return { ok: true, id: String(loaded.id), dir: String(loaded.dir) };
  });
}

async function createMissionUnlocked(root: any, { mode, prompt, sessionKey, requestedId }: any): Promise<JsonData> {
  let id: string;
  if (requestedId != null && String(requestedId).length > 0) {
    const validated = validateExternallyReservedMissionId(requestedId);
    if (!validated.ok) {
      const err = new Error(`invalid_mission_id:${validated.reason}`);
      (err as any).code = 'invalid_mission_id';
      (err as any).reason = validated.reason;
      throw err;
    }
    id = validated.id;
    if (await exists(path.join(missionDir(root, id), 'mission.json'))) {
      const err = new Error('mission_already_exists');
      (err as any).code = 'mission_already_exists';
      (err as any).id = id;
      throw err;
    }
  } else {
    id = missionId();
  }
  const dir = missionDir(root, id);
  await ensureDir(dir);
  await ensureDir(path.join(dir, 'bus'));
  await ensureDir(path.join(dir, 'goal'));
  await ensureDir(path.join(dir, 'sessions'));
  const mission = {
    id,
    mode,
    prompt,
    created_at: nowIso(),
    phase: mode === 'goal' ? 'GOAL_PREPARE' : 'PREPARE',
    questions_allowed: true,
    implementation_allowed: false
  };
  await writeJsonAtomic(path.join(dir, 'mission.json'), mission);
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'mission.created', mission: id, mode, prompt });
  await setCurrentUnlocked(root, { mission_id: id, mode: mode.toUpperCase(), phase: mission.phase }, { replace: true, sessionKey });
  return { id, dir, mission };
}

export async function getOrCreateSessionMission(root: any, input: {
  mode: string;
  prompt: string;
  sessionKey: string;
  selectMissionId: (state: JsonData) => string | null;
  syncRequestIntake?: boolean;
}): Promise<JsonData> {
  return withStateLock(root, async () => {
    const state = await loadStateForSessionUnlocked(root, input.sessionKey);
    const selectedMissionId = String(input.selectMissionId(state) || '').trim();
    if (selectedMissionId) {
      const loaded = await loadMission(root, selectedMissionId).catch(() => null);
      if (loaded) {
        const synced = await syncSessionMissionPrompt(root, selectedMissionId, input.prompt, loaded.mission, {
          ensureRequestIntake: input.syncRequestIntake === true
        });
        return { ...loaded, mission: synced, reused: true };
      }
    }
    const created = await createMissionUnlocked(root, {
      mode: input.mode,
      prompt: input.prompt,
      sessionKey: input.sessionKey
    });
    const synced = await syncSessionMissionPrompt(root, String(created.id), input.prompt, created.mission, {
      ensureRequestIntake: input.syncRequestIntake === true
    });
    return { ...created, mission: synced, reused: false };
  });
}

export async function syncSessionMissionPrompt(
  root: string,
  id: string,
  prompt: string,
  loadedMission?: any,
  opts: { ensureRequestIntake?: boolean } = {}
) {
  const normalizedPrompt = String(prompt || '').trim();
  const dir = missionDir(root, id);
  const missionFile = path.join(dir, 'mission.json');
  const mission = loadedMission || await readJson(missionFile, {});
  if (!normalizedPrompt) return mission;
  if (String(mission?.prompt || '').trim() === normalizedPrompt) {
    if (opts.ensureRequestIntake === true) await ensureSessionRequestIntake(dir, normalizedPrompt);
    return mission;
  }

  const previousPrompt = String(mission?.prompt || '').trim();
  const updated = {
    ...mission,
    original_prompt: String(mission?.original_prompt || previousPrompt || normalizedPrompt),
    prompt: normalizedPrompt,
    active_prompt: normalizedPrompt,
    prompt_updated_at: nowIso()
  };
  await writeJsonAtomic(missionFile, updated);

  if (opts.ensureRequestIntake === true) await ensureSessionRequestIntake(dir, normalizedPrompt);
  await appendJsonl(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'mission.prompt.synchronized',
    mission: id,
    previous_prompt_hash: previousPrompt ? sha256(previousPrompt).slice(0, 16) : null,
    prompt_hash: sha256(normalizedPrompt).slice(0, 16)
  });
  return updated;
}

async function ensureSessionRequestIntake(dir: string, prompt: string) {
  const intakeFile = path.join(dir, REQUEST_INTAKE_ARTIFACT);
  const intake = await readJson<any>(intakeFile, null).catch(() => null);
  if (intake?.schema === 'sks.request-intake.v1' && intake.original_prompt === prompt) return intake;
  const refreshed = buildRequestIntake(prompt);
  await writeJsonAtomic(intakeFile, {
    ...refreshed,
    wiki_context_used: intake?.wiki_context_used || refreshed.wiki_context_used,
    supersedes_prompt_hash: intake?.prompt_hash || null,
    refreshed_for_session_reuse: true
  });
  return refreshed;
}

export async function loadMission(root: any, id: any): Promise<JsonData> {
  const dir = missionDir(root, id);
  const mission = await readJson(path.join(dir, 'mission.json'));
  return { id, dir, mission };
}

function normalizeMissionRoute(value: any): string {
  return String(value || '').replace(/^\$/, '').replace(/_/g, '-').toLowerCase();
}

export interface FindLatestMissionOptions {
  route?: string | null;
  mode?: string | null;
  gateFile?: string | null;
}

export async function findLatestMission(root: any, opts: FindLatestMissionOptions = {}) {
  const { route = null, mode = null, gateFile = null } = opts || {};
  const dir = missionsDir(root);
  if (!(await exists(dir))) return null;
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const ids = entries.filter((e: any) => e.isDirectory() && e.name.startsWith('M-')).map((e: any) => e.name);
  const candidates = (await Promise.all(ids.map(async (id: any) => {
    const dirPath = missionDir(root, id);
    const stat = await fs.stat(dirPath).catch(() => null);
    const mission = await readJson(path.join(dirPath, 'mission.json'), {}).catch(() => ({}));
    if (mode && mission.mode !== mode) return null;
    // Route scoping is indirect: mission.json never carries a route field, so the
    // caller must name the route-specific gate artifact to probe for.
    if (route && gateFile) {
      const gate = await readJson(path.join(dirPath, gateFile), null).catch(() => null);
      if (!gate) return null;
      const actual = normalizeMissionRoute((gate as any).route || (gate as any).route_command || '');
      if (actual && actual !== normalizeMissionRoute(route)) return null;
    }
    const createdMs = Date.parse(mission.created_at || mission.updated_at || '');
    return {
      id,
      createdMs: Number.isFinite(createdMs) ? createdMs : 0,
      mtimeMs: stat?.mtimeMs || 0
    };
  }))).filter((candidate): candidate is { id: string; createdMs: number; mtimeMs: number } => candidate !== null);
  candidates.sort((a: any, b: any) => (a.createdMs - b.createdMs) || (a.mtimeMs - b.mtimeMs) || a.id.localeCompare(b.id));
  return candidates.at(-1)?.id || null;
}

export async function setCurrent(root: any, patch: any, opts: any = {}) {
  return withStateLock(root, () => setCurrentUnlocked(root, patch, opts));
}

export async function updateCurrentIfMissionAndRun(
  root: any,
  expectedMissionId: any,
  expectedWorkflowRunId: any,
  update: any | ((current: JsonData) => any),
  opts: any = {}
) {
  return withStateLock(root, async () => {
    const explicitSessionKey = opts.sessionKey || null;
    const sessionKey = explicitSessionKey ? sessionStateKey(explicitSessionKey) : null;
    const targetFile = sessionKey ? path.join(stateSessionsDir(root), `${sessionKey}.json`) : stateFile(root);
    const current = await readJson(targetFile, {});
    const expected = String(expectedMissionId || '');
    const actual = String(current?.mission_id || '');
    const expectedRun = String(expectedWorkflowRunId || '');
    const actualRun = String(current?.official_subagent_run_id || '');
    if (!expected || actual !== expected || actualRun !== expectedRun) {
      return {
        updated: false,
        status: actual !== expected ? 'mission_mismatch' : 'workflow_run_mismatch',
        expected_mission_id: expected || null,
        current_mission_id: actual || null,
        expected_workflow_run_id: expectedRun || null,
        current_workflow_run_id: actualRun || null
      };
    }
    const patch = typeof update === 'function' ? await update(current) : update;
    if (!patch || typeof patch !== 'object') {
      return {
        updated: false,
        status: 'unchanged',
        expected_mission_id: expected,
        current_mission_id: actual,
        expected_workflow_run_id: expectedRun || null,
        current_workflow_run_id: actualRun || null
      };
    }
    await setCurrentUnlocked(root, patch, { ...opts, sessionKey: explicitSessionKey });
    return {
      updated: true,
      status: 'updated',
      expected_mission_id: expected,
      current_mission_id: actual,
      expected_workflow_run_id: expectedRun || null,
      current_workflow_run_id: actualRun || null
    };
  });
}

async function setCurrentUnlocked(root: any, patch: any, opts: any = {}) {
  const explicitSessionKey = opts.sessionKey || patch?._session_key || null;
  const sessionKey = explicitSessionKey ? sessionStateKey(explicitSessionKey) : null;
  const targetFile = sessionKey ? path.join(stateSessionsDir(root), `${sessionKey}.json`) : stateFile(root);
  const current = opts.replace ? {} : await readJson(targetFile, {});
  const preempted = routePreemptions(current, patch, opts);
  const next = {
    ...current,
    ...patch,
    ...(preempted.length ? { preempted_missions: preempted } : {}),
    ...(sessionKey ? { _session_key: sessionKey } : {}),
    updated_at: nowIso()
  };
  if (sessionKey) {
    await ensureDir(stateSessionsDir(root));
    await writeJsonAtomic(targetFile, next);
    await writeJsonAtomic(stateFile(root), next).catch(() => undefined);
    return;
  }
  await writeJsonAtomic(stateFile(root), next);
}

export async function closeRouteState(root: any, input: { missionId?: string | null; sessionKey?: string | null; reason?: string | null } = {}) {
  return withStateLock(root, async () => {
    const sessionKey = input.sessionKey ? sessionStateKey(input.sessionKey) : null;
    const targetFile = sessionKey ? path.join(stateSessionsDir(root), `${sessionKey}.json`) : stateFile(root);
    const current = await readJson(targetFile, {});
    const missionId = String(input.missionId || current.mission_id || '');
    if (input.missionId && current.mission_id && String(current.mission_id) !== String(input.missionId)) {
      return { ok: false, status: 'mission_mismatch', mission_id: missionId, current_mission_id: current.mission_id };
    }
    const next = closedRouteState(current, missionId, input.reason, sessionKey);
    if (sessionKey) {
      await ensureDir(stateSessionsDir(root));
      await writeJsonAtomic(targetFile, next);
      await writeJsonAtomic(stateFile(root), next).catch(() => undefined);
    } else {
      await writeJsonAtomic(stateFile(root), next);
      for (const row of await matchingSessionStates(root, missionId, current._session_key)) {
        await writeJsonAtomic(row.path, closedRouteState(row.state, missionId, input.reason, row.session_key));
      }
    }
    if (missionId) {
      await appendJsonl(path.join(missionDir(root, missionId), 'events.jsonl'), {
        ts: nowIso(),
        type: 'route.state.closed',
        reason: input.reason || 'route_close_command',
        session_key: sessionKey
      }).catch(() => undefined);
    }
    return { ok: true, status: 'closed', mission_id: missionId || null, state_file: targetFile };
  });
}

function closedRouteState(current: any, missionId: string, reason?: string | null, sessionKey?: string | null) {
  const phase = String(current.phase || '');
  return {
    ...current,
    mission_id: missionId || current.mission_id || null,
    route_closed: true,
    route_closed_at: nowIso(),
    route_close_reason: reason || 'route_close_command',
    implementation_allowed: false,
    questions_allowed: true,
    mad_sks_active: false,
    permission_gate_active: false,
    gate_owner_mission_id: null,
    phase: phase ? (/_CLOSED$/i.test(phase) ? phase : `${phase}_CLOSED`) : 'ROUTE_CLOSED',
    updated_at: nowIso(),
    ...(sessionKey ? { _session_key: sessionKey } : {})
  };
}

async function matchingSessionStates(root: any, missionId: string, preferredSessionKey?: string | null) {
  const dir = stateSessionsDir(root);
  const rows: Array<{ session_key: string; path: string; state: any }> = [];
  if (!(await exists(dir))) return rows;
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const state = await readJson(file, {}).catch(() => ({}));
    const key = String(state._session_key || entry.name.replace(/\.json$/, ''));
    if (String(state.mission_id || '') === missionId || (preferredSessionKey && key === String(preferredSessionKey))) {
      rows.push({ session_key: key, path: file, state });
    }
  }
  return rows;
}

function withStateLock<T>(root: any, fn: () => Promise<T>): Promise<T> {
  return withFileLock({ lockPath: stateLockPath(root), timeoutMs: 20_000, staleMs: 120_000 }, fn);
}

function routePreemptions(current: any = {}, patch: any = {}, opts: any = {}) {
  const existingMission = current?.mission_id ? String(current.mission_id) : '';
  const nextMission = patch?.mission_id ? String(patch.mission_id) : '';
  const replaces = Boolean(opts.replace);
  const alreadyClosed = current?.route_closed === true || /(?:DONE|COMPLETE|CLOSED|BLOCKED)$/i.test(String(current?.phase || ''));
  if (!existingMission || !nextMission || existingMission === nextMission || replaces || alreadyClosed) {
    return Array.isArray(current?.preempted_missions) ? current.preempted_missions : [];
  }
  const row = {
    mission_id: existingMission,
    mode: current.mode || null,
    route: current.route || null,
    route_command: current.route_command || null,
    phase: current.phase || null,
    stop_gate_abs_path: current.stop_gate_abs_path || null,
    preempted_at: nowIso(),
    preempted_by_mission_id: nextMission
  };
  return [row, ...(Array.isArray(current?.preempted_missions) ? current.preempted_missions : [])].slice(0, 25);
}

export async function loadStateForSession(root: any, sessionKey: any): Promise<JsonData> {
  return loadStateForSessionUnlocked(root, sessionKey);
}

/**
 * Resolve route-gate state for one invocation without borrowing another
 * session's global compatibility mirror.
 *
 * `state/current.json` is updated after session-scoped writes so legacy
 * diagnostics can still discover the most recently touched route. It is not
 * an ownership record. A named session therefore reads its own state file
 * (with a same-owner mirror fallback for older installations), while an
 * unnamed standalone CLI invocation may read only an unowned legacy state.
 */
export async function loadOwnedRouteState(root: any, sessionKey?: any): Promise<JsonData> {
  const requestedSession = String(sessionKey || '').trim();
  if (requestedSession) {
    const hashed = sessionStateKey(requestedSession);
    const sessionState = await readJson(stateFileForSession(root, requestedSession), null).catch(() => null);
    if (sessionState) return { ...sessionState, _session_key: sessionState._session_key || hashed };

    const mirror = await readJson(stateFile(root), {}).catch(() => ({}));
    const mirrorSessionKey = String(mirror?._session_key || '').trim();
    const mirrorSessionScope = String(mirror?.session_scope || '').trim();
    const sameOwner = mirrorSessionKey === hashed
      || mirrorSessionKey === requestedSession
      || mirrorSessionScope === requestedSession;
    return sameOwner ? { ...mirror, _session_key: mirrorSessionKey || hashed } : {};
  }

  const legacy = await readJson(stateFile(root), {}).catch(() => ({}));
  const hasNamedOwner = Boolean(
    String(legacy?._session_key || '').trim()
    || String(legacy?.session_scope || '').trim()
  );
  return hasNamedOwner ? {} : legacy;
}

async function loadStateForSessionUnlocked(root: any, sessionKey: any): Promise<JsonData> {
  const hashed = sessionStateKey(sessionKey || 'default');
  const file = path.join(stateSessionsDir(root), `${hashed}.json`);
  const sessionState = await readJson(file, null).catch(() => null);
  if (sessionState) return { ...sessionState, _session_key: sessionState._session_key || hashed };
  const legacy = await readJson(stateFile(root), {}).catch(() => ({}));
  return Object.keys(legacy || {}).length ? { ...legacy, _session_key: legacy._session_key || hashed } : {};
}

export async function listSessionStates(root: any): Promise<Array<{ session_key: string; path: string; state: JsonData; updated_at: string | null; mission_id: string | null; phase: string | null }>> {
  const dir = stateSessionsDir(root);
  if (!(await exists(dir))) return [];
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const rows = await Promise.all(entries
    .filter((entry: any) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry: any) => {
      const file = path.join(dir, entry.name);
      const state = await readJson(file, {}).catch(() => ({}));
      const key = entry.name.replace(/\.json$/, '');
      return {
        session_key: String(state._session_key || key),
        path: file,
        state,
        updated_at: state.updated_at || null,
        mission_id: state.mission_id || null,
        phase: state.phase || null
      };
    }));
  rows.sort((a, b) => timestampMs(b.updated_at) - timestampMs(a.updated_at));
  return rows;
}

function timestampMs(value: any) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
