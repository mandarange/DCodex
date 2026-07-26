#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-fake-zellij-'))
process.env.SKS_ZELLIJ_FAKE_ADAPTER = '1'
process.env.SKS_ZELLIJ_FAKE_ROOT = tmp
process.env.SKS_ZELLIJ_FAKE_VERSION = '0.43.1'
process.env.SKS_ZELLIJ_FAKE_DELAY_MS = '1'

const { runZellij } = await importDist('core/zellij/zellij-command.js')
const version = await runZellij(['--version'], { cwd: tmp })
const attach = await runZellij(['attach', '--create-background', 'fixture'], { cwd: tmp })
const anchor = await runZellij(['--session', 'fixture', 'action', 'new-pane', '--direction', 'right', '--name', 'SLOTS', '--', 'sh', '-lc', 'echo slots'], { cwd: tmp })
const worker = await runZellij(['--session', 'fixture', 'action', 'new-pane', '--stacked', '--name', 'slot-001', '--', 'sh', '-lc', 'echo worker'], { cwd: tmp })
const focus = await runZellij(['--session', 'fixture', 'action', 'focus-pane-id', 'terminal_2'], { cwd: tmp })
const listed = await runZellij(['--session', 'fixture', 'action', 'list-panes', '--json', '--all'], { cwd: tmp })
const screen = await runZellij(['--session', 'fixture', 'action', 'dump-screen'], { cwd: tmp })
process.env.SKS_ZELLIJ_FAKE_VERSION = '0.42.2'
const rejected = await runZellij(['--session', 'fixture-old', 'action', 'new-pane', '--stacked', '--name', 'old', '--', 'sh', '-lc', 'echo old'], { cwd: tmp, optional: true })

const calls = await readJsonl(path.join(tmp, '.sneakoscope', 'fake-zellij-calls.jsonl'))
assertGate(version.ok && version.stdout_tail.includes('0.43.1'), 'fake zellij --version failed', version)
assertGate(attach.ok && anchor.ok && worker.ok && focus.ok && listed.ok && screen.ok, 'fake zellij core commands must pass', { attach, anchor, worker, focus, listed, screen })
assertGate(rejected.ok === false, 'fake zellij <0.43 must reject --stacked', rejected)
assertGate(calls.length >= 8, 'fake zellij calls must be recorded', calls)
assertGate(JSON.parse(listed.stdout_tail).length >= 2, 'fake zellij list-panes must return fake panes', listed)
emitGate('zellij:fake-adapter', { calls: calls.length, root: tmp })

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line))
}
