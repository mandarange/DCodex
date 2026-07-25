#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const RELEASE_HELPERS = [
  'src/scripts/release-dag-full-coverage-check.ts',
  'src/scripts/typed-routing-gate-lib.ts',
  'src/scripts/codex-native-gate-lib.ts',
  'src/scripts/release-script-lint-gate-lib.ts',
  'src/scripts/release-script-type-safety-check.ts',
  'src/scripts/no-ts-nocheck-release-scripts-check.ts'
]

export async function runReleaseScriptLintGate(id: string): Promise<void> {
  if (id === 'release-scripts:type-safe') return releaseScriptsTypeSafe(id)
  if (id === 'lint:no-ts-nocheck-release-scripts') return noTsNoCheckReleaseScripts(id)
  throw new Error(`unknown_3_1_7_gate:${id}`)
}

function releaseScriptsTypeSafe(id: string): void {
  checkNoTsNoCheckReleaseScripts()
  const dag = readText('src/scripts/release-dag-full-coverage-check.ts')
  for (const token of [
    'interface PackageJsonShape',
    'interface ReleaseGate',
    'interface ReleaseGateManifest',
    'function readPackageJson',
    'function readReleaseGateManifest',
    'function isReleaseGate',
    'function normalizeStringList',
    'const parsed: unknown'
  ]) {
    assertGate(dag.includes(token), `release DAG helper missing typed token:${token}`)
  }
  emitGate(id, { checked_files: RELEASE_HELPERS })
}

function noTsNoCheckReleaseScripts(id: string): void {
  checkNoTsNoCheckReleaseScripts()
  emitGate(id, { checked_files: RELEASE_HELPERS })
}

function checkNoTsNoCheckReleaseScripts(): void {
  const offenders = RELEASE_HELPERS.filter((rel) => /^\s*\/\/\s*@ts-nocheck\b/m.test(readText(rel)))
  assertGate(offenders.length === 0, 'release script ts-nocheck offenders found', { offenders, checked_files: RELEASE_HELPERS })
}

function readText(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function assertGate(condition: unknown, message: string, detail: unknown = {}): asserts condition {
  if (condition) return
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2))
  process.exit(1)
}

function emitGate(gate: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ schema: 'sks.release-gate.v1', ok: true, gate, ...detail }, null, 2))
}
