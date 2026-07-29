#!/usr/bin/env node
import fs from 'node:fs/promises'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  ensureCodexLbToolCatalog,
  normalizeCodexLbToolCatalog
} from '../core/codex-lb/codex-lb-tool-catalog.js'
import { assertGate, emitGate } from './gate-lib.js'

const gatewayKey = 'catalog-gate-secret'
const sensitiveEcho = 'Bearer catalog-gate-secret-must-not-persist'
const model = {
  id: 'future-codex-model',
  display_name: 'Future Codex',
  supported_reasoning_levels: [{ effort: 'high', future_effort_field: true }],
  truncation_policy: { mode: 'tokens', future_policy_field: 17 },
  use_responses_lite: true,
  future_unknown_field: {
    nested: ['preserve', { exactly: true }]
  },
  debug_echoed_authorization: sensitiveEcho
}
const payload = { models: [model] }

const normalized = normalizeCodexLbToolCatalog(payload)
const normalizedRow = normalized.catalog.models[0] as Record<string, unknown> | undefined

let observedAuthorization = ''
let observedPath = ''
const upstream = http.createServer((request, response) => {
  observedAuthorization = String(request.headers.authorization || '')
  observedPath = String(request.url || '')
  response.writeHead(200, {
    'content-type': 'application/json',
    etag: '"catalog-gate-v2"'
  })
  response.end(JSON.stringify(payload))
})
const upstreamPort = await listen(upstream)
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-catalog-gate-'))

let ensured: Awaited<ReturnType<typeof ensureCodexLbToolCatalog>> | null = null
let persisted: Record<string, unknown> | null = null
let metadata: Record<string, any> | null = null
try {
  const home = path.join(temporaryRoot, 'home')
  const codexHome = path.join(home, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  ensured = await ensureCodexLbToolCatalog({
    codexHome,
    baseUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    apiKey: gatewayKey,
    clientVersion: '0.145.0'
  })
  if (ensured.ok) {
    persisted = JSON.parse(await fs.readFile(ensured.path, 'utf8')) as Record<string, unknown>
    metadata = JSON.parse(await fs.readFile(`${ensured.path}.meta.json`, 'utf8')) as Record<string, any>
  }
} finally {
  await close(upstream)
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}

const persistedRow = Array.isArray(persisted?.models)
  ? persisted.models[0] as Record<string, unknown> | undefined
  : undefined
const idToSlug = normalized.ok === true
  && normalizedRow?.id === model.id
  && normalizedRow?.slug === model.id
const unknownFieldPassthrough = JSON.stringify(normalizedRow?.future_unknown_field) === JSON.stringify(model.future_unknown_field)
  && JSON.stringify(persistedRow?.future_unknown_field) === JSON.stringify(model.future_unknown_field)
const fullResponses = normalized.tools_transport === 'full_responses'
  && normalizedRow?.use_responses_lite === false
  && persistedRow?.use_responses_lite === false
const secretSafe = normalizedRow?.debug_echoed_authorization === undefined
  && persistedRow?.debug_echoed_authorization === undefined
  && !JSON.stringify(persisted || {}).includes(gatewayKey)
  && !JSON.stringify(persisted || {}).includes(sensitiveEcho)
const fetchedAndBound = ensured?.ok === true
  && ensured.status === 'repaired'
  && ensured.identity_verified === true
  && observedAuthorization === `Bearer ${gatewayKey}`
  && observedPath === '/backend-api/codex/models'
  && metadata?.identity?.contract === 'codex-model-catalog-pass-through.v2'
  && metadata?.unknown_fields_preserved === true
  && metadata?.upstream_etag === '"catalog-gate-v2"'

const report = {
  schema: 'sks.codex-lb-catalog-passthrough-check.v1',
  ok: idToSlug && unknownFieldPassthrough && fullResponses && secretSafe && fetchedAndBound,
  id_to_slug: idToSlug,
  unknown_field_passthrough: unknownFieldPassthrough,
  full_responses: fullResponses,
  secret_safe: secretSafe,
  localhost_fetch_verified: fetchedAndBound,
  contract: normalized.contract,
  blockers: [
    ...(idToSlug ? [] : ['catalog_id_to_slug_failed']),
    ...(unknownFieldPassthrough ? [] : ['catalog_unknown_field_changed']),
    ...(fullResponses ? [] : ['catalog_full_responses_not_enforced']),
    ...(secretSafe ? [] : ['catalog_secret_persisted']),
    ...(fetchedAndBound ? [] : ['catalog_localhost_fetch_unverified'])
  ]
}

assertGate(report.ok, 'codex-lb catalog pass-through gate failed', report)
emitGate('codex-lb:catalog-passthrough', {
  contract: report.contract,
  id_to_slug: report.id_to_slug,
  unknown_field_passthrough: report.unknown_field_passthrough,
  full_responses: report.full_responses,
  localhost_fetch_verified: report.localhost_fetch_verified
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
