#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'
import { runProcess } from '../core/fsx.js'

const mode = readOption(process.argv.slice(2), '--mode', 'hermetic')
const realMode = mode === 'real-codex'
const requireReal = process.env.SKS_REQUIRE_CODEX_E2E === '1'
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `sks-naruto-${mode}-`))
fs.mkdirSync(path.join(tempRoot, '.sneakoscope'), { recursive: true })
fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"name":"sks-naruto-e2e-fixture","type":"module"}\n')

if (realMode) {
  const codexProbe = await runProcess(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), 'codex', 'version', '--json'], {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024
  })
  assertGate(codexProbe.code === 0 || !requireReal, 'real Codex E2E requires a runnable Codex CLI before publish', {
    code: codexProbe.code,
    stderr_tail: tail(codexProbe.stderr),
    stdout_tail: tail(codexProbe.stdout)
  })
}

const args = [
  path.join(root, 'dist', 'bin', 'sks.js'),
  'naruto',
  'run',
  realMode ? 'real Codex E2E readonly smoke' : 'hermetic Naruto E2E readonly smoke',
  '--json',
  '--readonly',
  '--agents',
  realMode ? '2' : '3',
  '--max-threads',
  realMode ? '2' : '3'
]

const run = await runProcess(process.execPath, args, {
  cwd: tempRoot,
  timeoutMs: realMode ? readPositiveIntEnv('SKS_NARUTO_REAL_E2E_TIMEOUT_MS', 300_000) : 90_000,
  maxOutputBytes: 1024 * 1024,
  env: {
    ...process.env,
    SKS_CODEX_ALLOW_NON_GIT: realMode ? '1' : process.env.SKS_CODEX_ALLOW_NON_GIT || '',
    SKS_DISABLE_NETWORK: realMode ? process.env.SKS_DISABLE_NETWORK || '' : '1',
    SKS_DISABLE_UPDATE_CHECK: '1',
    SKS_NARUTO_STANDALONE_CLI: realMode ? '1' : '0',
    SKS_NARUTO_APP_SESSION: realMode ? '0' : '1',
    CODEX_THREAD_ID: realMode ? process.env.CODEX_THREAD_ID || '' : `naruto-e2e-${path.basename(tempRoot)}`
  }
})

const parsed = parseJsonObjectFromStdout(run.stdout)

const ok = realMode
  ? run.code === 0 && parsed?.ok === true && parsed?.route === '$sks-naruto' && parsed?.status === 'completed'
  : run.code === 0
    && parsed?.ok === false
    && parsed?.route === '$sks-naruto'
    && parsed?.status === 'delegation_context_ready'
    && parsed?.app_session === true
assertGate(ok || (realMode && !requireReal), `${mode} Naruto E2E failed`, {
  code: run.code,
  parsed,
  stdout_tail: tail(run.stdout),
  stderr_tail: tail(run.stderr),
  tempRoot
})

emitGate(realMode ? 'naruto:e2e-real-codex' : 'naruto:e2e-hermetic', {
  mode,
  temp_root: tempRoot,
  mission_id: parsed?.mission_id || null,
  readonly: true,
  preparation_only: !realMode,
  real_required: requireReal
})

function readOption(args, name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function readPositiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function tail(value, limit = 4000) {
  const text = String(value || '')
  return text.length > limit ? text.slice(-limit) : text
}

function parseJsonObjectFromStdout(stdout) {
  const text = String(stdout || '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1))
    } catch {}
  }
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
  }
  return null
}
