#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../commands/codex-lb.js';
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../core/codex-lb/codex-lb-tool-output-recovery.js';

const calls: any[] = [];
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-fast-truth-'));
await fs.mkdir(path.join(home, '.codex'), { recursive: true });
await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
  'model = "gpt-5.6-sol"',
  'model_provider = "codex-lb"',
  'service_tier = "fast"',
  '',
  '[model_providers.codex-lb]',
  'name = "codex-lb"',
  'base_url = "https://lb.example.test/backend-api/codex"',
  'wire_api = "responses"',
  'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
  'supports_websockets = true',
  'requires_openai_auth = false',
  ''
].join('\n'));
await fs.writeFile(path.join(home, '.codex', 'auth.json'), `${JSON.stringify({
  auth_mode: 'chatgpt',
  account_id: 'acct-fast-truth',
  tokens: {
    access_token: 'oauth-fast-truth',
    refresh_token: 'refresh-fast-truth'
  }
})}\n`);
await fs.writeFile(
  path.join(home, '.codex', 'sks-codex-lb.env'),
  "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-fixture'\n",
  { mode: 0o600 }
);

const chain = await runFastCheck({
  HOME: home,
  CODEX_LB_API_KEY: 'sk-fixture',
  CODEX_LB_BASE_URL: 'https://lb.example.test/backend-api/codex'
});

const requestedOnly = await runFastCheck({
  HOME: home,
  CODEX_LB_API_KEY: 'sk-fixture',
  CODEX_LB_BASE_URL: 'https://lb.example.test/backend-api/codex',
  SKS_TEST_FAST_ACTUAL_DEFAULT: '1'
});

const ok = chain.ok === true
  && chain.status === 'fast_verified'
  && calls[0]?.body?.service_tier === 'priority'
  && calls.every((call) => call.authorization === null && call.gatewayKey === 'sk-fixture')
  && requestedOnly.ok === false
  && requestedOnly.status === 'fast_requested_but_actual_unverified'
  && requestedOnly.blockers.includes('codex_lb_actual_fast_service_tier_unverified');

console.log(JSON.stringify({
  schema: 'sks.codex-lb-fast-mode-truth-check.v1',
  ok,
  priority_request_sent: calls[0]?.body?.service_tier === 'priority',
  custom_header_transport_verified: calls.every((call) => call.authorization === null && call.gatewayKey === 'sk-fixture'),
  verified_case: chain,
  requested_only_case: requestedOnly,
  blockers: ok ? [] : ['codex_lb_fast_mode_truth_check_failed']
}, null, 2));
if (!ok) process.exitCode = 1;

async function runFastCheck(env: NodeJS.ProcessEnv) {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const outputs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExitCode = process.exitCode;
  try {
    Object.assign(process.env, env);
    process.exitCode = 0;
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (new URL(String(url)).pathname === '/health') {
        return new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION
          }
        });
      }
      const body = JSON.parse(String(init.body || '{}'));
      const headers = new Headers(init.headers);
      calls.push({
        body,
        authorization: headers.get('authorization'),
        gatewayKey: headers.get('x-codex-lb-api-key')
      });
      const id = calls.length % 2 === 1 ? 'resp_fast_1' : 'resp_fast_2';
      const actual = env.SKS_TEST_FAST_ACTUAL_DEFAULT === '1' ? 'default' : 'priority';
      return new Response(JSON.stringify({
        id,
        requestedServiceTier: 'priority',
        actualServiceTier: actual,
        serviceTier: actual
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    (process.stdout.write as any) = (chunk: any) => {
      outputs.push(String(chunk));
      return true;
    };
    await run(null, ['fast-check', '--json']);
    return JSON.parse(outputs.join('') || '{}');
  } finally {
    (globalThis as any).fetch = originalFetch;
    (process.stdout.write as any) = originalWrite;
    process.exitCode = originalExitCode;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}
