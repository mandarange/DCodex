#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGate, emitGate, root } from './sks-cli-gate-lib.js';

const retentionPath = path.join(root, 'dist', 'core', 'retention.js');
assertGate(fs.existsSync(retentionPath), 'dist retention module missing; run npm run build first', { retentionPath });
const { enforceRetention } = await import(pathToFileURL(retentionPath).href);

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-retention-cleanup-'));
try {
  const applyRoot = path.join(tmp, 'apply');
  const dryRoot = path.join(tmp, 'dry');
  await writeFixture(applyRoot);
  await writeFixture(dryRoot);

  const applied = await enforceRetention(applyRoot, {
    pruneReportLogs: true,
    policy: { max_tmp_age_hours: 0, max_mission_age_days: 0, max_missions: 999 }
  });
  const dry = await enforceRetention(dryRoot, {
    dryRun: true,
    pruneReportLogs: true,
    policy: { max_tmp_age_hours: 0, max_mission_age_days: 0, max_missions: 999 }
  });

  for (const rel of [
    '.sneakoscope/memory/q2_facts/post-route-reflection.md',
    '.sneakoscope/wiki/context-pack.json',
    '.sneakoscope/wiki/records/learning.json',
    '.sneakoscope/missions/M-done/completion-proof.json',
    '.sneakoscope/missions/M-done/route-completion-contract.json',
    '.sneakoscope/missions/M-done/evidence-index.json',
    '.sneakoscope/missions/M-done/trust-report.json',
    '.sneakoscope/missions/M-done/reflection.md',
    '.sneakoscope/missions/M-done/reflection-gate.json',
    '.sneakoscope/missions/M-done/agents/agent-proof-evidence.json',
    '.sneakoscope/missions/M-old/completion-proof.json',
    '.sneakoscope/missions/M-old/trust-report.json',
    '.sneakoscope/missions/M-old/reflection.md',
    '.sneakoscope/missions/M-active/agents/tmp/active.md',
    '.sneakoscope/missions/M-active/agents/sessions/session-1/gen-1/worker/codex-sdk-home/codex/cache.bin',
    '.sneakoscope/missions/M-blocked/agents/tmp/blocked.md',
    '.sneakoscope/missions/M-blocked/scout.stderr.log',
    '.sneakoscope/missions/M-blocked-terminal/agents/tmp/blocked.md',
    '.sneakoscope/missions/M-blocked-terminal/agents/sessions/session-1/gen-1/worker/worker-result.json'
  ]) {
    assertGate(exists(path.join(applyRoot, rel)), `durable or active artifact was removed: ${rel}`, { rel, actions: applied.actions });
  }

  for (const rel of [
    '.sneakoscope/tmp/scratch.txt',
    '.sneakoscope/missions/M-done/agents/tmp/worker.md',
    '.sneakoscope/missions/M-done/bus/event.jsonl',
    '.sneakoscope/missions/M-done/agents/lanes/lane-1.json',
    '.sneakoscope/missions/M-done/sessions/terminal-transcript.log',
    '.sneakoscope/missions/M-done/agents/sessions/session-1/terminal-transcript.log',
    '.sneakoscope/missions/M-done/agents/sessions/session-1/gen-1/worker/codex-sdk-home/codex/cache.bin',
    '.sneakoscope/missions/M-done/scout.stdout.log',
    '.sneakoscope/missions/M-done/scout.stderr.log',
    '.sneakoscope/missions/M-old/agents/tmp/worker.md',
    '.sneakoscope/missions/M-old/agents/sessions/session-1/gen-1/worker/codex-sdk-home/codex/cache.bin',
    '.sneakoscope/missions/M-old/scout.stdout.log',
    '.sneakoscope/missions/M-blocked-terminal/agents/sessions/session-1/gen-1/worker/codex-sdk-home/codex/cache.bin',
    '.sneakoscope/reports/release-parallel-logs/build.stdout.log'
  ]) {
    assertGate(!exists(path.join(applyRoot, rel)), `disposable artifact survived cleanup: ${rel}`, { rel, actions: applied.actions });
    assertGate(exists(path.join(dryRoot, rel)), `dry-run removed artifact unexpectedly: ${rel}`, { rel, actions: dry.actions });
  }

  const actionKinds = new Set(applied.actions.map((row) => row.action));
  for (const kind of ['remove_tmp', 'remove_closed_mission_raw_log', 'remove_disposable_report_log_dir']) {
    assertGate(actionKinds.has(kind), `retention cleanup did not report action kind: ${kind}`, { actions: applied.actions });
  }
  assertGate(actionKinds.has('remove_terminal_session_runtime_home'), 'retention cleanup did not remove terminal session runtime homes', { actions: applied.actions });
  assertGate(actionKinds.has('remove_closed_mission_workdir') || actionKinds.has('remove_old_mission_workdir'), 'retention cleanup did not report mission workdir cleanup', { actions: applied.actions });
  assertGate(actionKinds.has('retain_mission_durable_context'), 'retention cleanup did not preserve old durable mission context', { actions: applied.actions });
  assertGate(dry.actions.length >= applied.actions.length, 'dry-run should plan cleanup actions without deleting files', { applied: applied.actions.length, dry: dry.actions.length });

  const report = {
    schema: 'sks.retention-cleanup-safety.v1',
    ok: true,
    applied_actions: applied.actions.length,
    dry_run_actions: dry.actions.length,
    preserved_durable_context: applied.cleanup?.protected_durable_context || [],
    removed_action_kinds: [...actionKinds].sort(),
    generated_at: new Date().toISOString()
  };
  await fsp.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
  await fsp.writeFile(path.join(root, '.sneakoscope', 'reports', 'retention-cleanup-safety.json'), `${JSON.stringify(report, null, 2)}\n`);
  emitGate('retention:cleanup-safety', report);
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

async function writeFixture(projectRoot) {
  await write(path.join(projectRoot, '.sneakoscope', 'policy.json'), { retention: { max_tmp_age_hours: 0 } });
  await write(path.join(projectRoot, '.sneakoscope', 'state', 'current.json'), { mission_id: 'M-active' });
  await writeText(path.join(projectRoot, '.sneakoscope', 'tmp', 'scratch.txt'), 'temporary scratch\n');
  await old(path.join(projectRoot, '.sneakoscope', 'tmp', 'scratch.txt'));
  await writeText(path.join(projectRoot, '.sneakoscope', 'memory', 'q2_facts', 'post-route-reflection.md'), '# durable reflection\n');
  await write(path.join(projectRoot, '.sneakoscope', 'wiki', 'context-pack.json'), { schema: 'sks.context-pack.v1', anchors: [] });
  await write(path.join(projectRoot, '.sneakoscope', 'wiki', 'records', 'learning.json'), { schema: 'sks.triwiki-record.v1', durable: true });
  await writeMission(projectRoot, 'M-done', true);
  await writeMission(projectRoot, 'M-active', false);
  await writeOldDurableMission(projectRoot);
  await writeBlockedMission(projectRoot);
  await writeTerminalBlockedMission(projectRoot);
  await writeText(path.join(projectRoot, '.sneakoscope', 'reports', 'release-parallel-logs', 'build.stdout.log'), 'summarized release log\n');
}

async function writeMission(projectRoot, missionId, closed) {
  const dir = path.join(projectRoot, '.sneakoscope', 'missions', missionId);
  await write(path.join(dir, 'mission.json'), { id: missionId, prompt: 'fixture' });
  if (closed) {
    await write(path.join(dir, 'completion-proof.json'), { schema: 'sks.completion-proof.v1', status: 'verified_partial', ok: true });
    await write(path.join(dir, 'route-completion-contract.json'), { mission_id: missionId });
    await write(path.join(dir, 'evidence-index.json'), { mission_id: missionId, evidence: [] });
    await write(path.join(dir, 'trust-report.json'), { mission_id: missionId, status: 'verified_partial' });
    await writeText(path.join(dir, 'reflection.md'), '# retained reflection\n');
    await write(path.join(dir, 'reflection-gate.json'), { passed: true });
    await write(path.join(dir, 'naruto-gate.json'), { passed: true });
    await write(path.join(dir, 'agents', 'agent-session-cleanup.json'), { passed: true, all_sessions_terminal: true });
    await write(path.join(dir, 'agents', 'agent-proof-evidence.json'), { ok: true, all_sessions_closed: true });
    await writeText(path.join(dir, 'sessions', 'terminal-transcript.log'), 'transcript is disposable after close\n');
    await writeText(path.join(dir, 'agents', 'sessions', 'session-1', 'terminal-transcript.log'), 'agent transcript is disposable after close\n');
    await writeText(path.join(dir, 'agents', 'sessions', 'session-1', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'), 'large sdk cache\n');
    await writeText(path.join(dir, 'scout.stdout.log'), 'raw stdout\n');
    await writeText(path.join(dir, 'scout.stderr.log'), 'raw stderr\n');
    await writeText(path.join(dir, 'agents', 'tmp', 'worker.md'), 'temporary scratch\n');
  } else {
    await writeText(path.join(dir, 'agents', 'tmp', 'active.md'), 'active mission scratch stays\n');
    await writeText(path.join(dir, 'agents', 'sessions', 'session-1', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'), 'active sdk cache stays\n');
  }
  await writeText(path.join(dir, 'bus', 'event.jsonl'), '{"event":"temporary"}\n');
  await writeText(path.join(dir, 'agents', 'lanes', 'lane-1.json'), '{"lane":"temporary"}\n');
}

async function writeOldDurableMission(projectRoot) {
  const dir = path.join(projectRoot, '.sneakoscope', 'missions', 'M-old');
  await write(path.join(dir, 'completion-proof.json'), { schema: 'sks.completion-proof.v1', status: 'verified', blockers: [] });
  await write(path.join(dir, 'trust-report.json'), { status: 'verified' });
  await write(path.join(dir, 'evidence-index.json'), { evidence: [] });
  await writeText(path.join(dir, 'reflection.md'), '# old retained reflection\n');
  await writeText(path.join(dir, 'agents', 'tmp', 'worker.md'), 'old scratch\n');
  await writeText(path.join(dir, 'agents', 'sessions', 'session-1', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'), 'old sdk cache\n');
  await writeText(path.join(dir, 'scout.stdout.log'), 'old raw log\n');
  await old(dir);
}

async function writeBlockedMission(projectRoot) {
  const dir = path.join(projectRoot, '.sneakoscope', 'missions', 'M-blocked');
  await write(path.join(dir, 'completion-proof.json'), { schema: 'sks.completion-proof.v1', status: 'blocked', blockers: ['fixture_blocker'] });
  await writeText(path.join(dir, 'agents', 'tmp', 'blocked.md'), 'diagnostic scratch\n');
  await writeText(path.join(dir, 'scout.stderr.log'), 'diagnostic raw log\n');
}

async function writeTerminalBlockedMission(projectRoot) {
  const dir = path.join(projectRoot, '.sneakoscope', 'missions', 'M-blocked-terminal');
  await write(path.join(dir, 'completion-proof.json'), { schema: 'sks.completion-proof.v1', status: 'blocked', blockers: ['fixture_blocker'] });
  await write(path.join(dir, 'agents', 'agent-session-cleanup.json'), { all_sessions_terminal: true, terminal_session_count: 1, total_sessions: 1 });
  await writeText(path.join(dir, 'agents', 'tmp', 'blocked.md'), 'diagnostic scratch\n');
  await writeText(path.join(dir, 'agents', 'sessions', 'session-1', 'gen-1', 'worker', 'worker-result.json'), '{"status":"blocked"}\n');
  await writeText(path.join(dir, 'agents', 'sessions', 'session-1', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'), 'terminal sdk cache\n');
}

async function write(file, data) {
  await writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
}

async function old(file) {
  const past = new Date(Date.now() - 60_000);
  await fsp.utimes(file, past, past);
}

function exists(file) {
  return fs.existsSync(file);
}
