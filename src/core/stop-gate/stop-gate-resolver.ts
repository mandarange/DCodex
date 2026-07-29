import path from 'node:path';
import fsp from 'node:fs/promises';
import { exists, readJson, sha256 } from '../fsx.js';
import { missionDir, missionsDir, stateFile, findLatestMission } from '../mission.js';
import type { StopGateResolution } from './stop-gate-types.js';

const GATE_FILE_CANDIDATES = ['stop-gate.json', 'naruto-gate.json'];
const GLM_NARUTO_DIR = '.sneakoscope/glm-naruto';
const ROUTE_CONTEXT_FILE = 'route-context.json';

async function statOrNull(filePath: string): Promise<{ mtime: string; sha: string; size: number } | null> {
  try {
    const stat = await fsp.stat(filePath);
    const content = await fsp.readFile(filePath, 'utf8');
    return { mtime: stat.mtime.toISOString(), sha: sha256(content), size: stat.size };
  } catch {
    return null;
  }
}

export async function resolveStopGate(input: {
  readonly root: string;
  readonly route?: string | undefined;
  readonly missionId?: string | undefined;
  readonly explicitGatePath?: string | undefined;
  readonly allowLatestFallback?: boolean | undefined;
}): Promise<StopGateResolution> {
  const root = path.resolve(input.root);
  const checkedPaths: string[] = [];
  const route = input.route ?? null;

  // 1. explicit absolute path
  if (input.explicitGatePath) {
    const abs = path.isAbsolute(input.explicitGatePath) ? input.explicitGatePath : path.resolve(root, input.explicitGatePath);
    checkedPaths.push(abs);
    if (await exists(abs)) {
      const raw = await readJson(abs, null) as Record<string, unknown> | null;
      return makeResolution(root, route, null, abs, raw, checkedPaths, null, null, 'explicit_gate_path');
    }
  }

  // 2. current.json → mission_id + stop_gate_abs_path
  const statePath = stateFile(root);
  let state: Record<string, unknown> = {};
  let stateMissionId: string | null = null;
  if (await exists(statePath)) {
    checkedPaths.push(statePath);
    state = await readJson(statePath, {}) as Record<string, unknown>;
    stateMissionId = typeof state.mission_id === 'string' ? state.mission_id : null;
  }

  const missionId = input.missionId ?? stateMissionId;

  // 2a. stop_gate_abs_path from current state
  if (typeof state.stop_gate_abs_path === 'string' && state.stop_gate_abs_path) {
    const abs = path.isAbsolute(state.stop_gate_abs_path) ? state.stop_gate_abs_path : path.resolve(root, state.stop_gate_abs_path);
    checkedPaths.push(abs);
    if (await exists(abs)) {
      const raw = await readJson(abs, null) as Record<string, unknown> | null;
      return makeResolution(root, route, missionId, abs, raw, checkedPaths, statePath, stateMissionId, 'state.stop_gate_abs_path');
    }
  }

  // 3. mission dir candidates
  if (missionId) {
    const dir = missionDir(root, missionId);
    for (const file of GATE_FILE_CANDIDATES) {
      const p = path.join(dir, file);
      checkedPaths.push(p);
      if (await exists(p)) {
        const raw = await readJson(p, null) as Record<string, unknown> | null;
        return makeResolution(root, route, missionId, p, raw, checkedPaths, statePath, stateMissionId, 'mission_dir');
      }
    }
    for (const p of await declaredMissionGatePaths(dir, {
      route,
      state: stateMissionId === missionId ? state : null
    })) {
      if (checkedPaths.includes(p)) continue;
      checkedPaths.push(p);
      if (await exists(p)) {
        const raw = await readJson(p, null) as Record<string, unknown> | null;
        return makeResolution(root, route, missionId, p, raw, checkedPaths, statePath, stateMissionId, 'mission_declared_gate');
      }
    }

    // GLM Naruto termination / mission-result
    const glmDir = path.join(root, GLM_NARUTO_DIR, missionId);
    for (const file of ['termination.json', 'mission-result.json']) {
      const p = path.join(glmDir, file);
      checkedPaths.push(p);
      if (await exists(p)) {
        const raw = await readJson(p, null) as Record<string, unknown> | null;
        return makeResolution(root, route, missionId, p, raw, checkedPaths, statePath, stateMissionId, 'glm_naruto_dir');
      }
    }
  }

  // 4. latest mission fallback. Interactive hooks disable this path so a stale
  // mission cannot satisfy the current session's stop gate by accident.
  const latest = input.allowLatestFallback === false ? null : await findLatestMission(root);
  if (latest) {
    const dir = missionDir(root, latest);
    const latestCandidates = [
      ...GATE_FILE_CANDIDATES.map((file) => path.join(dir, file)),
      ...await declaredMissionGatePaths(dir, {
        route,
        state: stateMissionId === latest ? state : null
      })
    ];
    for (const p of [...new Set(latestCandidates)]) {
      checkedPaths.push(p);
      if (await exists(p)) {
        const raw = await readJson(p, null) as Record<string, unknown> | null;
        if (!gateMatchesRoute(raw, route)) continue;
        if (stateMissionId && stateMissionId !== latest) {
          console.error(`SKS stop-gate warning: latest mission fallback selected ${latest}, current state mission is ${stateMissionId}. Pass --mission or --gate to avoid fallback.`);
        }
        return makeResolution(root, route, latest, p, raw, checkedPaths, statePath, stateMissionId, 'latest_mission_fallback_warn');
      }
    }
  }

  return makeResolution(root, route, missionId, null, null, checkedPaths, statePath, stateMissionId, 'no_gate_found');
}

async function declaredMissionGatePaths(
  dir: string,
  opts: {
    route: string | null;
    state: Record<string, unknown> | null;
  }
): Promise<string[]> {
  const routeContext = await readJson(
    path.join(dir, ROUTE_CONTEXT_FILE),
    null
  ) as Record<string, unknown> | null;
  const declarations: unknown[] = [];
  if (declarationMatchesRoute(routeContext, opts.route)) declarations.push(routeContext?.stop_gate);
  if (declarationMatchesRoute(opts.state, opts.route)) declarations.push(opts.state?.stop_gate);
  return [...new Set(declarations.flatMap((value) => safeMissionGatePaths(dir, value)))];
}

function declarationMatchesRoute(
  declaration: Record<string, unknown> | null,
  route: string | null
): boolean {
  if (!declaration || !route) return Boolean(declaration);
  const declaredRoute = String(declaration.route || declaration.route_command || '').trim();
  return !declaredRoute || normalizeRoute(declaredRoute) === normalizeRoute(route);
}

function safeMissionGatePaths(dir: string, value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const root = path.resolve(dir);
  return value
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.resolve(root, entry))
    .filter((candidate) => candidate.startsWith(`${root}${path.sep}`));
}

function gateMatchesRoute(raw: Record<string, unknown> | null, route: string | null): boolean {
  if (!route || !raw) return true;
  const expected = normalizeRoute(route);
  const actual = normalizeRoute(String(raw.route || raw.route_command || ''));
  return !actual || actual === expected;
}

function normalizeRoute(value: string): string {
  return String(value || '').replace(/^\$/, '').replace(/_/g, '-').toLowerCase();
}

function makeResolution(
  root: string,
  route: string | null,
  missionId: string | null,
  gatePath: string | null,
  gateRaw: Record<string, unknown> | null,
  checkedPaths: readonly string[],
  statePath: string | null,
  stateMissionId: string | null,
  reason: string
): StopGateResolution {
  let gateSchema: string | null = null;
  if (gateRaw) {
    gateSchema = typeof gateRaw.schema === 'string' ? gateRaw.schema : guessSchemaFromPath(gatePath);
  }
  return {
    root,
    route,
    mission_id: missionId,
    gate_path: gatePath,
    gate_schema: gateSchema,
    gate_raw: gateRaw,
    checked_paths: checkedPaths,
    current_state_path: statePath,
    current_state_mission_id: stateMissionId,
    reason,
  };
}

function guessSchemaFromPath(gatePath: string | null): string | null {
  if (!gatePath) return null;
  const base = path.basename(gatePath);
  if (base === 'stop-gate.json' || base === 'stop-gate.latest.json') return 'sks.stop-gate.v1';
  if (base === 'naruto-gate.json') return 'sks.naruto-gate';
  if (base === 'termination.json') return 'sks.glm-naruto-termination';
  if (base === 'mission-result.json') return 'sks.glm-naruto-mission-result';
  return 'sks.gate';
}

export async function gateStatInfo(gatePath: string): Promise<{ mtime: string | null; sha256: string | null }> {
  const info = await statOrNull(gatePath);
  return { mtime: info?.mtime ?? null, sha256: info?.sha ?? null };
}
