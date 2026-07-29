#!/usr/bin/env node
// @ts-nocheck
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, readText, runProcess } from '../core/fsx.js';
import { codexLbFixtureEnv } from './codex-lb-fixture-env.js';

const entry = path.resolve('dist/bin/sks.js');
const results = [];

async function runSetup(name, args, input = 'sk-clb-test\n') {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-lb-persist-${name}-`));
  const result = await runProcess(process.execPath, [entry, 'codex-lb', 'setup', '--host', 'lb.example.test', '--api-key-stdin', '--json', ...args], {
    cwd: home,
    input,
    env: codexLbFixtureEnv(home),
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });
  return {
    home,
    result,
    json: parseJson(result.stdout),
    configPath: path.join(home, '.codex', 'config.toml'),
    envPath: path.join(home, '.codex', 'sks-codex-lb.env')
  };
}

{
  const row = await runSetup('plan', ['--plan', '--no-env-file', '--no-keychain', '--no-launchctl', '--shell-profile', 'skip']);
  results.push({
    name: 'plan_writes_nothing_and_reports_process_only',
    ok: row.result.code === 0
      && row.json.writes === false
      && row.json.persistence?.effective_mode === 'process_only_ephemeral'
      && !(await exists(row.configPath))
      && !(await exists(row.envPath))
  });
}

{
  const row = await runSetup('requires-yes', ['--no-env-file', '--no-keychain', '--no-launchctl', '--shell-profile', 'skip']);
  results.push({
    name: 'process_only_requires_yes',
    ok: row.result.code === 1 && row.json.status === 'process_only_requires_yes' && row.json.persistence?.warning === 'process_only_ephemeral'
  });
}

{
  const row = await runSetup('process-only', ['--yes', '--no-env-file', '--no-keychain', '--no-launchctl', '--shell-profile', 'skip']);
  results.push({
    name: 'process_only_warns_and_writes_no_env',
    ok: row.result.code === 0
      && row.json.persistence?.effective_mode === 'process_only_ephemeral'
      && row.json.persistence?.durable === false
      && row.json.persistence?.warnings?.includes('next_session_requires_center_or_setup')
      && !(await exists(row.envPath))
  });
}

{
  const row = await runSetup('durable-env', ['--yes', '--write-env-file', '--no-keychain', '--no-launchctl']);
  const envText = await readText(row.envPath, '');
  results.push({
    name: 'durable_env_file_mode',
    ok: row.result.code === 0
      && row.json.persistence?.applied_modes?.includes('durable_env_file')
      && row.json.persistence?.durable === true
      && /CODEX_LB_API_KEY/.test(envText)
  });
}

{
  const row = await runSetup('action-report', ['--yes', '--write-env-file', '--no-keychain', '--no-launchctl', '--shell-profile', 'skip']);
  const actions = row.json.applied_actions?.map((action) => action.type) || [];
  results.push({
    name: 'applied_actions_match_actual_choices',
    ok: row.result.code === 0
      && actions.includes('write_env_file')
      && !actions.includes('store_keychain')
      && !actions.includes('sync_launchctl')
      && !actions.includes('install_shell_profile_snippet')
      && row.json.drift?.length === 0
  });
}

const secretLeaked = /sk-clb-test/.test(results.map((row) => JSON.stringify(row)).join('\n'));
const ok = results.every((row) => row.ok) && !secretLeaked;
console.log(JSON.stringify({
  schema: 'sks.codex-lb-persistence-truth-check.v1',
  ok,
  results,
  secret_leaked: secretLeaked
}, null, 2));
if (!ok) process.exitCode = 1;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
