#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, root } from './gate-lib.js';

const noWrite = process.argv.includes('--no-write');
const json = process.argv.includes('--json');
const sources = {
  runner: text('src/core/subagents/official-subagent-runner.ts'),
  preparation: text('src/core/subagents/official-subagent-preparation.ts'),
  config: text('src/core/subagents/official-subagent-config.ts'),
  naruto: text('src/core/commands/naruto-command.ts')
};

const checks = {
  official_workflow_only: sources.naruto.includes('runOfficialSubagentWorkflow'),
  runner_depth_one: sources.runner.includes("'agents.max_depth=1'") && sources.runner.includes('max_depth: 1'),
  default_depth_one: sources.config.includes('DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH = 1'),
  parent_plan_written: sources.preparation.includes('SUBAGENT_PLAN_FILENAME') && sources.preparation.includes('writeJsonAtomic'),
  parent_summary_required: sources.naruto.includes('persistOrReuseTrustworthySubagentParentSummary'),
  parent_integration_bound: sources.naruto.includes('bindTrustworthySubagentParentSummaryToRun')
};
const blockers = Object.entries(checks)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => `official_subagent_depth_contract_missing:${name}`);
const report = {
  schema: 'sks.official-subagent-depth-report.v1',
  ok: blockers.length === 0,
  workflow: 'official_codex_subagent',
  max_depth: 1,
  parent_owned_decomposition: true,
  parent_owned_integration: true,
  checked_source_count: Object.keys(sources).length,
  checks,
  blockers
};

if (!noWrite) {
  const output = path.join(root, '.sneakoscope', 'reports', 'official-subagent-depth-report.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}

assertGate(report.ok, 'official subagent workflow must remain single-depth and parent-owned', { blocker_count: blockers.length });

if (json) console.log(JSON.stringify(report, null, 2));
else emitGate('official-subagent:single-depth', {
  workflow: report.workflow,
  max_depth: report.max_depth,
  checked_source_count: report.checked_source_count,
  parent_owned_integration: report.parent_owned_integration
});

function text(rel: string): string {
  const absolute = path.join(root, rel);
  assertGate(fs.existsSync(absolute), `missing official subagent source: ${rel}`);
  return fs.readFileSync(absolute, 'utf8');
}
