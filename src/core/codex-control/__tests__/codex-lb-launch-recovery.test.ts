// First import: this suite spawns real codex/npm processes, which write
// $HOME/.codex/tmp and $HOME/.npm when the default home leaks through.
import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { runCodexTask } from '../codex-task-runner.js'
import { effectiveCodexWorkingRoot, inspectCodexLbCliLaunchRecovery } from '../codex-lb-launch-recovery.js'
import { runCodexExec } from '../../codex-adapter.js'
import { attemptCodexAppLaunch } from '../../codex-app/codex-app-launcher.js'
import { restartCodexApp } from '../../codex-app/codex-app-restart.js'
import { runCodexExecResumeWithOutputSchema } from '../../codex-exec-output-schema.js'
import { runCodexExecAgent } from '../../agents/agent-runner-codex-exec.js'
import { launchMadZellijUi } from '../../zellij/zellij-launcher.js'
import { runCodex0139ImageReferencedPathRealProbe } from '../codex-0139-image-path-real-probe.js'
import { runCodex0139WebSearchRealProbe } from '../codex-0139-web-search-probe.js'

test('ambient codex-lb credentials cannot select the native SDK control paths', async () => {
  let authorization: string | undefined
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-app-version': '1.20.0'
    })
    response.end(JSON.stringify({ status: 'ok' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server address missing')
  const baseUrl = `http://127.0.0.1:${address.port}/backend-api/codex`
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-launch-recovery-'))
  const previous = saveEnv([
    'CODEX_LB_API_KEY',
    'CODEX_LB_BASE_URL',
    'SKS_CODEX_LB_AUTOBYPASS',
    'SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY',
    'SKS_CODEX_SDK_FAKE',
    'SKS_PYTHON_CODEX_SDK_FAKE'
  ])
  try {
    process.env.CODEX_LB_API_KEY = 'sk-launch-recovery-fixture'
    process.env.CODEX_LB_BASE_URL = baseUrl
    delete process.env.SKS_CODEX_LB_AUTOBYPASS
    delete process.env.SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY
    process.env.SKS_CODEX_SDK_FAKE = '1'
    process.env.SKS_PYTHON_CODEX_SDK_FAKE = '1'

    const sdkRoot = path.join(root, 'sdk')
    const sdkResult: any = await runCodexTask(taskInput(sdkRoot, ['codex-sdk']))
    assert.equal(sdkResult.ok, true)
    assert.equal(sdkResult.codexLbToolOutputRecovery.status, 'not_selected')
    assert.equal(authorization, undefined)
    assert.doesNotMatch(JSON.stringify(sdkResult), /sk-launch-recovery-fixture/)
    const sdkProof = JSON.parse(await fsp.readFile(path.join(sdkRoot, 'codex-control-proof.json'), 'utf8'))
    assert.equal(sdkProof.config.model_provider, 'openai')
    assert.equal(sdkProof.env.codex_lb_env_injected, false)
    assert.equal(sdkProof.env.codex_lb_tool_output_recovery.status, 'not_selected')

    const pythonRoot = path.join(root, 'python')
    const pythonResult: any = await runCodexTask(taskInput(pythonRoot, ['python-codex-sdk']))
    assert.equal(pythonResult.ok, true)
    assert.equal(pythonResult.codexLbToolOutputRecovery.status, 'not_selected')
    assert.equal(authorization, undefined)
    assert.doesNotMatch(JSON.stringify(pythonResult), /sk-launch-recovery-fixture/)
    const pythonProof = JSON.parse(await fsp.readFile(path.join(pythonRoot, 'python-codex-sdk-proof.json'), 'utf8'))
    assert.equal(pythonProof.codex_lb_tool_output_recovery.status, 'not_selected')
  } finally {
    restoreEnv(previous)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('CLI recovery rejects project-local provider state and follows user/profile or explicit CLI selection', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-cli-selection-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const projectCodex = path.join(root, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.mkdir(projectCodex, { recursive: true })
  const oldFetch: typeof fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'x-app-version': '1.20.0' }
  })
  try {
    await fsp.writeFile(path.join(projectCodex, 'config.toml'), [
      "model_provider = 'codex-lb'",
      '',
      "[model_providers.'codex-lb']",
      "base_url = 'https://lb.single-quote.internal/backend-api/codex'",
      ''
    ].join('\n'))
    const projectSelected = await inspectCodexLbCliLaunchRecovery({
      root,
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        SKS_MODEL_PROVIDER: 'openai',
        CODEX_MODEL_PROVIDER: 'openai',
        OPENAI_MODEL_PROVIDER: 'openai'
      },
      fetchImpl: oldFetch
    })
    assert.equal(projectSelected.status, 'version_unverified')
    assert.ok(projectSelected.blockers.includes('codex_lb_launch_project_provider_config_forbidden'))

    await fsp.writeFile(path.join(projectCodex, 'config.toml'), '')
    await fsp.writeFile(path.join(codexHome, 'config.toml'), [
      "model_provider = 'codex-lb'",
      '',
      "[model_providers.'codex-lb']",
      "base_url = 'https://lb.user-config.internal/backend-api/codex'",
      ''
    ].join('\n'))
    const selected = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      fetchImpl: oldFetch
    })
    assert.equal(selected.status, 'version_too_old')
    assert.equal(selected.base_url, 'https://lb.user-config.internal/backend-api/codex')

    const cliOverrideAway = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      cliArgs: ["--config=model_provider='openai'"],
      fetchImpl: oldFetch
    })
    assert.equal(cliOverrideAway.status, 'not_selected')

    let explicitCliFetchCalls = 0
    for (const cliArgs of [
      ['--oss'],
      ['--config=model_provider="openai"']
    ]) {
      const explicitCliSelection = await inspectCodexLbCliLaunchRecovery({
        root,
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          SKS_PROVIDER: 'codex-lb',
          CODEX_LB_BASE_URL: 'https://lb.env-default.internal/backend-api/codex'
        },
        cliArgs,
        fetchImpl: async () => {
          explicitCliFetchCalls += 1
          return new Response('{}', { status: 200 })
        }
      })
      assert.equal(explicitCliSelection.status, 'not_selected', cliArgs.join(' '))
    }
    assert.equal(explicitCliFetchCalls, 0)

    let localProviderFetchCalls = 0
    const localProviderWithoutOss = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      cliArgs: ['--local-provider', 'ollama'],
      fetchImpl: async () => {
        localProviderFetchCalls += 1
        return new Response('{}', { status: 200, headers: { 'x-app-version': '1.20.0' } })
      }
    })
    assert.equal(localProviderWithoutOss.status, 'version_too_old')
    assert.equal(localProviderFetchCalls, 1)

    await fsp.writeFile(path.join(projectCodex, 'config.toml'), 'model_provider = "openai"\n')
    let unrelatedFetchCalls = 0
    const unrelated = await inspectCodexLbCliLaunchRecovery({
      root,
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        SKS_MODEL_PROVIDER: 'codex-lb',
        CODEX_LB_BASE_URL: 'https://lb.unrelated-env.internal/backend-api/codex'
      },
      fetchImpl: async () => {
        unrelatedFetchCalls += 1
        return new Response('{}', { status: 200 })
      }
    })
    assert.equal(unrelated.status, 'version_unverified')
    assert.ok(unrelated.blockers.includes('codex_lb_launch_project_provider_config_forbidden'))
    assert.equal(unrelatedFetchCalls, 0)

    await fsp.writeFile(path.join(projectCodex, 'config.toml'), '')
    const cliOverrideToCodexLb = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      cliArgs: [
        "--config=model_provider='codex-lb'",
        "--config=model_providers.'codex-lb'.base_url='https://lb.cli-override.internal/backend-api/codex'"
      ],
      fetchImpl: oldFetch
    })
    assert.equal(cliOverrideToCodexLb.status, 'version_too_old')
    assert.equal(cliOverrideToCodexLb.base_url, 'https://lb.cli-override.internal/backend-api/codex')

    const explicit = await inspectCodexLbCliLaunchRecovery({
      root,
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        SKS_PROVIDER: 'codex-lb',
        CODEX_LB_BASE_URL: 'https://lb.explicit.internal/backend-api/codex'
      },
      fetchImpl: oldFetch
    })
    assert.equal(explicit.status, 'version_too_old')

    const acknowledged = await inspectCodexLbCliLaunchRecovery({
      root,
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        SKS_PROVIDER: 'codex-lb',
        CODEX_LB_BASE_URL: 'https://lb.explicit.internal/backend-api/codex'
      },
      allowUnverified: true,
      fetchImpl: oldFetch
    })
    assert.equal(acknowledged.status, 'override_acknowledged')
    assert.equal(acknowledged.ok, true)

    await fsp.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "codex-lb"',
      '[model_providers.codex-lb]',
      'base_url = "https://lb.user-only.internal/backend-api/codex"',
      ''
    ].join('\n'))
    const ignoredUser = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      cliArgs: ['--ignore-user-config'],
      fetchImpl: oldFetch
    })
    assert.equal(ignoredUser.status, 'not_selected')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('CLI recovery rejects a project base URL before an explicit openai provider override', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-project-base-url-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const projectCodex = path.join(root, '.codex')
  await Promise.all([
    fsp.mkdir(codexHome, { recursive: true }),
    fsp.mkdir(projectCodex, { recursive: true })
  ])
  try {
    await fsp.writeFile(
      path.join(projectCodex, 'config.toml'),
      'openai_base_url = "https://project-redirect.example.test/v1"\n'
    )
    let fetchCalls = 0
    const result = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      cliArgs: ['--config=model_provider="openai"'],
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response('{}', { status: 200 })
      }
    })

    assert.equal(result.status, 'version_unverified')
    assert.ok(result.blockers.includes('codex_lb_launch_project_provider_config_forbidden'))
    assert.equal(fetchCalls, 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('CLI recovery inspects the final effective -C/--cd project root', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-effective-root-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const first = path.join(root, 'first')
  const final = path.join(root, 'final')
  await Promise.all([
    fsp.mkdir(codexHome, { recursive: true }),
    fsp.mkdir(path.join(first, '.codex'), { recursive: true }),
    fsp.mkdir(path.join(final, '.codex'), { recursive: true })
  ])
  try {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "codex-lb"',
      '[model_providers.codex-lb]',
      'base_url = "https://lb.effective-root.internal/backend-api/codex"',
      ''
    ].join('\n'))
    await fsp.writeFile(path.join(final, '.codex', 'config.toml'), 'model_provider = "openai"\n')
    const resolved = effectiveCodexWorkingRoot(root, ['exec', '--cd', first, '-C', final])
    assert.equal(resolved.ok, true)
    assert.equal(resolved.root, final)
    const blocked = await inspectCodexLbCliLaunchRecovery({
      root,
      env: { HOME: home, CODEX_HOME: codexHome },
      cliArgs: ['exec', '--cd', first, `--cd=${final}`],
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'x-app-version': '1.20.0' } })
    })
    assert.ok(blocked.blockers.includes('codex_lb_launch_project_provider_config_forbidden'))
    const malformed = effectiveCodexWorkingRoot(root, ['exec', '--cd'])
    assert.equal(malformed.ok, false)
    assert.ok(malformed.blockers.includes('codex_lb_launch_working_root_value_missing'))
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('every real Codex launch wrapper blocks before spawning when selected codex-lb recovery is too old', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-all-launches-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const projectCodex = path.join(root, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.mkdir(projectCodex, { recursive: true })
  const baseUrl = 'https://lb.all-launches.internal/backend-api/codex'
  await fsp.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    '[model_providers.codex-lb]',
    `base_url = "${baseUrl}"`,
    ''
  ].join('\n'))
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    SKS_PROVIDER: 'codex-lb',
    CODEX_LB_BASE_URL: baseUrl
  }
  const oldFetch: typeof fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'x-app-version': '1.20.0' }
  })
  let launches = 0
  let binaryResolutions = 0
  let qaBinaryResolutions = 0
  const fakeProcess = async (_command: string, args: readonly string[]) => {
    launches += 1
    const runningProbe = args[0] === '-e' && String(args[1] || '').includes('is running')
    return {
      code: 0,
      stdout: runningProbe ? 'false\n' : '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      timedOut: false
    }
  }
  try {
    const qa = await runCodexExec({
      root,
      prompt: 'fixture',
      env,
      recoveryFetch: oldFetch,
      findCodexBinaryImpl: async () => {
        qaBinaryResolutions += 1
        return '/fixture/codex'
      },
      runProcessImpl: fakeProcess
    })
    assert.equal(qa.code, 78)

    const appLaunch = await attemptCodexAppLaunch({
      cwd: root,
      promptArtifactPath: path.join(root, 'prompt.txt'),
      mode: 'attempt-launch',
      platform: 'darwin',
      env,
      recoveryFetch: oldFetch,
      findCodexBinaryImpl: async () => {
        binaryResolutions += 1
        return '/fixture/codex'
      },
      runProcessImpl: fakeProcess as any
    })
    assert.equal(appLaunch.fallback_reason, 'codex_lb_tool_output_recovery_blocked')
    assert.equal(appLaunch.attempted, false)

    const restart = await restartCodexApp({
      root,
      platform: 'darwin',
      osascriptPath: '/fixture/osascript',
      openPath: '/fixture/open',
      env,
      recoveryFetch: oldFetch,
      runProcessImpl: fakeProcess as any
    })
    assert.equal(restart.status, 'tool_output_recovery_blocked')

    const resume = await runCodexExecResumeWithOutputSchema({
      sessionId: 'fixture-session',
      prompt: 'fixture',
      outputSchemaPath: path.join(root, 'never-read.schema.json')
    }, {
      cwd: root,
      codexBin: '/fixture/codex',
      env,
      recoveryFetch: oldFetch,
      runProcessImpl: fakeProcess as any
    })
    assert.equal(resume.status, 'blocked')
    assert.deepEqual(resume.validation.issues, ['codex_lb_tool_output_recovery_blocked'])

    const agent = await runCodexExecAgent(
      { id: 'recovery-agent', session_id: 'recovery-agent-session', persona_id: 'reviewer' },
      { id: 'recovery-slice', description: 'bounded read-only fixture' },
      {
        missionId: 'M-recovery-all-launches',
        agentRoot: root,
        cwd: root,
        prompt: 'fixture',
        dryRun: false,
        codexBin: '/fixture/codex',
        env,
        recoveryFetch: oldFetch,
        runProcessImpl: fakeProcess
      }
    )
    assert.ok(agent.blockers.includes('codex_lb_tool_output_recovery_version_too_old'), JSON.stringify(agent))

    const previousFakeAdapter = process.env.SKS_ZELLIJ_FAKE_ADAPTER
    const previousFakeRoot = process.env.SKS_ZELLIJ_FAKE_ROOT
    process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
    process.env.SKS_ZELLIJ_FAKE_ROOT = root
    try {
      const zellij = await launchMadZellijUi(['--session', 'sks-recovery-blocked'], {
        root,
        missionId: 'M-zellij-recovery-blocked',
        ledgerRoot: path.join(root, '.sneakoscope', 'missions', 'M-zellij-recovery-blocked', 'agents'),
        codexArgs: ['-c', 'model_provider="codex-lb"'],
        launchEnv: env,
        recoveryFetch: oldFetch
      })
      assert.equal(zellij.ok, false)
      assert.equal(zellij.launch, null)
      assert.equal(zellij.session_reset, null)
      assert.equal(zellij.codex_lb_tool_output_recovery.status, 'version_too_old')
      assert.ok(zellij.blockers.includes('codex_lb_tool_output_recovery_version_too_old'))

      const acknowledgedZellij = await launchMadZellijUi(['--session', 'sks-recovery-acknowledged'], {
        root,
        missionId: 'M-zellij-recovery-acknowledged',
        ledgerRoot: path.join(root, '.sneakoscope', 'missions', 'M-zellij-recovery-acknowledged', 'agents'),
        codexArgs: ['-c', 'model_provider="codex-lb"'],
        launchEnv: env,
        recoveryFetch: oldFetch,
        recoveryAllowUnverified: true
      })
      assert.equal(acknowledgedZellij.codex_lb_tool_output_recovery.status, 'override_acknowledged')
      assert.equal(acknowledgedZellij.launch?.create_background?.ok, true)
    } finally {
      restoreOneEnv('SKS_ZELLIJ_FAKE_ADAPTER', previousFakeAdapter)
      restoreOneEnv('SKS_ZELLIJ_FAKE_ROOT', previousFakeRoot)
    }

    const imageProbe = await runCodex0139ImageReferencedPathRealProbe({
      root,
      codexBin: '/fixture/codex',
      env,
      recoveryFetch: oldFetch,
      runProcessImpl: fakeProcess as any
    })
    assert.ok(imageProbe.blockers.includes('codex_lb_tool_output_recovery_version_too_old'))

    const webProbe = await runCodex0139WebSearchRealProbe({
      root,
      requireReal: true,
      allowNetwork: true,
      codexBin: '/fixture/codex',
      env,
      recoveryFetch: oldFetch,
      runProcessImpl: fakeProcess as any
    })
    assert.ok(webProbe.blockers.includes('codex_lb_tool_output_recovery_version_too_old'))
    assert.equal(qaBinaryResolutions, 0)
    assert.equal(binaryResolutions, 0)
    assert.equal(launches, 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

function taskInput(root: string, backendPreference: Array<'codex-sdk' | 'python-codex-sdk'>) {
  return {
    route: '$Naruto',
    tier: 'worker' as const,
    missionId: 'M-codex-lb-launch-recovery',
    workItemId: 'W-recovery-probe',
    cwd: root,
    prompt: 'Return a bounded fixture result.',
    outputSchemaId: 'sks.fixture-output.v1',
    outputSchema: { type: 'object' },
    sandboxPolicy: 'read-only' as const,
    requestedScopeContract: { read_only: true },
    backendPreference,
    localLlmPolicy: { mode: 'disabled' as const, requiresGptFinal: true },
    mutationLedgerRoot: root
  }
}

function saveEnv(names: string[]) {
  return new Map(names.map((name) => [name, process.env[name]]))
}

function restoreEnv(values: Map<string, string | undefined>) {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function restoreOneEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
