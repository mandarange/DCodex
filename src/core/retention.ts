import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exists, readJson, writeJsonAtomic, ensureDir, dirSize, fileSize, formatBytes, rmrf, nowIso, appendJsonlBounded, listFilesRecursive, managedSksTmpRoot, sha256 } from './fsx.js';
import { FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS } from './routes.js';
import {
  activeTempEnvironmentKey,
  currentProcessOwns,
  inspectTempPath,
  liveTempLease,
  removeDeadCanonicalTestLease,
  sharedTempEntryMatchesProject
} from './retention/temp-lease.js';

export const DEFAULT_RETENTION_POLICY = Object.freeze({
  schema_version: 1,
  max_missions: 30,
  max_mission_age_days: 14,
  max_sneakoscope_bytes: 256 * 1024 * 1024,
  max_mission_bytes: 64 * 1024 * 1024,
  max_event_log_bytes: 5 * 1024 * 1024,
  max_tmp_age_hours: 24,
  keep_last_cycles_per_mission: 3,
  run_gc_after_each_cycle: true,
  compact_oversize_missions: false,
  compact_closed_mission_workdirs: true,
  compact_inactive_open_mission_workdirs: true,
  compact_terminal_session_runtime_homes: true,
  prune_disposable_report_logs: false,
  max_wiki_artifacts: 40,
  max_wiki_artifact_age_days: 30,
  max_wiki_scan_files: 250,
  max_wiki_prune_files: 25,
  max_wiki_artifact_read_bytes: 256 * 1024,
  min_wiki_trust_score: 0.3,
  prune_wiki_artifacts: false,
  max_session_state_age_days: 7,
  max_session_state_files: 200,
  max_from_chat_img_temp_sessions: FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS
});

const DURABLE_RETENTION_CLASSES = Object.freeze([
  '.sneakoscope/memory/**',
  '.sneakoscope/wiki/context-pack.json',
  '.sneakoscope/wiki/code-pack*.json',
  '.sneakoscope/wiki/wrongness-*',
  '.sneakoscope/wiki/image-assets.json',
  '.sneakoscope/wiki/image-voxel-ledger.json',
  '.sneakoscope/wiki/visual-anchors.json',
  '.sneakoscope/wiki/records/**',
  '.sneakoscope/missions/*/completion-proof.json',
  '.sneakoscope/missions/*/route-completion-contract.json',
  '.sneakoscope/missions/*/evidence-index.json',
  '.sneakoscope/missions/*/trust-report.json',
  '.sneakoscope/missions/*/reflection.md',
  '.sneakoscope/missions/*/reflection-gate.json',
  '.sneakoscope/missions/*/wrongness-*',
  '.sneakoscope/missions/*/image-voxel-ledger.json',
  '.sneakoscope/missions/*/agents/agent-proof-evidence.json',
  '.sneakoscope/missions/*/agents/agent-cleanup*.json',
  '.sneakoscope/missions/*/agents/agent-session-cleanup.json'
]);
const CANONICAL_MISSION_ID_RE = /^M-[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DISPOSABLE_MISSION_DIRS = Object.freeze([
  'bus',
  'tmp',
  'cycles',
  'arenas',
  'sessions',
  'codex-sdk-workers',
  'agents/lanes',
  'agents/sessions',
  'agents/codex-sdk-workers',
  'agents/tmp',
  'agents/worktrees',
  'research/cycles',
  'research/tmp'
]);

const DISPOSABLE_MISSION_FILES = Object.freeze([
  'agents/agent-intelligent-work-graph.json',
  'agents/agent-intelligent-work-graph-v2.json',
  'agents/agent-codex-cockpit-events.jsonl',
  'agents/agent-events.jsonl',
  'agents/agent-live-summary.json',
  'agents/agent-personas.json',
  'agents/agent-scheduler-events.jsonl',
  'agents/agent-scheduler-state.json',
  'agents/agent-task-board.json',
  'agents/agent-task-board.md',
  'agents/agent-work-queue.json',
  'agents/agent-work-queue-events.jsonl',
  'agents/parallel-runtime.events.jsonl'
]);

const DISPOSABLE_RUNTIME_HOME_DIR_NAMES = Object.freeze([
  'codex-sdk-home',
  'codex-sdk-workers'
]);

const MISSION_CLOSE_GATES = Object.freeze([
  'naruto-gate.json',
  'reflection-gate.json',
  'research-gate.json',
  'qa-gate.json',
  'ppt-gate.json',
  'image-ux-review-gate.json',
  'computer-use-gate.json',
  'gx-gate.json',
  'db-safety-gate.json',
  'goal-gate.json',
  'dfix-gate.json'
]);

const DISPOSABLE_LOG_RE = /\.(?:stdout|stderr)\.log$/;
const RELEASE_PARALLEL_REPORT = 'release-parallel-report.json';
const REMOVAL_PLAN_PATHS = new WeakMap<any[], Set<string>>();
const ACTIVE_MISSION_SESSION_GRACE_MS = 2 * 60 * 60 * 1000;
const FULL_RETENTION_SCAN_MAX_FILES = 1_000_000;
const FULL_RETENTION_SCAN_MAX_DEPTH = 80;
const MISSION_COMPACTION_SCAN_MAX_FILES = 100_000;
const MISSION_COMPACTION_SCAN_MAX_DEPTH = 20;

export async function ensureRetentionPolicy(root: any) {
  const p = path.join(root, '.sneakoscope', 'policy.json');
  if (!(await exists(p))) await writeJsonAtomic(p, { retention: DEFAULT_RETENTION_POLICY });
  return p;
}

export async function loadRetentionPolicy(root: any) {
  const p = path.join(root, '.sneakoscope', 'policy.json');
  const data = await readJson(p, {});
  return { ...DEFAULT_RETENTION_POLICY, ...(data.retention || data || {}) };
}

export async function storageReport(root: any): Promise<any> {
  const sks = path.join(root, '.sneakoscope');
  const safe = await safeProjectStateRoot(root, { create: false });
  const report: any = {
    root,
    exists: await exists(sks),
    generated_at: nowIso(),
    safe,
    scan_complete: safe,
    scan_blockers: safe ? [] : ['unsafe_sneakoscope_root'],
    sections: {},
    total_bytes: 0
  };
  if (!report.exists) return report;
  if (!safe) {
    report.total_bytes = null;
    report.total_human = null;
    return report;
  }
  const entries = await fs.readdir(sks, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((row) => row.isDirectory() && !row.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    const p = path.join(sks, name);
    const measured = await measureTreeBounded(p, {
      maxFiles: FULL_RETENTION_SCAN_MAX_FILES,
      maxDepth: FULL_RETENTION_SCAN_MAX_DEPTH
    });
    report.sections[name] = {
      bytes: measured.bytes,
      human: formatBytes(measured.bytes),
      file_count: measured.fileCount,
      scan_complete: measured.complete,
      blockers: measured.blockers
    };
    report.total_bytes += measured.bytes;
    if (!measured.complete) {
      report.scan_complete = false;
      report.scan_blockers.push(...measured.blockers.map((blocker) => `${name}:${blocker}`));
    }
  }
  let rootFilesBytes = 0;
  for (const entry of entries.filter((row) => row.isFile() && !row.isSymbolicLink())) {
    rootFilesBytes += await fileSize(path.join(sks, entry.name)).catch(() => 0);
  }
  report.sections.__root_files = { bytes: rootFilesBytes, human: formatBytes(rootFilesBytes) };
  report.total_bytes += rootFilesBytes;
  report.total_human = formatBytes(report.total_bytes);
  report.scan_blockers = [...new Set(report.scan_blockers)];
  return report;
}

async function measureTreeBounded(root: string, opts: { maxFiles: number; maxDepth: number }) {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let bytes = 0;
  let fileCount = 0;
  const blockers: string[] = [];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > opts.maxDepth) {
      blockers.push(`max_depth_exceeded:${opts.maxDepth}`);
      continue;
    }
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= opts.maxDepth) blockers.push(`max_depth_exceeded:${opts.maxDepth}`);
        else stack.push({ dir: child, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (fileCount > opts.maxFiles) {
        blockers.push(`max_files_exceeded:${opts.maxFiles}`);
        return { bytes, fileCount, complete: false, blockers: [...new Set(blockers)] };
      }
      bytes += await fileSize(child).catch(() => 0);
    }
  }
  return { bytes, fileCount, complete: blockers.length === 0, blockers: [...new Set(blockers)] };
}

async function collectFilesBounded(root: string, opts: { maxFiles: number; maxDepth: number }) {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const files: string[] = [];
  const blockers: string[] = [];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > opts.maxDepth) {
      blockers.push(`max_depth_exceeded:${opts.maxDepth}`);
      continue;
    }
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= opts.maxDepth) blockers.push(`max_depth_exceeded:${opts.maxDepth}`);
        else stack.push({ dir: child, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(child);
      if (files.length > opts.maxFiles) {
        blockers.push(`max_files_exceeded:${opts.maxFiles}`);
        return { files: files.slice(0, opts.maxFiles), complete: false, blockers: [...new Set(blockers)] };
      }
    }
  }
  return { files, complete: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function lightweightStorageReport(root: any): Promise<any> {
  const sks = path.join(root, '.sneakoscope');
  const report: any = {
    root,
    exists: await exists(sks),
    generated_at: nowIso(),
    lightweight: true,
    sections: {},
    total_bytes: null,
    total_human: null
  };
  if (!report.exists) return report;
  for (const name of ['missions', 'memory', 'gx', 'hproof', 'tmp', 'arenas', 'state', 'model', 'genome', 'trajectories', 'locks', 'reports', 'wiki']) {
    const p = path.join(sks, name);
    report.sections[name] = { exists: await exists(p), bytes: null, human: null };
  }
  return report;
}

async function listMissionDirs(root: any, opts: any = {}) {
  const base = path.join(root, '.sneakoscope', 'missions');
  if (!(await exists(base))) return [];
  if (!(await safeRetentionBase(root, base))) return [];
  if (!opts.includeSize && opts.useIndex !== false) {
    const indexed = await readMissionIndex(root).catch(() => null);
    if (indexed?.ok && Array.isArray(indexed.missions)) {
      const safeIndexed: any[] = [];
      for (const mission of indexed.missions) {
        const missionPath = await safeMissionDirectory(root, mission?.id);
        if (!missionPath) continue;
        safeIndexed.push({
          id: mission.id,
          path: missionPath,
          createdMs: Number(mission.created_ms || 0),
          mtimeMs: Number(mission.mtime_ms || 0),
          size: null
        });
      }
      return safeIndexed.sort(compareMissionChronology);
    }
  }
  const entries = await fs.readdir(base, { withFileTypes: true });
  const out: any[] = [];
  const includeSize = Boolean(opts.includeSize);
  for (const e of entries) {
    if (!e.isDirectory() || !isCanonicalMissionId(e.name)) continue;
    const p = await safeMissionDirectory(root, e.name);
    if (!p) continue;
    const st = await fs.lstat(p).catch(() => null);
    const mission = await readJson(path.join(p, 'mission.json'), {}).catch(() => ({}));
    const createdMs = Date.parse(String((mission as any)?.created_at || ''));
    if (st) out.push({
      id: e.name,
      path: p,
      createdMs: Number.isFinite(createdMs) ? createdMs : 0,
      mtimeMs: st.mtimeMs,
      size: includeSize ? await dirSize(p).catch(() => 0) : null
    });
  }
  return out.sort(compareMissionChronology);
}

function compareMissionChronology(a: any, b: any) {
  const createdDelta = missionChronologyValue(b) - missionChronologyValue(a);
  if (createdDelta) return createdDelta;
  return String(b.id || '').localeCompare(String(a.id || '')) || Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0);
}

function missionChronologyValue(mission: any) {
  const explicit = Number(mission?.createdMs || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(mission?.id || '').match(/^M-(\d{8})-(\d{6})-/);
  if (match) {
    const date = match[1]!;
    const time = match[2]!;
    return Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(4, 6)) - 1,
      Number(date.slice(6, 8)),
      Number(time.slice(0, 2)),
      Number(time.slice(2, 4)),
      Number(time.slice(4, 6))
    );
  }
  return Number(mission?.mtimeMs || 0);
}

export function missionIndexPath(root: any) {
  return path.join(root, '.sneakoscope', 'missions', 'index.json');
}

export async function readMissionIndex(root: any) {
  const indexFile = missionIndexPath(root);
  const index = await readJson(indexFile, null).catch(() => null);
  if (!index || index.schema !== 'sks.mission-index.v1') return null;
  const base = path.join(root, '.sneakoscope', 'missions');
  const st = await fs.stat(base).catch(() => null);
  const indexStat = await fs.stat(indexFile).catch(() => null);
  if (!st) return { ...index, ok: false, stale: true };
  const stale = indexStat ? st.mtimeMs > indexStat.mtimeMs + 1000 : Number(index.base_mtime_ms || 0) < st.mtimeMs;
  if (stale) return { ...index, ok: false, stale: true };
  return { ...index, ok: true, stale: false };
}

export async function refreshMissionIndex(root: any, opts: any = {}) {
  const base = path.join(root, '.sneakoscope', 'missions');
  await ensureDir(base);
  if (!(await safeRetentionBase(root, base))) throw new Error('unsafe_missions_root_symlink');
  const excludedMissionIds = new Set(
    Array.from(opts.excludeMissionIds || [], (value: any) => String(value || '')).filter(Boolean)
  );
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const missions = (await Promise.all(entries
    .filter((entry) => entry.isDirectory()
      && isCanonicalMissionId(entry.name)
      && !excludedMissionIds.has(entry.name))
    .map(async (entry) => {
      const dir = path.join(base, entry.name);
      const st = await fs.stat(dir).catch(() => null);
      const mission = await readJson(path.join(dir, 'mission.json'), {}).catch(() => ({}));
      const createdMs = Date.parse(String(mission.created_at || ''));
      return {
        id: entry.name,
        created_at: mission.created_at || null,
        created_ms: Number.isFinite(createdMs) ? createdMs : 0,
        mtime_ms: st?.mtimeMs || 0,
        ...(opts.includeSize ? { bytes: await dirSize(dir).catch(() => 0) } : {})
      };
    })))
    .sort((a: any, b: any) => (b.created_ms - a.created_ms) || (b.mtime_ms - a.mtime_ms) || b.id.localeCompare(a.id));
  const baseStat = await fs.stat(base).catch(() => null);
  const index = {
    schema: 'sks.mission-index.v1',
    generated_at: nowIso(),
    root,
    base_mtime_ms: baseStat?.mtimeMs || 0,
    mission_count: missions.length,
    latest_mission_id: missions[0]?.id || null,
    missions
  };
  await writeJsonAtomic(missionIndexPath(root), index);
  return index;
}

async function missionDirById(root: any, id: any) {
  const missionId = String(id || '');
  const p = await safeMissionDirectory(root, missionId);
  if (!p) return null;
  const st = await fs.lstat(p).catch(() => null);
  if (!st?.isDirectory() || st.isSymbolicLink()) return null;
  return { id: missionId, path: p, mtimeMs: st.mtimeMs, size: null };
}

function isCanonicalMissionId(value: unknown) {
  return CANONICAL_MISSION_ID_RE.test(String(value || ''));
}

async function safeMissionDirectory(root: any, id: any): Promise<string | null> {
  const missionId = String(id || '');
  if (!isCanonicalMissionId(missionId)) return null;
  const base = path.resolve(root, '.sneakoscope', 'missions');
  if (!(await safeRetentionBase(root, base))) return null;
  const candidate = path.resolve(base, missionId);
  if (!isWithin(base, candidate)) return null;
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  const [realBase, realCandidate] = await Promise.all([
    fs.realpath(base).catch(() => null),
    fs.realpath(candidate).catch(() => null)
  ]);
  if (!realBase || !realCandidate || !isWithin(realBase, realCandidate)) return null;
  return candidate;
}

async function pruneTmp(root: any, policy: any, dryRun: any, actions: any) {
  const tmp = path.join(root, '.sneakoscope', 'tmp');
  if (!(await exists(tmp))) return;
  if (!(await safeRetentionBase(root, tmp))) {
    actions.push({ action: 'skip_unsafe_retention_root', path: tmp, reason: 'symlink_or_outside_project_state' });
    return;
  }
  const now = Date.now();
  const maxAge = Math.max(0, Number(policy.max_tmp_age_hours) || 0) * 60 * 60 * 1000;
  const entries = await fs.readdir(tmp, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(tmp, e.name);
    const inspected = await inspectTempPath(p);
    if (!inspected.complete) {
      actions.push({ action: 'skip_unsafe_temp_entry', path: p, reason: inspected.blockers.join(',') });
      continue;
    }
    if (now - inspected.latestMtimeMs > maxAge) {
      actions.push({ action: 'remove_tmp', path: p, bytes: inspected.bytes, latest_descendant_mtime_ms: inspected.latestMtimeMs });
      if (!dryRun) await rmrf(p);
    }
  }
}

async function activeMissionId(root: any) {
  const current = await readJson(path.join(root, '.sneakoscope', 'state', 'current.json'), null).catch(() => null);
  if (current?.route_closed === true) return null;
  return current?.mission_id || current?.missionId || current?.mission?.id || null;
}

function gatePassed(gate: any) {
  return Boolean(gate?.passed === true || gate?.ok === true || gate?.status === 'pass' || gate?.status === 'passed');
}

function proofClosed(proof: any) {
  const status = String(proof?.status || '');
  if (['blocked', 'failed', 'not_verified'].includes(status)) return false;
  if (Array.isArray(proof?.blockers) && proof.blockers.length) return false;
  return ['verified', 'verified_partial', 'pass', 'passed'].includes(status);
}

/**
 * NC-20: Write or confirm a durable completion receipt before mission directory deletion.
 * The receipt is independent of the mission directory remaining on disk so restart
 * logic must not treat absence as incomplete.
 */
async function ensureMissionCompletionReceiptBeforeDelete(
  mission: any,
  dryRun: boolean,
  actions: any[],
  reason: string
): Promise<{ ok: boolean; blockers: string[] }> {
  const blockers: string[] = [];
  const proof = await readJson(path.join(mission.path, 'completion-proof.json'), null).catch(() => null);
  if (!proofClosed(proof) && !(await missionClosed(mission))) {
    blockers.push('mission_not_closed_for_delete');
    return { ok: false, blockers };
  }
  const receiptsRoot = path.join(path.dirname(mission.path), '..', 'retention', 'completion-receipts');
  const receiptPath = path.join(receiptsRoot, `${mission.id}.json`);
  const existing = await readJson(receiptPath, null).catch(() => null);
  if (existing?.schema === 'sks.mission-completion-receipt.v1' && existing?.mission_id === mission.id) {
    actions.push({
      action: 'reuse_mission_completion_receipt',
      mission: mission.id,
      path: receiptPath,
      reason
    });
    return { ok: true, blockers };
  }
  const receipt = {
    schema: 'sks.mission-completion-receipt.v1',
    mission_id: mission.id,
    completed_at: nowIso(),
    retention_reason: reason,
    completion_status: String(proof?.status || 'closed'),
    delete_after_receipt: true,
    note: 'Mission directory may be deleted after this receipt; absence must not restart the mission.'
  };
  actions.push({
    action: 'write_mission_completion_receipt',
    mission: mission.id,
    path: receiptPath,
    reason
  });
  if (!dryRun) {
    await ensureDir(receiptsRoot);
    await writeJsonAtomic(receiptPath, receipt);
  }
  return { ok: true, blockers };
}

function proofRequiresDiagnostics(proof: any) {
  if (!proof || typeof proof !== 'object') return false;
  const status = String(proof.status || '').toLowerCase();
  return ['blocked', 'failed', 'not_verified'].includes(status)
    || (Array.isArray(proof.blockers) && proof.blockers.length > 0);
}

async function missionRequiresDiagnostics(mission: any) {
  for (const rel of ['completion-proof.json', ...MISSION_CLOSE_GATES]) {
    const evidence = await readJson(path.join(mission.path, rel), null).catch(() => null);
    if (proofRequiresDiagnostics(evidence)) return true;
  }
  return false;
}

function sessionsTerminal(cleanup: any) {
  if (!cleanup || typeof cleanup !== 'object') return false;
  if (cleanup.all_sessions_terminal === true || cleanup.all_sessions_closed === true) return true;
  const terminal = Number(cleanup.terminal_session_count);
  const total = Number(cleanup.total_sessions);
  return Number.isFinite(terminal) && Number.isFinite(total) && total > 0 && terminal >= total;
}

async function missionClosed(mission: any, opts: any = {}) {
  const proof = await readJson(path.join(mission.path, 'completion-proof.json'), null).catch(() => null);
  if (opts.completedMissionId && mission.id === opts.completedMissionId) return proofClosed(proof);
  if (proofClosed(proof)) return true;
  for (const gateFile of MISSION_CLOSE_GATES) {
    const gate = await readJson(path.join(mission.path, gateFile), null).catch(() => null);
    if (!gatePassed(gate)) continue;
    return true;
  }
  return false;
}

async function missionSessionsTerminal(mission: any) {
  const cleanupFiles = [
    'agents/agent-session-cleanup.json',
    'agent-session-cleanup.json'
  ];
  for (const rel of cleanupFiles) {
    const cleanupPath = path.join(mission.path, rel);
    const cleanup = await readJson(cleanupPath, null).catch(() => null);
    if (!sessionsTerminal(cleanup)) continue;
    const cleanupStat = await fs.stat(cleanupPath).catch(() => null);
    const sessionIndexPath = path.join(mission.path, 'agents', 'agent-sessions.json');
    const sessionIndexStat = await fs.stat(sessionIndexPath).catch(() => null);
    if (cleanupStat && sessionIndexStat && sessionIndexStat.mtimeMs > cleanupStat.mtimeMs) continue;
    const sessionIndex = await readJson(sessionIndexPath, null).catch(() => null);
    const rows = Object.values(sessionIndex?.sessions || {});
    if (rows.length && rows.some((row: any) => !TERMINAL_SESSION_STATUS_RE.test(String(row?.status || '')))) continue;
    return true;
  }
  return false;
}

async function missionHasLiveSessions(mission: any) {
  const sessionIndexPath = path.join(mission.path, 'agents', 'agent-sessions.json');
  const sessionIndex = await readJson(sessionIndexPath, null).catch(() => null);
  if (!sessionIndex || typeof sessionIndex !== 'object') return false;
  const rows = Object.values(sessionIndex?.sessions || {}) as any[];
  const nonterminal = rows.filter((row: any) => !TERMINAL_SESSION_STATUS_RE.test(String(row?.status || '')));
  if (rows.length && !nonterminal.length) return false;
  const sessionIndexStat = await fs.stat(sessionIndexPath).catch(() => null);
  const now = Date.now();
  if (nonterminal.length) {
    if (sessionIndexStat && now - sessionIndexStat.mtimeMs <= ACTIVE_MISSION_SESSION_GRACE_MS) return true;
    for (const row of nonterminal) {
      if (latestSessionActivityMs(row) >= now - ACTIVE_MISSION_SESSION_GRACE_MS) return true;
      if (await sessionRowHasLiveOrAmbiguousProcess(mission, row, now)) return true;
    }
    return false;
  }
  const closeEvidence = await Promise.all([
    'completion-proof.json',
    ...MISSION_CLOSE_GATES
  ].map((rel) => fs.stat(path.join(mission.path, rel)).catch(() => null)));
  const newestCloseMtime = Math.max(0, ...closeEvidence.map((stat) => stat?.mtimeMs || 0));
  return Boolean(sessionIndexStat
    && now - sessionIndexStat.mtimeMs <= ACTIVE_MISSION_SESSION_GRACE_MS
    && (!newestCloseMtime || sessionIndexStat.mtimeMs > newestCloseMtime));
}

function latestSessionActivityMs(row: any) {
  return Math.max(0, ...[
    row?.heartbeat_at,
    row?.last_heartbeat_at,
    row?.updated_at,
    row?.opened_at,
    row?.started_at,
    row?.launched_at,
    row?.last_activity_at
  ].map((value) => Date.parse(String(value || ''))).filter(Number.isFinite));
}

function processMayStillBeAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== 'ESRCH' && err?.code !== 'EINVAL';
  }
}

function processIds(row: any) {
  return [...new Set([
    Number(row?.pid || 0),
    Number(row?.process_id || 0),
    Number(row?.worker_pid || 0),
    ...(Array.isArray(row?.child_process_ids) ? row.child_process_ids.map(Number) : [])
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

async function sessionRowHasLiveOrAmbiguousProcess(mission: any, row: any, now: number) {
  if (processIds(row).some(processMayStillBeAlive)) return true;
  const rawArtifactDir = String(row?.session_artifact_dir || '');
  if (!rawArtifactDir || path.isAbsolute(rawArtifactDir) || rawArtifactDir.split(/[\\/]+/).includes('..')) return false;
  const agentRoot = path.join(mission.path, 'agents');
  const artifactDir = path.resolve(agentRoot, rawArtifactDir);
  if (!isWithin(agentRoot, artifactDir)) return false;
  const evidenceFiles = [
    path.join(artifactDir, 'agent-session-record.json'),
    path.join(artifactDir, 'agent-terminal-session.json'),
    path.join(artifactDir, 'worker', 'worker-process-report.json'),
    path.join(artifactDir, 'worker', 'agent-process-report.json'),
    path.join(artifactDir, 'worker', 'process-report.json')
  ];
  for (const file of evidenceFiles) {
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const evidence = await readJson(file, null).catch(() => null);
    if (!evidence || typeof evidence !== 'object') return true;
    if (latestSessionActivityMs(evidence) >= now - ACTIVE_MISSION_SESSION_GRACE_MS) return true;
    if (evidence.exit_code == null && processIds(evidence).some(processMayStillBeAlive)) return true;
  }
  return false;
}

async function removePath(action: string, target: string, dryRun: boolean, actions: any[], extra: any = {}) {
  const st = await fs.stat(target).catch(() => null);
  if (!st) return false;
  const resolvedTarget = path.resolve(target);
  let plannedPaths = REMOVAL_PLAN_PATHS.get(actions);
  if (!plannedPaths) {
    plannedPaths = new Set(actions
      .filter((planned: any) => String(planned?.action || '').startsWith('remove_') && planned?.path)
      .map((planned: any) => path.resolve(String(planned.path))));
    REMOVAL_PLAN_PATHS.set(actions, plannedPaths);
  }
  let cursor = resolvedTarget;
  while (true) {
    if (plannedPaths.has(cursor)) return false;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const bytes = st.isDirectory()
    ? await dirSize(target, { ignore: [], maxFiles: FULL_RETENTION_SCAN_MAX_FILES, maxDepth: 80 }).catch(() => 0)
    : st.size;
  actions.push({ action, path: target, bytes, ...extra });
  plannedPaths.add(resolvedTarget);
  if (!dryRun) await rmrf(target);
  return true;
}

function missionRelative(mission: any, file: string) {
  return path.relative(mission.path, file).split(path.sep).join('/');
}

async function pruneMissionDisposableLogs(mission: any, dryRun: boolean, actions: any[]) {
  const files = await listFilesRecursive(mission.path, { ignore: [], maxFiles: 10000, maxDepth: 8 }).catch(() => []);
  for (const file of files) {
    const rel = missionRelative(mission, file);
    if (!DISPOSABLE_LOG_RE.test(rel)) continue;
    await removePath('remove_closed_mission_raw_log', file, dryRun, actions, { mission: mission.id, reason: 'closed_mission_disposable_log' });
  }
}

async function collectRuntimeHomeDirs(dir: string, depth = 10): Promise<string[]> {
  if (depth < 0 || !(await exists(dir))) return [];
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (DISPOSABLE_RUNTIME_HOME_DIR_NAMES.includes(entry.name)) {
      out.push(child);
      continue;
    }
    out.push(...await collectRuntimeHomeDirs(child, depth - 1));
  }
  return out;
}

const TERMINAL_SESSION_STATUS_RE = /^(?:blocked|cancelled|canceled|closed|complete|completed|done|exited|failed|killed|stopped|terminated|timed?_?out)$/i;

async function runtimeHomeSessionEvidence(dir: string) {
  let cursor = path.dirname(dir);
  let generationRoot: string | null = null;
  for (let depth = 0; depth < 5; depth++) {
    if (await exists(path.join(cursor, 'agent-session-record.json')) || await exists(path.join(cursor, 'agent-terminal-session.json'))) {
      generationRoot = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const files = generationRoot ? [
    path.join(generationRoot, 'agent-session-record.json'),
    path.join(generationRoot, 'agent-terminal-session.json'),
    path.join(generationRoot, 'agent-terminal-close-report.json'),
    path.join(generationRoot, 'worker', 'worker-result.json'),
    path.join(generationRoot, 'worker', 'codex-sdk-worker-result.json'),
    path.join(generationRoot, 'worker', 'worker-process-report.json')
  ] : [];
  let terminal = false;
  let lastActivityMs = 0;
  for (const file of files) {
    const row = await readJson(file, null).catch(() => null);
    if (!row || typeof row !== 'object') continue;
    const status = String(row.status || row.state || row.phase || '');
    if (TERMINAL_SESSION_STATUS_RE.test(status)
      || row.closed === true
      || row.terminal === true
      || row.terminal_closed_at
      || row.closed_at
      || row.completed_at
      || row.ended_at) terminal = true;
    for (const key of ['heartbeat_at', 'updated_at', 'terminal_closed_at', 'closed_at', 'completed_at', 'ended_at', 'opened_at', 'terminal_started_at']) {
      const timestamp = Date.parse(String(row[key] || ''));
      if (Number.isFinite(timestamp)) lastActivityMs = Math.max(lastActivityMs, timestamp);
    }
  }
  if (!lastActivityMs) {
    const stat = await fs.stat(dir).catch(() => null);
    lastActivityMs = stat?.mtimeMs || 0;
  }
  return { terminal, lastActivityMs };
}

async function activeRuntimeMissionIds(root: string, graceMs: number) {
  const active = new Set<string>();
  const current = await activeMissionId(root);
  if (current) active.add(String(current));
  const dir = path.join(root, '.sneakoscope', 'state', 'sessions');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const row = await readJson(path.join(dir, entry.name), null).catch(() => null);
    if (row?.route_closed === true) continue;
    const missionId = row?.mission_id || row?.missionId;
    const updated = Date.parse(String(row?.updated_at || row?.heartbeat_at || ''));
    if (missionId && Number.isFinite(updated) && now - updated <= graceMs) active.add(String(missionId));
  }
  return active;
}

async function pruneTerminalSessionRuntimeHomes(root: any, policy: any, dryRun: boolean, actions: any[], opts: any = {}) {
  if (policy.compact_terminal_session_runtime_homes === false && opts.compactTerminalSessionRuntimeHomes !== true) return;
  const orphanAgeMs = Math.max(ACTIVE_MISSION_SESSION_GRACE_MS, Math.max(0, Number(policy.max_tmp_age_hours) || 0) * 60 * 60 * 1000);
  const activeMissionIds = await activeRuntimeMissionIds(root, orphanAgeMs);
  const targetOnly = Boolean(opts.afterRoute && opts.completedMissionId && opts.sweepClosedMissions !== true);
  const missions = targetOnly
    ? [await missionDirById(root, opts.completedMissionId)]
    : await listMissionDirs(root);
  for (const mission of missions.filter(Boolean)) {
    const hasLiveSessions = await missionHasLiveSessions(mission);
    if (hasLiveSessions && opts.forceLiveSessionCleanup !== true) {
      actions.push({
        action: 'retain_live_session_runtime_homes',
        mission: mission.id,
        path: mission.path,
        reason: 'authoritative_agent_sessions_are_live'
      });
      continue;
    }
    const active = activeMissionIds.has(mission.id);
    const activeRouteTarget = Boolean(opts.afterRoute && opts.completedMissionId === mission.id);
    const allSessionsTerminal = await missionSessionsTerminal(mission);
    const closed = await missionClosed(mission, opts);
    for (const dir of await collectRuntimeHomeDirs(mission.path)) {
      if (!isWithin(mission.path, dir)) continue;
      // A current/recent mission can contain a blocked or failed worker that is
      // still resumable. Never delete its runtime home during a general sweep;
      // only an explicit after-route cleanup (or explicit override) may do so.
      if (active && !activeRouteTarget && opts.allowActiveMissionCleanup !== true) continue;
      const evidence = await runtimeHomeSessionEvidence(dir);
      const terminal = evidence.terminal || allSessionsTerminal;
      const orphaned = !active
        && evidence.lastActivityMs > 0
        && Date.now() - evidence.lastActivityMs > orphanAgeMs;
      if (!terminal && !closed && !orphaned) continue;
      await removePath(
        terminal || closed ? 'remove_terminal_session_runtime_home' : 'remove_orphaned_session_runtime_home',
        dir,
        dryRun,
        actions,
        {
          mission: mission.id,
          rel: missionRelative(mission, dir),
          reason: terminal || closed ? 'terminal_agent_session_runtime_home' : 'orphaned_stale_agent_session_runtime_home',
          last_activity_ms: evidence.lastActivityMs || null
        }
      );
    }
  }
}

async function compactClosedMissionWorkdirs(root: any, policy: any, dryRun: boolean, actions: any[], opts: any = {}) {
  if (policy.compact_closed_mission_workdirs === false || opts.compactClosedMissionWorkdirs === false) return;
  const activeGraceMs = Math.max(ACTIVE_MISSION_SESSION_GRACE_MS, Math.max(0, Number(policy.max_tmp_age_hours) || 0) * 60 * 60 * 1000);
  const activeIds = await activeRuntimeMissionIds(root, activeGraceMs);
  const targetOnly = Boolean(opts.targetMissionOnly || (opts.afterRoute && opts.completedMissionId && opts.sweepClosedMissions !== true));
  const missions = targetOnly
    ? [await missionDirById(root, opts.completedMissionId)]
    : await listMissionDirs(root);
  for (const mission of missions.filter(Boolean)) {
    if (activeIds.has(mission.id) && !(await canCompactActiveMission(mission, opts))) continue;
    if (await missionHasLiveSessions(mission)) continue;
    const closed = await missionClosed(mission, opts);
    if (!closed) continue;
    const actionPrefix = 'closed_mission';
    const reason = 'closed_mission_disposable_workdir';
    for (const rel of DISPOSABLE_MISSION_DIRS) {
      const target = path.join(mission.path, rel);
      await removePath(`remove_${actionPrefix}_workdir`, target, dryRun, actions, { mission: mission.id, rel, reason });
    }
    for (const rel of DISPOSABLE_MISSION_FILES) {
      await removePath(`remove_${actionPrefix}_large_file`, path.join(mission.path, rel), dryRun, actions, { mission: mission.id, rel, reason });
    }
    await pruneMissionDisposableLogs(mission, dryRun, actions);
  }
}

async function hasDurableMissionArtifacts(mission: any) {
  for (const rel of [
    'completion-proof.json',
    'completion-proof.md',
    'route-completion-contract.json',
    'evidence-index.json',
    'trust-report.json',
    'trust-report.md',
    'reflection.md',
    'reflection-gate.json',
    'wrongness-ledger.json',
    'wrongness-summary.md',
    'image-voxel-ledger.json',
    'agents/agent-proof-evidence.json',
    'agents/agent-cleanup.json',
    'agents/agent-session-cleanup.json',
    'agents/agent-cleanup-proof.json',
    ...MISSION_CLOSE_GATES
  ]) {
    if (await exists(path.join(mission.path, rel))) return true;
  }
  return false;
}

async function compactOldMissionWithDurableArtifacts(mission: any, dryRun: boolean, actions: any[], reason: string) {
  actions.push({
    action: 'retain_mission_durable_context',
    mission: mission.id,
    path: mission.path,
    bytes: mission.size ?? null,
    reason
  });
  await compactMissionToDurableContext(mission, dryRun, actions, 'compact_old_mission_context', reason);
}

async function canCompactActiveMission(mission: any, opts: any = {}) {
  if (opts.allowActiveMissionCleanup === true) return true;
  const reflection = await readJson(path.join(mission.path, 'reflection-gate.json'), null).catch(() => null);
  return gatePassed(reflection);
}

async function releaseReportReferencesLogDir(root: any, logDir: string) {
  const report = await readJson(path.join(root, '.sneakoscope', 'reports', RELEASE_PARALLEL_REPORT), null).catch(() => null);
  if (!Array.isArray(report?.results)) return false;
  const prefix = `${path.resolve(logDir)}${path.sep}`;
  return report.results.some((row: any) => {
    const stdout = resolveReportArtifactPath(root, row?.stdout_log);
    const stderr = resolveReportArtifactPath(root, row?.stderr_log);
    return (stdout && stdout.startsWith(prefix)) || (stderr && stderr.startsWith(prefix));
  });
}

function resolveReportArtifactPath(root: string, value: any) {
  if (!value) return '';
  const raw = String(value);
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
}

function isWithin(parent: string, candidate: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function safeProjectStateRoot(root: string, opts: { create?: boolean } = {}) {
  const managed = path.resolve(root, '.sneakoscope');
  let stat = await fs.lstat(managed).catch(() => null);
  if (!stat && opts.create) {
    await ensureDir(managed);
    stat = await fs.lstat(managed).catch(() => null);
  }
  if (!stat) return opts.create !== true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  try {
    const [realRoot, realManaged] = await Promise.all([
      fs.realpath(path.resolve(root)),
      fs.realpath(managed)
    ]);
    return isWithin(realRoot, realManaged) && realManaged === path.join(realRoot, '.sneakoscope');
  } catch {
    return false;
  }
}

async function safeRetentionBase(root: string, base: string, opts: { external?: boolean } = {}) {
  const resolvedBase = path.resolve(base);
  const baseStat = await fs.lstat(resolvedBase).catch(() => null);
  if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) return false;
  if (opts.external) return true;
  const managed = path.resolve(root, '.sneakoscope');
  if (!isWithin(managed, resolvedBase)) return false;
  const relative = path.relative(managed, resolvedBase);
  let cursor = managed;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  }
  try {
    const [realManaged, realBase] = await Promise.all([fs.realpath(managed), fs.realpath(resolvedBase)]);
    return isWithin(realManaged, realBase);
  } catch {
    return false;
  }
}

async function pruneDisposableReportLogs(root: any, policy: any, dryRun: boolean, actions: any[], opts: any = {}) {
  if (!(opts.pruneReportLogs || policy.prune_disposable_report_logs)) return;
  const reports = path.join(root, '.sneakoscope', 'reports');
  if (!(await exists(reports))) return;
  if (!(await safeRetentionBase(root, reports))) {
    actions.push({ action: 'skip_unsafe_retention_root', path: reports, reason: 'symlink_or_outside_project_state' });
    return;
  }
  const releaseLogDir = path.join(reports, 'release-parallel-logs');
  let handledReleaseLogDir = false;
  if (await exists(releaseLogDir)) {
    handledReleaseLogDir = true;
    if (await releaseReportReferencesLogDir(root, releaseLogDir)) {
      actions.push({ action: 'skip_disposable_report_log_dir', path: releaseLogDir, reason: 'release_parallel_report_still_references_logs' });
    } else {
      await removePath('remove_disposable_report_log_dir', releaseLogDir, dryRun, actions, { reason: 'summarized_release_parallel_logs' });
    }
  }
  const files = await listFilesRecursive(reports, { ignore: [], maxFiles: 20000, maxDepth: 8 }).catch(() => []);
  for (const file of files) {
    if (!DISPOSABLE_LOG_RE.test(file)) continue;
    if (handledReleaseLogDir && isWithin(releaseLogDir, file)) continue;
    await removePath('remove_disposable_report_log', file, dryRun, actions, { reason: 'summarized_report_log' });
  }
}

async function pruneSessionStateFiles(root: any, policy: any, dryRun: boolean, actions: any[]) {
  const dir = path.join(root, '.sneakoscope', 'state', 'sessions');
  if (!(await exists(dir))) return;
  if (!(await safeRetentionBase(root, dir))) {
    actions.push({ action: 'skip_unsafe_retention_root', path: dir, reason: 'symlink_or_outside_project_state' });
    return;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const rows = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const file = path.join(dir, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      const state = await readJson(file, {}).catch(() => ({}));
      const updatedMs = Date.parse(String(state.updated_at || ''));
      return {
        file,
        stat,
        state,
        mtimeMs: stat?.mtimeMs || 0,
        updatedMs: Number.isFinite(updatedMs) ? updatedMs : (stat?.mtimeMs || 0),
        mission_id: state.mission_id || null
      };
    }));
  const now = Date.now();
  const maxAgeMs = Math.max(1, Number(policy.max_session_state_age_days) || 7) * 24 * 60 * 60 * 1000;
  const removed = new Set<string>();
  for (const row of rows) {
    if (!row.stat || !row.mission_id || now - row.updatedMs <= maxAgeMs) continue;
    const mission = await missionDirById(root, row.mission_id);
    if (!mission || await missionHasLiveSessions(mission) || !(await missionClosed(mission))) continue;
    actions.push({ action: 'remove_closed_session_state', path: row.file, mission: row.mission_id, bytes: row.stat.size, reason: 'closed_session_state_ttl' });
    removed.add(row.file);
    if (!dryRun) await rmrf(row.file);
  }
  const cap = Math.max(1, Number(policy.max_session_state_files) || 200);
  const remaining = rows.filter((row) => !removed.has(row.file));
  const excess = Math.max(0, remaining.length - cap);
  const removable: any[] = [];
  for (const row of remaining) {
    if (!row.stat) continue;
    if (!row.mission_id) {
      removable.push(row);
      continue;
    }
    const mission = await missionDirById(root, row.mission_id);
    if (!mission || (!(await missionHasLiveSessions(mission)) && await missionClosed(mission))) removable.push(row);
  }
  removable.sort((a, b) => a.updatedMs - b.updatedMs);
  for (const row of removable.slice(0, excess)) {
    actions.push({ action: 'remove_old_session_state', path: row.file, mission: row.mission_id, bytes: row.stat.size, reason: 'session_state_file_cap', cap });
    if (!dryRun) await rmrf(row.file);
  }
}

export async function sweepSksTempDirs(root: any, opts: any = {}) {
  const dryRun = Boolean(opts.dryRun);
  const actions = opts.actions || [];
  const now = Date.now();
  const maxAgeMs = Math.max(0, Number(opts.maxAgeHours ?? 6)) * 60 * 60 * 1000;
  const realRoot = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
  const projectHash = sha256(realRoot).slice(0, 12);
  const activeTempRoot = path.resolve(os.tmpdir());
  const activeTempRootLease = await liveTempLease(activeTempRoot);
  const roots = [
    { base: path.join(os.tmpdir(), 'sks-gate'), external: true, shared: true },
    // `managedSksTmpRoot()` is an explicit SKS-owned namespace. Its children
    // are intentionally named by feature prefixes (not by project hash), so
    // ownership, symlink and descendant-activity checks below are the safety
    // boundary for every child in this root.
    { base: managedSksTmpRoot(), external: true, shared: false, canonicalLeaseCleanup: true },
    { base: path.join(os.tmpdir(), `sks-${projectHash}`), external: true, shared: false },
    { base: path.join(root, '.sneakoscope', 'tmp'), external: false, shared: false }
  ];
  const plannedPaths = new Set(actions
    .map((action: any) => action?.path ? path.resolve(String(action.path)) : null)
    .filter(Boolean));
  for (const rootSpec of roots) {
    const base = rootSpec.base;
    if (!(await exists(base))) continue;
    if (rootSpec.external
      && activeTempRootLease
      && activeTempRootLease.kind === 'canonical-test-runner'
      && isWithin(activeTempRoot, base)) {
      actions.push({
        action: 'skip_sks_temp_sweep',
        path: base,
        reason: 'active_parent_temp_lease',
        lease_path: activeTempRootLease.path,
        owner_pid: activeTempRootLease.pid,
        lease_kind: activeTempRootLease.kind
      });
      continue;
    }
    if (!(await safeRetentionBase(root, base, { external: rootSpec.external }))) {
      actions.push({ action: 'skip_unsafe_retention_root', path: base, reason: 'symlink_or_outside_managed_temp' });
      continue;
    }
    const baseStat = await fs.lstat(base).catch(() => null);
    if (!baseStat || !currentProcessOwns(baseStat)) continue;
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (rootSpec.shared && !sharedTempEntryMatchesProject(entry.name, projectHash)) continue;
      const target = path.join(base, entry.name);
      const resolvedTarget = path.resolve(target);
      if (plannedPaths.has(resolvedTarget)) continue;
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat || stat.isSymbolicLink() || !currentProcessOwns(stat)) continue;
      const environmentKey = activeTempEnvironmentKey(target);
      if (environmentKey) {
        actions.push({
          action: 'retain_active_sks_temp',
          path: target,
          reason: 'active_temp_environment',
          environment_key: environmentKey
        });
        continue;
      }
      if (rootSpec.canonicalLeaseCleanup
        && await removeDeadCanonicalTestLease(base, target, stat, dryRun, actions)) {
        plannedPaths.add(resolvedTarget);
        continue;
      }
      const lease = stat.isDirectory() ? await liveTempLease(target) : null;
      if (lease) {
        actions.push({
          action: 'retain_active_sks_temp',
          path: target,
          reason: 'active_temp_lease',
          lease_path: lease.path,
          owner_pid: lease.pid,
          lease_kind: lease.kind
        });
        continue;
      }
      const inspected = await inspectTempPath(target);
      if (!inspected.complete) {
        actions.push({ action: 'skip_unsafe_temp_entry', path: target, reason: inspected.blockers.join(',') });
        continue;
      }
      if (maxAgeMs > 0 && now - inspected.latestMtimeMs <= maxAgeMs) continue;
      actions.push({
        action: 'remove_sks_temp',
        path: target,
        bytes: inspected.bytes,
        latest_descendant_mtime_ms: inspected.latestMtimeMs,
        reason: base.endsWith(`${path.sep}sks-gate`) ? 'stale_release_gate_temp' : 'stale_project_temp'
      });
      plannedPaths.add(resolvedTarget);
      if (!dryRun) await rmrf(target);
    }
  }
  return { ok: true, dryRun, actions };
}

async function pruneOldMissions(root: any, policy: any, dryRun: any, actions: any) {
  if (policy.prune_old_missions === false) return;
  const missions = await listMissionDirs(root);
  const activeIds = await activeRuntimeMissionIds(root, ACTIVE_MISSION_SESSION_GRACE_MS);
  const now = Date.now();
  const maxAge = policy.max_mission_age_days * 24 * 60 * 60 * 1000;
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    if (activeIds.has(m.id)) continue;
    const tooMany = i >= policy.max_missions;
    const tooOld = now - m.mtimeMs > maxAge;
    if (tooMany || tooOld) {
      const reason = tooMany ? 'max_missions' : 'max_age';
      if (await missionHasLiveSessions(m)) {
        actions.push({
          action: 'retain_mission_live_sessions',
          mission: m.id,
          path: m.path,
          bytes: m.size ?? null,
          reason: `${reason}_authoritative_agent_sessions_are_live`
        });
        continue;
      }
      const closed = await missionClosed(m);
      if (!closed) {
        const requiresDiagnostics = await missionRequiresDiagnostics(m);
        actions.push({
          action: 'retain_mission_open_context',
          mission: m.id,
          path: m.path,
          bytes: m.size ?? null,
          reason: `${reason}_mission_not_closed`
        });
        if (requiresDiagnostics) {
          actions.push({
            action: 'retain_mission_blocked_diagnostics',
            mission: m.id,
            path: m.path,
            bytes: m.size ?? null,
            reason: `${reason}_blocked_or_failed_completion_evidence`
          });
        } else if (policy.compact_inactive_open_mission_workdirs !== false && !(await missionHasLiveSessions(m))) {
          await compactMissionToDurableContext(m, dryRun, actions, 'compact_inactive_open_mission_context', reason);
        }
      } else {
        // NC-20 / S2: closed missions may be compacted or deleted for capacity, but only
        // after a durable completion receipt exists outside the mission directory.
        const completionReceipt = await ensureMissionCompletionReceiptBeforeDelete(m, dryRun, actions, reason);
        if (!completionReceipt.ok) {
          actions.push({
            action: 'retain_mission_missing_completion_receipt',
            mission: m.id,
            path: m.path,
            bytes: m.size ?? null,
            reason: `${reason}_completion_receipt_required_before_delete`,
            blockers: completionReceipt.blockers
          });
          continue;
        }
        if (await hasDurableMissionArtifacts(m)) {
          await compactOldMissionWithDurableArtifacts(m, dryRun, actions, reason);
        } else {
          actions.push({ action: 'remove_mission', mission: m.id, path: m.path, bytes: m.size ?? null, reason });
          if (!dryRun) await rmrf(m.path);
        }
      }
    }
  }
}

async function compactMissionToDurableContext(mission: any, dryRun: boolean, actions: any[], action: string, reason: string) {
  const inventory = await collectFilesBounded(mission.path, {
    maxFiles: MISSION_COMPACTION_SCAN_MAX_FILES,
    maxDepth: MISSION_COMPACTION_SCAN_MAX_DEPTH
  });
  if (!inventory.complete) {
    actions.push({
      action: 'skip_mission_compaction_scan_incomplete',
      mission: mission.id,
      path: mission.path,
      reason: `${reason}_scan_incomplete`,
      blockers: inventory.blockers
    });
    return;
  }
  const closedRawLogs = action === 'compact_old_mission_context'
    ? inventory.files.filter((file) => DISPOSABLE_LOG_RE.test(missionRelative(mission, file)))
    : [];
  const closedRawLogSet = new Set(closedRawLogs);
  for (const file of closedRawLogs) {
    await removePath('remove_closed_mission_raw_log', file, dryRun, actions, {
      mission: mission.id,
      reason: 'closed_mission_disposable_log'
    });
  }
  const removed: Array<{ rel: string; bytes: number }> = [];
  const retained: string[] = [];
  for (const file of inventory.files) {
    if (closedRawLogSet.has(file)) continue;
    const rel = missionRelative(mission, file);
    if (durableMissionContextFile(rel)) {
      retained.push(rel);
      continue;
    }
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    removed.push({ rel, bytes: stat.size });
  }
  if (!removed.length) return;
  removed.sort((a, b) => a.rel.localeCompare(b.rel));
  retained.sort();
  const removedBytes = removed.reduce((sum, row) => sum + row.bytes, 0);
  const removedManifestSha256 = sha256(JSON.stringify(removed));
  actions.push({
    action,
    mission: mission.id,
    path: mission.path,
    bytes: removedBytes,
    reason: `${reason}_durable_context_archive`,
    removed_file_count: removed.length,
    compressed_file_count: 0,
    compressed_bytes_saved: 0,
    retained_file_count: retained.length,
    removed_manifest_sha256: removedManifestSha256,
    deletion_policy: 'known_disposable_runtime_only'
  });
  if (dryRun) return;
  for (const row of removed) await rmrf(path.join(mission.path, row.rel));
  await writeJsonAtomic(path.join(mission.path, 'retention-archive-manifest.json'), {
    schema: 'sks.mission-retention-archive.v1',
    generated_at: nowIso(),
    mission_id: mission.id,
    reason,
    removed_file_count: removed.length,
    removed_bytes: removedBytes,
    removed_manifest_sha256: removedManifestSha256,
    compressed_file_count: 0,
    compressed_bytes_saved: 0,
    compressed_files: [],
    deletion_policy: 'known_disposable_runtime_only',
    retained_files: [...new Set(retained)].sort(),
    durable_context_preserved: true
  });
}

function durableMissionContextFile(rel: string) {
  const normalized = rel.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return false;
  if (DISPOSABLE_MISSION_FILES.includes(normalized)) return false;
  if (DISPOSABLE_MISSION_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) return false;
  if (normalized.split('/').some((segment) => DISPOSABLE_RUNTIME_HOME_DIR_NAMES.includes(segment))) return false;
  if (DISPOSABLE_LOG_RE.test(normalized)) return false;
  return true;
}

async function pruneFromChatImgTempTriWiki(root: any, policy: any, dryRun: any, actions: any) {
  const missions = await listMissionDirs(root);
  const ttlDefault = Math.max(1, Number(policy.max_from_chat_img_temp_sessions) || FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS);
  const activeIds = await activeRuntimeMissionIds(root, ACTIVE_MISSION_SESSION_GRACE_MS);
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    const file = path.join(m.path, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT);
    if (!(await exists(file))) continue;
    const data = await readJson(file, {});
    const ttl = Math.max(1, Math.min(ttlDefault, Number(data.expires_after_sessions) || ttlDefault));
    if (i < ttl) continue;
    const live = await missionHasLiveSessions(m);
    const closed = await missionClosed(m);
    if (activeIds.has(m.id) || live || !closed) {
      actions.push({
        action: 'retain_from_chat_img_temp_triwiki',
        mission: m.id,
        path: file,
        reason: activeIds.has(m.id) ? 'active_mission' : (live ? 'live_mission_session' : 'resumable_open_mission')
      });
      continue;
    }
    const bytes = await fileSize(file).catch(() => 0);
    actions.push({ action: 'remove_from_chat_img_temp_triwiki', mission: m.id, path: file, bytes, reason: 'session_ttl', expires_after_sessions: ttl });
    if (!dryRun) await rmrf(file);
  }
}

async function compactMission(mission: any, policy: any, dryRun: any, actions: any) {
  if (mission.size == null) mission.size = await dirSize(mission.path).catch(() => 0);
  if (mission.size <= policy.max_mission_bytes) return;
  const cyclesRoot = path.join(mission.path, 'cycles');
  if (await exists(cyclesRoot)) {
    const entries = await fs.readdir(cyclesRoot, { withFileTypes: true }).catch(() => []);
    const dirs: any[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !/^cycle-\d+$/.test(e.name)) continue;
      const n = Number(e.name.replace('cycle-', ''));
      const p = path.join(cyclesRoot, e.name);
      dirs.push({ n, path: p, bytes: await dirSize(p).catch(() => 0) });
    }
    dirs.sort((a: any, b: any) => b.n - a.n);
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

async function rotateLargeJsonl(root: any, policy: any, dryRun: any, actions: any) {
  const sks = path.join(root, '.sneakoscope');
  if (!(await safeProjectStateRoot(root, { create: false }))) {
    actions.push({ action: 'skip_unsafe_retention_root', path: sks, reason: 'symlink_or_outside_project_state' });
    return;
  }
  const files = await listFilesRecursive(sks, { maxFiles: 100000 }).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const size = await fileSize(f);
    if (size <= policy.max_event_log_bytes) continue;
    actions.push({ action: 'rotate_jsonl', path: f, bytes: size, keep_bytes: Math.floor(policy.max_event_log_bytes / 2) });
    if (!dryRun) await appendJsonlBounded(f, { ts: nowIso(), type: 'gc.rotate_requested' }, policy.max_event_log_bytes);
  }
}

function wikiTrustScore(data: any = {}) {
  const summaryAvg = Number(data.trust_summary?.avg);
  if (Number.isFinite(summaryAvg)) return summaryAvg;
  const wiki = data.wiki || data;
  const scores: any[] = [];
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
  return scores.reduce((sum: any, score: any) => sum + score, 0) / scores.length;
}

async function wikiArtifactTrust(file: any, maxReadBytes: any) {
  const size = await fileSize(file).catch(() => 0);
  if (!size || size > maxReadBytes) return null;
  try {
    return wikiTrustScore(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

export async function pruneWikiArtifacts(root: any, opts: any = {}) {
  const policy = { ...(await loadRetentionPolicy(root)), ...(opts.policy || {}) };
  const dryRun = Boolean(opts.dryRun);
  const actions = opts.actions || [];
  const wikiDir = path.join(root, '.sneakoscope', 'wiki');
  if (!(await exists(wikiDir))) return { dryRun, policy, actions, scanned: 0, candidates: 0 };
  if (!(await safeRetentionBase(root, wikiDir))) {
    actions.push({ action: 'skip_unsafe_retention_root', path: wikiDir, reason: 'symlink_or_outside_project_state' });
    return { dryRun, policy, actions, scanned: 0, candidates: 0 };
  }
  const files = (await listFilesRecursive(wikiDir, { maxFiles: Number(policy.max_wiki_scan_files) || 250 }).catch(() => []))
    .filter((file: any) => path.extname(file) === '.json');
  const keep = new Set([
    'context-pack.json',
    'code-pack.json',
    'code-pack.prev.json',
    'wrongness-ledger.json',
    'wrongness-index.json',
    'image-assets.json',
    'image-voxel-ledger.json',
    'visual-anchors.json'
  ].map((name) => path.resolve(wikiDir, name)));
  const keepDirs = [
    path.resolve(wikiDir, 'records'),
    path.resolve(wikiDir, 'wrongness'),
    path.resolve(wikiDir, 'image-voxels'),
    path.resolve(wikiDir, 'avoidance-rules')
  ];
  const entries: any[] = [];
  for (const file of files) {
    const st = await fs.stat(file).catch(() => null);
    const resolvedFile = path.resolve(file);
    if (!st || keep.has(resolvedFile) || keepDirs.some((dir) => isWithin(dir, resolvedFile))) continue;
    entries.push({ path: file, mtimeMs: st.mtimeMs, bytes: st.size });
  }
  entries.sort((a: any, b: any) => b.mtimeMs - a.mtimeMs);
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

export async function enforceRetention(root: any, opts: any = {}) {
  const stateRootSafe = await safeProjectStateRoot(root, { create: true });
  if (!stateRootSafe) {
    const policy = { ...DEFAULT_RETENTION_POLICY, ...(opts.policy || {}) };
    const actions = [{
      action: 'skip_unsafe_retention_root',
      path: path.join(root, '.sneakoscope'),
      reason: 'symlink_or_outside_project_state'
    }];
    const blocker = 'unsafe_sneakoscope_root';
    const cleanup = {
      schema: 'sks.retention-cleanup.v1',
      generated_at: nowIso(),
      ok: false,
      mode: opts.mode || 'gc',
      dry_run: Boolean(opts.dryRun),
      bounded: Boolean(opts.lightweight || opts.afterRoute || opts.afterReleaseCheck),
      full_mission_sweep: false,
      action_count: actions.length,
      storage_budget: { checked: false, ok: false, total_bytes: null, max_bytes: Number(policy.max_sneakoscope_bytes) || 0, remaining_bytes: null, blockers: [blocker] },
      blockers: [blocker],
      actions
    };
    return {
      dryRun: Boolean(opts.dryRun),
      policy,
      actions,
      report: { root, exists: true, safe: false, scan_complete: false, scan_blockers: [blocker], total_bytes: null, total_human: null, sections: {} },
      cleanup,
      plan: { schema: 'sks.retention-plan.v1', generated_at: nowIso(), dry_run: Boolean(opts.dryRun), plan_hash: retentionPlanHash(actions, policy), action_count: actions.length, actions }
    };
  }
  const policy = { ...(await loadRetentionPolicy(root)), ...(opts.policy || {}) };
  const dryRun = Boolean(opts.dryRun);
  const actions: any[] = [];
  const boundedMode = Boolean(opts.lightweight || opts.afterRoute || opts.afterReleaseCheck);
  const fullMissionSweep = opts.fullMissionSweep ?? !boundedMode;
  const shouldCompactClosedMissions = opts.compactClosedMissionWorkdirs === true
    || (fullMissionSweep && policy.compact_closed_mission_workdirs !== false)
    || Boolean(opts.afterRoute && opts.completedMissionId);
  await ensureDir(path.join(root, '.sneakoscope', 'reports'));
  const missionIndex = await refreshMissionIndex(root).catch((err) => ({
    schema: 'sks.mission-index.v1',
    ok: false,
    blockers: [`mission_index_refresh_failed:${err instanceof Error ? err.message : String(err)}`]
  }));
  await pruneTmp(root, policy, dryRun, actions);
  if (fullMissionSweep) await pruneOldMissions(root, policy, dryRun, actions);
  if (fullMissionSweep) await pruneFromChatImgTempTriWiki(root, policy, dryRun, actions);
  if (opts.compactOversizeMissions === true || policy.compact_oversize_missions === true) {
    for (const m of await listMissionDirs(root, { includeSize: true })) await compactMission(m, policy, dryRun, actions);
  }
  if (shouldCompactClosedMissions) await compactClosedMissionWorkdirs(root, policy, dryRun, actions, opts);
  if (fullMissionSweep || opts.compactTerminalSessionRuntimeHomes === true || Boolean(opts.afterRoute && opts.completedMissionId)) await pruneTerminalSessionRuntimeHomes(root, policy, dryRun, actions, opts);
  if (fullMissionSweep || opts.rotateLargeJsonl === true) await rotateLargeJsonl(root, policy, dryRun, actions);
  await pruneDisposableReportLogs(root, policy, dryRun, actions, opts);
  await pruneSessionStateFiles(root, policy, dryRun, actions);
  if (opts.skipSksTempSweep === true) {
    actions.push({
      action: 'skip_sks_temp_sweep',
      reason: opts.afterRoute ? 'post_route_global_temp_isolation' : 'explicit_temp_sweep_skip'
    });
  } else {
    await sweepSksTempDirs(root, { dryRun, actions, maxAgeHours: opts.sksTempMaxAgeHours ?? policy.max_tmp_age_hours ?? 0 });
  }
  if (opts.pruneWikiArtifacts || policy.prune_wiki_artifacts) await pruneWikiArtifacts(root, { policy, dryRun, actions, lowTrust: opts.pruneWikiLowTrust });
  let report = boundedMode || opts.skipStorageReport === true ? await lightweightStorageReport(root) : await storageReport(root);
  let storageBudget = retentionStorageBudget(report, policy);
  const cleanup: any = {
    schema: 'sks.retention-cleanup.v1',
    generated_at: nowIso(),
    ok: storageBudget.ok,
    mode: opts.mode || (opts.afterRoute ? 'post_route' : (opts.afterReleaseCheck ? 'post_release_check' : 'gc')),
    dry_run: dryRun,
    bounded: boundedMode,
    full_mission_sweep: Boolean(fullMissionSweep),
    action_count: actions.length,
    protected_durable_context: DURABLE_RETENTION_CLASSES,
    disposable_mission_dirs: DISPOSABLE_MISSION_DIRS,
    disposable_mission_files: DISPOSABLE_MISSION_FILES,
    disposable_runtime_home_dir_names: DISPOSABLE_RUNTIME_HOME_DIR_NAMES,
    prune_report_logs: Boolean(opts.pruneReportLogs || policy.prune_disposable_report_logs),
    completed_mission_id: opts.completedMissionId || null,
    storage_budget: storageBudget,
    blockers: storageBudget.blockers,
    actions
  };
  const plan_hash = retentionPlanHash(actions, policy);
  const plan: any = {
    schema: 'sks.retention-plan.v1',
    generated_at: nowIso(),
    dry_run: dryRun,
    plan_hash,
    action_count: actions.length,
    mission_index: {
      path: path.relative(root, missionIndexPath(root)),
      ok: (missionIndex as any).ok !== false,
      mission_count: (missionIndex as any).mission_count ?? null,
      latest_mission_id: (missionIndex as any).latest_mission_id ?? null
    },
    protected_durable_context: DURABLE_RETENTION_CLASSES,
    current_storage_budget: storageBudget,
    actions
  };
  if (dryRun && opts.writePlan !== false) await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'retention-plan.json'), plan);
  if (!dryRun) {
    if (!(await safeProjectStateRoot(root, { create: false }))) {
      const blocker = 'unsafe_sneakoscope_root_changed_during_retention';
      cleanup.ok = false;
      cleanup.blockers = [...new Set([...(cleanup.blockers || []), blocker])];
      return { dryRun, policy, actions, report, cleanup, plan };
    }
    const storagePath = path.join(root, '.sneakoscope', 'reports', 'storage.json');
    const cleanupPath = path.join(root, '.sneakoscope', 'reports', 'retention-cleanup.json');
    await writeJsonAtomic(storagePath, report);
    await writeJsonAtomic(cleanupPath, cleanup);
    if (!boundedMode && opts.skipStorageReport !== true) {
      for (let iteration = 0; iteration < 3; iteration++) {
        report = await storageReport(root);
        storageBudget = retentionStorageBudget(report, policy);
        cleanup.ok = storageBudget.ok;
        cleanup.storage_budget = storageBudget;
        cleanup.blockers = storageBudget.blockers;
        plan.current_storage_budget = storageBudget;
        await writeJsonAtomic(storagePath, report);
        await writeJsonAtomic(cleanupPath, cleanup);
      }
    }
  }
  return { dryRun, policy, actions, report, cleanup, plan };
}

export async function retentionStatus(root: any) {
  const [index, plan, cleanup, report] = await Promise.all([
    readMissionIndex(root).catch(() => null),
    readJson(path.join(root, '.sneakoscope', 'reports', 'retention-plan.json'), null).catch(() => null),
    readJson(path.join(root, '.sneakoscope', 'reports', 'retention-cleanup.json'), null).catch(() => null),
    readJson(path.join(root, '.sneakoscope', 'reports', 'storage.json'), null).catch(() => null)
  ]);
  return {
    schema: 'sks.retention-status.v1',
    ok: true,
    generated_at: nowIso(),
    mission_index: index ? {
      ok: index.ok !== false,
      stale: index.stale === true,
      mission_count: index.mission_count ?? null,
      latest_mission_id: index.latest_mission_id ?? null,
      path: path.relative(root, missionIndexPath(root))
    } : null,
    latest_plan: plan ? { plan_hash: plan.plan_hash || null, action_count: plan.action_count ?? null, generated_at: plan.generated_at || null } : null,
    latest_cleanup: cleanup ? { ok: cleanup.ok !== false, action_count: cleanup.action_count ?? null, generated_at: cleanup.generated_at || null, dry_run: cleanup.dry_run === true, storage_budget: cleanup.storage_budget || null, blockers: cleanup.blockers || [] } : null,
    storage: report || null
  };
}

export async function applyRetentionPlan(root: any, opts: any = {}) {
  const previous = await readJson(path.join(root, '.sneakoscope', 'reports', 'retention-plan.json'), null).catch(() => null);
  if (!previous?.plan_hash) {
    return persistRetentionApplyProof(root, { schema: 'sks.retention-apply.v1', generated_at: nowIso(), ok: false, applied: false, plan_hash_verified: false, blockers: ['retention_plan_missing'] });
  }
  const expectedHash = String(opts.planHash || previous.plan_hash);
  const planned = await enforceRetention(root, { ...opts, dryRun: true, skipStorageReport: true, writePlan: false });
  const actualHash = planned.plan.plan_hash;
  if (actualHash !== expectedHash) {
    return persistRetentionApplyProof(root, {
      schema: 'sks.retention-apply.v1',
      generated_at: nowIso(),
      ok: false,
      applied: false,
      expected_plan_hash: expectedHash,
      actual_plan_hash: actualHash,
      plan_hash_verified: false,
      blockers: ['retention_plan_hash_mismatch']
    });
  }
  const applied = await enforceRetention(root, { ...opts, dryRun: false });
  const blockers = applied.cleanup?.blockers || [];
  const appliedPlanHash = applied.plan.plan_hash;
  const planHashVerified = actualHash === expectedHash && appliedPlanHash === expectedHash;
  const result = {
    schema: 'sks.retention-apply.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0 && planHashVerified,
    applied: true,
    expected_plan_hash: expectedHash,
    actual_plan_hash: actualHash,
    applied_plan_hash: appliedPlanHash,
    plan_hash_verified: planHashVerified,
    action_count: applied.actions.length,
    cleanup: applied.cleanup,
    report: applied.report,
    blockers: planHashVerified ? blockers : [...new Set([...blockers, 'retention_applied_plan_hash_mismatch'])]
  };
  return persistRetentionApplyProof(root, result);
}

async function persistRetentionApplyProof(root: string, result: any) {
  const reportDir = path.join(root, '.sneakoscope', 'reports');
  await ensureDir(reportDir);
  await writeJsonAtomic(path.join(reportDir, 'retention-apply.json'), result);
  return result;
}

function retentionPlanHash(actions: any[], policy: any) {
  return sha256(JSON.stringify({
    policy: {
      max_missions: policy.max_missions,
      max_mission_age_days: policy.max_mission_age_days,
      max_event_log_bytes: policy.max_event_log_bytes,
      max_tmp_age_hours: policy.max_tmp_age_hours,
      max_sneakoscope_bytes: policy.max_sneakoscope_bytes,
      compact_inactive_open_mission_workdirs: policy.compact_inactive_open_mission_workdirs
    },
    actions: actions.map((action) => ({
      action: action.action,
      path: action.path ? String(action.path) : null,
      mission: action.mission || null,
      rel: action.rel || null,
      bytes: Number(action.bytes || 0),
      reason: action.reason || null,
      removed_file_count: Number(action.removed_file_count || 0),
      compressed_file_count: Number(action.compressed_file_count || 0),
      removed_manifest_sha256: action.removed_manifest_sha256 || null,
      compressed_manifest_sha256: action.compressed_manifest_sha256 || null
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }));
}

function retentionStorageBudget(report: any, policy: any) {
  const maxBytes = Math.max(0, Number(policy.max_sneakoscope_bytes) || 0);
  if (report?.safe === false || report?.scan_complete === false) {
    const blockers = report?.safe === false
      ? ['unsafe_sneakoscope_root']
      : ['retention_storage_scan_incomplete', ...(Array.isArray(report?.scan_blockers) ? report.scan_blockers.map((row: any) => `retention_storage_scan_incomplete:${String(row)}`) : [])];
    return {
      checked: false,
      ok: false,
      total_bytes: typeof report?.total_bytes === 'number' ? report.total_bytes : null,
      max_bytes: maxBytes,
      remaining_bytes: null,
      blockers: [...new Set(blockers)]
    };
  }
  const rawTotalBytes = report?.total_bytes;
  if (typeof rawTotalBytes !== 'number' || !Number.isFinite(rawTotalBytes) || rawTotalBytes < 0) {
    return {
      checked: false,
      ok: true,
      total_bytes: null,
      max_bytes: maxBytes,
      remaining_bytes: null,
      blockers: []
    };
  }
  const totalBytes = rawTotalBytes;
  const ok = maxBytes <= 0 || totalBytes <= maxBytes;
  return {
    checked: true,
    ok,
    total_bytes: totalBytes,
    max_bytes: maxBytes,
    remaining_bytes: maxBytes > 0 ? maxBytes - totalBytes : null,
    blockers: ok ? [] : ['retention_budget_exceeded:.sneakoscope']
  };
}
