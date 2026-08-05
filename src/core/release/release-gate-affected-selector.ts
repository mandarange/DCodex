import { spawnSync } from 'node:child_process'
import type { ReleaseGateManifestV2, ReleaseGateNode } from './release-gate-node.js'

const ALWAYS_KEEP = new Set([
  'release:proof-truth',
  'typecheck',
  'schema:check'
])

export interface ReleaseGateAffectedSelection {
  schema: 'sks.release-gate-affected-selection.v1'
  mode: 'affected' | 'full'
  changed_files: string[]
  selected_gate_ids: string[]
  skipped_gate_ids: string[]
  reasons: Record<string, string>
}

export function selectAffectedReleaseGates(root: string, manifest: ReleaseGateManifestV2, gates: ReleaseGateNode[], input: {
  changedSince?: string | null
  changedFiles?: string[]
  full?: boolean
  preset?: string
} = {}): { gates: ReleaseGateNode[]; selection: ReleaseGateAffectedSelection } {
  if (input.full) {
    return selectionResult(gates, gates, [], 'full', {}, [])
  }
  const changedFiles = input.changedFiles ? [...new Set(input.changedFiles)].sort() : resolveChangedFiles(root, input.changedSince || 'auto')
  const selected: ReleaseGateNode[] = []
  const reasons: Record<string, string> = {}
  for (const gate of gates) {
    const reason = gateSelectionReason(gate, changedFiles, input.preset || 'affected')
    if (reason) {
      selected.push(gate)
      reasons[gate.id] = reason
    }
  }
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  for (const id of ALWAYS_KEEP) {
    const gate = byId.get(id) || manifest.gates.find((candidate) => candidate.id === id)
    if (gate && !selected.some((row) => row.id === gate.id)) {
      selected.push(gate)
      reasons[gate.id] = 'always_keep_core_release_safety'
    }
  }
  const expanded = input.preset === 'affected' || input.preset === 'fast'
    ? selected
    : expandWithDependencies(selected, manifest)
  const ordered = manifest.gates.filter((gate) => expanded.some((row) => row.id === gate.id))
  return selectionResult(gates, ordered, changedFiles, 'affected', reasons, gates.filter((gate) => !ordered.some((row) => row.id === gate.id)).map((gate) => gate.id))
}

function expandWithDependencies(selected: ReleaseGateNode[], manifest: ReleaseGateManifestV2) {
  const byId = new Map(manifest.gates.map((gate) => [gate.id, gate]))
  const out = new Map(selected.map((gate) => [gate.id, gate]))
  const visit = (gate: ReleaseGateNode) => {
    for (const dep of gate.deps || []) {
      const depGate = byId.get(dep)
      if (depGate && !out.has(depGate.id)) {
        out.set(depGate.id, depGate)
        visit(depGate)
      }
    }
  }
  for (const gate of selected) visit(gate)
  return [...out.values()]
}

function gateSelectionReason(gate: ReleaseGateNode, changedFiles: string[], preset: string) {
  if (ALWAYS_KEEP.has(gate.id)) return 'always_keep_core_release_safety'
  if (!changedFiles.length) return preset === 'fast' ? 'fast_no_diff_core_only_skip' : 'no_changed_files'
  const releaseGate = /^(release:|publish:|prepublish)/.test(gate.id)
  if (changedFiles.some((file) => file === 'package.json' || file === 'package-lock.json')) {
    if (/^(release:|publish:|prepublish|runtime:|typecheck|schema:check)/.test(gate.id)) return 'package_metadata_changed'
  }
  if (changedFiles.some((file) => file === 'release-gates.v2.json' || file.startsWith('src/core/release/'))) {
    if (releaseGate) return 'release_gate_system_changed'
  }
  if (changedFiles.some((file) => isCodexCurrentFile(file))) {
    if (gate.id.startsWith('codex:current') || gate.id.startsWith('codex-control:') || gate.id.startsWith('codex-sdk:')) return 'codex_current_surface_changed'
  }
  const matchingReleaseScript = changedFiles.some((file) => releaseScriptGateCandidates(file).includes(gate.id) || (file.startsWith('src/scripts/release-') && gateCommandReferencesScript(gate, file)))
  if (matchingReleaseScript) return 'release_script_changed'
  if (changedFiles.some((file) => file.startsWith('src/scripts/prepublish-') || file.startsWith('src/scripts/publish-'))) {
    if (releaseGate && gate.id === 'release:proof-truth') return 'publish_or_prepublish_script_changed'
  }
  if (changedFiles.some((file) => file.startsWith('src/scripts/scheduler-') || file.startsWith('src/core/scheduler/'))) {
    return gate.id.startsWith('scheduler:') ? 'scheduler_source_changed' : null
  }
  if (changedFiles.some((file) => file.startsWith('src/core/research/'))) return gate.id.startsWith('research:') ? 'research_source_changed' : null
  if (
    changedFiles.some((file) => file.includes('/db') || file.includes('mad-sks/sql-plane') || file.includes('mcp'))
    && /db|mcp|mad-sks/.test(gate.id)
  ) return 'db_mcp_or_mad_sks_sql_plane_changed'
  const inputs = (gate.cache?.inputs || []).filter((pattern) => !isBroadAffectedInput(pattern))
  if (inputs.some((pattern) => changedFiles.some((file) => matchesGlobish(file, pattern)))) return 'cache_input_changed'
  return null
}

function isCodexCurrentFile(file: string) {
  return file.startsWith('src/core/codex-control/')
    || file.startsWith('src/core/codex-compat/')
    || file.startsWith('src/core/codex-runtime/')
    || file.startsWith('src/core/codex-app-server/')
    || file.startsWith('src/core/codex-policy/')
    || file === 'src/commands/codex.ts'
    || file === 'src/cli/install-helpers.ts'
    || file.startsWith('config/codex-releases/')
    || file.startsWith('schemas/codex-')
}

function selectionResult(all: ReleaseGateNode[], selected: ReleaseGateNode[], changedFiles: string[], mode: 'affected' | 'full', reasons: Record<string, string>, skipped: string[]) {
  return {
    gates: selected,
    selection: {
      schema: 'sks.release-gate-affected-selection.v1' as const,
      mode,
      changed_files: changedFiles,
      selected_gate_ids: selected.map((gate) => gate.id),
      skipped_gate_ids: skipped.length ? skipped : all.filter((gate) => !selected.some((row) => row.id === gate.id)).map((gate) => gate.id),
      reasons
    }
  }
}

export function resolveChangedFiles(root: string, changedSince: string) {
  const base = changedSince === 'auto' ? autoChangedFilesBase(root) : changedSince
  const args = base === 'HEAD'
    ? ['diff', '--name-only', 'HEAD']
    : ['diff', '--name-only', String(base)]
  const diff = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })
  const files = [
    ...String(diff.stdout || '').split(/\n/),
    ...String(status.stdout || '').split(/\n/).map((line) => line.slice(3))
  ].map((file) => file.trim()).filter(Boolean)
  return [...new Set(files)].sort()
}

function autoChangedFilesBase(root: string) {
  const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: root,
    encoding: 'utf8'
  })
  const upstreamRef = upstream.status === 0 ? String(upstream.stdout || '').trim() : ''
  if (!upstreamRef) return 'HEAD'
  const mergeBase = spawnSync('git', ['merge-base', 'HEAD', upstreamRef], { cwd: root, encoding: 'utf8' })
  const base = mergeBase.status === 0 ? String(mergeBase.stdout || '').trim() : ''
  return base || 'HEAD'
}

function gateCommandReferencesScript(gate: ReleaseGateNode, file: string): boolean {
  const base = file.replace(/\\/g, '/').split('/').pop()?.replace(/\.(ts|tsx)$/, '') || ''
  if (!base) return false
  return gate.command.includes(`/${base}.js`)
}

function matchesGlobish(file: string, pattern: string) {
  const normalized = pattern.replace(/\\/g, '/')
  if (normalized === file) return true
  if (normalized.endsWith('/**')) return file.startsWith(normalized.slice(0, -3))
  if (normalized.endsWith('/**/*')) return file.startsWith(normalized.slice(0, -5))
  if (normalized.includes('**')) return file.startsWith(normalized.split('**')[0] || '')
  if (normalized.endsWith('*')) return file.startsWith(normalized.slice(0, -1))
  return false
}

function isBroadAffectedInput(pattern: string) {
  const normalized = pattern.replace(/\\/g, '/')
  return new Set([
    '**',
    '**/*',
    'src/**',
    'src/**/*',
    'schemas/**',
    'schemas/**/*',
    'package.json',
    'package-lock.json',
    'release-gates.v2.json'
  ]).has(normalized)
}

function releaseScriptGateCandidates(file: string) {
  const normalized = file.replace(/\\/g, '/')
  const base = normalized.split('/').pop()?.replace(/\.(ts|js|mjs|cjs)$/, '') || ''
  if (!base.startsWith('release-')) return []
  const rest = base.slice('release-'.length)
  const withoutCheck = rest.replace(/-check$/, '')
  return [
    `release:${rest}`,
    `release:${withoutCheck}`,
    `release:${withoutCheck}:check`
  ]
}
