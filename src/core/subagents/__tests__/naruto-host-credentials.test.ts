import test from 'node:test'
import assert from 'node:assert/strict'
import {
  narutoCredentialConfigArgs,
  narutoCredentialPolicyReceipt,
  resolveNarutoCredentialPolicy
} from '../naruto-host-credentials.js'
import { buildOfficialSubagentChildEnv, buildOfficialSubagentCodexArgs } from '../official-subagent-runner.js'

const DEFAULTS = {
  defaultParentModel: 'gpt-5.6-sol',
  defaultParentEffort: 'max',
  defaultSubagentModel: 'gpt-5.6-sol',
  defaultSubagentEffort: 'high'
}

function policy(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return resolveNarutoCredentialPolicy({ args, env, ...DEFAULTS })
}

test('the default stays SKS-managed ChatGPT authentication', () => {
  const resolved = policy()
  assert.equal(resolved.authMode, 'managed')
  assert.equal(resolved.modelProvider, 'openai')
  assert.equal(resolved.forcedLoginMethod, 'chatgpt')
  assert.equal(resolved.providerEnvKey, null)
  assert.deepEqual(resolved.blockers, [])
  assert.deepEqual(narutoCredentialConfigArgs(resolved), [
    '-c', 'model_provider="openai"',
    '-c', 'forced_login_method="chatgpt"'
  ])
})

test('host auth mode injects neither the provider nor the login method', () => {
  const resolved = policy(['--auth-mode=host'])
  assert.equal(resolved.authMode, 'host')
  assert.equal(resolved.forcedLoginMethod, null)
  assert.equal(resolved.modelProvider, null)
  assert.deepEqual(narutoCredentialConfigArgs(resolved), [])
  assert.ok(resolved.warnings.includes('naruto_host_auth_mode_without_explicit_model_provider'))
})

test('host auth mode names the provider block the host configured', () => {
  const resolved = policy(['--auth-mode', 'host', '--model-provider', 'codex-lb'])
  assert.equal(resolved.modelProvider, 'codex-lb')
  assert.deepEqual(narutoCredentialConfigArgs(resolved), ['-c', 'model_provider="codex-lb"'])
  assert.equal(resolved.forcedLoginMethod, null)
  assert.deepEqual(resolved.blockers, [])
})

test('the env contract matches the flag contract', () => {
  const resolved = policy([], {
    SKS_NARUTO_AUTH_MODE: 'host',
    SKS_NARUTO_MODEL_PROVIDER: 'openrouter',
    CODEX_LB_API_KEY: 'not-read-by-sks',
    SKS_NARUTO_PROVIDER_ENV_KEY: 'CODEX_LB_API_KEY'
  })
  assert.equal(resolved.authMode, 'host')
  assert.equal(resolved.modelProvider, 'openrouter')
  assert.equal(resolved.providerEnvKey, 'CODEX_LB_API_KEY')
  assert.equal(resolved.sources.authMode, 'env')
  assert.deepEqual(resolved.blockers, [])
})

test('--no-forced-login-method releases the login without switching provider', () => {
  const resolved = policy(['--no-forced-login-method'])
  assert.equal(resolved.authMode, 'managed')
  assert.equal(resolved.modelProvider, 'openai')
  assert.equal(resolved.forcedLoginMethod, null)
  assert.ok(resolved.warnings.includes('naruto_forced_login_method_released_without_host_auth_mode'))
  assert.deepEqual(narutoCredentialConfigArgs(resolved), ['-c', 'model_provider="openai"'])
})

test('model and effort overrides reach the codex arguments', () => {
  const resolved = policy([
    '--parent-model', 'gpt-5.6-terra',
    '--parent-effort', 'medium',
    '--subagent-model', 'gpt-5.6-luna',
    '--subagent-effort', 'low'
  ])
  assert.equal(resolved.parentModel, 'gpt-5.6-terra')
  assert.equal(resolved.parentEffort, 'medium')
  const args = buildOfficialSubagentCodexArgs({
    prompt: 'task',
    maxThreads: 2,
    parentSummaryFile: '/tmp/summary.txt',
    credentialPolicy: resolved
  })
  assert.ok(args.includes('gpt-5.6-terra'))
  assert.ok(args.includes('model_reasoning_effort="medium"'))
  assert.ok(args.includes('agents.default_subagent_model="gpt-5.6-luna"'))
  assert.ok(args.includes('agents.default_subagent_reasoning_effort="low"'))
})

test('a host-mode run carries no chatgpt login into the codex arguments', () => {
  const resolved = policy(['--auth-mode=host', '--model-provider=codex-lb'])
  const args = buildOfficialSubagentCodexArgs({
    prompt: 'task',
    maxThreads: 2,
    parentSummaryFile: '/tmp/summary.txt',
    credentialPolicy: resolved
  })
  assert.ok(!args.some((arg) => arg.includes('forced_login_method')))
  assert.ok(args.includes('model_provider="codex-lb"'))
})

test('the named provider key reaches the child, and nothing else does', () => {
  const resolved = policy(['--auth-mode=host', '--provider-env-key=CODEX_LB_API_KEY'], {
    CODEX_LB_API_KEY: 'value-under-test'
  })
  const childEnv = buildOfficialSubagentChildEnv({
    env: { CODEX_LB_API_KEY: 'value-under-test', OPENAI_API_KEY: 'unrelated', HOME: '/tmp/home' },
    credentialPolicy: resolved
  })
  assert.equal(childEnv.CODEX_LB_API_KEY, 'value-under-test')
  assert.equal(childEnv.OPENAI_API_KEY, undefined)
})

test('a malformed identifier blocks instead of falling back to the managed credential', () => {
  assert.ok(policy(['--auth-mode=nope']).blockers.some((b) => b.startsWith('naruto_auth_mode_invalid')))
  assert.ok(policy(['--auth-mode=host', '--model-provider=has space']).blockers.some((b) => b.startsWith('naruto_model_provider_invalid')))
  assert.ok(policy(['--auth-mode=host', '--parent-effort=turbo']).blockers.some((b) => b.startsWith('naruto_parentEffort_invalid')))
  assert.ok(policy(['--auth-mode=host', '--provider-env-key=lower_case']).blockers.some((b) => b.startsWith('naruto_provider_env_key_invalid')))
})

test('naming a provider without host auth mode is a blocker, not a silent mixed configuration', () => {
  const resolved = policy(['--model-provider=codex-lb'])
  assert.ok(resolved.blockers.includes('naruto_model_provider_requires_host_auth_mode'))
  assert.equal(resolved.modelProvider, 'openai')
})

test('a provider env key that is absent from the environment blocks before Codex sees it', () => {
  const resolved = policy(['--auth-mode=host', '--provider-env-key=MISSING_KEY'], {})
  assert.ok(resolved.blockers.includes('naruto_provider_env_key_absent:MISSING_KEY'))
})

test('the receipt records the decision and never the credential', () => {
  const resolved = policy(['--auth-mode=host', '--model-provider=codex-lb', '--provider-env-key=CODEX_LB_API_KEY'], {
    CODEX_LB_API_KEY: 'super-secret-value'
  })
  const receipt = narutoCredentialPolicyReceipt(resolved)
  const serialized = JSON.stringify(receipt)
  assert.ok(!serialized.includes('super-secret-value'))
  assert.ok(serialized.includes('CODEX_LB_API_KEY'))
  assert.equal(receipt.credential_handled_by, 'host_config_toml_provider_block')
  assert.equal(receipt.auth_mode, 'host')
})
