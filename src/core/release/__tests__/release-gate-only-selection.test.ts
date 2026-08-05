import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  gatePackRunCoverageComplete,
  loadReleaseGateManifest,
  runReleaseGateDag,
  selectReleaseGateClosure
} from '../release-gate-dag.js'
import type { ReleaseGateManifestV2, ReleaseGateNode } from '../release-gate-node.js'

function gate(id: string, deps: string[], command: string): ReleaseGateNode {
  return {
    id,
    command,
    deps,
    resource: ['cpu-light', 'fs-write'],
    side_effect: 'hermetic',
    timeout_ms: 10_000,
    output_contract: 'sks.gate-result.v1',
    cache: { enabled: false, inputs: [] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release']
  }
}

function nodeCommand(source: string) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`
}

test('single Desktop Bridge gate selection executes without a retired gate alias or dependency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-gate-only-'))
  const manifest: ReleaseGateManifestV2 = {
    schema: 'sks.release-gates.v2',
    gates: [
      gate('desktop-bridge:comprehensive', [], nodeCommand("console.log(JSON.stringify({schema:'sks.gate-result.v1',ok:true}))"))
    ]
  }
  try {
    await fs.writeFile(path.join(root, 'release-gates.v2.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const result = await runReleaseGateDag({ root, onlyGateIds: ['desktop-bridge:comprehensive'], noCache: true })
    assert.equal(result.ok, true)
    assert.deepEqual(result.selected_gate_ids, ['desktop-bridge:comprehensive'])
    assert.deepEqual(result.executed_gates, ['desktop-bridge:comprehensive'])
    assert.equal(result.completed, 1)
    assert.equal(result.failed, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('in-progress DAG snapshots cannot claim a successful full release proof', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-gate-in-progress-'))
  const manifest: ReleaseGateManifestV2 = {
    schema: 'sks.release-gates.v2',
    gates: [
      gate('gate:fast', [], nodeCommand("setTimeout(() => console.log(JSON.stringify({schema:'sks.gate-result.v1',ok:true})), 10)")),
      gate('gate:slow', [], nodeCommand("setTimeout(() => console.log(JSON.stringify({schema:'sks.gate-result.v1',ok:true})), 600)"))
    ]
  }
  const run = (async () => {
    await fs.writeFile(path.join(root, 'release-gates.v2.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return runReleaseGateDag({ root, preset: 'release', full: true, noCache: true })
  })()
  try {
    const snapshot = await waitForInProgressSummary(root)
    assert.equal(snapshot.in_progress, true)
    assert.equal(snapshot.ok, false)
    assert.ok(snapshot.completed + snapshot.failed < snapshot.selected_gates)
    assert.equal(snapshot.completion_certificate?.ok, false)
    assert.equal(snapshot.completion_certificate?.confidence, 'incomplete')
    assert.equal(snapshot.completion_certificate?.sla_met, false)
    assert.equal(snapshot.completion_certificate?.full_release_proof, 'background_or_release_before_publish_required')

    const result = await run
    assert.equal(result.ok, true)
    assert.equal(result.completed, 2)
    assert.equal(result.completion_certificate.confidence, 'full-release-proof')
    assert.equal(result.completion_certificate.full_release_proof, 'current_run')
  } finally {
    await run.catch(() => null)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('gate-pack completion requires exact pack reports and selected-gate coverage', () => {
  const complete = {
    executed_packs: ['pack-a'],
    pack_reports: [{ pack_id: 'pack-a' }],
    executed_gate_count: 1,
    reused_proof_count: 1
  } as any
  assert.equal(gatePackRunCoverageComplete(2, complete), true)
  assert.equal(gatePackRunCoverageComplete(3, complete), false)
  assert.equal(gatePackRunCoverageComplete(2, { ...complete, pack_reports: [] }), false)
  assert.equal(gatePackRunCoverageComplete(2, { ...complete, pack_reports: [...complete.pack_reports, ...complete.pack_reports] }), false)
})

test('current Desktop Bridge comprehensive selection is exact and contains only packaged bridge checks', () => {
  const manifest = loadReleaseGateManifest(process.cwd())
  const selected = selectReleaseGateClosure(manifest, ['desktop-bridge:comprehensive'])
  assert.deepEqual(selected.map((entry) => entry.id), ['desktop-bridge:comprehensive'])
  assert.equal(manifest.gates.some((entry) => entry.id === 'codex-lb:comprehensive'), false)
  const command = selected[0]?.command || ''
  assert.deepEqual(command.split(' && '), [
    'node ./dist/scripts/desktop-bridge-unification-check.js',
    'node ./dist/scripts/codex-lb-desktop-bridge-check.js',
    'node ./dist/scripts/codex-lb-desktop-bridge-latency-check.js',
    'node ./dist/scripts/codex-lb-catalog-passthrough-check.js',
    'node ./dist/scripts/codex-lb-desktop-capabilities-check.js'
  ])
})

test('current Desktop Bridge comprehensive scripts are all installed-runtime requirements', async () => {
  const manifest = loadReleaseGateManifest(process.cwd())
  const selected = selectReleaseGateClosure(manifest, ['desktop-bridge:comprehensive'])
  const commandPaths = (selected[0]?.command || '')
    .split(' && ')
    .map((command) => command.match(/node \.\/(dist\/scripts\/[^ ]+\.js)$/)?.[1])
    .filter((entry): entry is string => Boolean(entry))
  const runtimeManifest = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'runtime-required-scripts.json'),
    'utf8'
  )) as { scripts?: Array<{ path?: string }> }
  const requiredPaths = new Set((runtimeManifest.scripts || []).map((entry) => entry.path))
  assert.deepEqual(commandPaths, [
    'dist/scripts/desktop-bridge-unification-check.js',
    'dist/scripts/codex-lb-desktop-bridge-check.js',
    'dist/scripts/codex-lb-desktop-bridge-latency-check.js',
    'dist/scripts/codex-lb-catalog-passthrough-check.js',
    'dist/scripts/codex-lb-desktop-capabilities-check.js'
  ])
  for (const scriptPath of commandPaths) assert.equal(requiredPaths.has(scriptPath), true)
})

test('single-gate selection fails immediately for unknown gates and dependency cycles', () => {
  const manifest: ReleaseGateManifestV2 = {
    schema: 'sks.release-gates.v2',
    gates: [
      gate('gate:a', ['gate:b'], 'true'),
      gate('gate:b', ['gate:a'], 'true')
    ]
  }
  assert.throws(() => selectReleaseGateClosure(manifest, ['gate:missing']), /release_gate_only_selection_unknown:gate:missing/)
  assert.throws(() => selectReleaseGateClosure(manifest, ['gate:a']), /release_gate_only_selection_dependency_cycle:gate:a->gate:b->gate:a/)
})

async function waitForInProgressSummary(root: string): Promise<any> {
  const reportRoot = path.join(root, '.sneakoscope', 'reports', 'release-gates')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const names = await fs.readdir(reportRoot).catch(() => [])
    for (const name of names) {
      const file = path.join(reportRoot, name, 'summary.json')
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
        if (parsed?.in_progress === true && Number(parsed?.completed || 0) + Number(parsed?.failed || 0) < Number(parsed?.selected_gates || 0)) return parsed
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('in-progress release DAG summary was not observed')
}
