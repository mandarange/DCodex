// First import: `sks selftest` runs the install/repair battery (fast-mode
// config install, managed role configs) against the default home; isolate it.
import './helpers/isolated-test-home.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('mock selftest removes its temporary mission root before returning', () => {
  const result = spawnSync(process.execPath, [path.resolve(process.cwd(), 'dist/bin/sks.js'), 'selftest', '--mock', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    maxBuffer: 4 * 1024 * 1024
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.tmp_cleaned, true)
  assert.equal(fs.existsSync(report.tmp_root), false)
})
