import '../../__tests__/helpers/isolated-test-home.js'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { doctorJsonFastInline } from '../../../bin/fast-inline.js'

test('fast Doctor reports Desktop Bridge as not checked and never reads ambient provider secrets', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-fast-inline-doctor-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const sentinel = 'sk-fast-inline-sentinel-not-real'
  const credentialPath = path.join(home, '.codex', 'sks-codex-lb.env')
  await fsp.mkdir(path.dirname(credentialPath), { recursive: true })
  await fsp.writeFile(credentialPath, `CODEX_LB_API_KEY='${sentinel}'\n`, { mode: 0o600 })

  let output = ''
  await doctorJsonFastInline({
    home,
    processEnv: { HOME: home, CODEX_LB_API_KEY: sentinel },
    platform: 'darwin',
    write: (text) => { output += text }
  })
  const result = JSON.parse(output)

  assert.equal(result.schema, 'sks.doctor-status.v3')
  assert.deepEqual(result.desktop_bridge, {
    schema: 'sks.desktop-bridge-fast-status.v1',
    status: 'not_checked',
    reason: 'fast_readonly_json',
    secret_stores_read: false
  })
  assert.equal('codex_lb' in result, false)
  assert.doesNotMatch(output, new RegExp(sentinel))
})
