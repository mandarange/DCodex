import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, nowIso, readText, writeJsonAtomic } from '../fsx.js'
import { isUnmanagedProjectCodexConfig, writeCodexConfigGuarded } from '../codex/codex-config-guard.js'
import { escapeRegExp } from '../text/regex.js'

export const DOCTOR_CODEX_STARTUP_REPAIR_SCHEMA = 'sks.doctor-codex-startup-repair.v1'

type Scope = 'project' | 'global'

export interface DoctorCodexStartupRepairResult {
  schema: typeof DOCTOR_CODEX_STARTUP_REPAIR_SCHEMA
  ok: boolean
  generated_at: string
  fix: boolean
  configs: Array<{
    scope: Scope
    path: string
    present: boolean
    changed: boolean
    backup_path: string | null
    agent_config_files_repaired: string[]
    stale_mcp_blocks_removed: string[]
    mcp_blocks_repaired: string[]
    optional_mcp_blocks_ignored: string[]
    blockers: string[]
    warnings: string[]
    duplicate_toml_blocks_removed: string[]
  }>
  agent_role_files: {
    sanitized: string[]
    created: string[]
    blockers: string[]
  }
  actions: string[]
  manual_actions: string[]
  blockers: string[]
  warnings: string[]
  report_path: string
}

export async function runDoctorCodexStartupRepair(input: {
  root: string
  fix: boolean
  codexHome?: string
  nodeReplCommandCandidates?: string[]
  includeDefaultNodeReplCandidates?: boolean
}): Promise<DoctorCodexStartupRepairResult> {
  const root = path.resolve(input.root || process.cwd())
  const codexHome = input.codexHome || process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex')
  // Project-scoped official custom-agent installation is owned by repairAgentRoleConfigs.
  // This startup repair remains structural/MCP-only and never touches legacy
  // or user agent TOMLs in project or global directories.
  const roleFiles = { sanitized: [], created: [], blockers: [] }
  const configs = []
  for (const candidate of [
    { scope: 'project' as const, path: path.join(root, '.codex', 'config.toml'), agentDir: path.join(root, '.codex', 'agents') },
    { scope: 'global' as const, path: path.join(codexHome, 'config.toml'), agentDir: path.join(codexHome, 'agents') }
  ]) {
    configs.push(await inspectOrRepairConfig(root, candidate, input.fix, input.nodeReplCommandCandidates || [], input.includeDefaultNodeReplCandidates !== false))
  }
  const blockers = [...roleFiles.blockers, ...configs.flatMap((entry) => entry.blockers.map((item) => `${entry.scope}:${item}`))]
  const warnings = configs.flatMap((entry) => entry.warnings.map((item) => `${entry.scope}:${item}`))
  const actions = [
    ...roleFiles.sanitized.map((file) => `removed unsupported message_role_prefix from ${file}`),
    ...roleFiles.created.map((file) => `created missing SKS agent role config ${file}`),
    ...configs.flatMap((entry) => [
      ...entry.agent_config_files_repaired.map((file) => `${entry.scope} agent config_file now points at ${file}`),
      ...(entry.mcp_blocks_repaired || []).map((server) => `${entry.scope} MCP block repaired: ${server}`),
      ...entry.stale_mcp_blocks_removed.map((server) => `${entry.scope} stale MCP block removed: ${server}`),
      ...entry.duplicate_toml_blocks_removed.map((header) => `${entry.scope} duplicate TOML table removed: ${header}`)
    ])
  ]
  const manualActions = [
    ...configs.flatMap((entry) => entry.blockers
      .filter((item) => item.includes('codex_apps_token_expired'))
      .map(() => 'Codex Apps MCP token is expired; sign in to Codex App/CLI again so the connector can mint a fresh token.')),
    ...configs.flatMap((entry) => entry.blockers
      .filter((item) => item.includes('supabase_access_token_missing'))
      .map(() => 'Supabase MCP uses SUPABASE_ACCESS_TOKEN but the variable is unset; export the token or migrate that server to a read-only remote URL.'))
  ]
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'doctor-codex-startup-repair.json')
  const report: DoctorCodexStartupRepairResult = {
    schema: DOCTOR_CODEX_STARTUP_REPAIR_SCHEMA,
    ok: blockers.length === 0,
    generated_at: nowIso(),
    fix: input.fix === true,
    configs,
    agent_role_files: roleFiles,
    actions,
    manual_actions: [...new Set(manualActions)],
    blockers,
    warnings,
    report_path: reportPath
  }
  await writeJsonAtomic(reportPath, report)
  return report
}

async function inspectOrRepairConfig(root: string, candidate: { scope: Scope; path: string; agentDir: string }, fix: boolean, nodeReplCommandCandidates: string[], includeDefaultNodeReplCandidates: boolean): Promise<DoctorCodexStartupRepairResult['configs'][number]> {
  const text = await readText(candidate.path, null)
  if (text == null) {
    return {
      scope: candidate.scope,
      path: candidate.path,
      present: false,
      changed: false,
      backup_path: null,
      agent_config_files_repaired: [],
      stale_mcp_blocks_removed: [],
      mcp_blocks_repaired: [],
      optional_mcp_blocks_ignored: [],
      blockers: [],
      warnings: candidate.scope === 'global' ? ['codex_home_config_missing_optional'] : [],
      duplicate_toml_blocks_removed: []
    }
  }
  if (fix && isUnmanagedProjectCodexConfig(root, candidate.path, text)) {
    return {
      scope: candidate.scope,
      path: candidate.path,
      present: true,
      changed: false,
      backup_path: null,
      agent_config_files_repaired: [],
      stale_mcp_blocks_removed: [],
      mcp_blocks_repaired: [],
      optional_mcp_blocks_ignored: [],
      blockers: ['user_owned_file_without_sks_marker'],
      warnings: ['unmanaged_project_config_preserved'],
      duplicate_toml_blocks_removed: []
    }
  }
  let next = text
  const agentConfigFilesRepaired: string[] = []
  const staleMcpBlocksRemoved: string[] = []
  const mcpBlocksRepaired: string[] = []
  const optionalMcpBlocksIgnored: string[] = []
  const duplicateTomlBlocksRemoved: string[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  const duplicateRepair = inspectOrRepairDuplicateTomlBlocks(next, candidate, fix)
  next = duplicateRepair.text
  duplicateTomlBlocksRemoved.push(...duplicateRepair.removed)
  warnings.push(...duplicateRepair.warnings)

  const nodeReplRepair = await inspectOrRepairNodeRepl(next, fix, nodeReplCommandCandidates, includeDefaultNodeReplCandidates)
  next = nodeReplRepair.text
  warnings.push(...nodeReplRepair.warnings)
  staleMcpBlocksRemoved.push(...nodeReplRepair.removed)
  mcpBlocksRepaired.push(...nodeReplRepair.repaired)

  for (const server of ['supabase_sauron']) {
    if (tomlBlock(next, `mcp_servers.${server}`)) optionalMcpBlocksIgnored.push(server)
  }

  const supabase = tomlBlock(next, 'mcp_servers.supabase')
  if (supabase && /\bSUPABASE_ACCESS_TOKEN\b/.test(supabase.text) && !process.env.SUPABASE_ACCESS_TOKEN) {
    blockers.push('supabase_access_token_missing')
  }
  const codexApps = tomlBlock(next, 'mcp_servers.codex_apps')
  if (codexApps && /token_expired|expired/i.test(codexApps.text)) blockers.push('codex_apps_token_expired')

  const plannedChanged = next !== text
  let changed = plannedChanged
  let backupPath: string | null = null
  let writeApplied = true
  if (plannedChanged && fix) {
    const guarded = await writeCodexConfigGuarded({
      root,
      configPath: candidate.path,
      before: text,
      cause: 'doctor-codex-startup-repair',
      mutate: () => next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
    })
    writeApplied = guarded.ok
    changed = guarded.ok && guarded.changed
    backupPath = guarded.backup_path
    if (!guarded.ok) {
      blockers.push(`config_write_guard:${guarded.status}`)
      warnings.push(`config_preserved:${guarded.status}`)
    }
  }
  return {
    scope: candidate.scope,
    path: candidate.path,
    present: true,
    changed,
    backup_path: backupPath,
    agent_config_files_repaired: writeApplied ? agentConfigFilesRepaired : [],
    stale_mcp_blocks_removed: writeApplied ? staleMcpBlocksRemoved : [],
    mcp_blocks_repaired: writeApplied ? mcpBlocksRepaired : [],
    optional_mcp_blocks_ignored: optionalMcpBlocksIgnored,
    blockers,
    warnings,
    duplicate_toml_blocks_removed: writeApplied ? duplicateTomlBlocksRemoved : []
  }
}

function inspectOrRepairDuplicateTomlBlocks(text: string, candidate: { scope: Scope; path: string; agentDir: string }, fix: boolean) {
  const blocks = tomlBlocks(text)
  const groups = new Map<string, Array<TomlNamedBlock>>()
  for (const block of blocks) {
    const list = groups.get(block.header) || []
    list.push(block)
    groups.set(block.header, list)
  }
  const warnings: string[] = []
  const removals: TomlNamedBlock[] = []
  for (const [header, rows] of groups) {
    if (rows.length < 2) continue
    warnings.push(`duplicate_toml_table:${header}`)
    const keep = selectDuplicateTomlBlockToKeep(header, rows, candidate)
    for (let index = 0; index < rows.length; index += 1) {
      if (index !== keep) removals.push(rows[index] as TomlNamedBlock)
    }
  }
  if (!removals.length || !fix) return { text, warnings, removed: [] as string[] }
  return {
    text: removeBlocks(text, removals),
    warnings,
    removed: removals.map((block) => block.header)
  }
}

interface TomlNamedBlock {
  header: string
  start: number
  end: number
  text: string
}

function tomlBlocks(text: string): TomlNamedBlock[] {
  const source = String(text || '')
  const matches = [...source.matchAll(/(^|\n)\s*\[([^\]]+)\]\s*(?:#.*)?(?:\n|$)/g)]
  return matches.map((match, index) => {
    const start = Number(match.index || 0) + (match[1] ? 1 : 0)
    const next = matches[index + 1]
    const end = next ? Number(next.index || 0) + (next[1] ? 1 : 0) : source.length
    return {
      header: String(match[2] || '').trim(),
      start,
      end,
      text: source.slice(start, end)
    }
  })
}

function selectDuplicateTomlBlockToKeep(header: string, rows: TomlNamedBlock[], candidate: { agentDir: string }): number {
  void candidate
  if (header.startsWith('mcp_servers.')) return 0
  return maxIndexBy(rows, (block, index) => assignmentCount(block.text) - index / 1000)
}

function maxIndexBy<T>(rows: T[], score: (row: T, index: number) => number): number {
  let best = 0
  let bestScore = Number.NEGATIVE_INFINITY
  rows.forEach((row, index) => {
    const value = score(row, index)
    if (value > bestScore) {
      best = index
      bestScore = value
    }
  })
  return best
}

function assignmentCount(text: string): number {
  return String(text || '').split(/\r?\n/).filter((line) => /^\s*[A-Za-z0-9_.-]+\s*=/.test(line)).length
}

async function inspectOrRepairNodeRepl(text: string, fix: boolean, extraCandidates: string[], includeDefaultCandidates: boolean) {
  const server = 'node_repl'
  const table = tomlBlock(text, `mcp_servers.${server}`)
  const fullTable = tomlBlockWithChildren(text, `mcp_servers.${server}`)
  const childBlocks = tomlChildBlocks(text, `mcp_servers.${server}`)
  if (!table && childBlocks.length === 0) return { text, warnings: [] as string[], removed: [] as string[], repaired: [] as string[] }

  const command = table ? stringValue(table.text, 'command') : null
  if (command && await commandExists(command)) {
    return { text, warnings: [] as string[], removed: [] as string[], repaired: [] as string[] }
  }

  const warnings = [table ? `stale_mcp_command_missing:${server}` : `stale_mcp_orphan_children:${server}`]
  if (!fix) return { text, warnings, removed: [] as string[], repaired: [] as string[] }

  const replacement = await firstExistingNodeReplCommand(text, extraCandidates, includeDefaultCandidates)
  if (replacement) {
    if (table) {
      return {
        text: replaceOrInsertKey(text, table, 'command', `"${escapeToml(replacement)}"`),
        warnings,
        removed: [] as string[],
        repaired: [server]
      }
    }
    if (childBlocks.length) {
      const firstChild = childBlocks[0]
      if (!firstChild) return { text, warnings, removed: [] as string[], repaired: [] as string[] }
      const mainBlock = `[mcp_servers.${server}]\ncommand = "${escapeToml(replacement)}"\nargs = []\n\n`
      return {
        text: `${text.slice(0, firstChild.start).trimEnd()}${firstChild.start > 0 ? '\n\n' : ''}${mainBlock}${text.slice(firstChild.start).replace(/^\n+/, '')}`,
        warnings,
        removed: [] as string[],
        repaired: [server]
      }
    }
  }

  const removalBlocks = [
    ...(fullTable ? [fullTable] : table ? [table] : []),
    ...childBlocks.filter((block) => !fullTable || block.start < fullTable.start || block.end > fullTable.end)
  ]
  return {
    text: removeBlocks(text, removalBlocks),
    warnings,
    removed: [server],
    repaired: [] as string[]
  }
}

function tomlBlock(text: string, table: string): { start: number; end: number; text: string } | null {
  const header = new RegExp(`(^|\\n)\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?(?:\\n|$)`, 'g')
  const match = header.exec(text)
  if (!match) return null
  const start = match.index + (match[1] ? 1 : 0)
  const rest = text.slice(header.lastIndex)
  const nextHeader = rest.search(/\n\s*\[[^\]]+\]\s*(?:#.*)?(?:\n|$)/)
  const end = nextHeader >= 0 ? header.lastIndex + nextHeader : text.length
  return { start, end, text: text.slice(start, end) }
}

function tomlBlockWithChildren(text: string, table: string): { start: number; end: number; text: string } | null {
  const header = new RegExp(`(^|\\n)\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?(?:\\n|$)`, 'g')
  const match = header.exec(text)
  if (!match) return null
  const start = match.index + (match[1] ? 1 : 0)
  const rest = text.slice(header.lastIndex)
  const nextHeader = rest.search(new RegExp(`\\n\\s*\\[(?!${escapeRegExp(table)}(?:\\.|\\]))[^\\]]+\\]\\s*(?:#.*)?(?:\\n|$)`))
  const end = nextHeader >= 0 ? header.lastIndex + nextHeader : text.length
  return { start, end, text: text.slice(start, end) }
}

function tomlChildBlocks(text: string, table: string): Array<{ start: number; end: number; text: string }> {
  const blocks: Array<{ start: number; end: number; text: string }> = []
  const header = new RegExp(`(^|\\n)\\s*\\[${escapeRegExp(table)}\\.[^\\]]+\\]\\s*(?:#.*)?(?:\\n|$)`, 'g')
  let match: RegExpExecArray | null
  while ((match = header.exec(text))) {
    const start = match.index + (match[1] ? 1 : 0)
    const rest = text.slice(header.lastIndex)
    const nextHeader = rest.search(new RegExp(`\\n\\s*\\[(?!${escapeRegExp(table)}\\.)[^\\]]+\\]\\s*(?:#.*)?(?:\\n|$)`))
    const end = nextHeader >= 0 ? header.lastIndex + nextHeader : text.length
    blocks.push({ start, end, text: text.slice(start, end) })
  }
  return blocks
}

function removeTomlBlock(text: string, block: { start: number; end: number }): string {
  return `${text.slice(0, block.start).trimEnd()}${block.start > 0 ? '\n\n' : ''}${text.slice(block.end).replace(/^\n+/, '')}`
}

function removeBlocks(text: string, blocks: Array<{ start: number; end: number }>): string {
  return [...blocks]
    .sort((a, b) => b.start - a.start)
    .reduce((current, block) => removeTomlBlock(current, block), text)
}

function replaceOrInsertKey(text: string, block: { start: number; end: number; text: string }, key: string, encodedValue: string): string {
  const lines = block.text.replace(/\s*$/, '').split('\n')
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  const index = lines.findIndex((line) => re.test(line))
  if (index >= 0) lines[index] = `${key} = ${encodedValue}`
  else lines.push(`${key} = ${encodedValue}`)
  const replacement = `${lines.join('\n')}\n`
  return `${text.slice(0, block.start)}${replacement}${text.slice(block.end)}`
}

function stringValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, 'm'))
  return match && typeof match[1] === 'string' ? match[1] : null
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes(path.sep)) return exists(command)
  const paths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of paths) if (await exists(path.join(dir, command))) return true
  return false
}

async function firstExistingNodeReplCommand(configText: string, extraCandidates: string[], includeDefaultCandidates: boolean): Promise<string | null> {
  const candidates = [
    ...extraCandidates,
    ...(includeDefaultCandidates ? [
      process.env.SKS_NODE_REPL_COMMAND,
      process.env.NODE_REPL_COMMAND,
      ...nodeReplCandidatesFromNodePaths([
        ...stringValues(configText, 'NODE_REPL_NODE_PATH'),
        process.env.NODE_REPL_NODE_PATH
      ]),
      '/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl',
      '/Applications/Codex.app/Contents/Resources/node_repl'
    ] : [])
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (await commandExists(candidate)) return candidate
  }
  return null
}

function nodeReplCandidatesFromNodePaths(values: Array<string | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    const nodePath = String(value || '').trim()
    if (!nodePath) continue
    const dir = path.dirname(nodePath)
    out.push(path.join(dir, 'node_repl'))
    const resources = path.basename(dir) === 'bin' ? path.dirname(path.dirname(dir)) : dir
    out.push(path.join(resources, 'cua_node', 'bin', 'node_repl'))
  }
  return out
}

function stringValues(text: string, key: string): string[] {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, 'gm')
  return [...text.matchAll(re)].map((match) => String(match[1] || '')).filter(Boolean)
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
