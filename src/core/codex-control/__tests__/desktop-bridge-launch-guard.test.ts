import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCodexExec } from '../../codex-adapter.js'
import { attemptCodexAppLaunch } from '../../codex-app/codex-app-launcher.js'
import { restartCodexApp } from '../../codex-app/codex-app-restart.js'
import { runCodexExecResumeWithOutputSchema } from '../../codex-exec-output-schema.js'
import {
  DESKTOP_BRIDGE_DIRECT_PROVIDER_SELECTION_RETIRED,
  effectiveCodexWorkingRoot,
  inspectDesktopBridgeCliLaunchGuard,
  inspectDesktopBridgeSdkLaunchGuard,
  stripRetiredDirectProviderEnv,
  withDesktopBridgeCliLaunchGuard
} from '../desktop-bridge-launch-guard.js'

async function fixture(t: test.TestContext, config = '') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-bridge-launch-guard-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(path.join(codexHome, 'config.toml'), config)
  return { root, home, codexHome }
}

test('ordinary OpenAI/OAuth launch is allowed and ambient CODEX_LB_* is stripped', async (t) => {
  const setup = await fixture(t, 'model_provider = "openai"\n')
  const launchedEnvs: NodeJS.ProcessEnv[] = []
  const guarded = await withDesktopBridgeCliLaunchGuard({
    root: setup.root,
    env: {
      HOME: setup.home,
      CODEX_HOME: setup.codexHome,
      CODEX_LB_API_KEY: 'never-forward-this',
      CODEX_LB_BASE_URL: 'https://retired.example.test/backend-api/codex',
      CODEX_LB_CUSTOM_AMBIENT: 'also-strip-this',
      OPENAI_API_KEY: 'ordinary-openai-value'
    }
  }, async (env) => {
    launchedEnvs.push(env)
    return 'launched'
  })
  assert.equal(guarded.launched, true)
  assert.equal(guarded.desktopBridgeLaunchGuard.status, 'allowed')
  assert.equal(guarded.value, 'launched')
  assert.equal(launchedEnvs[0]?.CODEX_LB_API_KEY, undefined)
  assert.equal(launchedEnvs[0]?.CODEX_LB_BASE_URL, undefined)
  assert.equal(launchedEnvs[0]?.CODEX_LB_CUSTOM_AMBIENT, undefined)
  assert.equal(launchedEnvs[0]?.OPENAI_API_KEY, 'ordinary-openai-value')
})

test('historical codex-lb and openrouter selection blocks before launch with Bridge guidance', async (t) => {
  for (const provider of ['codex-lb', 'openrouter']) {
    const setup = await fixture(t, `model_provider = "${provider}"\n`)
    let launches = 0
    const guarded = await withDesktopBridgeCliLaunchGuard({
      root: setup.root,
      env: { HOME: setup.home, CODEX_HOME: setup.codexHome },
      cliArgs: ['--config=model_provider="openai"']
    }, async () => {
      launches += 1
      return null
    })
    assert.equal(guarded.launched, false, provider)
    assert.equal(launches, 0, provider)
    assert.equal(guarded.desktopBridgeLaunchGuard.status, 'direct_provider_selection_retired')
    assert.deepEqual(guarded.desktopBridgeLaunchGuard.blockers, [DESKTOP_BRIDGE_DIRECT_PROVIDER_SELECTION_RETIRED])
    assert.ok(guarded.desktopBridgeLaunchGuard.operator_actions.some((action) => action.includes('sks bridge ensure --json')))
  }
})

test('SDK guard ignores ambient credentials but rejects explicit retired config selection', () => {
  const ambientOnly = inspectDesktopBridgeSdkLaunchGuard({
    config: { model_provider: 'openai' },
    env: { CODEX_LB_API_KEY: 'ambient', CODEX_LB_BASE_URL: 'https://retired.example.test' }
  })
  assert.equal(ambientOnly.ok, true)
  assert.equal(ambientOnly.status, 'allowed')
  for (const provider of ['codex-lb', 'openrouter']) {
    const blocked = inspectDesktopBridgeSdkLaunchGuard({ config: { model_provider: provider } })
    assert.equal(blocked.ok, false)
    assert.deepEqual(blocked.blockers, [DESKTOP_BRIDGE_DIRECT_PROVIDER_SELECTION_RETIRED])
  }
})

test('runCodexExec fails closed before binary resolution and spawn', async (t) => {
  const setup = await fixture(t, 'model_provider = "codex-lb"\n')
  let binaryResolutions = 0
  let launches = 0
  const result = await runCodexExec({
    root: setup.root,
    prompt: 'fixture',
    env: { HOME: setup.home, CODEX_HOME: setup.codexHome, CODEX_LB_API_KEY: 'secret' },
    prepareCodexRuntimeEnvImpl: async ({ env }: any) => env,
    findCodexBinaryImpl: async () => {
      binaryResolutions += 1
      return '/fixture/codex'
    },
    runProcessImpl: async () => {
      launches += 1
      throw new Error('must not spawn')
    }
  }) as any
  assert.equal(result.code, 78)
  assert.equal(binaryResolutions, 0)
  assert.equal(launches, 0)
  assert.deepEqual(result.desktop_bridge_launch_guard.blockers, [DESKTOP_BRIDGE_DIRECT_PROVIDER_SELECTION_RETIRED])
  assert.match(result.stderr, /sks bridge ensure --json/)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
})

test('app launch, app restart, and resume wrappers block before spawn', async (t) => {
  const setup = await fixture(t, 'model_provider = "openrouter"\n')
  const env = { HOME: setup.home, CODEX_HOME: setup.codexHome }
  let launches = 0
  const runProcessImpl: any = async () => {
    launches += 1
    return { code: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false }
  }

  const appLaunch = await attemptCodexAppLaunch({
    cwd: setup.root,
    promptArtifactPath: path.join(setup.root, 'prompt.txt'),
    mode: 'attempt-launch',
    platform: 'darwin',
    env,
    runProcessImpl,
    findCodexBinaryImpl: async () => '/fixture/codex'
  })
  assert.equal(appLaunch.attempted, false)
  assert.equal(appLaunch.fallback_reason, 'desktop_bridge_launch_guard_blocked')

  const restart = await restartCodexApp({
    root: setup.root,
    platform: 'darwin',
    osascriptPath: '/fixture/osascript',
    openPath: '/fixture/open',
    env,
    runProcessImpl
  })
  assert.equal(restart.status, 'desktop_bridge_launch_guard_blocked')

  const resume = await runCodexExecResumeWithOutputSchema({
    sessionId: '01900000-0000-7000-8000-000000000001',
    outputSchemaPath: path.join(setup.root, 'unused-schema.json')
  }, {
    cwd: setup.root,
    env,
    prepareCodexRuntimeEnvImpl: async ({ env: sourceEnv }: any) => sourceEnv,
    runProcessImpl
  })
  assert.equal(resume.status, 'blocked')
  assert.deepEqual(resume.validation.issues, ['desktop_bridge_launch_guard_blocked'])
  assert.equal(launches, 0)
})

test('effective working root follows the final -C and rejects missing values', () => {
  const root = path.resolve('/tmp/desktop-bridge-launch-root')
  const final = path.join(root, 'final')
  assert.deepEqual(effectiveCodexWorkingRoot(root, ['exec', '--cd', 'first', '-C', final]), {
    ok: true,
    root: final,
    blockers: []
  })
  const malformed = effectiveCodexWorkingRoot(root, ['exec', '--cd'])
  assert.equal(malformed.ok, false)
  assert.deepEqual(malformed.blockers, ['desktop_bridge_launch_working_root_value_missing'])
})

test('environment sanitizer is pure', () => {
  const source = { CODEX_LB_API_KEY: 'secret', HOME: '/tmp/home' }
  const sanitized = stripRetiredDirectProviderEnv(source)
  assert.deepEqual(source, { CODEX_LB_API_KEY: 'secret', HOME: '/tmp/home' })
  assert.deepEqual(sanitized, { HOME: '/tmp/home' })
})
