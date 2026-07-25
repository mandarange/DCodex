#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/strategy/strategy-compiler.js');
const compiled = mod.compileStrategy({
  prompt: 'Patch with rollback proof.',
  writeTargets: ['src/core/agents/agent-patch-proof.ts']
});
const dag = compiled.verification_rollback_dag;
const report = { schema: 'sks.strategy-verification-rollback-dag-check.v1', ok: dag.rollback_ready, dag };
const out = path.join(root, '.sneakoscope', 'reports', 'strategy-verification-rollback-dag.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(dag.rollback_ready === true, 'verification rollback DAG must include rollback node', report);
assertGate(dag.nodes.some((node) => node.kind === 'verification'), 'verification rollback DAG must include verification node', report);
emitGate('strategy:verification-rollback-dag', { nodes: dag.nodes.length });
