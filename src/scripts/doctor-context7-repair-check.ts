#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureDistFresh, root as repoRoot } from './lib/ensure-dist-fresh.js'
import { assertGate, emitGate } from './gate-lib.js'
import { writeTextAtomic } from '../core/fsx.js'

const freshness = ensureDistFresh({ rebuild: true })
assertGate(freshness.ok, 'dist must be fresh for doctor context7 repair check', freshness)

const mod = await import(pathToFileURL(path.join(repoRoot, 'dist', 'core', 'doctor', 'doctor-context7-repair.js')).href)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context7-doctor-'))
const codexHome = path.join(tmp, 'codex-home')
await fs.mkdir(path.join(tmp, '.codex'), { recursive: true })
await fs.mkdir(codexHome, { recursive: true })

const localBlock = [
  '# SKS managed fixture',
  'model = "gpt-5.6-terra"',
  '',
  '[mcp_servers.context7]',
  'command = "npx"',
  'args = ["-y", "@upstash/context7-mcp@latest"]',
  '',
  '[features]',
  'hooks = true',
  '',
  '[mcp_servers.context7.env]',
  'CONTEXT7_API_KEY = "fixture"',
  ''
].join('\n')
await writeTextAtomic(path.join(tmp, '.codex', 'config.toml'), localBlock)
await writeTextAtomic(path.join(codexHome, 'config.toml'), localBlock)

const planned = await mod.runDoctorContext7Repair({ root: tmp, codexHome, fix: false })
assertGate(planned.configs.every((entry) => entry.status === 'local_stdio_detected'), 'dry inspect must detect local stdio context7', planned)

const repaired = await mod.runDoctorContext7Repair({ root: tmp, codexHome, fix: true })
const projectText = await fs.readFile(path.join(tmp, '.codex', 'config.toml'), 'utf8')
const globalText = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')

for (const text of [projectText, globalText]) {
  assertGate(text.includes('url = "https://mcp.context7.com/mcp"'), 'context7 must migrate to remote MCP URL', text)
  assertGate(!text.includes('@upstash/context7-mcp'), 'local stdio context7 package must be removed', text)
  assertGate(!text.includes('[mcp_servers.context7.env]'), 'nested local context7 env table must be removed with the stdio block', text)
  assertGate(text.includes('[features]') && text.includes('hooks = true'), 'unrelated config tables must be preserved', text)
}

assertGate(repaired.ok === true, 'context7 doctor repair must pass', repaired)
assertGate(repaired.configs.every((entry) => entry.changed === true && entry.backup_path), 'context7 repair must back up changed configs', repaired)
emitGate('doctor:context7-repair', { configs: repaired.configs.length, actions: repaired.actions })
