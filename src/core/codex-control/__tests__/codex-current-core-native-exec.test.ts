import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RunProcessOptions, RunProcessResult } from '../../fsx.js'
import { runCodexCurrentCoreImageReferencedPathRealProbe } from '../codex-current-image-path-real-probe.js'
import { runCodexCurrentCoreWebSearchRealProbe } from '../codex-current-web-search-probe.js'
import {
  CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS,
  nativeCodexCurrentCoreProbeEnv,
  withNativeCodexCurrentCoreExecArgs
} from '../codex-current-core-native-exec.js'

function okProcess(stdout: string): RunProcessResult {
  return {
    code: 0,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    truncated: false,
    timedOut: false
  }
}

async function isolatedProbeRoot(t: test.TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-core-native-probe-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(
    path.join(codexHome, 'config.toml'),
    [
      'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:53451/__sks/client/dead/backend-api/codex"',
      ''
    ].join('\n')
  )
  return { root, home, codexHome }
}

test('native current-core exec pins official OpenAI and strips loopback base-url env', () => {
  const extra = withNativeCodexCurrentCoreExecArgs(['--image', '/tmp/input-b.png'])
  assert.deepEqual([...CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS], extra.slice(0, CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS.length))
  assert.ok(extra.includes('--ignore-user-config'))
  assert.ok(extra.includes('model_provider="openai"'))
  assert.ok(extra.includes('--image'))
  const env = nativeCodexCurrentCoreProbeEnv({
    PATH: '/usr/bin',
    OPENAI_BASE_URL: 'http://127.0.0.1:53451/backend-api/codex',
    CHATGPT_BASE_URL: 'http://127.0.0.1:53451/backend-api/codex',
    OPENAI_API_KEY: 'keep-this'
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.OPENAI_API_KEY, 'keep-this')
  assert.equal(env.OPENAI_BASE_URL, undefined)
  assert.equal(env.CHATGPT_BASE_URL, undefined)
})

test('web-search and image-path probes ignore host config and do not forward loopback base URLs', async (t) => {
  const setup = await isolatedProbeRoot(t)
  const captured: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const runProcessImpl = async (_bin: string, args: readonly string[], opts: RunProcessOptions = {}) => {
    captured.push({ args: [...args], env: opts.env || {} })
    const imagePath = args.find((arg) => String(arg).endsWith('input-b.png'))
    const stdout = imagePath
      ? `{"referenced_path":"${imagePath}","saw_image":true}`
      : '{"used_web_search":true,"answer":"Example Domain","sources":["https://example.com"]}'
    return okProcess(stdout)
  }
  const env = {
    HOME: setup.home,
    CODEX_HOME: setup.codexHome,
    PATH: process.env.PATH,
    OPENAI_BASE_URL: 'http://127.0.0.1:53451/__sks/client/dead/backend-api/codex'
  }
  const web = await runCodexCurrentCoreWebSearchRealProbe({
    root: setup.root,
    allowNetwork: true,
    codexBin: process.execPath,
    env,
    runProcessImpl
  })
  const image = await runCodexCurrentCoreImageReferencedPathRealProbe({
    root: setup.root,
    codexBin: process.execPath,
    env,
    runProcessImpl
  })
  assert.equal(web.ok, true, String(web.blockers))
  assert.equal(image.ok, true, String(image.blockers))
  assert.equal(captured.length, 2)
  for (const row of captured) {
    assert.ok(row.args.includes('--ignore-user-config'), String(row.args))
    assert.ok(row.args.includes('model_provider="openai"'), String(row.args))
    assert.equal(row.env.OPENAI_BASE_URL, undefined)
    assert.ok(!row.args.some((arg) => String(arg).includes('127.0.0.1:53451')))
  }
})
