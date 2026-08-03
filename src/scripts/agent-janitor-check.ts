#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const issues = [];
for (const rel of ['src/core/agents/agent-janitor.ts', 'src/core/agents/agent-orchestrator.ts', 'src/core/agents/agent-proof-evidence.ts']) {
  if (!fs.existsSync(path.join(root, rel))) issues.push(`missing:${rel}`);
}
if (!read('src/core/agents/agent-orchestrator.ts').includes('runAgentJanitor')) issues.push('orchestrator_not_running_janitor');
if (!read('src/core/agents/agent-orchestrator.ts').includes('periodic_janitor_blocked')) issues.push('orchestrator_not_running_periodic_janitor');
if (!read('src/core/agents/agent-proof-evidence.ts').includes('janitor_ok')) issues.push('proof_missing_janitor_ok');
const janitorSrc = read('src/core/agents/agent-janitor.ts');
if (!janitorSrc.includes("error?.code === 'ENOENT'") || !janitorSrc.includes("error?.code === 'ENOTDIR'")) issues.push('janitor_list_files_missing_disappearing_dir_guard');

await runFixture();

const result = { schema: 'sks.agent-janitor-check.v1', ok: issues.length === 0, issues };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function read(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

async function runFixture() {
  const built = path.join(root, 'dist', 'core', 'agents', 'agent-janitor.js');
  if (!fs.existsSync(built)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-janitor-'));
  const missionDir = path.join(tmp, '.sneakoscope', 'missions', 'M-janitor');
  const agentDir = path.join(missionDir, 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent-sessions.json'), JSON.stringify({ schema: 'sks.agent-sessions.v1', sessions: { agent_1: { agent_id: 'agent_1', session_id: 's1', status: 'closed', heartbeat_at: '2026-05-25T00:00:00.000Z' } } }));
  const mod = await import(pathToFileURL(built).href);
  const report = await mod.runAgentJanitor({ missionDir, missionId: 'M-janitor', projectHash: 'fixture', staleMs: 1 });
  if (!report.ok) issues.push('fixture_closed_session_marked_stale');
  if (!fs.existsSync(path.join(agentDir, 'agent-janitor-report.json'))) issues.push('fixture_janitor_report_missing');
  const negative = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-janitor-negative-'));
  const negativeMission = path.join(negative, '.sneakoscope', 'missions', 'M-janitor-negative');
  const negativeAgentDir = path.join(negativeMission, 'agents');
  const negativeSessionDir = path.join(negativeAgentDir, 'sessions', 'agent_1');
  const lockDir = path.join(negative, '.sneakoscope', 'locks', 'fixture');
  fs.mkdirSync(negativeSessionDir, { recursive: true });
  fs.mkdirSync(lockDir, { recursive: true });
  const activeTemp = path.join(os.tmpdir(), 'sks-fixture-active');
  fs.mkdirSync(activeTemp, { recursive: true });
  fs.writeFileSync(path.join(negativeMission, 'project-session-namespace.json'), JSON.stringify({ mission_id: 'M-janitor-negative', root_hash: 'fixture', lock_dir: lockDir, temp_dir: activeTemp }));
  fs.writeFileSync(path.join(negativeAgentDir, 'agent-sessions.json'), JSON.stringify({ schema: 'sks.agent-sessions.v1', sessions: { agent_1: { agent_id: 'agent_1', session_id: 's1', status: 'running', heartbeat_at: '2026-05-25T00:00:00.000Z' } } }));
  fs.writeFileSync(path.join(negativeSessionDir, 'agent-process-report.json'), JSON.stringify({ schema: 'sks.agent-process-report.v1', agent_id: 'agent_1', session_id: 's1', pid: 999999999, exit_code: null }));
  const lockFile = path.join(lockDir, 'agent.lock');
  fs.writeFileSync(lockFile, 'lock');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  const blocked = await mod.runAgentJanitor({ missionDir: negativeMission, missionId: 'M-janitor-negative', projectHash: 'fixture', staleMs: 1 });
  for (const token of ['stale_heartbeat:s1', 'zombie_process:s1']) {
    if (!blocked.blockers.includes(token)) issues.push(`fixture_janitor_missing:${token}`);
  }
  if (!blocked.blockers.some((entry) => entry.startsWith('stale_lock:'))) issues.push('fixture_janitor_missing_stale_lock');
  await mod.runAgentJanitor({ missionDir: negativeMission, missionId: 'M-janitor-negative', projectHash: 'fixture', staleMs: 1, cleanup: true });
  if (!fs.existsSync(activeTemp)) issues.push('fixture_janitor_deleted_active_temp_dir');
}
