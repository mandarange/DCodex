#!/usr/bin/env node
import { assertGate, emitGate, importDist } from './gate-lib.js'

process.env.SKS_RELEASE_MAX_CPU_LIGHT = '7'
process.env.SKS_RELEASE_MAX_TOTAL = '2'
const governor = await importDist('core/release/release-gate-resource-governor.js')
const budget = governor.defaultReleaseGateBudget()
assertGate(budget['cpu-light'] >= 1 && budget['cpu-light'] <= 4, 'resource governor env requests must not raise the desktop-safe cpu-light cap', budget)
assertGate(governor.defaultReleaseGateMaxTotal() >= 1 && governor.defaultReleaseGateMaxTotal() <= 4, 'resource governor default total cap must stay desktop-safe', { max_total: governor.defaultReleaseGateMaxTotal() })
const gate = (id: string) => ({ id, resource: ['cpu-light'], deps: [], command: 'true', side_effect: 'hermetic', timeout_ms: 1000, cache: { enabled: false, inputs: [] }, isolation: { report_dir: 'per-gate' }, preset: ['release'] })
const fsGate = (id: string) => ({ ...gate(id), resource: ['fs-read'] })
const timingGate = (id: string) => ({ ...gate(id), resource: ['timing-sensitive'] })
const picked = governor.pickLaunchableReleaseGates({ ready: [gate('a'), gate('b'), gate('c')], running: [], budget })
assertGate(picked.length === 2, 'resource governor must honor SKS_RELEASE_MAX_TOTAL', { picked: picked.map((row: any) => row.id) })
process.env.SKS_RELEASE_MAX_TOTAL = '9999'
const raisedTotal = governor.pickLaunchableReleaseGates({ ready: Array.from({ length: 80 }, (_, index) => fsGate(`fs-${index}`)), running: [], budget })
assertGate(raisedTotal.length <= governor.defaultReleaseGateMaxTotal(), 'SKS_RELEASE_MAX_TOTAL must not raise above the host-safe default cap', { picked: raisedTotal.length, default_cap: governor.defaultReleaseGateMaxTotal() })
process.env.SKS_RELEASE_MAX_TOTAL = '2'
const timingFirst = governor.pickLaunchableReleaseGates({ ready: [timingGate('timing'), gate('a')], running: [], budget })
assertGate(timingFirst.length === 1 && timingFirst[0].id === 'timing', 'timing-sensitive gate must launch alone when selected', { picked: timingFirst.map((row: any) => row.id) })
const timingAfterOther = governor.pickLaunchableReleaseGates({ ready: [gate('a'), timingGate('timing')], running: [], budget })
assertGate(timingAfterOther.length === 1 && timingAfterOther[0].id === 'a', 'timing-sensitive gate must wait behind already-selected non-exclusive work', { picked: timingAfterOther.map((row: any) => row.id) })
const blockedByTiming = governor.pickLaunchableReleaseGates({ ready: [gate('a')], running: [timingGate('timing')], budget })
assertGate(blockedByTiming.length === 0, 'running timing-sensitive gate must block co-scheduled release gates', { picked: blockedByTiming.map((row: any) => row.id) })
emitGate('release:aggressive-resource-governor', { cpu_light: budget['cpu-light'], total: picked.length })
