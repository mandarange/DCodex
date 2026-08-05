import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { selectAffectedReleaseGates } from '../release-gate-affected-selector.js'

test('auto changed-since includes committed work ahead of the tracked upstream', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-affected-upstream-'))
  const remote = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-affected-remote-'))
  try {
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'sks@example.test'])
    git(root, ['config', 'user.name', 'SKS Test'])
    await fsp.writeFile(path.join(root, 'baseline.txt'), 'baseline\n')
    git(root, ['add', 'baseline.txt'])
    git(root, ['commit', '-m', 'baseline'])
    git(remote, ['init', '--bare'])
    git(root, ['remote', 'add', 'origin', remote])
    git(root, ['push', '-u', 'origin', 'main'])

    await fsp.mkdir(path.join(root, 'src', 'feature'), { recursive: true })
    await fsp.writeFile(path.join(root, 'src', 'feature', 'change.ts'), 'export const changed = true\n')
    git(root, ['add', 'src/feature/change.ts'])
    git(root, ['commit', '-m', 'feature change'])

    const gate: any = {
      id: 'test:feature-change',
      command: 'node fixture.js',
      deps: [],
      preset: ['release'],
      cache: { enabled: true, inputs: ['src/feature/**'] }
    }
    const manifest: any = { gates: [gate] }
    const selected = selectAffectedReleaseGates(root, manifest, [gate], {
      changedSince: 'auto',
      preset: 'affected'
    })

    assert.ok(selected.selection.changed_files.includes('src/feature/change.ts'))
    assert.ok(selected.selection.selected_gate_ids.includes('test:feature-change'))
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(remote, { recursive: true, force: true })
  }
})

test('an MCP change does not suppress unrelated gates selected by another changed file', () => {
  const mcpGate: any = {
    id: 'test:mcp-config',
    command: 'node mcp-test.js',
    deps: [],
    preset: ['release'],
    cache: { enabled: true, inputs: ['src/core/commands/**'] }
  }
  const roleGate: any = {
    id: 'test:role-models',
    command: 'node role-test.js',
    deps: [],
    preset: ['release'],
    cache: { enabled: true, inputs: ['src/core/subagents/**'] }
  }
  const gates = [mcpGate, roleGate]
  const selected = selectAffectedReleaseGates(process.cwd(), { gates } as any, gates, {
    changedFiles: [
      'src/core/commands/__tests__/mcp-config-command.test.ts',
      'src/core/subagents/role-model-preferences.ts'
    ],
    preset: 'affected'
  })

  assert.deepEqual(selected.selection.selected_gate_ids, ['test:mcp-config', 'test:role-models'])
  assert.equal(selected.selection.reasons['test:mcp-config'], 'db_mcp_or_mad_sks_sql_plane_changed')
  assert.equal(selected.selection.reasons['test:role-models'], 'cache_input_changed')
})

test('package metadata changes do not select unrelated Codex-current gates', () => {
  const releaseGate: any = {
    id: 'release:metadata-current',
    command: 'node release-check.js',
    deps: [],
    preset: ['release'],
    cache: { enabled: true, inputs: ['package.json'] }
  }
  const runtimeGate: any = {
    id: 'runtime:closure',
    command: 'node runtime-check.js',
    deps: [],
    preset: ['release'],
    cache: { enabled: true, inputs: ['package.json'] }
  }
  const codexGate: any = {
    id: 'codex-control:regression',
    command: 'node codex-check.js',
    deps: [],
    preset: ['release'],
    cache: { enabled: true, inputs: ['src/core/codex-control/**'] }
  }
  const gates = [releaseGate, runtimeGate, codexGate]
  const selected = selectAffectedReleaseGates(process.cwd(), { gates } as any, gates, {
    changedFiles: ['package.json', 'package-lock.json'],
    preset: 'affected'
  })

  assert.deepEqual(selected.selection.selected_gate_ids, [releaseGate.id, runtimeGate.id])
  assert.equal(selected.selection.reasons[releaseGate.id], 'package_metadata_changed')
  assert.equal(selected.selection.reasons[runtimeGate.id], 'package_metadata_changed')
  assert.equal(selected.selection.reasons[codexGate.id], undefined)
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`)
}
