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
  // No bridge state file under this home: nothing is serving, so there is no
  // log evidence to read — and still no secret store is opened.
  assert.deepEqual(result.desktop_bridge, {
    schema: 'sks.desktop-bridge-fast-status.v1',
    status: 'not_checked',
    reason: 'bridge_state_missing',
    secret_stores_read: false
  })
  assert.equal('codex_lb' in result, false)
  assert.doesNotMatch(output, new RegExp(sentinel))
})

function rejectionLine(at: string, code: string): string {
  return JSON.stringify({
    schema: 'sks.desktop-bridge-log.v2', sks_version: '9.2.7', at, secret_fields_redacted: true,
    event: 'sks.desktop_bridge.rejected', code, transport: 'http', method: 'POST', pathname: '/backend-api/codex/responses'
  })
}

test('fast Doctor surfaces the serving bridge\'s own unreachable-upstream evidence without breaking the fast contract', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-fast-inline-doctor-evidence-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const runtime = path.join(home, '.codex', 'sks')
  await fsp.mkdir(path.join(runtime, 'logs'), { recursive: true })
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString()
  await fsp.writeFile(path.join(runtime, 'desktop-bridge-state.json'), JSON.stringify({ pid: 4242, started_at: startedAt }), { mode: 0o600 })
  const logPath = path.join(runtime, 'logs', 'desktop-bridge.out.log')
  const recent = new Date(Date.now() - 60_000).toISOString()

  // Clear log: the section says so, and neither warnings nor next actions grow.
  await fsp.writeFile(logPath, `${rejectionLine(recent, 'bridge_client_capability_required')}\n`)
  let output = ''
  await doctorJsonFastInline({ home, processEnv: { HOME: home }, platform: 'darwin', write: (text) => { output += text } })
  let result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'fast_readonly_ok')
  assert.equal(result.desktop_bridge.status, 'log_evidence_clear')
  assert.equal(result.desktop_bridge.serving_pid, 4242)
  assert.deepEqual(result.desktop_bridge.blockers, [])
  assert.equal(result.warnings.some((w: string) => w.startsWith('desktop_bridge_upstream_unreachable')), false)

  // A dead pin: the evidence is named, the fast contract (ok/status) holds.
  await fsp.appendFile(logPath, `${rejectionLine(recent, 'bridge_upstream_unavailable:EHOSTUNREACH')}\n`)
  output = ''
  await doctorJsonFastInline({ home, processEnv: { HOME: home }, platform: 'darwin', write: (text) => { output += text } })
  result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'fast_readonly_ok')
  assert.equal(result.desktop_bridge.status, 'upstream_unreachable_evidence')
  assert.deepEqual(result.desktop_bridge.blockers, ['desktop_bridge_upstream_unreachable:bridge_upstream_unavailable:EHOSTUNREACH'])
  assert.equal(result.desktop_bridge.recovery_actions.length, 1)
  assert.ok(result.warnings.includes('desktop_bridge_upstream_unreachable:bridge_upstream_unavailable:EHOSTUNREACH'))
  assert.ok(result.next_actions.some((a: string) => a.includes('sks doctor --fix')))
  assert.equal(result.desktop_bridge.secret_stores_read, false)
})
