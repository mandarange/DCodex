// First import: this suite spawns the real sks/codex binaries, which write
// $HOME/.codex/tmp lock files when the default home leaks through.
import '../../__tests__/helpers/isolated-test-home.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

test('doctor JSON fast path writes an exact report file when requested', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-doctor-fast-report-'))
  try {
    const reportFile = path.join(temp, 'nested', 'doctor.json')
    const result = spawnSync(process.execPath, ['dist/bin/sks.js', 'doctor', '--json', '--report-file', reportFile], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(fs.statSync(reportFile).isFile(), true)
    const stdoutReport = JSON.parse(result.stdout || '{}')
    const fileReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    assert.deepEqual(fileReport, stdoutReport)
    assert.equal(fileReport.no_fix_write_policy, 'report_file_only')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
