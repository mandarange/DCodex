#!/usr/bin/env node
// @ts-nocheck
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, exists, readText } from '../core/fsx.js';

const entry = path.resolve('dist/bin/sks.js');
const results = [];
const fixturePreload = `const models=['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol'].map(slug=>({slug,display_name:slug,supported_reasoning_levels:[],shell_type:'shell_command',visibility:'list',supported_in_api:true,priority:1,base_instructions:'',supports_reasoning_summaries:true,support_verbosity:true,truncation_policy:{mode:'tokens',limit:10000},supports_parallel_tool_calls:true,experimental_supported_tools:[],service_tiers:['priority'],tool_mode:'code_mode_only'}));globalThis.fetch=async input=>{const url=String(input?.url||input);if(url.endsWith('/health'))return new Response('{}',{status:200,headers:{'x-app-version':'1.21.0-beta.3'}});if(url.endsWith('/models'))return new Response(JSON.stringify({models}),{status:200,headers:{'content-type':'application/json'}});throw new Error('unexpected fixture fetch '+url)}`;

async function runSetup(name, args, input = 'sk-clb-test\n') {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-lb-truth-${name}-`));
  const codexHome = path.join(home, '.codex');
  const globalRoot = path.join(home, '.sneakoscope-global');
  const result = await runProcess(process.execPath, [entry, 'codex-lb', 'setup', '--host', 'lb.example.test', '--api-key-stdin', '--yes', '--json', ...args], {
    cwd: home,
    input,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      SKS_GLOBAL_ROOT: globalRoot,
      CODEX_LB_API_KEY: '',
      CODEX_LB_BASE_URL: '',
      CI: 'true',
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
      SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY: '',
      SKS_CODEX_LB_CHAIN_CHECK: '0',
      SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(fixturePreload)}`
    },
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });
  let json = {};
  try { json = JSON.parse(result.stdout); } catch {}
  return {
    home,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
    configPath: path.join(codexHome, 'config.toml'),
    envPath: path.join(codexHome, 'sks-codex-lb.env')
  };
}

{
  const row = await runSetup('plan', ['--plan']);
  results.push({
    name: 'plan_writes_nothing',
    ok: row.code === 0 && row.json.writes === false && !(await exists(row.configPath)) && !(await exists(row.envPath))
  });
}

{
  const row = await runSetup('no-default', ['--no-default-provider']);
  const config = await readText(row.configPath, '');
  results.push({
    name: 'no_default_provider',
    ok: row.code === 0 && row.json.ok === true && config.includes('[model_providers.codex-lb]') && !/^\s*model_provider\s*=\s*"codex-lb"/m.test(config)
  });
}

{
  const row = await runSetup('no-env', ['--no-env-file']);
  const actions = row.json.applied_actions?.map((action) => action.type) || [];
  results.push({
    name: 'no_env_file',
    ok: row.code === 0
      && row.json.status === 'configured'
      && row.json.persistence?.applied_modes?.includes('process_only_ephemeral')
      && !actions.includes('write_env_file')
      && !(await exists(row.envPath))
  });
}

{
  const row = await runSetup('shell-skip', ['--shell-profile', 'skip']);
  const touched = ['.zshrc', '.bashrc', '.config/fish/config.fish'];
  results.push({
    name: 'shell_profile_skip',
    ok: row.code === 0 && touched.every((file) => !row.json.applied_actions?.some((action) => action.type === 'install_shell_profile_snippet') && !row.stdout.includes(file))
  });
}

{
  const row = await runSetup('report', ['--no-keychain', '--no-launchctl']);
  const actions = row.json.applied_actions?.map((action) => action.type) || [];
  results.push({
    name: 'action_report_matches_choices',
    ok: row.code === 0
      && actions.includes('write_cli_provider')
      && actions.includes('write_env_file')
      && !actions.includes('store_keychain')
      && !actions.includes('sync_launchctl')
      && row.json.drift?.length === 0
  });
}

const text = results.map((row) => `${row.name}:${row.ok}`).join('\n');
const ok = results.every((row) => row.ok) && !/sk-clb-test/.test(text);
console.log(JSON.stringify({
  schema: 'sks.codex-lb-setup-truthfulness-check.v1',
  ok,
  results
}, null, 2));
if (!ok) process.exitCode = 1;
