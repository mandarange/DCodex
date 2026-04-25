import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson, writeJsonAtomic, ensureDir, dirSize, fileSize, formatBytes, rmrf, nowIso, appendJsonlBounded, listFilesRecursive } from './fsx.mjs';

export const DEFAULT_RETENTION_POLICY = Object.freeze({
  schema_version: 1,
  max_missions: 30,
  max_mission_age_days: 14,
  max_sneakoscope_bytes: 256 * 1024 * 1024,
  max_mission_bytes: 64 * 1024 * 1024,
  max_event_log_bytes: 5 * 1024 * 1024,
  max_tmp_age_hours: 2,
  keep_last_cycles_per_mission: 3,
  run_gc_after_each_cycle: true
});

export async function ensureRetentionPolicy(root) {
  const p = path.join(root, '.sneakoscope', 'policy.json');
  if (!(await exists(p))) await writeJsonAtomic(p, { retention: DEFAULT_RETENTION_POLICY });
  return p;
}

export async function loadRetentionPolicy(root) {
  const p = path.join(root, '.sneakoscope', 'policy.json');
  const data = await readJson(p, {});
  return { ...DEFAULT_RETENTION_POLICY, ...(data.retention || data || {}) };
}

export async function storageReport(root) {
  const sks = path.join(root, '.sneakoscope');
  const report = { root, exists: await exists(sks), generated_at: nowIso(), sections: {}, total_bytes: 0 };
  if (!report.exists) return report;
  for (const name of ['missions', 'memory', 'gx', 'hproof', 'tmp', 'arenas', 'state', 'model', 'genome', 'trajectories', 'locks', 'reports']) {
    const p = path.join(sks, name);
    const bytes = await dirSize(p).catch(() => 0);
    report.sections[name] = { bytes, human: formatBytes(bytes) };
    report.total_bytes += bytes;
  }
  report.total_human = formatBytes(report.total_bytes);
  return report;
}

async function listMissionDirs(root) {
  const base = path.join(root, '.sneakoscope', 'missions');
  if (!(await exists(base))) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('M-')) continue;
    const p = path.join(base, e.name);
    const st = await fs.stat(p).catch(() => null);
    if (st) out.push({ id: e.name, path: p, mtimeMs: st.mtimeMs, size: await dirSize(p).catch(() => 0) });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function pruneTmp(root, policy, dryRun, actions) {
  const tmp = path.join(root, '.sneakoscope', 'tmp');
  if (!(await exists(tmp))) return;
  const now = Date.now();
  const maxAge = policy.max_tmp_age_hours * 60 * 60 * 1000;
  const entries = await fs.readdir(tmp, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(tmp, e.name);
    const st = await fs.stat(p).catch(() => null);
    if (!st) continue;
    if (now - st.mtimeMs > maxAge) {
      actions.push({ action: 'remove_tmp', path: p, bytes: e.isDirectory() ? await dirSize(p).catch(() => 0) : st.size });
      if (!dryRun) await rmrf(p);
    }
  }
}

async function pruneOldMissions(root, policy, dryRun, actions) {
  const missions = await listMissionDirs(root);
  const now = Date.now();
  const maxAge = policy.max_mission_age_days * 24 * 60 * 60 * 1000;
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    const tooMany = i >= policy.max_missions;
    const tooOld = now - m.mtimeMs > maxAge;
    if (tooMany || tooOld) {
      actions.push({ action: 'remove_mission', mission: m.id, path: m.path, bytes: m.size, reason: tooMany ? 'max_missions' : 'max_age' });
      if (!dryRun) await rmrf(m.path);
    }
  }
}

async function compactMission(mission, policy, dryRun, actions) {
  if (mission.size <= policy.max_mission_bytes) return;
  const ralph = path.join(mission.path, 'ralph');
  if (await exists(ralph)) {
    const entries = await fs.readdir(ralph, { withFileTypes: true }).catch(() => []);
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() || !/^cycle-\d+$/.test(e.name)) continue;
      const n = Number(e.name.replace('cycle-', ''));
      const p = path.join(ralph, e.name);
      dirs.push({ n, path: p, bytes: await dirSize(p).catch(() => 0) });
    }
    dirs.sort((a, b) => b.n - a.n);
    for (const d of dirs.slice(policy.keep_last_cycles_per_mission)) {
      actions.push({ action: 'remove_old_cycle_dir', mission: mission.id, path: d.path, bytes: d.bytes });
      if (!dryRun) await rmrf(d.path);
    }
  }
  const arena = path.join(mission.path, 'arenas');
  if (await exists(arena)) {
    const bytes = await dirSize(arena).catch(() => 0);
    if (bytes > 0) {
      actions.push({ action: 'remove_mission_arenas', mission: mission.id, path: arena, bytes });
      if (!dryRun) await rmrf(arena);
    }
  }
}

async function rotateLargeJsonl(root, policy, dryRun, actions) {
  const files = await listFilesRecursive(path.join(root, '.sneakoscope'), { maxFiles: 100000 }).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const size = await fileSize(f);
    if (size <= policy.max_event_log_bytes) continue;
    actions.push({ action: 'rotate_jsonl', path: f, bytes: size, keep_bytes: Math.floor(policy.max_event_log_bytes / 2) });
    if (!dryRun) await appendJsonlBounded(f, { ts: nowIso(), type: 'gc.rotate_requested' }, policy.max_event_log_bytes);
  }
}

export async function enforceRetention(root, opts = {}) {
  const policy = { ...(await loadRetentionPolicy(root)), ...(opts.policy || {}) };
  const dryRun = Boolean(opts.dryRun);
  const actions = [];
  await ensureDir(path.join(root, '.sneakoscope', 'reports'));
  await pruneTmp(root, policy, dryRun, actions);
  await pruneOldMissions(root, policy, dryRun, actions);
  for (const m of await listMissionDirs(root)) await compactMission(m, policy, dryRun, actions);
  await rotateLargeJsonl(root, policy, dryRun, actions);
  const report = await storageReport(root);
  if (!dryRun) await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'storage.json'), report);
  return { dryRun, policy, actions, report };
}
