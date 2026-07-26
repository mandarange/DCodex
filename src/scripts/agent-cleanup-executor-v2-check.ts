#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertGate, emitGate, importDist, root as repoRoot, readJson } from './gate-lib.js';

const cleanup = await importDist('core/agents/agent-cleanup-executor.js');
const releaseVersion = readJson('package.json').version;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cleanup-v2-'));
const missionDir = path.join(root, '.sneakoscope', 'missions', 'M-cleanup-v2');
const agentRoot = path.join(missionDir, 'agents');
await fs.mkdir(path.join(agentRoot, 'sessions', 'slot-001', 'gen-1'), { recursive: true });
await fs.writeFile(path.join(missionDir, 'project-session-namespace.json'), JSON.stringify({ mission_id: 'M-cleanup-v2', root_hash: 'cleanupv2' }, null, 2));
await fs.writeFile(path.join(agentRoot, 'agent-sessions.json'), JSON.stringify({ sessions: { stale: { session_id: 'stale-session', status: 'closed' } } }, null, 2));
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await fs.writeFile(path.join(agentRoot, 'sessions', 'slot-001', 'gen-1', 'agent-process-report.json'), JSON.stringify({
  session_id: 'stale-session',
  pid: child.pid,
  exit_code: 0,
  project_hash: 'cleanupv2'
}, null, 2));
try {
  const proof = await cleanup.runAgentCleanupExecutor({ missionDir, missionId: 'M-cleanup-v2', apply: true, staleMs: 1 });
  assertGate(proof.schema === 'sks.agent-cleanup-proof.v2', 'cleanup proof schema must be v2', proof);
  assertGate(proof.sigterm_sent.includes(String(child.pid)), 'cleanup must send SIGTERM before escalation', proof);
  assertGate(proof.process_exit_verified.includes(String(child.pid)), 'cleanup must verify process exit', proof);
  assertGate(proof.process_trees.some((row) => row.target === String(child.pid)), 'cleanup must record process tree', proof);
  await fs.mkdir(path.join(repoRoot, '.sneakoscope', 'reports'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.sneakoscope', 'reports', `agent-cleanup-executor-v2-${releaseVersion}.json`), `${JSON.stringify(proof, null, 2)}\n`);
  emitGate('agent:cleanup-executor-v2', { actions: proof.action_count, sigterm: proof.sigterm_sent.length, sigkill: proof.sigkill_escalations.length });
} finally {
  try { process.kill(child.pid, 'SIGKILL'); } catch {}
}
