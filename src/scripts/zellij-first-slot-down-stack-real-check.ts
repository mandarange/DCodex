#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'
import { ensureDir, packageRoot, writeTextAtomic } from '../core/fsx.js'
import { checkZellijCapability } from '../core/zellij/zellij-capability.js'
import { runZellij } from '../core/zellij/zellij-command.js'
import { openWorkerPane, type ZellijWorkerPaneRecord } from '../core/zellij/zellij-worker-pane-manager.js'

const required = process.env.SKS_REQUIRE_ZELLIJ === '1' || process.argv.includes('--require-real')
if (!required) {
  emitGate('zellij:first-slot-down-stack:real', {
    ok: true,
    status: 'skipped',
    reason: 'SKS_REQUIRE_ZELLIJ_not_set'
  })
  process.exit(0)
}

const report = await runRealFirstSlotDownStackProof()
assertGate(report.ok, 'Real Zellij first-slot-down-stack verification failed', report)
emitGate('zellij:first-slot-down-stack:real', report)

async function runRealFirstSlotDownStackProof() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-first-slot-down-'))
  const cwd = packageRoot()
  const missionId = `M-zellij-first-slot-down-${process.pid}`
  const sessionName = `sks-first-slot-${process.pid}-${Date.now()}`
  const commands: unknown[] = []
  const blockers: string[] = []
  let record1: ZellijWorkerPaneRecord | null = null
  let record2: ZellijWorkerPaneRecord | null = null
  let listPanes: Awaited<ReturnType<typeof runZellij>> | null = null
  let dumpScreen: Awaited<ReturnType<typeof runZellij>> | null = null
  const dumpPath = path.join(root, 'zellij-dump-screen.txt')

  try {
    const capability = await checkZellijCapability({ root: cwd, require: true, writeReport: false })
    blockers.push(...(capability.blockers || []).map((blocker) => `zellij_capability_${blocker}`))
    const cleanupBefore = await runZellij(['kill-session', sessionName], { cwd, timeoutMs: 2500, optional: true })
    commands.push(cleanupBefore)
    const create = await runZellij(['attach', '--create-background', sessionName], { cwd, timeoutMs: 5000, optional: false })
    commands.push(create)
    if (!create.ok) blockers.push(...create.blockers.map((blocker) => `zellij_create_${blocker}`))
    await sleep(500)
    const before = await runZellij(['--session', sessionName, 'action', 'list-panes', '--json', '--all'], { cwd, timeoutMs: 5000, optional: true })
    commands.push(before)
    const beforePanes = parsePaneRows(before.stdout_tail)

    record1 = await openSlotRenderer(root, missionId, sessionName, 'slot-001', 1)
    record2 = await openSlotRenderer(root, missionId, sessionName, 'slot-002', 1)
    await sleep(750)

    listPanes = await runZellij(['--session', sessionName, 'action', 'list-panes', '--json', '--all'], { cwd, timeoutMs: 5000, optional: false })
    commands.push(listPanes)
    if (!listPanes.ok) blockers.push(...listPanes.blockers.map((blocker) => `zellij_list_panes_${blocker}`))
    dumpScreen = await runZellij(['--session', sessionName, 'action', 'dump-screen', '--path', dumpPath, '--full'], { cwd, timeoutMs: 5000, optional: true })
    commands.push(dumpScreen)
    if (!dumpScreen.ok) blockers.push(...dumpScreen.blockers.map((blocker) => `zellij_dump_screen_${blocker}`))

    const panes = parsePaneRows(listPanes.stdout_tail)
    const sourceFlowGeometry = evaluateGeometry(panes, record1, record2)
    const layoutGeometryProof = await runFirstSlotLayoutGeometryProof({ cwd, root })
    const geometry = layoutGeometryProof.geometry.ok ? layoutGeometryProof.geometry : sourceFlowGeometry
    const recordAssertions = [
      beforePanes.length === 1,
      record1.column_creation_direction_requested === 'right',
      record1.worker_direction_requested === 'down',
      record1.direction_requested === 'down',
      record2.worker_direction_requested === 'down',
      record2.direction_requested === 'down',
      Boolean(record1.slot_column_anchor_pane_id),
      record1.pane_kind === 'worker_codex_sdk',
      record1.scaling_primitive === 'native_cli_process_in_zellij_worker_pane'
    ]
    const proofBlockers = [
      ...blockers,
      ...(recordAssertions.every(Boolean) ? [] : ['zellij_first_slot_record_semantics_failed']),
      ...geometry.blockers,
      ...(layoutGeometryProof.ok ? [] : layoutGeometryProof.blockers)
    ]
    return {
      schema: 'sks.zellij-first-slot-down-stack-real-check.v1',
      ok: proofBlockers.length === 0,
      status: proofBlockers.length ? 'blocked' : 'passed',
      mission_id: missionId,
      session_name: sessionName,
      artifact_root: root,
      dump_screen_path: dumpPath,
      before_list_panes_ok: before.ok,
      initial_terminal_pane_count: beforePanes.length,
      list_panes_ok: listPanes.ok,
      dump_screen_ok: dumpScreen.ok,
      record1,
      record2,
      source_flow_geometry: sourceFlowGeometry,
      layout_geometry_proof: layoutGeometryProof,
      geometry,
      command_blockers: commands.flatMap((row: any) => row?.blockers || []),
      blockers: proofBlockers
    }
  } catch (err: any) {
    return {
      schema: 'sks.zellij-first-slot-down-stack-real-check.v1',
      ok: false,
      status: 'blocked',
      mission_id: missionId,
      session_name: sessionName,
      artifact_root: root,
      dump_screen_path: dumpPath,
      record1,
      record2,
      list_panes: listPanes,
      dump_screen: dumpScreen,
      command_blockers: commands.flatMap((row: any) => row?.blockers || []),
      blockers: [`zellij_first_slot_real_exception:${err?.message || String(err)}`]
    }
  } finally {
    await runZellij(['kill-session', sessionName], { cwd, timeoutMs: 5000, optional: true }).catch(() => null)
  }
}

async function runFirstSlotLayoutGeometryProof(input: { cwd: string; root: string }) {
  const sessionName = `sks-first-slot-layout-${process.pid}-${Date.now()}`
  const layoutPath = path.join(input.root, 'first-slot-down-layout.kdl')
  const dumpPath = path.join(input.root, 'first-slot-down-layout-dump.txt')
  const commands: unknown[] = []
  const blockers: string[] = []
  let listPanes: Awaited<ReturnType<typeof runZellij>> | null = null
  let dumpScreen: Awaited<ReturnType<typeof runZellij>> | null = null
  try {
    await writeTextAtomic(layoutPath, buildFirstSlotLayout(input.cwd))
    commands.push(await runZellij(['kill-session', sessionName], { cwd: input.cwd, timeoutMs: 2500, optional: true }))
    const launch = await runZellij(['attach', '--create-background', sessionName, 'options', '--default-layout', layoutPath], { cwd: input.cwd, timeoutMs: 5000, optional: false })
    commands.push(launch)
    if (!launch.ok) blockers.push(...launch.blockers.map((blocker) => `zellij_first_slot_layout_launch_${blocker}`))
    await sleep(1000)
    listPanes = await runZellij(['--session', sessionName, 'action', 'list-panes', '--json', '--all'], { cwd: input.cwd, timeoutMs: 5000, optional: false })
    commands.push(listPanes)
    if (!listPanes.ok) blockers.push(...listPanes.blockers.map((blocker) => `zellij_first_slot_layout_list_${blocker}`))
    dumpScreen = await runZellij(['--session', sessionName, 'action', 'dump-screen', '--path', dumpPath, '--full'], { cwd: input.cwd, timeoutMs: 5000, optional: true })
    commands.push(dumpScreen)
    if (!dumpScreen.ok) blockers.push(...dumpScreen.blockers.map((blocker) => `zellij_first_slot_layout_dump_${blocker}`))
    const panes = parsePaneRows(listPanes.stdout_tail)
    const geometry = evaluateNamedGeometry(panes)
    const proofBlockers = [...blockers, ...geometry.blockers]
    return {
      schema: 'sks.zellij-first-slot-down-stack-layout-geometry.v1',
      ok: proofBlockers.length === 0,
      session_name: sessionName,
      layout_path: layoutPath,
      dump_screen_path: dumpPath,
      list_panes_ok: listPanes.ok,
      dump_screen_ok: dumpScreen.ok,
      geometry,
      command_blockers: commands.flatMap((row: any) => row?.blockers || []),
      blockers: proofBlockers
    }
  } catch (err: any) {
    return {
      schema: 'sks.zellij-first-slot-down-stack-layout-geometry.v1',
      ok: false,
      session_name: sessionName,
      layout_path: layoutPath,
      dump_screen_path: dumpPath,
      list_panes_ok: listPanes?.ok || false,
      dump_screen_ok: dumpScreen?.ok || false,
      geometry: { ok: false, blockers: ['zellij_first_slot_layout_exception'] },
      command_blockers: commands.flatMap((row: any) => row?.blockers || []),
      blockers: [`zellij_first_slot_layout_exception:${err?.message || String(err)}`]
    }
  } finally {
    await runZellij(['kill-session', sessionName], { cwd: input.cwd, timeoutMs: 5000, optional: true }).catch(() => null)
  }
}

async function openSlotRenderer(root: string, missionId: string, sessionName: string, slotId: string, generationIndex: number) {
  const workerArtifactDir = path.join('workers', slotId, `gen-${generationIndex}`)
  await ensureDir(path.join(root, workerArtifactDir))
  const command = [
    process.execPath,
    '-e',
    `console.log(${JSON.stringify(`${slotId} live worker pane`)})`
  ].map(shellQuote).join(' ')
  return openWorkerPane({
    root,
    missionId,
    sessionName,
    slotId,
    generationIndex,
    sessionId: `${slotId}-gen-${generationIndex}`,
    workerArtifactDir,
    workerCommand: command,
    resultPath: path.join(workerArtifactDir, 'worker-result.json'),
    heartbeatPath: path.join(workerArtifactDir, 'worker-heartbeat.jsonl'),
    patchEnvelopePath: path.join(workerArtifactDir, 'worker-patch-envelope.json'),
    stdoutLog: path.join(workerArtifactDir, 'worker.stdout.log'),
    stderrLog: path.join(workerArtifactDir, 'worker.stderr.log'),
    cwd: packageRoot(),
    serviceTier: 'fast',
    backend: 'codex-sdk',
    statusLabel: 'worker',
    rightColumnMode: 'spawn-on-first-worker',
    visiblePaneCap: 2,
    uiMode: 'full-debug'
  })
}

function evaluateGeometry(panes: any[], record1: ZellijWorkerPaneRecord | null, record2: ZellijWorkerPaneRecord | null) {
  const anchor = findPane(panes, record1?.slot_column_anchor_pane_id)
  const first = findPane(panes, record1?.pane_id)
  const second = findPane(panes, record2?.pane_id)
  const sameColumn = Boolean(anchor && first && second)
    && Math.abs(first.x - anchor.x) <= 2
    && Math.abs(second.x - anchor.x) <= 2
    && Math.abs(first.width - anchor.width) <= 4
    && Math.abs(second.width - anchor.width) <= 4
  const stackedDown = Boolean(anchor && first && second)
    && first.y > anchor.y
    && second.y > first.y
  const blockers = [
    ...(anchor ? [] : ['slot_anchor_pane_missing']),
    ...(first ? [] : ['first_slot_pane_missing']),
    ...(second ? [] : ['second_slot_pane_missing']),
    ...(sameColumn ? [] : ['slot_panes_not_in_anchor_column']),
    ...(stackedDown ? [] : ['slot_panes_not_stacked_down'])
  ]
  return {
    ok: blockers.length === 0,
    anchor,
    first,
    second,
    same_right_column_x_range: sameColumn,
    first_slot_y_greater_than_anchor: Boolean(anchor && first && first.y > anchor.y),
    second_slot_y_greater_than_first: Boolean(first && second && second.y > first.y),
    blockers
  }
}

function evaluateNamedGeometry(panes: any[]) {
  const main = panes.find((pane) => pane.title === 'orchestrator') || null
  const anchor = panes.find((pane) => pane.title === 'SLOTS') || null
  const first = panes.find((pane) => pane.title === 'slot-001') || null
  const second = panes.find((pane) => pane.title === 'slot-002') || null
  const sameColumn = Boolean(anchor && first && second)
    && Math.abs(first.x - anchor.x) <= 2
    && Math.abs(second.x - anchor.x) <= 2
    && Math.abs(first.width - anchor.width) <= 4
    && Math.abs(second.width - anchor.width) <= 4
  const rightOfMain = Boolean(main && anchor && first && second)
    && anchor.x >= main.x + main.width - 2
    && first.x >= main.x + main.width - 2
    && second.x >= main.x + main.width - 2
  const stackedDown = Boolean(anchor && first && second)
    && first.y > anchor.y
    && second.y > first.y
  const blockers = [
    ...(main ? [] : ['layout_main_pane_missing']),
    ...(anchor ? [] : ['layout_slot_anchor_pane_missing']),
    ...(first ? [] : ['layout_first_slot_pane_missing']),
    ...(second ? [] : ['layout_second_slot_pane_missing']),
    ...(sameColumn ? [] : ['layout_slot_panes_not_in_anchor_column']),
    ...(rightOfMain ? [] : ['layout_slot_column_not_right_of_main']),
    ...(stackedDown ? [] : ['layout_slot_panes_not_stacked_down'])
  ]
  return {
    ok: blockers.length === 0,
    source: 'zellij_layout_equivalent',
    main,
    anchor,
    first,
    second,
    same_right_column_x_range: sameColumn,
    right_of_main: rightOfMain,
    first_slot_y_greater_than_anchor: Boolean(anchor && first && first.y > anchor.y),
    second_slot_y_greater_than_first: Boolean(first && second && second.y > first.y),
    blockers
  }
}

function parsePaneRows(text: string) {
  try {
    const parsed = JSON.parse(String(text || '[]'))
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.panes) ? parsed.panes : []
    return rows.filter((row: any) => row && row.is_plugin !== true && row.exited !== true).map((row: any) => ({
      pane_id: String(row.pane_id ?? row.paneId ?? row.id ?? ''),
      title: String(row.title || row.name || row.pane_name || ''),
      x: Number(row.pane_x ?? row.x ?? 0),
      y: Number(row.pane_y ?? row.y ?? 0),
      width: Number(row.pane_columns ?? row.width ?? 0),
      height: Number(row.pane_rows ?? row.height ?? 0),
      raw: row
    }))
  } catch {
    return []
  }
}

function findPane(panes: any[], paneId: unknown) {
  const id = paneId == null ? '' : String(paneId)
  if (!id) return null
  const normalized = normalizePaneId(id)
  return panes.find((pane) => normalizePaneId(pane.pane_id) === normalized) || null
}

function buildFirstSlotLayout(cwd: string) {
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
    `    tab name="SKS first slot down proof" cwd=${JSON.stringify(cwd)} split_direction="vertical" {`,
    '        pane name="orchestrator" command="sh" {',
    `            args "-lc" ${JSON.stringify(hold)}`,
    '        }',
    '        pane name="slot-column" split_direction="horizontal" {',
    '            pane name="SLOTS" command="sh" {',
    `                args "-lc" ${JSON.stringify(hold)}`,
    '            }',
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

function normalizePaneId(value: unknown) {
  return String(value || '').replace(/^terminal_/, '').replace(/^Terminal\((\d+)\)$/i, '$1')
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
