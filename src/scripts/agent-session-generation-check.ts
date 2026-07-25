#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/agents/agent-session-generation.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-session-generation-'));
const refs = { artifact: 'source-intelligence-evidence.json', ok: true };
const goal = { artifact: 'goal-mode-applied.json', ok: true };
const gen1 = mod.createAgentSessionGeneration({ slotId: 'slot-001', generationIndex: 1, missionId: 'M-gen', rootHash: 'root', taskId: 'work-1', personaId: 'verifier', sourceIntelligenceRefs: refs, goalModeRef: goal });
const gen2 = mod.createAgentSessionGeneration({ slotId: 'slot-001', generationIndex: 2, missionId: 'M-gen', rootHash: 'root', taskId: 'work-2', personaId: 'verifier', sourceIntelligenceRefs: refs, goalModeRef: goal });
await mod.writeAgentSessionGeneration(root, gen1);
await mod.closeAgentSessionGeneration(root, gen1.session_id, { status: 'closed' });
await mod.writeAgentSessionGeneration(root, gen2);
await mod.closeAgentSessionGeneration(root, gen2.session_id, { status: 'closed' });
const closed = await mod.assertAgentSessionGenerationsClosed(root);
assertGate(closed.ok === true, 'all generations must close and retain refs', closed);
assertGate(closed.generation_count === 2, 'same slot must retain two immutable generations', closed);
emitGate('agent:session-generation', { generation_count: closed.generation_count });
