import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  CURRENT_CODEX_RELEASE_MANIFEST,
  codexReleaseManifestParity,
  currentCodexReleaseManifestPath
} from '../codex-compat/codex-release-manifest.js'
import { sha256 } from '../fsx.js'

interface PackageShape {
  dependencies?: Record<string, string>
  files?: string[]
}

interface LockShape {
  packages?: Record<string, { version?: string }>
}

test('current Codex manifest, dependency graph, schemas, and package allowlist agree on preferred 0.146.0', async () => {
  const root = process.cwd()
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as PackageShape
  const lock = JSON.parse(await fsp.readFile(path.join(root, 'package-lock.json'), 'utf8')) as LockShape
  const parity = await codexReleaseManifestParity(root)
  const packageFiles = pkg.files || []

  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.targetTag, 'rust-v0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.preferredCliVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.sdkVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.minimumSupportedVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.narutoCapabilityFloorVersion, '0.146.0')
  assert.equal(parity.ok, true, parity.mismatches.join(', '))
  assert.equal(currentCodexReleaseManifestPath(root), path.join(root, 'config', 'codex-releases', 'rust-v0.146.0.json'))
  assert.equal(pkg.dependencies?.['@openai/codex-sdk'], '0.146.0')
  assert.equal(lock.packages?.['node_modules/@openai/codex-sdk']?.version, '0.146.0')
  assert.equal(lock.packages?.['node_modules/@openai/codex']?.version, '0.146.0')
  assert.ok(packageFiles.includes('config/codex-releases/rust-v0.146.0.json'))
  assert.ok(packageFiles.includes('schemas/codex/app-server-0.146/codex_app_server_protocol.v2.schemas.json'))
  assert.deepEqual(
    packageFiles.filter((entry) => entry.includes('config/codex-releases/rust-v0.')),
    ['config/codex-releases/rust-v0.146.0.json']
  )
  assert.equal(
    packageFiles.filter((entry) => entry.includes('schemas/codex/app-server-0.')).every((entry) => entry.includes('app-server-0.146')),
    true
  )

  const schemaRoot = path.join(root, 'schemas', 'codex', 'app-server-0.146')
  assert.equal(await canonicalSchemaDirectorySha256(schemaRoot), CURRENT_CODEX_RELEASE_MANIFEST.generatedSchemaSha256)
})

async function canonicalSchemaDirectorySha256(root: string): Promise<string> {
  const files = await listFiles(root)
  const rows = await Promise.all(files.map(async (file) => {
    const text = await fsp.readFile(file, 'utf8')
    const canonical = file.endsWith('.json') ? JSON.stringify(sortJsonKeys(JSON.parse(text) as unknown)) : text
    return `${path.relative(root, file)}\n${canonical}`
  }))
  return sha256(rows.join('\n'))
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files.sort()
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJsonKeys(record[key])]))
}
