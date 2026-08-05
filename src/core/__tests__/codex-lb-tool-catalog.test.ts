import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  codexLbToolCatalogMetadataPath,
  ensureCodexLbToolCatalog,
  inspectCodexLbToolCatalog,
  normalizeCodexLbToolCatalog
} from '../codex-lb/codex-lb-tool-catalog.js'
import { packageRoot, runProcess } from '../fsx.js'

const CODEX_PARSER_PROBE_TIMEOUT_MS = 20_000

function codexCurrentModel(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    display_name: slug.replace('gpt-', 'GPT-').replaceAll('-', ' '),
    supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    base_instructions: 'You are Codex.',
    supports_reasoning_summaries: true,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    ...extra
  }
}

const remoteCatalog = {
  models: [
    codexCurrentModel('gpt-5.6-sol', { minimal_client_version: '0.144.5', debug_echoed_authorization: 'sk-must-not-persist' }),
    codexCurrentModel('gpt-5.6-terra'),
    codexCurrentModel('gpt-5.6-luna'),
    codexCurrentModel('gpt-5.4', { tool_mode: null, use_responses_lite: false })
  ]
}

test('normalizes the Current Codex 0.146.0 catalog and preserves native GPT-5.6 tool transport', () => {
  const result = normalizeCodexLbToolCatalog(remoteCatalog)
  assert.equal(result.ok, true)
  assert.equal(result.tools_transport, 'full_responses')
  assert.deepEqual(result.patched_models, ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])
  for (const model of result.catalog.models.filter((row: any) => row.slug.startsWith('gpt-5.6'))) {
    assert.equal(model.use_responses_lite, false)
    assert.equal(model.tool_mode, 'code_mode_only')
    assert.equal(model.supports_parallel_tool_calls, true)
  }
  assert.equal(result.catalog.models[0].minimal_client_version, '0.144.5')
  assert.equal('debug_echoed_authorization' in result.catalog.models[0], false)
})

test('catalog v2 derives slug from id while preserving the remaining Codex model contract', () => {
  const result = normalizeCodexLbToolCatalog({ data: [
    codexCurrentIdModel('gpt-5.6-sol'),
    codexCurrentIdModel('gpt-5.6-terra'),
    codexCurrentIdModel('gpt-5.6-luna')
  ] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.catalog.models.map((row: any) => row.slug), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
  ])
  assert.ok(result.catalog.models.every((row: any) => row.id === row.slug))
  assert.ok(result.catalog.models.every((row: any) => row.use_responses_lite === false))
})

function codexCurrentIdModel(id: string) {
  const { slug: _slug, ...row } = codexCurrentModel(id)
  return { id, ...row }
}

test('writes and reuses an identity-bound owner-only Codex model catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-tool-catalog-'))
  try {
    let calls = 0
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1
      assert.match(String((init?.headers as any)?.Authorization || ''), /^Bearer /)
      return new Response(JSON.stringify(remoteCatalog), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const repaired = await ensureCodexLbToolCatalog({
      codexHome: root,
      baseUrl: 'https://lb.example.test/backend-api/codex',
      apiKey: 'sk-catalog-fixture',
      fetchImpl
    })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.status, 'repaired')
    assert.equal(repaired.identity_verified, true)
    assert.equal(calls, 1)
    const text = await fs.readFile(repaired.path, 'utf8')
    assert.equal(text.includes('sk-catalog-fixture'), false)
    assert.equal(text.includes('sk-must-not-persist'), false)
    const catalogStat = await fs.lstat(repaired.path)
    const metadataStat = await fs.lstat(codexLbToolCatalogMetadataPath(repaired.path))
    assert.equal(catalogStat.isFile() && !catalogStat.isSymbolicLink(), true)
    assert.equal(metadataStat.isFile() && !metadataStat.isSymbolicLink(), true)
    if (process.platform !== 'win32') {
      assert.equal(catalogStat.mode & 0o777, 0o600)
      assert.equal(metadataStat.mode & 0o777, 0o600)
    }
    const inspected = await inspectCodexLbToolCatalog(repaired.path)
    assert.equal(inspected.ok, true)

    const cached = await ensureCodexLbToolCatalog({
      codexHome: root,
      baseUrl: 'https://lb.example.test/backend-api/codex',
      apiKey: 'sk-catalog-fixture',
      fetchImpl,
      maxAgeMs: 10_000
    })
    assert.equal(cached.status, 'cached_compatible')
    assert.equal(calls, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('validates transport and cache identity before reusing any catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-tool-catalog-identity-'))
  try {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify(remoteCatalog), { status: 200 })
    }) as typeof fetch
    const first = await ensureCodexLbToolCatalog({ codexHome: root, baseUrl: 'https://one.example.test', apiKey: 'sk-one', fetchImpl })
    assert.equal(first.ok, true)

    const otherOrigin = await ensureCodexLbToolCatalog({ codexHome: root, baseUrl: 'https://two.example.test', apiKey: 'sk-one', fetchImpl })
    assert.equal(otherOrigin.ok, true)
    assert.equal(otherOrigin.status, 'repaired')
    assert.equal(calls, 2)

    const otherIdentity = await ensureCodexLbToolCatalog({ codexHome: root, baseUrl: 'https://two.example.test', apiKey: 'sk-two', fetchImpl })
    assert.equal(otherIdentity.ok, true)
    assert.equal(otherIdentity.status, 'repaired')
    assert.equal(calls, 3)

    const insecure = await ensureCodexLbToolCatalog({
      codexHome: root,
      baseUrl: 'http://not-loopback.example.com',
      apiKey: 'sk-two',
      fetchImpl: (async () => { throw new Error('must not fetch') }) as typeof fetch,
      force: true
    })
    assert.equal(insecure.ok, false)
    assert.ok(insecure.blockers.includes('codex_lb_insecure_base_url'))
    assert.equal(calls, 3)

    const missingKey = await ensureCodexLbToolCatalog({ codexHome: root, baseUrl: 'https://two.example.test', apiKey: '', fetchImpl })
    assert.equal(missingKey.ok, false)
    assert.ok(missingKey.blockers.includes('codex_lb_api_key_missing'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('caps response bytes and model count before writing a catalog', async () => {
  const tooMany = normalizeCodexLbToolCatalog({ models: [
    codexCurrentModel('gpt-5.6-sol'),
    codexCurrentModel('gpt-5.6-terra')
  ] }, { maxModels: 1 })
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.blockers.includes('codex_lb_model_catalog_model_limit_exceeded:2:1'))

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-tool-catalog-cap-'))
  try {
    const result = await ensureCodexLbToolCatalog({
      codexHome: root,
      baseUrl: 'https://lb.example.test',
      apiKey: 'sk-cap',
      maxResponseBytes: 128,
      fetchImpl: (async () => new Response(JSON.stringify(remoteCatalog), { status: 200 })) as typeof fetch
    })
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes('codex_lb_tool_catalog_response_too_large'))
    await assert.rejects(fs.access(result.path))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('coalesces concurrent cold-cache fetches for the same identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-tool-catalog-concurrent-'))
  try {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return new Response(JSON.stringify(remoteCatalog), { status: 200 })
    }) as typeof fetch
    const input = { codexHome: root, baseUrl: 'https://lb.example.test', apiKey: 'sk-concurrent', fetchImpl }
    const results = await Promise.all([
      ensureCodexLbToolCatalog(input),
      ensureCodexLbToolCatalog(input),
      ensureCodexLbToolCatalog(input)
    ])
    assert.equal(calls, 1)
    assert.ok(results.every((result) => result.ok && result.path === results[0].path))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('emitted minimum catalog parses in the project-local Codex CLI preferred channel', async () => {
  const preferred = JSON.parse(await fs.readFile(path.join(packageRoot(), 'package.json'), 'utf8')).dependencies?.['@openai/codex-sdk']
  assert.match(String(preferred || ''), /^\d+\.\d+\.\d+$/, 'preferred Codex SDK pin must be a semver')
  const codexPackageRoot = path.join(packageRoot(), 'node_modules', '@openai', 'codex')
  const codexPackage = JSON.parse(await fs.readFile(path.join(codexPackageRoot, 'package.json'), 'utf8'))
  assert.equal(codexPackage.version, preferred, 'project-local @openai/codex must track the preferred Codex channel')
  const codexEntrypoint = path.join(codexPackageRoot, 'bin', 'codex.js')
  await fs.access(codexEntrypoint)
  const version = await runProcess(process.execPath, [codexEntrypoint, '--version'], { timeoutMs: CODEX_PARSER_PROBE_TIMEOUT_MS, maxOutputBytes: 4_096 })
  assert.equal(version.code, 0, version.stderr || version.stdout)
  assert.match(version.stdout, new RegExp(`\\b${String(preferred).replace(/\./g, '\\.')}\\b`))

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-tool-catalog-parser-'))
  try {
    const catalog = { models: [codexCurrentModel('gpt-5.6-sol')] }
    const ensured = await ensureCodexLbToolCatalog({
      codexHome: root,
      baseUrl: 'https://lb.example.test',
      apiKey: 'sk-parser',
      fetchImpl: (async () => new Response(JSON.stringify(catalog), { status: 200 })) as typeof fetch
    })
    assert.equal(ensured.ok, true)
    await fs.writeFile(path.join(root, 'config.toml'), `model_catalog_json = ${JSON.stringify(ensured.path)}\n`, { mode: 0o600 })
    const probe = await runProcess(process.execPath, [codexEntrypoint, 'features', 'list'], {
      env: { ...process.env, HOME: root, CODEX_HOME: root },
      timeoutMs: CODEX_PARSER_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    assert.equal(probe.code, 0, probe.stderr || probe.stdout)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
