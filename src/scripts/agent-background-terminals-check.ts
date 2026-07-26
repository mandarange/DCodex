#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/agents/agent-terminal-session.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-terminal-'));
await fs.writeFile(path.join(root, 'agent-sessions.json'), JSON.stringify({ schema: 'sks.agent-sessions.v1', sessions: { agent_1: { agent_id: 'agent_1', session_id: 's1', status: 'closed' } } }, null, 2));
const agent = { id: 'agent_1', session_id: 's1' };
await mod.startAgentTerminalSession(root, agent, { backend: 'fake', real: false });
await mod.closeAgentTerminalSession(root, agent, { exitCode: 0, status: 'done' });
const closed = await mod.assertAgentTerminalSessionsClosed(root);
assertGate(closed.ok === true, 'every agent terminal session must have close report', closed);
emitGate('agent:background-terminals', { terminal_sessions: closed.total_sessions });
