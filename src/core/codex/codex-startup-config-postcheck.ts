import fs from 'node:fs/promises'
import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import {
  inspectOfficialSubagentToml,
  installOfficialSubagentAgentConfigs,
  readOfficialSubagentConfig
} from '../subagents/official-subagent-config.js'

export async function postcheckCodexStartupConfig(input: {
  root: string
  reportPath?: string | null
  home?: string
  codexHome?: string
}) {
  const root = path.resolve(input.root)
  const configPath = path.join(root, '.codex', 'config.toml')
  const text = await fs.readFile(configPath, 'utf8').catch(() => '')
  const configPresent = Boolean(text.trim())
  const tomlValidation = inspectOfficialSubagentToml(text)
  const officialConfig = await readOfficialSubagentConfig(root, {
    ...(input.home ? { home: input.home } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    projectConfigPath: configPath
  })
  const rolePlan = await installOfficialSubagentAgentConfigs(root, { apply: false })
  const tomlSmoke = tomlSyntaxSmoke(text)
  const orphanChildTables = orphanMcpChildTables(text)
  // `enabled` and `multi_agent_v2.enabled` were reported but gated nothing, so
  // the postcheck passed on a config where the official subagent lane is off.
  // Codex resolves `multi_agent_v2 = true` to V2 unconditionally and ignores
  // `agents.enabled` in that case (verified against Codex 0.147), so
  // `agents.enabled = false` is only fatal when v2 is also off.
  const multiAgentV2Disabled = officialConfig.multiAgentV2.enabled === false
  const blockers = [
    ...(!configPresent ? ['project_official_subagent_config_missing'] : []),
    ...(!tomlValidation.ok ? ['project_official_subagent_config_toml_parse_failed'] : []),
    ...(multiAgentV2Disabled ? ['official_subagent_multi_agent_v2_disabled'] : []),
    ...(multiAgentV2Disabled && officialConfig.enabled === false
      ? ['official_subagent_agents_disabled']
      : []),
    ...officialConfig.blockers.map((item) => `official_subagent_config:${item}`),
    ...rolePlan.missing.map((file) => `missing_official_subagent_agent:${file}`),
    ...rolePlan.stale.map((file) => `stale_official_subagent_agent:${file}`),
    ...rolePlan.manual_blockers,
    ...tomlSmoke.blockers,
    ...orphanChildTables.map((table) => `orphan_mcp_child_table:${table}`)
  ]
  const report = {
    schema: 'sks.codex-startup-config-postcheck.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    config_path: configPath,
    missing_config_files: [],
    relative_config_files: [],
    unsupported_managed_role_fields: false,
    official_subagent_config: {
      enabled: officialConfig.enabled,
      max_threads: officialConfig.maxThreads,
      max_concurrent_threads_per_session: officialConfig.maxThreads,
      max_depth: officialConfig.maxDepth,
      job_max_runtime_seconds: officialConfig.jobMaxRuntimeSeconds,
      interrupt_message: officialConfig.interruptMessage,
      default_subagent_model: officialConfig.defaultSubagentModel,
      default_subagent_reasoning_effort: officialConfig.defaultSubagentReasoningEffort,
      multi_agent_v2: officialConfig.multiAgentV2,
      sources: officialConfig.sources,
      warnings: officialConfig.warnings
    },
    official_subagent_agents: {
      missing: rolePlan.missing,
      stale: rolePlan.stale,
      existing: rolePlan.existing,
      preserved: rolePlan.preserved,
      manual_blockers: rolePlan.manual_blockers
    },
    legacy_agent_tables_preserved: true,
    toml_syntax_smoke_ok: tomlSmoke.ok,
    orphan_mcp_child_tables: orphanChildTables,
    blockers
  }
  if (input.reportPath !== null) {
    await writeJsonAtomic(input.reportPath || path.join(root, '.sneakoscope', 'reports', 'codex-startup-config-postcheck.json'), report).catch(() => undefined)
  }
  return report
}

function tomlSyntaxSmoke(text: string): { ok: boolean; blockers: string[] } {
  const blockers: string[] = []
  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    if (!/^\[[^\]]+\]\s*(?:#.*)?$/.test(trimmed)) blockers.push(`toml_table_header_invalid:${index + 1}`)
  }
  const tripleQuotes = (String(text || '').match(/"""/g) || []).length
  if (tripleQuotes % 2 !== 0) blockers.push('toml_multiline_string_unbalanced')
  return { ok: blockers.length === 0, blockers }
}

function orphanMcpChildTables(text: string): string[] {
  const headers = new Set(tomlBlocks(text).map((block) => block.header))
  return [...headers].filter((header) => {
    const match = header.match(/^mcp_servers\.([^.]+)\./)
    return Boolean(match && !headers.has(`mcp_servers.${match[1]}`))
  })
}

function tomlBlocks(text: string): Array<{ header: string; text: string }> {
  const source = String(text || '')
  const matches = [...source.matchAll(/(^|\n)\s*\[([^\]]+)\]\s*(?:#.*)?(?:\n|$)/g)]
  return matches.map((match, index) => {
    const start = Number(match.index || 0) + (match[1] ? 1 : 0)
    const next = matches[index + 1]
    const end = next ? Number(next.index || 0) + (next[1] ? 1 : 0) : source.length
    return { header: String(match[2] || '').trim(), text: source.slice(start, end) }
  })
}
