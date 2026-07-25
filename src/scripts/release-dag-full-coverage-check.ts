#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './sks-1-18-gate-lib.js'
import { releaseGateContractSnapshot } from '../core/release/release-gate-contract.js'
import { isRecord } from '../core/json/records.js'

interface ReleaseGate {
  id: string
  command: string
  deps: string[]
  resource: string[]
  side_effect: string
  timeout_ms: number
  cache: unknown
  isolation: unknown
  preset: string[]
}

interface ReleaseGateManifest {
  schema?: string
  gates: ReleaseGate[]
}

interface PackageJsonShape {
  scripts?: Record<string, string>
}

const packageJson = readPackageJson(path.join(root, 'package.json'))
const releaseManifest = readReleaseGateManifest(path.join(root, 'release-gates.v2.json'), 'sks.release-gates.v2')
const harnessManifest = readReleaseGateManifest(path.join(root, 'infra-harness-gates.json'), 'sks.infra-harness-gates.v1')
const releasePreset = releaseManifest.gates.filter((gate) => gate.preset.includes('release'))
const harnessPreset = harnessManifest.gates.filter((gate) => gate.preset.includes('harness'))
const releaseIds = new Set(releasePreset.map((gate) => gate.id))
const harnessIds = new Set(harnessPreset.map((gate) => gate.id))
const releaseContract = releaseGateContractSnapshot()
const requiredReleasePresetIds = releaseContract.ids
const requiredHarnessPresetIds = [
  'zellij:layout-valid',
  'zellij:compact-slot-renderer',
  'zellij:slot-telemetry',
  'zellij:slot-pane-telemetry-renderer',
  'zellij:first-slot-down-stack',
  'zellij:right-column-geometry-proof'
]
const missingRequiredReleasePreset = requiredReleasePresetIds.filter((id) => !releaseIds.has(id))
const unexpectedReleasePreset = [...releaseIds].filter((id) => !requiredReleasePresetIds.includes(id)).sort()
const missingRequiredHarnessPreset = requiredHarnessPresetIds.filter((id) => !harnessIds.has(id))
const duplicateAcrossManifests = [...releaseIds].filter((id) => harnessIds.has(id))
const releaseZellij = [...releaseIds].filter((id) => id.startsWith('zellij:'))
const harnessNonZellij = [...harnessIds].filter((id) => !id.startsWith('zellij:'))
const npmRunCommands = [...releasePreset, ...harnessPreset].filter((gate) => /\bnpm\s+run\b/.test(gate.command)).map((gate) => gate.id)
const schemaComplete = [...releaseManifest.gates, ...harnessManifest.gates].every(isReleaseGate)

const report = {
  schema: 'sks.release-dag-full-coverage-check.v2',
  ok: schemaComplete
    && releasePreset.length <= 200
    && missingRequiredReleasePreset.length === 0
    && unexpectedReleasePreset.length === 0
    && missingRequiredHarnessPreset.length === 0
    && duplicateAcrossManifests.length === 0
    && releaseZellij.length === 0
    && harnessNonZellij.length === 0
    && npmRunCommands.length === 0,
  release_gate_count: releasePreset.length,
  harness_gate_count: harnessPreset.length,
  required_release_preset_ids: requiredReleasePresetIds,
  missing_required_release_preset: missingRequiredReleasePreset,
  unexpected_release_preset: unexpectedReleasePreset,
  release_gate_contract: releaseContract,
  required_harness_preset_ids: requiredHarnessPresetIds,
  missing_required_harness_preset: missingRequiredHarnessPreset,
  duplicate_across_manifests: duplicateAcrossManifests,
  release_zellij: releaseZellij,
  harness_non_zellij: harnessNonZellij,
  npm_run_commands: npmRunCommands,
  schema_complete: schemaComplete,
  package_script_count: Object.keys(packageJson.scripts || {}).length
}

assertGate(report.ok, 'release/harness gate manifests must satisfy consolidated v2 coverage policy', report)
emitGate('release:dag-full-coverage', report)

function readPackageJson(file: string): PackageJsonShape {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  assertGate(isRecord(parsed), 'package.json must be an object', { file })
  const record = parsed as Record<string, unknown>
  const scripts = isRecord(record.scripts) ? Object.fromEntries(
    Object.entries(record.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  ) : {}
  return { scripts }
}

function readReleaseGateManifest(file: string, expectedSchema: string): ReleaseGateManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  assertGate(isRecord(parsed), 'gate manifest must be an object', { file })
  assertGate((parsed as any).schema === expectedSchema, 'gate manifest schema mismatch', { file, schema: (parsed as any).schema, expected_schema: expectedSchema })
  const gatesValue = (parsed as any).gates
  assertGate(Array.isArray(gatesValue), 'gate manifest missing gates array', { file })
  const gatesRaw: unknown[] = Array.isArray(gatesValue) ? gatesValue : []
  const gates = gatesRaw.filter(isReleaseGate)
  assertGate(gates.length === gatesRaw.length, 'gate manifest contains invalid gates', {
    file,
    invalid_count: gatesRaw.length - gates.length
  })
  return { schema: expectedSchema, gates }
}

function isReleaseGate(value: unknown): value is ReleaseGate {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.command === 'string'
    && typeof value.side_effect === 'string'
    && typeof value.timeout_ms === 'number'
    && normalizeStringList(value.deps).length === (Array.isArray(value.deps) ? value.deps.length : 0)
    && normalizeStringList(value.resource).length === (Array.isArray(value.resource) ? value.resource.length : 0)
    && normalizeStringList(value.preset).length === (Array.isArray(value.preset) ? value.preset.length : 0)
    && value.cache !== undefined
    && value.isolation !== undefined
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
}
