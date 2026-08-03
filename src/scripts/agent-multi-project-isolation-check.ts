#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const issues = [];
for (const rel of ['src/core/session/project-namespace.ts', 'src/core/agents/agent-orchestrator.ts']) {
  if (!fs.existsSync(path.join(root, rel))) issues.push(`missing:${rel}`);
}
const orchestrator = read('src/core/agents/agent-orchestrator.ts');
for (const token of ['buildProjectNamespace', 'namespacedAgentSessionId', 'writeProjectNamespaceArtifact']) {
  if (!orchestrator.includes(token)) issues.push(`orchestrator_namespace_missing:${token}`);
}

await runFixture();

const result = { schema: 'sks.agent-multi-project-isolation-check.v1', ok: issues.length === 0, issues };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function read(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

async function runFixture() {
  const built = path.join(root, 'dist', 'core', 'session', 'project-namespace.js');
  const orchestratorBuilt = path.join(root, 'dist', 'core', 'agents', 'agent-orchestrator.js');
  const janitorBuilt = path.join(root, 'dist', 'core', 'agents', 'agent-janitor.js');
  if (!fs.existsSync(built) || !fs.existsSync(orchestratorBuilt) || !fs.existsSync(janitorBuilt)) {
    issues.push('fixture_dist_namespace_or_orchestrator_missing_run_build_first');
    return;
  }
  const mod = await import(pathToFileURL(built).href);
  const orchestrator = await import(pathToFileURL(orchestratorBuilt).href);
  const janitor = await import(pathToFileURL(janitorBuilt).href);
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-proj-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-proj-b-'));
  const nsA = await mod.buildProjectNamespace({ root: a, missionId: 'M-same' });
  const nsB = await mod.buildProjectNamespace({ root: b, missionId: 'M-same' });
  if (nsA.root_hash === nsB.root_hash) issues.push('fixture_root_hash_collision');
  if (nsA.mission_namespace_id === nsB.mission_namespace_id) issues.push('fixture_mission_namespace_collision');
  if (!nsA.temp_dir.includes(nsA.root_hash) || !nsB.temp_dir.includes(nsB.root_hash)) issues.push('fixture_temp_dir_missing_hash');
  const sessionA = mod.namespacedAgentSessionId({ agentId: 'agent_1', missionId: 'M-same', rootHash: nsA.root_hash, index: 1 });
  const sessionB = mod.namespacedAgentSessionId({ agentId: 'agent_1', missionId: 'M-same', rootHash: nsB.root_hash, index: 1 });
  if (sessionA === sessionB) issues.push('fixture_agent_session_collision');
  const [runA, runB] = await Promise.all([
    orchestrator.runNativeAgentOrchestrator({ root: a, missionId: 'M-same', prompt: 'fixture A', backend: 'fake', agents: 5, concurrency: 2, readonly: true }),
    orchestrator.runNativeAgentOrchestrator({ root: b, missionId: 'M-same', prompt: 'fixture B', backend: 'fake', agents: 5, concurrency: 2, readonly: true })
  ]);
  if (!runA.ok || !runB.ok) issues.push('fixture_concurrent_fake_agent_failed');
  const proofA = JSON.parse(fs.readFileSync(path.join(a, '.sneakoscope', 'missions', 'M-same', 'agents', 'agent-proof-evidence.json'), 'utf8'));
  const proofB = JSON.parse(fs.readFileSync(path.join(b, '.sneakoscope', 'missions', 'M-same', 'agents', 'agent-proof-evidence.json'), 'utf8'));
  const liveNsA = JSON.parse(fs.readFileSync(path.join(a, '.sneakoscope', 'missions', 'M-same', 'project-session-namespace.json'), 'utf8'));
  const liveNsB = JSON.parse(fs.readFileSync(path.join(b, '.sneakoscope', 'missions', 'M-same', 'project-session-namespace.json'), 'utf8'));
  if (liveNsA.root_hash === liveNsB.root_hash) issues.push('fixture_runtime_root_hash_collision');
  if (proofA.mission_id !== 'M-same' || proofB.mission_id !== 'M-same') issues.push('fixture_proof_mission_id_drift');
  if (JSON.stringify(proofA).includes(liveNsB.root_hash) || JSON.stringify(proofB).includes(liveNsA.root_hash)) issues.push('fixture_proof_cross_project_reference');
  const currentA = JSON.parse(fs.readFileSync(path.join(a, '.sneakoscope', 'state', 'current.json'), 'utf8'));
  const currentB = JSON.parse(fs.readFileSync(path.join(b, '.sneakoscope', 'state', 'current.json'), 'utf8'));
  if (currentA.mission_id !== 'M-same' || currentB.mission_id !== 'M-same') issues.push('fixture_current_state_not_project_local');
  fs.mkdirSync(liveNsA.temp_dir, { recursive: true });
  fs.mkdirSync(liveNsB.temp_dir, { recursive: true });
  await janitor.runAgentJanitor({ missionDir: path.join(a, '.sneakoscope', 'missions', 'M-same'), missionId: 'M-same', projectHash: liveNsA.root_hash, cleanup: true });
  if (!fs.existsSync(liveNsA.temp_dir)) issues.push('fixture_janitor_deleted_active_project_temp');
  if (!fs.existsSync(liveNsB.temp_dir)) issues.push('fixture_janitor_cross_project_deleted_temp');
}
