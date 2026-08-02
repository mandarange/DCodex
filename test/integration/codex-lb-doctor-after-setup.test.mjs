import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runProcess } from '../../dist/core/fsx.js';

const rawMissingEnvPattern = new RegExp(['Missing environment variable:', '\\s*`?CODEX_LB_API_KEY`?'].join(''), 'i');

function hermeticEnv(home) {
  const preload = `const models=['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol'].map(slug=>({slug,display_name:slug,supported_reasoning_levels:[],shell_type:'shell_command',visibility:'list',supported_in_api:true,priority:1,base_instructions:'',supports_reasoning_summaries:true,support_verbosity:true,truncation_policy:{mode:'tokens',limit:10000},supports_parallel_tool_calls:true,experimental_supported_tools:[],service_tiers:['priority'],tool_mode:'code_mode_only'}));globalThis.fetch=async input=>{const url=String(input?.url||input);if(url.endsWith('/health'))return new Response('{}',{status:200,headers:{'x-app-version':'1.21.0-beta.3'}});if(url.endsWith('/models'))return new Response(JSON.stringify({models}),{status:200,headers:{'content-type':'application/json'}});throw new Error('unexpected fixture fetch '+url)}`;
  return { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CODEX_LB_API_KEY: '', CODEX_LB_BASE_URL: '', CI: 'true', SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'), SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY: '', SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1', SKS_CODEX_LB_CHAIN_CHECK: '0', NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=data:text/javascript,${encodeURIComponent(preload)}`].filter(Boolean).join(' ') };
}

test('codex-lb doctor sees redacted key after setup', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-doctor-'));
  const secret = 'sk-fixture-doctor-secret';
  const env = hermeticEnv(home);
  const entry = path.resolve('dist/bin/sks.js');
  const setup = await runProcess(process.execPath, [entry, 'codex-lb', 'setup', '--host', 'lb.example.test', '--api-key-stdin', '--yes', '--json'], {
    cwd: home,
    input: `${secret}\n`,
    env,
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });
  assert.equal(setup.code, 0, setup.stderr || setup.stdout);

  const doctor = await runProcess(process.execPath, [entry, 'codex-lb', 'doctor', '--deep', '--json'], {
    cwd: home,
    env,
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });
  assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
  const text = `${doctor.stdout}\n${doctor.stderr}`;
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, rawMissingEnvPattern);
  const json = JSON.parse(doctor.stdout);
  assert.equal(json.schema, 'sks.codex-lb-doctor.v2');
  assert.equal(json.status.configured, true);
  assert.match(json.status.bridge.key_fingerprint, /^sha256:[a-f0-9]{16}$/);
  assert.equal(json.status.routing_truth.schema, 'sks.codex-lb-routing-truth.v1');
  assert.equal(json.status.routing_truth.auth_outcome, 'accepted');
  assert.equal(json.status.setup_needed, false);
});
