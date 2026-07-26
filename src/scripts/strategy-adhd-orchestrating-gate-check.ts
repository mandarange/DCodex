#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/strategy/adhd-orchestrating-gate.js');
const gate = mod.runAdhdOrchestratingGate({
  prompt: 'Implement strategy-first parallel write gates in `src/core/strategy/strategy-gate.ts` with Appshots evidence.',
  agentCount: 5,
  visualRequired: true
});
const artifacts = mod.buildDopamineOrchestrationArtifacts(gate);
const report = { schema: 'sks.strategy-adhd-orchestrating-gate-check.v1', ok: gate.ok, gate, artifacts };
const out = path.join(root, '.sneakoscope', 'reports', 'strategy-adhd-orchestrating-gate.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(gate.ok === true, 'ADHD orchestration gate must pass a concrete prompt', report);
assertGate(gate.scheduler_requires_gate === true, 'strategy scheduler gate must be explicit', report);
assertGate(gate.micro_wins.length >= 4, 'micro-win board must contain executable slices', report);
assertGate(artifacts.microWinBoard.summary_available === true, 'micro-win board summary must remain available', report);
emitGate('strategy:adhd-orchestrating-gate', { micro_wins: gate.micro_wins.length });
