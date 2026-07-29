import path from 'node:path';
import { buildAgentManifest } from '../agent-bridge/agent-manifest.js';
import { readJson, writeJsonAtomic } from '../fsx.js';
import { ensureConfinedDirectory, inspectConfinedPath } from '../managed-path-safety.js';
import {
  isRetiredCommandTombstone,
  isRetiredPublicValue,
  quarantineUserPath,
  type MutableCounters,
  walkEntries
} from './retired-managed-residue-private.js';

const RETIRED_DB_STATE_KEY_RE = /^mad_db_/;
const RETIRED_DB_ROUTE_VALUE_RE = /^(?:maddb|\$?mad-db)(?:$|[-_: ])/i;
const RETIRED_AGENT_STATE_KEY_RE = /^(?:agent|native_agent|team|tmux|swarm|xai|shadow_?clone|kage_?bunshin)_/;

type AgentBridgeManifestReconciliation =
  | 'absent'
  | 'current'
  | 'reconciled'
  | 'would_reconcile'
  | 'user_collision_quarantined'
  | 'user_collision_preserved';

export async function reconcileRetiredStateResidue(input: {
  root: string;
  fix: boolean;
  quarantineRoot: string;
  counters: MutableCounters;
}): Promise<AgentBridgeManifestReconciliation> {
  await reconcileStateFiles(input.root, input.fix, input.quarantineRoot, input.counters);
  return reconcileAgentBridgeManifest(input.root, input.fix, input.quarantineRoot, input.counters);
}

async function reconcileStateFiles(root: string, fix: boolean, quarantineRoot: string, counters: MutableCounters): Promise<void> {
  const stateRoot = path.join(root, '.sneakoscope', 'state');
  const stateInspection = await inspectConfinedPath(root, stateRoot).catch(() => null);
  if (!stateInspection) {
    counters.errors += 1;
    counters.remaining += 1;
    return;
  }
  if (!stateInspection.exists) return;
  if (stateInspection.leafSymlink || !stateInspection.stat?.isDirectory()) {
    await reconcileUserStateCollision(root, stateRoot, fix, quarantineRoot, counters);
    return;
  }
  const walk = await walkEntries(root, stateRoot);
  if (walk.errors.length) {
    counters.errors += walk.errors.length;
    counters.remaining += walk.errors.length;
  }
  for (const file of walk.entries) {
    const inspected = await inspectConfinedPath(root, file).catch(() => null);
    if (!inspected) {
      counters.errors += 1;
      counters.remaining += 1;
      continue;
    }
    if (inspected.leafSymlink) {
      await reconcileUserStateCollision(root, file, fix, quarantineRoot, counters);
      continue;
    }
    if (!file.endsWith('.json') || !inspected.stat?.isFile()) continue;
    const value = await readJson<any>(file, null).catch(() => null);
    if (!value || typeof value !== 'object') continue;
    const stripped = stripRetiredPublicState(value, true);
    if (!stripped.changed) continue;
    counters.detected += 1;
    if (!fix) {
      counters.remaining += 1;
      if (!isSksOwnedStateFile(stateRoot, file, value)) counters.preserved += 1;
      continue;
    }
    try {
      if (!isSksOwnedStateFile(stateRoot, file, value)) {
        await quarantineUserPath(root, file, quarantineRoot);
        counters.preserved += 1;
        continue;
      }
      await writeJsonAtomic(file, stripped.value);
      counters.removed += 1;
      counters.rewrittenState += 1;
    } catch {
      counters.errors += 1;
      counters.remaining += 1;
    }
  }
}

function isSksOwnedStateFile(stateRoot: string, file: string, value: Record<string, unknown>): boolean {
  const relative = path.relative(stateRoot, file).split(path.sep).join('/');
  const knownLocation = relative === 'current.json'
    || relative === 'active-route.json'
    || relative.startsWith('sessions/');
  const schema = String(value.schema || '');
  if (/^sks\.(?:active-route|mission-state|route-state|session-state)\./.test(schema)) return true;
  if (!knownLocation || !isRetiredStateObject(value)) return false;
  return /^M-[A-Za-z0-9._-]+$/.test(String(value.mission_id || ''))
    && /^[A-Za-z0-9._-]{6,128}$/.test(String(value._session_key || ''))
    && Number.isFinite(Date.parse(String(value.updated_at || '')));
}

async function reconcileUserStateCollision(
  root: string,
  file: string,
  fix: boolean,
  quarantineRoot: string,
  counters: MutableCounters
): Promise<void> {
  counters.detected += 1;
  counters.preserved += 1;
  if (!fix) {
    counters.remaining += 1;
    return;
  }
  try {
    await quarantineUserPath(root, file, quarantineRoot);
  } catch {
    counters.errors += 1;
    counters.remaining += 1;
  }
}

function stripRetiredPublicState(value: unknown, routeStateRoot: boolean): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const entry of value) {
      const result = stripRetiredPublicState(entry, false);
      changed ||= result.changed;
      next.push(result.value);
    }
    return { value: next, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };
  const next: Record<string, unknown> = {};
  let changed = false;
  const retiredRoute = routeStateRoot && isRetiredStateObject(value as Record<string, unknown>);
  for (const [key, entry] of Object.entries(value)) {
    if (RETIRED_DB_STATE_KEY_RE.test(key)) {
      changed = true;
      continue;
    }
    if (routeStateRoot && key === 'preempted_missions' && Array.isArray(entry)) {
      const filtered = entry.filter((row) => !row || typeof row !== 'object' || !isRetiredStateObject(row as Record<string, unknown>));
      changed ||= filtered.length !== entry.length;
      const nested = stripRetiredPublicState(filtered, false);
      changed ||= nested.changed;
      next[key] = nested.value;
      continue;
    }
    if (retiredRoute && (['route', 'route_command', 'command', 'mode', 'phase', 'mission_id'].includes(key) || RETIRED_AGENT_STATE_KEY_RE.test(key))) {
      changed = true;
      continue;
    }
    if (['route', 'route_command', 'command', 'mode', 'phase'].includes(key) && RETIRED_DB_ROUTE_VALUE_RE.test(String(entry || ''))) {
      changed = true;
      continue;
    }
    const nested = stripRetiredPublicState(entry, false);
    changed ||= nested.changed;
    next[key] = nested.value;
  }
  if (retiredRoute) {
    next.route_closed = true;
    next.phase = 'CURRENT_SURFACE_RECONCILED';
    next.implementation_allowed = false;
    next.questions_allowed = false;
    changed = true;
  }
  return { value: next, changed };
}

function isRetiredStateObject(value: Record<string, unknown>): boolean {
  return ['route', 'route_command', 'command', 'mode', 'phase']
    .some((key) => isRetiredPublicValue(value[key]));
}

async function reconcileAgentBridgeManifest(
  root: string,
  fix: boolean,
  quarantineRoot: string,
  counters: MutableCounters
): Promise<AgentBridgeManifestReconciliation> {
  const bridgeRoot = path.join(root, '.sneakoscope', 'agent-bridge');
  const file = path.join(bridgeRoot, 'manifest.json');
  const bridgeInspection = await inspectConfinedPath(root, bridgeRoot).catch(() => null);
  if (!bridgeInspection) {
    counters.errors += 1;
    counters.remaining += 1;
    return 'user_collision_preserved';
  }
  let userCollisionQuarantined = false;
  if (bridgeInspection.leafSymlink || (bridgeInspection.exists && !bridgeInspection.stat?.isDirectory())) {
    counters.detected += 1;
    counters.preserved += 1;
    if (!fix) {
      counters.remaining += 1;
      return 'user_collision_preserved';
    }
    try {
      await quarantineUserPath(root, bridgeRoot, quarantineRoot);
      userCollisionQuarantined = true;
    } catch {
      counters.errors += 1;
      counters.remaining += 1;
      return 'user_collision_preserved';
    }
  }
  const fileInspection = await inspectConfinedPath(root, file).catch(() => null);
  if (!fileInspection) {
    counters.errors += 1;
    counters.remaining += 1;
    return 'user_collision_preserved';
  }
  if (!fileInspection.exists) {
    if (!userCollisionQuarantined) return 'absent';
    try {
      await ensureConfinedDirectory(root, path.dirname(file));
      await writeJsonAtomic(file, buildAgentManifest());
      return 'user_collision_quarantined';
    } catch {
      counters.errors += 1;
      counters.remaining += 1;
      return 'user_collision_preserved';
    }
  }
  if (fileInspection.leafSymlink || !fileInspection.stat?.isFile()) {
    counters.detected += 1;
    counters.preserved += 1;
    if (!fix) {
      counters.remaining += 1;
      return 'user_collision_preserved';
    }
    try {
      await quarantineUserPath(root, file, quarantineRoot);
      userCollisionQuarantined = true;
    } catch {
      counters.errors += 1;
      counters.remaining += 1;
      return 'user_collision_preserved';
    }
  }
  const existing = userCollisionQuarantined ? null : await readJson<any>(file, null).catch(() => null);
  const current = buildAgentManifest();
  const currentNames = new Set(current.tools.map((tool) => tool.name));
  const observedNames = Array.isArray(existing?.tools) ? existing.tools.map((tool: any) => String(tool?.name || '')).filter(Boolean) : [];
  const retiredNamesPresent = observedNames.some((name: string) => isRetiredCommandTombstone(name));
  const currentNamesMatch = observedNames.length === currentNames.size && observedNames.every((name: string) => currentNames.has(name));
  if (!userCollisionQuarantined && !retiredNamesPresent && currentNamesMatch) return 'current';

  const sksOwned = !userCollisionQuarantined && isSksOwnedAgentBridgeManifest(existing, currentNames);
  if (!userCollisionQuarantined) counters.detected += 1;
  if (!fix) {
    counters.remaining += 1;
    if (!sksOwned) counters.preserved += 1;
    return sksOwned ? 'would_reconcile' : 'user_collision_preserved';
  }

  try {
    if (!sksOwned) {
      if (!userCollisionQuarantined) {
        await quarantineUserPath(root, file, quarantineRoot);
        counters.preserved += 1;
      }
    }
    await ensureConfinedDirectory(root, path.dirname(file));
    await writeJsonAtomic(file, current);
    if (sksOwned) counters.removed += 1;
    return sksOwned ? 'reconciled' : 'user_collision_quarantined';
  } catch {
    counters.errors += 1;
    counters.remaining += 1;
    return sksOwned ? 'would_reconcile' : 'user_collision_preserved';
  }
}

function isSksOwnedAgentBridgeManifest(value: any, currentNames: Set<string>): boolean {
  if (!['sks.agent-manifest.v1', 'sks.agent-manifest.v2'].includes(value?.schema)
    || !Array.isArray(value?.tools)
    || typeof value?.generated_at !== 'string') return false;
  if (Object.keys(value).some((key) => !['schema', 'generated_at', 'tools'].includes(key))) return false;
  return value.tools.every((tool: any) => {
    const name = String(tool?.name || '');
    if (!name || (!currentNames.has(name) && !isRetiredCommandTombstone(name))) return false;
    return typeof tool?.description === 'string'
      && typeof tool?.example_invocation === 'string'
      && tool.example_invocation.startsWith(`sks ${name}`);
  });
}
