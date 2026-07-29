import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureCodexLbToolCatalog,
  normalizeCodexLbToolCatalog,
  shouldBindLocalModelCatalog
} from '../codex-lb-tool-catalog.js'

function modelRow(slug = 'future-codex-model') {
  return {
    id: slug,
    display_name: 'Future Codex',
    supported_reasoning_levels: [{ effort: 'high', future_effort_field: true }],
    truncation_policy: { mode: 'tokens', future_policy_field: 17 },
    use_responses_lite: true,
    debug_echoed_authorization: 'Bearer must-not-persist',
    future_unknown_field: {
      nested: ['preserve', { exactly: true }]
    }
  }
}

test('catalog pass-through v2 preserves unknown fields and forces full Responses for every model row', () => {
  const row = modelRow()
  const result = normalizeCodexLbToolCatalog({ models: [row] })

  assert.equal(result.ok, true)
  assert.equal(result.contract, 'codex-model-catalog-pass-through.v2')
  assert.equal(result.catalog.models[0]?.slug, 'future-codex-model')
  assert.equal(result.catalog.models[0]?.use_responses_lite, false)
  assert.deepEqual(result.catalog.models[0]?.future_unknown_field, row.future_unknown_field)
  assert.equal(Object.prototype.hasOwnProperty.call(result.catalog.models[0], 'debug_echoed_authorization'), false)
  assert.deepEqual(result.catalog.models[0]?.supported_reasoning_levels, row.supported_reasoning_levels)
  assert.notEqual(result.catalog.models[0], row)
  assert.equal(row.use_responses_lite, true)
})

test('catalog validates the known subset without rejecting or deleting future fields', () => {
  const result = normalizeCodexLbToolCatalog({
    models: [{
      ...modelRow(),
      display_name: 42,
      another_future_field: { arbitrary: 'not validated' }
    }]
  })

  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('codex_lb_model_catalog_field_type_invalid:0:display_name'))
  assert.equal(Object.prototype.hasOwnProperty.call(result.catalog.models[0], 'another_future_field'), true)
})

test('native bridge never binds a replacement catalog while compat and CLI modes may', () => {
  assert.equal(shouldBindLocalModelCatalog('desktop-native-bridge'), false)
  assert.equal(shouldBindLocalModelCatalog('desktop-dual-auth-compat'), true)
  assert.equal(shouldBindLocalModelCatalog('cli-provider'), true)
  assert.equal(shouldBindLocalModelCatalog('disabled'), false)
})

test('catalog metadata records pass-through contract and upstream validators', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-catalog-pass-through-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const result = await ensureCodexLbToolCatalog({
    codexHome: root,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    apiKey: 'fixture-secret',
    clientVersion: '0.145.0',
    fetchImpl: async () => new Response(JSON.stringify({ models: [modelRow()] }), {
      status: 200,
      headers: {
        etag: '"catalog-1"',
        'last-modified': 'Tue, 28 Jul 2026 00:00:00 GMT',
        'content-type': 'application/json'
      }
    })
  })

  assert.equal(result.ok, true)
  const metadata = JSON.parse(await fs.readFile(`${result.path}.meta.json`, 'utf8'))
  assert.equal(metadata.identity.contract, 'codex-model-catalog-pass-through.v2')
  assert.equal(metadata.upstream_etag, '"catalog-1"')
  assert.equal(metadata.upstream_last_modified, 'Tue, 28 Jul 2026 00:00:00 GMT')
  assert.equal(metadata.client_version, '0.145.0')
  assert.equal(metadata.unknown_fields_preserved, true)
  assert.deepEqual(metadata.normalizations, ['desktop_full_responses_required'])
})
