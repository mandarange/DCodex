// First import: the CLI migration gate and selftest helpers can resolve the
// default home; isolate it before spawning the CLI.
import './helpers/isolated-test-home.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('mock selftest removes its temporary mission root before returning', () => {
  const cli = path.resolve(process.cwd(), 'dist/bin/sks.js')
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-selftest-project-'))
  try {
    const result = spawnSync(process.execPath, [cli, 'selftest', '--mock', '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      maxBuffer: 4 * 1024 * 1024
    })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, true)
    assert.equal(report.tmp_cleaned, true)
    assert.equal(fs.existsSync(report.tmp_root), false)
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})
