#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
import { writeTextAtomic } from '../core/fsx.js'
process.env.SKS_CODEX_0138_FAKE = '1'
const mod = await importDist('core/doctor/codex-0138-doctor.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-0138-doctor-'))
await writeTextAtomic(path.join(root, 'AGENTS.md'), '# fixture\n')
const report = await mod.runCodex0138Doctor(root, { fix: true })
assertGate(report.schema === 'sks.codex-0138-doctor.v1' && report.ok === true && report.checks.oauth_mcp_prerefresh.supported === true, 'Codex 0.138 doctor must check startup resilience and OAuth MCP pre-refresh support', report)
emitGate('codex:0138-doctor', { fixed: report.fixed })
