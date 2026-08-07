import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../codex-compat/codex-runtime-contract.js'

export interface CodexSdkCapability {
  schema: 'sks.codex-sdk-capability.v1'
  ok: boolean
  package_name: '@openai/codex-sdk'
  package_version: string | null
  node_version: string
  node_compatible: boolean
  dynamic_import_ok: boolean
  structured_output_fake_smoke: boolean
  setup_action: string | null
  blockers: string[]
}

export async function detectCodexSdkCapability(input: { fakeSmoke?: boolean } = {}): Promise<CodexSdkCapability> {
  let dynamicImportOk = false
  let version: string | null = null
  const blockers: string[] = []
  try {
    await import('@openai/codex-sdk')
    dynamicImportOk = true
  } catch {
    blockers.push('codex_sdk_unavailable')
  }
  try {
    const req = createRequire(import.meta.url)
    version = readPackageVersionFromEntrypoint(req.resolve('@openai/codex-sdk'))
  } catch {
    version = findPackageVersion()
    if (!version) blockers.push('codex_sdk_package_metadata_unavailable')
  }
  const nodeCompatible = nodeAtLeast(process.versions.node, '18.0.0')
  if (!nodeCompatible) blockers.push('codex_sdk_node_version_unsupported')
  const structuredFake = input.fakeSmoke === false ? true : dynamicImportOk && nodeCompatible
  if (!structuredFake) blockers.push('codex_sdk_structured_output_fake_smoke_failed')
  return {
    schema: 'sks.codex-sdk-capability.v1',
    ok: blockers.length === 0,
    package_name: '@openai/codex-sdk',
    package_version: version,
    node_version: process.versions.node,
    node_compatible: nodeCompatible,
    dynamic_import_ok: dynamicImportOk,
    structured_output_fake_smoke: structuredFake,
    setup_action: blockers.includes('codex_sdk_unavailable') ? `npm install @openai/codex-sdk@${CURRENT_CODEX_RUNTIME_CONTRACT.sdkVersion}` : null,
    blockers
  }
}

function readPackageVersionFromEntrypoint(entrypoint: string): string | null {
  let dir = path.dirname(entrypoint)
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'package.json')
    const version = readPackageJsonVersion(candidate)
    if (version) return version
    const next = path.dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}

function findPackageVersion(): string | null {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '@openai', 'codex-sdk', 'package.json'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '@openai', 'codex-sdk', 'package.json'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '@openai', 'codex-sdk', 'package.json')
  ]
  for (const candidate of candidates) {
    const version = readPackageJsonVersion(candidate)
    if (version) return version
  }
  return null
}

function readPackageJsonVersion(file: string): string | null {
  if (!fs.existsSync(file)) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

function nodeAtLeast(actual: string, minimum: string) {
  const a = actual.split('.').map((part) => Number(part) || 0)
  const b = minimum.split('.').map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true
    if ((a[i] || 0) < (b[i] || 0)) return false
  }
  return true
}
