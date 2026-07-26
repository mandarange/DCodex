#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const runner = await importDist('core/agents/agent-runner-codex-exec.js');
const compat = await importDist('core/codex/codex-0-134-compat.js');
const history = await importDist('core/source-intelligence/codex-history-search.js');
const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-codex-0134-runner-'));
const agent = { id: 'agent-0134', session_id: 'session-0134', persona_id: 'verifier', session_artifact_dir: 'sessions/agent-0134' };
const command = runner.buildCodexExecAgentArgs(agent, 'runner truth fixture', { profile: 'sks-fast-high', resultFile: path.join(agentRoot, 'result.json') });
const result = await runner.runCodexExecAgent(agent, { id: 'slice-0134', description: 'runner truth fixture' }, {
  agentRoot,
  cwd: root,
  dryRun: true,
  profile: 'sks-fast-high',
  resultFile: path.join(agentRoot, 'result.json'),
  env: {
    HTTPS_PROXY: 'http://user:secret@example.test:8080',
    NO_PROXY: 'localhost,127.0.0.1'
  }
});
const processReportPath = path.join(agentRoot, 'sessions/agent-0134/agent-process-report.json');
const processReport = JSON.parse(fs.readFileSync(processReportPath, 'utf8'));
const codexHome = path.join(agentRoot, 'codex-home');
fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(codexHome, 'sessions', 'history.jsonl'), '{"message":"Codex 0.134 runner truth history"}\n');
const historyReport = await history.searchCodexHistory({ codexHome, query: 'runner truth', maxFiles: 5, maxResults: 3 });
const matrix = compat.codex0134Matrix({
  version: 'codex-cli 0.134.0',
  available: true,
  execHelp: 'Usage: codex exec --profile <PROFILE>',
  mcpHelp: 'Usage: codex mcp --env KEY --oauth streamable',
  historyHelp: 'Usage: codex search history',
  historyCommandAvailable: true,
  schemaPolicyText: '$ref $defs readOnlyHint'
});
const require0134 = process.env.SKS_REQUIRE_CODEX_0_134 === '1';
const blockers = [
  ...(command.args.includes('--profile') ? [] : ['codex_profile_arg_missing']),
  ...(command.args.includes('--ignore-user-config') ? ['codex_profile_combined_with_ignore_user_config'] : []),
  ...(processReport.profile === 'sks-fast-high' ? [] : ['codex_process_report_profile_missing']),
  ...(Array.isArray(processReport.managed_proxy_env_keys) && processReport.managed_proxy_env_keys.includes('HTTPS_PROXY') ? [] : ['codex_managed_proxy_keys_missing']),
  ...(JSON.stringify(processReport).includes('secret') ? ['codex_process_report_leaked_proxy_secret'] : []),
  ...(historyReport.ok === true && historyReport.results.length === 1 ? [] : ['codex_history_search_evidence_missing']),
  ...(matrix.ok === true ? [] : ['codex_0_134_matrix_not_ok']),
  ...(require0134 && matrix.ok !== true ? ['codex_0_134_required_mode_blocked'] : [])
];
const report = {
  schema: 'sks.codex-0.134-runner-truth-check.v1',
  ok: blockers.length === 0,
  required_mode: require0134,
  command_args: command.args,
  process_report: processReport,
  history_report: historyReport,
  matrix,
  runner_result_status: result.status,
  blockers
};
const out = path.join(root, '.sneakoscope', 'reports', 'codex-0-134-runner-truth.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(report.ok === true, 'Codex 0.134 runner truth has blockers', report);
emitGate('codex:0.134-runner-truth', { profile: processReport.profile, history_results: historyReport.results.length });
