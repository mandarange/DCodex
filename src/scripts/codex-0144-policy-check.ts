#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js';
import { buildCodexExecutionPolicy } from '../core/codex-control/codex-sdk-config-policy.js';
import { buildCodexSdkEnv } from '../core/codex-control/codex-sdk-env-policy.js';

process.env.AWS_SECRET_ACCESS_KEY = 'fixture-secret-aws';
process.env.GITHUB_TOKEN = 'fixture-secret-github';
process.env.SLACK_BOT_TOKEN = 'fixture-secret-slack';
process.env.CODEX_LB_API_KEY = 'fixture-secret-codex-lb';
process.env.CODEX_LB_BASE_URL = 'https://lb.example.test/backend-api/codex';

const input: any = {
  route: 'test',
  tier: 'worker',
  missionId: 'M-test',
  cwd: process.cwd(),
  prompt: 'fixture',
  outputSchemaId: 'fixture',
  outputSchema: {},
  sandboxPolicy: 'workspace-write',
  requestedScopeContract: {},
  mutationLedgerRoot: '.sneakoscope/tmp/codex-policy-check'
};
const env = buildCodexSdkEnv(input);
const policy = buildCodexExecutionPolicy(input);
for (const key of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN']) {
  assertGate(!(key in env.env), `secret env must not be inherited: ${key}`, env.proof);
}
assertGate(!('CODEX_LB_API_KEY' in env.env) && !('CODEX_LB_BASE_URL' in env.env), 'ambient codex-lb variables must not alter the native Codex SDK environment', env.proof);
assertGate(env.proof.native_codex_only === true && env.proof.codex_home_isolated === true && env.proof.home_isolated === true, 'worker HOME and config must stay isolated while native auth is bridged separately', env.proof);
assertGate(policy.network === 'disabled' && policy.approval === 'on-request' && policy.gitRepoCheck === 'required', 'default Codex execution policy must be conservative', policy);
emitGate('codex:0144:policy', {
  inherited_key_count: env.proof.inherited_key_count,
  blocked_sensitive_host_env_key_count: env.proof.blocked_sensitive_host_env_key_count,
  network: policy.network,
  approval: policy.approval
});
