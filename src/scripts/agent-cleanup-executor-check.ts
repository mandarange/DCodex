#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const cleanup = await importDist('core/agents/agent-cleanup-executor.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cleanup-executor-'));
const missionDir = path.join(root, '.sneakoscope', 'missions', 'M-cleanup-fixture');
const agentRoot = path.join(missionDir, 'agents');
const projectHash = 'cleanupfixturehash';
const tempDir = path.join(os.tmpdir(), `sks-${projectHash}-orphan`);
const lockDir = path.join(os.tmpdir(), `sks-${projectHash}-locks`);
await fs.mkdir(path.join(agentRoot, 'sessions', 'slot-001', 'gen-1'), { recursive: true });
await fs.mkdir(tempDir, { recursive: true });
await fs.mkdir(lockDir, { recursive: true });
const lockFile = path.join(lockDir, 'stale.lock');
await fs.writeFile(lockFile, 'stale\n');
const staleTime = new Date(Date.now() - 60 * 60 * 1000);
await fs.utimes(lockFile, staleTime, staleTime);
await fs.writeFile(path.join(missionDir, 'project-session-namespace.json'), JSON.stringify({
  schema: 'sks.project-session-namespace.v1',
  mission_id: 'M-cleanup-fixture',
  root_hash: projectHash,
  orphan_temp_dirs: [tempDir, path.join(os.tmpdir(), 'foreign-temp')],
  lock_dir: lockDir
}, null, 2));
await fs.writeFile(path.join(agentRoot, 'agent-sessions.json'), JSON.stringify({
  sessions: {
    active: { session_id: 'active-session', status: 'running' },
    closed: { session_id: 'closed-session', status: 'closed' }
  }
}, null, 2));
await fs.writeFile(path.join(agentRoot, 'sessions', 'slot-001', 'gen-1', 'agent-terminal-session.json'), '{}\n');
const dry = await cleanup.runAgentCleanupExecutor({ missionDir, missionId: 'M-cleanup-fixture', action: 'cleanup', dryRun: true, staleMs: 1 });
assertGate(dry.dry_run === true && dry.orphan_temp_dirs_found.includes(tempDir), 'cleanup dry-run must find orphan temp dir without applying', dry);
assertGate(await exists(tempDir), 'cleanup dry-run removed temp dir unexpectedly', { tempDir });
const applied = await cleanup.runAgentCleanupExecutor({ missionDir, missionId: 'M-cleanup-fixture', action: 'cleanup', apply: true, staleMs: 1 });
assertGate(applied.ok === true, 'cleanup apply proof must pass', applied);
assertGate(!(await exists(tempDir)), 'cleanup apply must remove namespaced orphan temp dir', applied);
assertGate(!(await exists(lockFile)), 'cleanup apply must remove stale lock file', applied);
assertGate(applied.terminal_transcripts_preserved.length === 1, 'cleanup must preserve terminal transcripts', applied);
emitGate('agent:cleanup-executor', { removed_temp_dirs: applied.orphan_temp_dirs_removed.length, removed_locks: applied.stale_locks_removed.length });

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
