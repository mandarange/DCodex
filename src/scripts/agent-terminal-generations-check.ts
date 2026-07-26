#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/agents/agent-terminal-session.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-terminal-generations-'));
await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
await fs.writeFile(path.join(root, 'agent-events.jsonl'), '');
const sessions = {};
for (const generationIndex of [1, 2]) {
  const agent = { id: 'slot-001', slot_id: 'slot-001', generation_index: generationIndex, session_id: `agent_slot-001-gen_${generationIndex}`, session_artifact_dir: path.join('sessions', 'slot-001', `gen-${generationIndex}`) };
  sessions[agent.session_id] = { agent_id: agent.id, slot_id: agent.slot_id, generation_index: generationIndex, session_id: agent.session_id, status: 'closed', session_artifact_dir: agent.session_artifact_dir };
  await mod.startAgentTerminalSession(root, agent, { backend: 'fake', real: false });
  await mod.closeAgentTerminalSession(root, agent, { exitCode: 0, status: 'done' });
}
await fs.writeFile(path.join(root, 'agent-sessions.json'), JSON.stringify({ schema: 'sks.agent-sessions.v1', sessions }, null, 2));
const closed = await mod.assertAgentTerminalSessionsClosed(root);
assertGate(closed.ok === true, 'terminal close reports must exist for every generation', closed);
assertGate(closed.total_sessions === 2, 'terminal generation count must be 2', closed);
emitGate('agent:terminal-generations', { terminal_generation_count: closed.total_sessions });
