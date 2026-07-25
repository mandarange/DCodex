#!/usr/bin/env node
// @ts-nocheck
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'
import { tmpdir, writeTextAtomic } from '../core/fsx.js'
import { checkZellijCapability } from '../core/zellij/zellij-capability.js'
import { runZellij } from '../core/zellij/zellij-command.js'

const requireReal = process.argv.includes('--require-real') || process.env.SKS_REQUIRE_ZELLIJ === '1'
const visiblePaneCap = Number(process.env.SKS_ZELLIJ_GEOMETRY_VISIBLE_CAP || 8)

const report = requireReal ? await realGeometryProof() : syntheticGeometryProof()
assertGate(report.ok, 'right-column geometry proof failed', report)
emitGate('zellij:right-column-geometry-proof', report)

function syntheticGeometryProof() {
  const panes = [
    { pane_id: 'main', role: 'main', geometry: { x: 0, y: 0, width: 120, height: 60 }, name: 'orchestrator' },
    { pane_id: 'w1', role: 'worker', geometry: { x: 121, y: 0, width: 80, height: 15 }, name: 'slot-001' },
    { pane_id: 'w2', role: 'worker', geometry: { x: 121, y: 16, width: 80, height: 15 }, name: 'slot-002' }
  ]
  return buildReport({ synthetic: true, panes, commands: [], listPanes: null, dumpScreen: null, blockers: [] })
}

async function realGeometryProof() {
  const root = process.cwd()
  const capability = await checkZellijCapability({ root, require: true, writeReport: false })
  const sessionName = `sks-geom-${process.pid}-${Date.now()}`
  const tmpDir = await fsTempDir()
  const layoutPath = path.join(tmpDir, 'layout.kdl')
  const commands: any[] = []
  let listPanes: any = null
  let dumpScreen: any = null
    const blockers = [...(capability.blockers || [])]
    try {
      await writeTextAtomic(layoutPath, buildRealGeometryLayout(root))
      await runZellij(['kill-session', sessionName], { cwd: root, timeoutMs: 2500, optional: true })
      const launch = await runZellij(['attach', '--create-background', sessionName, 'options', '--default-layout', layoutPath], { cwd: root, timeoutMs: 5000, optional: false })
    commands.push(launch)
    if (!launch.ok) blockers.push(...launch.blockers.map((blocker) => `zellij_geometry_launch_${blocker}`))
    await sleep(1000)
    listPanes = await runZellij(['--session', sessionName, 'action', 'list-panes', '--json', '--all'], { cwd: root, timeoutMs: 5000, optional: false })
    commands.push(listPanes)
    if (!listPanes.ok) blockers.push(...listPanes.blockers.map((blocker) => `zellij_geometry_list_panes_${blocker}`))
    dumpScreen = await runZellij(['--session', sessionName, 'action', 'dump-screen'], { cwd: root, timeoutMs: 5000, optional: false })
    commands.push(dumpScreen)
    if (!dumpScreen.ok) blockers.push(...dumpScreen.blockers.map((blocker) => `zellij_geometry_dump_screen_${blocker}`))
    const panes = parseRealPanes(listPanes.stdout_tail)
    return buildReport({ synthetic: false, panes, commands, listPanes, dumpScreen, blockers })
  } finally {
    commands.push(await runZellij(['kill-session', sessionName], { cwd: root, timeoutMs: 5000, optional: true }).catch((err) => ({
      ok: false,
      command: 'zellij',
      args: ['kill-session', sessionName],
      blockers: [`zellij_geometry_cleanup_exception:${err?.message || String(err)}`],
      warnings: []
    })))
  }
}

function buildReport(input: { synthetic: boolean; panes: any[]; commands: any[]; listPanes: any; dumpScreen: any; blockers: string[] }) {
  const main = input.panes.find((pane) => pane.role === 'main') || null
  const workers = input.panes.filter((pane) => pane.role === 'worker')
  const sameRightX = workers.length > 0 && workers.every((pane) => Math.abs(Number(pane.geometry.x) - Number(workers[0].geometry.x)) <= 2)
  const rightOfMain = Boolean(main) && workers.length > 0 && workers.every((pane) => Number(pane.geometry.x) >= Number(main.geometry.x) + Number(main.geometry.width) - 2)
  const increasingY = workers.every((pane, index) => index === 0 || Number(pane.geometry.y) > Number(workers[index - 1].geometry.y))
  const capOk = workers.length <= visiblePaneCap
  const realEvidenceOk = input.synthetic || (input.listPanes?.ok === true && input.dumpScreen?.ok === true && workers.length >= 2)
  const blockers = [
    ...input.blockers,
    ...(main ? [] : ['zellij_geometry_main_missing']),
    ...(workers.length >= 2 ? [] : ['zellij_geometry_workers_missing']),
    ...(sameRightX ? [] : ['zellij_geometry_worker_x_mismatch']),
    ...(rightOfMain ? [] : ['zellij_geometry_workers_not_right_of_main']),
    ...(increasingY ? [] : ['zellij_geometry_workers_not_stacked_down']),
    ...(capOk ? [] : ['zellij_geometry_visible_cap_exceeded']),
    ...(realEvidenceOk ? [] : ['zellij_geometry_real_evidence_missing'])
  ]
  return {
    schema: 'sks.zellij-right-column-geometry-proof.v1',
    ok: blockers.length === 0,
    gate: 'zellij:right-column-geometry-proof',
    synthetic: input.synthetic,
    same_right_x: sameRightX,
    right_of_main: rightOfMain,
    increasing_y: increasingY,
    visible_cap_ok: capOk,
    real_list_panes_json_observed: input.synthetic ? false : input.listPanes?.ok === true,
    real_dump_screen_observed: input.synthetic ? false : input.dumpScreen?.ok === true,
    panes: input.panes,
    command_count: input.commands.length,
    command_blockers: input.commands.flatMap((row) => row?.blockers || []),
    blockers
  }
}

function parseRealPanes(text: string) {
  let rows: any[] = []
  try {
    const parsed = JSON.parse(String(text || '[]'))
    rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.panes) ? parsed.panes : []
  } catch {
    rows = []
  }
  return rows
    .filter((row) => row && row.is_plugin !== true && row.exited !== true)
    .map((row) => {
      const title = String(row.title || row.name || row.pane_name || '')
      return {
        pane_id: String(row.pane_id ?? row.paneId ?? row.id ?? title),
        role: /^slot-\d+/i.test(title) ? 'worker' : title === 'orchestrator' ? 'main' : 'unknown',
        geometry: {
          x: Number(row.pane_x ?? row.x ?? 0),
          y: Number(row.pane_y ?? row.y ?? 0),
          width: Number(row.pane_columns ?? row.width ?? 0),
          height: Number(row.pane_rows ?? row.height ?? 0)
        },
        name: title,
        pane_command: row.pane_command || row.terminal_command || null
      }
    })
    .filter((row) => row.role === 'main' || row.role === 'worker')
    .sort((a, b) => a.role === b.role ? a.geometry.y - b.geometry.y : a.role === 'main' ? -1 : 1)
}

function buildRealGeometryLayout(cwd: string) {
  const hold = 'sleep 30'
  return [
    'layout {',
    '    default_tab_template {',
    '        pane size=1 borderless=true {',
    '            plugin location="zellij:tab-bar"',
    '        }',
    '        children',
    '        pane size=2 borderless=true {',
    '            plugin location="zellij:status-bar"',
    '        }',
    '    }',
    `    tab name="SKS geometry proof" cwd=${JSON.stringify(cwd)} split_direction="vertical" {`,
    '        pane name="orchestrator" command="sh" {',
    `            args "-lc" ${JSON.stringify(hold)}`,
    '        }',
    '        pane name="slot-column" split_direction="horizontal" {',
    '            pane name="slot-001" command="sh" {',
    `                args "-lc" ${JSON.stringify(hold)}`,
    '            }',
    '            pane name="slot-002" command="sh" {',
    `                args "-lc" ${JSON.stringify(hold)}`,
    '            }',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n')
}

async function fsTempDir() {
  return tmpdir('sks-zellij-geometry-')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
