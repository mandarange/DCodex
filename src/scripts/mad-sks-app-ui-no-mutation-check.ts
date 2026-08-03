#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { madHighCommand } from '../core/commands/mad-sks-command.js'
import { sha256 } from '../core/fsx.js'

const original = {
  cwd: process.cwd(),
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  skipNpm: process.env.SKS_SKIP_NPM_FRESHNESS_CHECK,
  exitCode: process.exitCode
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-mad-ui-no-mutation-'))
const home = path.join(tmp, 'home')
const codexHome = path.join(home, '.codex')
const configPath = path.join(codexHome, 'config.toml')
let report: Record<string, any>

try {
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(path.join(tmp, '.sneakoscope'), { recursive: true })
  await fs.writeFile(configPath, [
    'service_tier = "fast"',
    '[features]',
    'fast_mode = true',
    '[plugins."chrome@openai-bundled"]',
    'enabled = false',
    ''
  ].join('\n'))
  const before = await fs.readFile(configPath, 'utf8')

  process.chdir(tmp)
  process.env.HOME = home
  process.env.CODEX_HOME = codexHome
  process.env.SKS_SKIP_NPM_FRESHNESS_CHECK = '1'
  process.exitCode = 0

  const launch: any = await madHighCommand(['--dry-run'])
  const after = await fs.readFile(configPath, 'utf8')
  const entries = await fs.readdir(codexHome)

  assert.equal(launch?.ok, true)
  assert.equal(launch?.execution_surface, 'base-codex-cli')
  assert.equal(after, before)
  assert.equal(entries.some((entry) => entry === 'sks-mad-high.config.toml'), false)
  assert.equal(/\[profiles\.sks-mad-high\]/.test(after), false)
  assert.equal(/enabled\s*=\s*false/.test(after), true)

  report = {
    schema: 'sks.mad-sks-app-ui-no-mutation-check.v2',
    ok: true,
    before_hash: sha256(before),
    after_hash: sha256(after),
    profile_files_written: entries.filter((entry) => /sks-mad-high/.test(entry)),
    plugin_disabled_preserved: true,
    execution_surface: launch.execution_surface,
    blockers: []
  }
} catch (err: any) {
  report = {
    schema: 'sks.mad-sks-app-ui-no-mutation-check.v2',
    ok: false,
    error: err?.message || String(err),
    blockers: ['mad_sks_app_ui_no_mutation_failed']
  }
} finally {
  process.chdir(original.cwd)
  restoreEnv('HOME', original.home)
  restoreEnv('CODEX_HOME', original.codexHome)
  restoreEnv('SKS_SKIP_NPM_FRESHNESS_CHECK', original.skipNpm)
  process.exitCode = original.exitCode
  await fs.rm(tmp, { recursive: true, force: true })
}

console.log(JSON.stringify(report!, null, 2))
if (!report!.ok) process.exitCode = 1

function restoreEnv(key: string, value: string | undefined) {
  if (value == null) delete process.env[key]
  else process.env[key] = value
}
