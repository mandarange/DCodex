import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launchZellijLayout } from '../zellij-launcher.js'
import type { ZellijCapabilityReport } from '../zellij-capability.js'
import type { CodexLbToolOutputRecoveryProbe } from '../../codex-lb/codex-lb-tool-output-recovery.js'

test('Zellij Codex pane receives validated codex-lb credentials and drops stale ambient values', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-codex-lb-env-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const preparedCalls: NodeJS.ProcessEnv[] = []
  const capability: ZellijCapabilityReport = {
    schema: 'sks.zellij-capability.v1',
    generated_at: new Date().toISOString(),
    ok: true,
    status: 'ok',
    integration_optional: true,
    require_zellij: false,
    min_version: '0.43.0',
    version: '0.43.1',
    bin: 'zellij',
    command: ['zellij', '--version'],
    docs_evidence: [],
    blockers: [],
    warnings: [],
    operator_actions: []
  }
  const report = await launchZellijLayout({
    root,
    missionId: 'M-codex-lb-env',
    kind: 'mad',
    dryRun: true,
    launchEnv: {
      HOME: root,
      CODEX_LB_API_KEY: 'stale-synthetic-key',
      CODEX_LB_BASE_URL: 'https://stale.example.test/backend-api/codex'
    },
    zellijCapability: capability,
    prepareCodexRuntimeEnvImpl: async (input = {}) => {
      const env = input.env || {}
      preparedCalls.push(env)
      return {
        ...env,
        CODEX_LB_API_KEY: 'validated-synthetic-key',
        CODEX_LB_BASE_URL: 'https://validated.example.test/backend-api/codex'
      }
    }
  })
  assert.equal(preparedCalls[0]?.CODEX_LB_API_KEY, 'stale-synthetic-key')
  assert.ok(report.codex_pane.launch_env_keys.includes('CODEX_LB_API_KEY'))
  const layout = await fsp.readFile(report.layout_path, 'utf8')
  assert.match(layout, /CODEX_LB_API_KEY='validated-synthetic-key'/)
  assert.doesNotMatch(layout, /stale-synthetic-key/)
})

test('Zellij session creation receives the same viewport and refresh environment', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-launch-env-'))
  const previous = {
    adapter: process.env.SKS_ZELLIJ_FAKE_ADAPTER,
    status: process.env.SKS_ZELLIJ_CAPABILITY_FAKE_STATUS
  }
  process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
  process.env.SKS_ZELLIJ_CAPABILITY_FAKE_STATUS = 'ok'
  try {
    const report = await launchZellijLayout({
      root,
      missionId: 'M-launch-env',
      kind: 'naruto',
      attach: false,
      launchEnv: {
        SKS_ZELLIJ_FAKE_ADAPTER: '1',
        SKS_ZELLIJ_FAKE_ROOT: root,
        SKS_ZELLIJ_VIEWPORTS: '3',
        SKS_ZELLIJ_REFRESH_MS: '725'
      }
    })
    assert.equal(report.ok, true)
    const calls = (await fsp.readFile(path.join(root, '.sneakoscope', 'fake-zellij-calls.jsonl'), 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const create = calls.find((row) => row.args?.[0] === 'attach' && row.args?.[1] === '--create-background')
    assert.ok(create)
    assert.equal(create.sks_zellij_viewports, '3')
    assert.equal(create.sks_zellij_refresh_ms, '725')
  } finally {
    restoreEnv('SKS_ZELLIJ_FAKE_ADAPTER', previous.adapter)
    restoreEnv('SKS_ZELLIJ_CAPABILITY_FAKE_STATUS', previous.status)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Zellij launch reuses verified preflight capability and codex-lb recovery evidence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-launch-evidence-'))
  const previous = {
    adapter: process.env.SKS_ZELLIJ_FAKE_ADAPTER,
    root: process.env.SKS_ZELLIJ_FAKE_ROOT,
    status: process.env.SKS_ZELLIJ_CAPABILITY_FAKE_STATUS
  }
  process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
  process.env.SKS_ZELLIJ_FAKE_ROOT = root
  process.env.SKS_ZELLIJ_CAPABILITY_FAKE_STATUS = 'blocked'
  const capability: ZellijCapabilityReport = {
    schema: 'sks.zellij-capability.v1',
    generated_at: new Date().toISOString(),
    ok: true,
    status: 'ok',
    integration_optional: true,
    require_zellij: false,
    min_version: '0.43.0',
    version: '0.43.1',
    bin: 'zellij',
    command: ['zellij', '--version'],
    docs_evidence: [],
    blockers: [],
    warnings: [],
    operator_actions: []
  }
  const recovery: CodexLbToolOutputRecoveryProbe = {
    schema: 'sks.codex-lb-tool-output-recovery.v1',
    ok: true,
    required: true,
    status: 'compatible',
    base_url: 'https://lb.example.test/backend-api/codex',
    health_url: 'https://lb.example.test/health',
    observed_version: '1.21.0-beta.3',
    minimum_version: '1.21.0-beta.3',
    version_header: 'x-app-version',
    supports_interrupted_tool_output_recovery: true,
    verified: true,
    override_acknowledged: false,
    test_bypass: false,
    http_status: 200,
    blockers: [],
    warnings: [],
    operator_actions: []
  }
  try {
    const report = await launchZellijLayout({
      root,
      missionId: 'M-launch-evidence',
      kind: 'mad',
      attach: false,
      codexArgs: ['-c', 'model_provider="codex-lb"'],
      launchEnv: {
        HOME: root,
        CODEX_HOME: path.join(root, '.codex'),
        CODEX_LB_BASE_URL: 'https://lb.example.test/backend-api/codex'
      },
      zellijCapability: capability,
      verifiedCodexLbToolOutputRecovery: recovery,
      prepareCodexRuntimeEnvImpl: async (input = {}) => ({
        ...(input.env || {}),
        CODEX_LB_API_KEY: 'validated-synthetic-key',
        CODEX_LB_BASE_URL: 'https://lb.example.test/backend-api/codex'
      }),
      recoveryFetch: async () => { throw new Error('recovery probe should have been reused') }
    })
    assert.equal(report.ok, true)
    assert.equal(report.capability.version, '0.43.1')
    assert.equal((report.pane_proof as any).capability_status, 'ok')
    assert.equal(report.codex_lb_tool_output_recovery.status, 'compatible')
  } finally {
    restoreEnv('SKS_ZELLIJ_FAKE_ADAPTER', previous.adapter)
    restoreEnv('SKS_ZELLIJ_FAKE_ROOT', previous.root)
    restoreEnv('SKS_ZELLIJ_CAPABILITY_FAKE_STATUS', previous.status)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Zellij launch does not reuse codex-lb recovery evidence for a different effective base URL', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-launch-recovery-binding-'))
  const previous = {
    adapter: process.env.SKS_ZELLIJ_FAKE_ADAPTER,
    root: process.env.SKS_ZELLIJ_FAKE_ROOT,
    status: process.env.SKS_ZELLIJ_CAPABILITY_FAKE_STATUS
  }
  process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
  process.env.SKS_ZELLIJ_FAKE_ROOT = root
  process.env.SKS_ZELLIJ_CAPABILITY_FAKE_STATUS = 'ok'
  let fetchCalls = 0
  const recovery: CodexLbToolOutputRecoveryProbe = {
    schema: 'sks.codex-lb-tool-output-recovery.v1',
    ok: true,
    required: true,
    status: 'compatible',
    base_url: 'https://verified.example.test/backend-api/codex',
    health_url: 'https://verified.example.test/health',
    observed_version: '1.21.0-beta.3',
    minimum_version: '1.21.0-beta.3',
    version_header: 'x-app-version',
    supports_interrupted_tool_output_recovery: true,
    verified: true,
    override_acknowledged: false,
    test_bypass: false,
    http_status: 200,
    blockers: [],
    warnings: [],
    operator_actions: []
  }
  try {
    const report = await launchZellijLayout({
      root,
      missionId: 'M-launch-recovery-binding',
      kind: 'mad',
      attach: false,
      codexArgs: ['-c', 'model_provider="codex-lb"'],
      launchEnv: {
        HOME: root,
        CODEX_HOME: path.join(root, '.codex'),
        CODEX_LB_BASE_URL: 'https://different.example.test/backend-api/codex'
      },
      verifiedCodexLbToolOutputRecovery: recovery,
      prepareCodexRuntimeEnvImpl: async (input = {}) => ({
        ...(input.env || {}),
        CODEX_LB_API_KEY: 'validated-synthetic-key',
        CODEX_LB_BASE_URL: 'https://different.example.test/backend-api/codex'
      }),
      recoveryFetch: async () => {
        fetchCalls += 1
        return new Response('{}', { status: 200, headers: { 'x-app-version': '1.21.0-beta.3' } })
      }
    })
    assert.equal(report.ok, true)
    assert.equal(fetchCalls, 1)
    assert.equal(report.codex_lb_tool_output_recovery.base_url, 'https://different.example.test/backend-api/codex')
  } finally {
    restoreEnv('SKS_ZELLIJ_FAKE_ADAPTER', previous.adapter)
    restoreEnv('SKS_ZELLIJ_FAKE_ROOT', previous.root)
    restoreEnv('SKS_ZELLIJ_CAPABILITY_FAKE_STATUS', previous.status)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
