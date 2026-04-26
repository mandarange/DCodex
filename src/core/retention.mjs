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
  run_gc_after_each_cycle: true,
  max_wiki_artifacts: 40,
  max_wiki_artifact_age_days: 30,
  max_wiki_scan_files: 250,
  max_wiki_prune_files: 25,
  max_wiki_artifact_read_bytes: 256 * 1024,
  min_wiki_trust_score: 0.3,
  prune_wiki_artifacts: false
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
  for (const name of ['missions', 'memory', 'gx', 'hproof', 'tmp', 'arenas', 'state', 'model', 'genome', 'trajectories', 'locks', 'reports', 'wiki']) {
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

function wikiTrustScore(data = {}) {
  const summaryAvg = Number(data.trust_summary?.avg);
  if (Number.isFinite(summaryAvg)) return summaryAvg;
  const wiki = data.wiki || data;
  const scores = [];
  if (Array.isArray(wiki.anchors)) {
    for (const anchor of wiki.anchors) {
      const score = Number(anchor?.trust_score);
      if (Number.isFinite(score)) scores.push(score);
    }
  }
  if (Array.isArray(wiki.a)) {
    for (const row of wiki.a) {
      const score = Number(row?.[9]);
      if (Number.isFinite(score)) scores.push(score);
    }
  }
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

async function wikiArtifactTrust(file, maxReadBytes) {
  const size = await fileSize(file).catch(() => 0);
  if (!size || size > maxReadBytes) return null;
  try {
    return wikiTrustScore(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

export async function pruneWikiArtifacts(root, opts = {}) {
  const policy = { ...(await loadRetentionPolicy(root)), ...(opts.policy || {}) };
  const dryRun = Boolean(opts.dryRun);
  const actions = opts.actions || [];
  const wikiDir = path.join(root, '.sneakoscope', 'wiki');
  if (!(await exists(wikiDir))) return { dryRun, policy, actions, scanned: 0, candidates: 0 };
  const files = (await listFilesRecursive(wikiDir, { maxFiles: Number(policy.max_wiki_scan_files) || 250 }).catch(() => []))
    .filter((file) => path.extname(file) === '.json');
  const keep = new Set([
    path.join(wikiDir, 'context-pack.json')
  ]);
  const entries = [];
  for (const file of files) {
    const st = await fs.stat(file).catch(() => null);
    if (!st || keep.has(file)) continue;
    entries.push({ path: file, mtimeMs: st.mtimeMs, bytes: st.size });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  const maxAge = Number(policy.max_wiki_artifact_age_days) * 24 * 60 * 60 * 1000;
  const maxArtifacts = Math.max(0, Number(policy.max_wiki_artifacts) || 0);
  const minTrust = Number(policy.min_wiki_trust_score);
  const maxReadBytes = Math.max(1024, Number(policy.max_wiki_artifact_read_bytes) || 256 * 1024);
  const maxPrune = Math.max(0, Number(policy.max_wiki_prune_files) || 0);
  let candidates = 0;
  for (let i = 0; i < entries.length; i++) {
    if (candidates >= maxPrune) break;
    const entry = entries[i];
    const tooMany = maxArtifacts > 0 && i >= maxArtifacts;
    const tooOld = Number.isFinite(maxAge) && maxAge > 0 && now - entry.mtimeMs > maxAge;
    const trustScore = opts.lowTrust === false || !Number.isFinite(minTrust)
      ? null
      : await wikiArtifactTrust(entry.path, maxReadBytes);
    const lowTrust = trustScore != null && trustScore < minTrust;
    const reason = tooMany ? 'max_wiki_artifacts' : (tooOld ? 'max_wiki_artifact_age' : (lowTrust ? 'low_wiki_trust' : null));
    if (!reason) continue;
    candidates += 1;
    actions.push({
      action: 'remove_wiki_artifact',
      path: entry.path,
      bytes: entry.bytes,
      reason,
      ...(trustScore != null ? { trust_score: Number(trustScore.toFixed(4)) } : {})
    });
    if (!dryRun) await rmrf(entry.path);
  }
  return { dryRun, policy, actions, scanned: entries.length, candidates };
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
  if (opts.pruneWikiArtifacts || policy.prune_wiki_artifacts) await pruneWikiArtifacts(root, { policy, dryRun, actions, lowTrust: opts.pruneWikiLowTrust });
  const report = await storageReport(root);
  if (!dryRun) await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'storage.json'), report);
  return { dryRun, policy, actions, report };
}
