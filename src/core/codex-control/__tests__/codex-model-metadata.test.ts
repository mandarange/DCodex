import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../../codex-compat/codex-runtime-contract.js'
import {
  codexModelEffortCapability,
  modelEffortAtLeast,
  nextAdvertisedEffort
} from '../codex-model-capabilities.js'
import { collectCodexModelMetadata } from '../codex-model-metadata.js'

const ASTRA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

test('collects GPT-6 Astra efforts from the official app-server model/list method', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-model-metadata-app-server-'))
  try {
    const requestsPath = path.join(root, 'requests.log')
    const codexBin = await writeFakeCodex(root)
    const env = {
      ...process.env,
      HOME: root,
      CODEX_HOME: path.join(root, '.codex'),
      FAKE_CODEX_REQUESTS_PATH: requestsPath
    }

    const result = await collectCodexModelMetadata({
      model: 'gpt-6-astra',
      env,
      home: root,
      codexBin
    })

    assert.equal(result.model, 'gpt-6-astra')
    assert.equal(result.source, 'app-server')
    assert.deepEqual(result.advertised_efforts, ASTRA_EFFORTS)
    assert.equal(result.default_effort, 'medium')
    assert.deepEqual(result.blockers, [])
    assert.deepEqual((await fs.readFile(requestsPath, 'utf8')).trim().split('\n'), [
      'initialize',
      'model/list'
    ])

    const capability = codexModelEffortCapability({ metadata: result })
    assert.deepEqual(capability.advertised_efforts, ASTRA_EFFORTS)
    assert.equal(capability.order_source, 'model-advertised')
    assert.equal(nextAdvertisedEffort('xhigh', capability), 'max')
    assert.equal(nextAdvertisedEffort('minimal', capability), 'low')
    assert.equal(modelEffortAtLeast('none', capability), 'low')
    assert.equal(codexModelEffortCapability({
      model: 'gpt-6-astra',
      advertisedEfforts: ASTRA_EFFORTS,
      defaultEffort: 'minimal'
    }).default_effort, 'low')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('uses the configured Codex catalog and preserves the explicitly requested model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-model-metadata-catalog-'))
  try {
    const codexHome = path.join(root, '.codex')
    const catalogPath = path.join(codexHome, 'catalog.json')
    const configPath = path.join(codexHome, 'config.toml')
    await fs.mkdir(codexHome, { recursive: true })
    await fs.writeFile(catalogPath, `${JSON.stringify({
      models: [catalogRow('gpt-6-astra', ASTRA_EFFORTS, 'medium')]
    })}\n`, { mode: 0o600 })
    await fs.writeFile(configPath, [
      'model = "gpt-5.6-sol"',
      'model_catalog_json = "catalog.json"',
      ''
    ].join('\n'))

    const result = await collectCodexModelMetadata({
      model: 'gpt-6-astra',
      env: { HOME: root, CODEX_HOME: codexHome },
      home: root,
      configPath,
      codexBin: path.join(root, 'must-not-run')
    })

    assert.equal(result.model, 'gpt-6-astra')
    assert.equal(result.source, 'codex-catalog')
    assert.deepEqual(result.advertised_efforts, ASTRA_EFFORTS)
    assert.equal(result.default_effort, 'medium')
    assert.deepEqual(result.blockers, [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('reports unavailable metadata without fabricating advertised efforts', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-model-metadata-unavailable-'))
  try {
    const codexHome = path.join(root, '.codex')
    const configPath = path.join(codexHome, 'config.toml')
    await fs.mkdir(codexHome, { recursive: true })
    await fs.writeFile(configPath, 'model = "gpt-6-astra"\n')
    const codexBin = await writeFakeCodex(root, true)

    const result = await collectCodexModelMetadata({
      env: { ...process.env, HOME: root, CODEX_HOME: codexHome },
      home: root,
      configPath,
      codexBin
    })

    assert.equal(result.model, 'gpt-6-astra')
    assert.equal(result.source, 'unavailable')
    assert.deepEqual(result.advertised_efforts, [])
    assert.equal(result.default_effort, '')
    assert.ok(result.blockers.includes('codex_model_metadata_unavailable'))
    assert.ok(result.blockers.includes('codex_model_not_found_in_advertised_catalog'))

    const capability = codexModelEffortCapability({ metadata: result })
    assert.deepEqual(capability.advertised_efforts, [])
    assert.equal(capability.order_source, 'sks-fallback')
    assert.equal(capability.default_effort, 'medium')
    assert.equal(nextAdvertisedEffort('medium', capability), 'high')
    assert.equal(capability.advertised_efforts.length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function writeFakeCodex(root: string, malformedSingleModel = false): Promise<string> {
  const filePath = path.join(root, malformedSingleModel ? 'codex-malformed' : 'codex-model-list')
  const modelListResult = malformedSingleModel
    ? {
        id: 'different-model',
        model: 'different-model',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }]
      }
    : { data: [{
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ASTRA_EFFORTS.map((reasoningEffort) => ({ reasoningEffort }))
      }], nextCursor: null }
  await fs.writeFile(filePath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    `if (process.argv.includes('--version')) { console.log('codex-cli ${CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion}'); process.exit(0); }`,
    `const modelListResult = ${JSON.stringify(modelListResult)};`,
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.method === "initialized") return;',
    '  if (process.env.FAKE_CODEX_REQUESTS_PATH) fs.appendFileSync(process.env.FAKE_CODEX_REQUESTS_PATH, `${message.method}\\n`);',
    '  const result = message.method === "model/list" ? modelListResult : {};',
    '  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\\n`);',
    '});',
    ''
  ].join('\n'), { mode: 0o755 })
  return filePath
}

function catalogRow(model: string, efforts: string[], defaultEffort: string) {
  return {
    slug: model,
    display_name: model,
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
    default_reasoning_level: defaultEffort,
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    base_instructions: '',
    supports_reasoning_summaries: true,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 100_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: []
  }
}
