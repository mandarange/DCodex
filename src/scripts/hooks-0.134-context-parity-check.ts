#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, readText, root } from './gate-lib.js';

const hooksSchema = readText('src/core/codex-compat/codex-hook-events.ts');
const cockpit = readText('src/core/agents/agent-orchestrator.ts');
const report = {
  schema: 'sks.hooks-0.134-context-parity-check.v1',
  ok: hooksSchema.includes('SubagentStart') && hooksSchema.includes('SubagentStop') && cockpit.includes('agent_transcript_path') && cockpit.includes('permission_mode'),
  hook_events_have_subagents: hooksSchema.includes('SubagentStart') && hooksSchema.includes('SubagentStop'),
  agent_context_forwarded: cockpit.includes('agent_transcript_path') && cockpit.includes('permission_mode')
};
const out = path.join(root, '.sneakoscope', 'reports', 'hooks-0.134-context-parity.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(report.hook_events_have_subagents === true, 'Codex 0.134 hook event parity must include subagent events', report);
assertGate(report.agent_context_forwarded === true, 'Codex 0.134 hook context parity must forward agent context', report);
emitGate('hooks:0.134-context-parity', { hook_events_have_subagents: report.hook_events_have_subagents });
