import '../../__tests__/helpers/isolated-test-home.js'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { doctorJsonFastInline } from '../../../bin/fast-inline.js'

const API_KEY = 'sk-fast-inline-fixture-not-real'
const STALE_API_KEY = 'sk-fast-inline-stale-process-fixture'

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-fast-inline-doctor-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  await fsp.mkdir(codexHome, { recursive: true })
  return { home, codexHome, envPath, metadataPath }
}

async function runFastDoctor(input: {
  home: string
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}) {
  let output = ''
  await doctorJsonFastInline({
    home: input.home,
    processEnv: input.processEnv || { HOME: input.home },
    platform: input.platform || 'darwin',
    write: (text) => { output += text }
  })
  return { output, result: JSON.parse(output) }
}

test('production fast Doctor reports a private canonical env-file without spawning probes or overstating prompt safety', async (t) => {
  const setup = await fixture(t)
  const binDir = path.join(setup.home, 'bin')
  const marker = path.join(setup.home, 'subprocess-invoked')
  await fsp.mkdir(binDir)
  for (const name of ['security', 'lsof']) {
    await fsp.writeFile(
      path.join(binDir, name),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o755 }
    )
  }
  await fsp.writeFile(
    setup.envPath,
    `export CODEX_LB_API_KEY='${API_KEY}'\n`,
    { mode: 0o600 }
  )
  await fsp.writeFile(setup.metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: 'https://lb.example.test/backend-api/codex',
    api_key: { redacted: true, sha256: 'a'.repeat(64) }
  })}\n`, { mode: 0o600 })

  const { output, result } = await runFastDoctor({
    home: setup.home,
    processEnv: {
      HOME: setup.home,
      PATH: binDir,
      CODEX_LB_API_KEY: STALE_API_KEY
    }
  })

  assert.equal(result.schema, 'sks.doctor-status.v3')
  assert.equal(result.status, 'fast_readonly_ok')
  assert.deepEqual(result.codex_lb.secret_resolution, {
    source: 'env-file',
    path: setup.envPath,
    prompt_risk: 'unknown_keychain_not_probed'
  })
  assert.doesNotMatch(output, new RegExp(`${API_KEY}|${STALE_API_KEY}`))
  await assert.rejects(fsp.access(marker), { code: 'ENOENT' })
})

test('production fast Doctor reports process and missing sources without a Keychain claim', async (t) => {
  const setup = await fixture(t)
  const fromProcess = await runFastDoctor({
    home: setup.home,
    processEnv: { HOME: setup.home, CODEX_LB_API_KEY: API_KEY }
  })
  assert.deepEqual(fromProcess.result.codex_lb.secret_resolution, {
    source: 'process.env',
    path: null,
    prompt_risk: 'unknown_keychain_not_probed'
  })
  assert.doesNotMatch(fromProcess.output, new RegExp(API_KEY))

  const missing = await runFastDoctor({ home: setup.home })
  assert.deepEqual(missing.result.codex_lb.secret_resolution, {
    source: 'missing',
    path: null,
    prompt_risk: 'unknown_keychain_not_probed'
  })
})

test('production fast Doctor rejects unsafe and symlinked canonical env files', async (t) => {
  const unsafe = await fixture(t)
  await fsp.writeFile(unsafe.envPath, `CODEX_LB_API_KEY='${API_KEY}'\n`, { mode: 0o644 })
  const unsafeResult = await runFastDoctor({ home: unsafe.home })
  assert.deepEqual(unsafeResult.result.codex_lb.secret_resolution, {
    source: 'missing',
    path: unsafe.envPath,
    prompt_risk: 'unknown_keychain_not_probed'
  })

  const linked = await fixture(t)
  const target = path.join(linked.home, 'credential-target')
  await fsp.writeFile(target, `CODEX_LB_API_KEY='${API_KEY}'\n`, { mode: 0o600 })
  await fsp.symlink(target, linked.envPath)
  const linkedResult = await runFastDoctor({ home: linked.home })
  assert.deepEqual(linkedResult.result.codex_lb.secret_resolution, {
    source: 'missing',
    path: linked.envPath,
    prompt_risk: 'unknown_keychain_not_probed'
  })
  assert.doesNotMatch(unsafeResult.output + linkedResult.output, new RegExp(API_KEY))
})

test('production fast Doctor rejects oversized private metadata without reading an unbounded payload', async (t) => {
  const setup = await fixture(t)
  await fsp.writeFile(setup.envPath, `CODEX_LB_API_KEY='${API_KEY}'\n`, { mode: 0o600 })
  await fsp.writeFile(setup.metadataPath, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 })

  const { output, result } = await runFastDoctor({ home: setup.home })

  assert.deepEqual(result.codex_lb.secret_resolution, {
    source: 'missing',
    path: setup.envPath,
    prompt_risk: 'unknown_keychain_not_probed'
  })
  assert.equal(Buffer.byteLength(output), Buffer.byteLength(JSON.stringify(result, null, 2)) + 1)
  assert.doesNotMatch(output, new RegExp(API_KEY))
})
