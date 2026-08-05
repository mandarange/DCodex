import { nowIso } from '../fsx.js'

export const MCP_TOOL_POLICY_SCHEMA = 'sks.mcp-tool-policy.v1'

export interface McpServerPolicy {
  name: string
  environment_keys: string[]
  transport: string | null
  oauth_configured: boolean
}

export interface McpToolClassification {
  name: string
  read_only_hint: boolean
  concurrency: 'candidate_parallel_readonly' | 'serial_required'
  advisory_only: boolean
  warnings: string[]
}

export interface McpReadOnlyRuntimeToolFixture {
  name: string
  annotations?: Record<string, any>
  inputSchema?: Record<string, any>
  durationMs?: number
}

export interface McpReadOnlyRuntimeToolProof {
  name: string
  concurrency: McpToolClassification['concurrency']
  scheduled_mode: 'parallel_readonly_batch' | 'serial_required'
  batch_id: string
  started_at_ms: number
  ended_at_ms: number
  duration_ms: number
}

export interface McpReadOnlyRuntimeSchedulerProof {
  schema: 'sks.mcp-readonly-runtime-scheduler-proof.v1'
  generated_at: string
  ok: boolean
  read_only_parallel: boolean
  write_serial: boolean
  destructive_false_positive_blocked: boolean
  overlap_evidence: Array<{ a: string; b: string; overlap_ms: number }>
  tools: McpReadOnlyRuntimeToolProof[]
  blockers: string[]
}

const DESTRUCTIVE_TOOL_RE = /(?:^|[^A-Za-z0-9])(write|delete|remove|rm|mutate|update|insert|create|drop|truncate|reset|publish|deploy|apply|patch|commit|push)(?:$|[^A-Za-z0-9])/i
const DESTRUCTIVE_WORDS = [
  'write',
  'delete',
  'remove',
  'rm',
  'mutate',
  'update',
  'insert',
  'create',
  'drop',
  'truncate',
  'reset',
  'publish',
  'deploy',
  'apply',
  'patch',
  'commit',
  'push'
]

export function classifyMcpToolForConcurrency(tool: any): McpToolClassification {
  const annotations = tool?.annotations || tool?.inputSchema?.annotations || tool?.schema?.annotations || {}
  const readOnlyHint = annotations.readOnlyHint === true
  const name = String(tool?.name || tool?.id || '')
  const schemaText = safeJson(tool?.inputSchema || tool?.schema || {})
  const destructive =
    hasDestructiveSignal(name) ||
    hasDestructiveSignal(schemaText) ||
    annotations.destructiveHint === true
  return {
    name,
    read_only_hint: readOnlyHint,
    concurrency: readOnlyHint && !destructive ? 'candidate_parallel_readonly' : 'serial_required',
    advisory_only: true,
    warnings: [
      ...(readOnlyHint ? ['readOnlyHint_is_advisory_not_authoritative'] : ['readOnlyHint_missing']),
      ...(destructive ? ['destructive_name_or_schema_blocks_parallel_mcp'] : [])
    ]
  }
}

export function compactMcpToolSchema(schema: any, maxBytes = 8192) {
  const text = safeJson(schema)
  const hasDollarDefs = Boolean(schema?.$defs)
  const hasDefinitions = Boolean(schema?.definitions)
  const refs = collectRefs(schema)
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return {
      schema,
      compacted: false,
      original_bytes: Buffer.byteLength(text, 'utf8'),
      preserved_ref_defs: refs.length > 0 || hasDollarDefs || hasDefinitions,
      refs
    }
  }
  const preservedDefs: Record<string, any> = {}
  if (hasDollarDefs) preservedDefs.$defs = schema.$defs
  if (hasDefinitions) preservedDefs.definitions = schema.definitions
  return {
    schema: {
      type: schema?.type || 'object',
      description: String(schema?.description || '').slice(0, 512),
      properties: Object.fromEntries(Object.entries(schema?.properties || {}).slice(0, 50)),
      ...(Array.isArray(schema?.oneOf) ? { oneOf: schema.oneOf } : {}),
      ...(Array.isArray(schema?.allOf) ? { allOf: schema.allOf } : {}),
      ...(Array.isArray(schema?.required) ? { required: schema.required } : {}),
      ...preservedDefs,
      ...(refs.length ? { refs } : {})
    },
    compacted: true,
    original_bytes: Buffer.byteLength(text, 'utf8'),
    preserved_ref_defs: refs.length > 0 || hasDollarDefs || hasDefinitions,
    refs
  }
}

export async function proveMcpReadOnlyRuntimeScheduler(input: {
  readOnlyTools?: McpReadOnlyRuntimeToolFixture[]
  writeTools?: McpReadOnlyRuntimeToolFixture[]
} = {}): Promise<McpReadOnlyRuntimeSchedulerProof> {
  const readOnlyTools = input.readOnlyTools || [
    { name: 'docs_search_a', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' }, durationMs: 25 },
    { name: 'docs_search_b', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' }, durationMs: 25 },
    { name: 'docs_lookup_c', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' }, durationMs: 25 }
  ]
  const writeTools = input.writeTools || [
    { name: 'docs_update', annotations: { readOnlyHint: false }, inputSchema: { type: 'object' }, durationMs: 5 },
    { name: 'delete_docs', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { destructiveOperation: { const: 'delete' } } }, durationMs: 5 }
  ]
  const readOnlyCandidates = readOnlyTools.filter((tool) => classifyMcpToolForConcurrency(tool).concurrency === 'candidate_parallel_readonly')
  const readOnlySerial = readOnlyTools.filter((tool) => classifyMcpToolForConcurrency(tool).concurrency !== 'candidate_parallel_readonly')
  const readOnlyRows = await Promise.all(readOnlyCandidates.map((tool) => runMcpRuntimeFixture(tool, 'parallel_readonly_batch', 'readonly-parallel-001')))
  const writeRows: McpReadOnlyRuntimeToolProof[] = []
  for (const tool of [...readOnlySerial, ...writeTools]) writeRows.push(await runMcpRuntimeFixture(tool, 'serial_required', `serial-${String(writeRows.length + 1).padStart(3, '0')}`))
  const tools = [...readOnlyRows, ...writeRows]
  const overlapEvidence = collectOverlapEvidence(readOnlyRows)
  const readOnlyParallel = readOnlyRows.length < 2 || overlapEvidence.length > 0
  const writeSerial = collectOverlapEvidence(writeRows).length === 0
  const destructiveFalsePositiveBlocked = writeRows.some((row) => row.name === 'delete_docs' && row.concurrency === 'serial_required')
  const blockers = [
    ...(readOnlyTools.length >= 3 ? [] : ['mcp_readonly_tool_count_below_3']),
    ...(readOnlyParallel ? [] : ['mcp_readonly_tools_serialized_without_reason']),
    ...(overlapEvidence.every((edge) => {
      const a = readOnlyRows.find((row) => row.name === edge.a)
      const b = readOnlyRows.find((row) => row.name === edge.b)
      return a?.concurrency === 'candidate_parallel_readonly' && b?.concurrency === 'candidate_parallel_readonly'
    }) ? [] : ['mcp_overlap_contains_non_readonly_candidate']),
    ...(writeSerial ? [] : ['mcp_write_tools_ran_concurrently_without_permission']),
    ...(destructiveFalsePositiveBlocked ? [] : ['mcp_destructive_readonly_hint_false_positive_not_blocked'])
  ]
  return {
    schema: 'sks.mcp-readonly-runtime-scheduler-proof.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    read_only_parallel: readOnlyParallel,
    write_serial: writeSerial,
    destructive_false_positive_blocked: destructiveFalsePositiveBlocked,
    overlap_evidence: overlapEvidence,
    tools,
    blockers
  }
}

export function detectMcpToolPolicyFromConfig(sources: Array<{ path: string; text: string; source?: string }> = []) {
  const servers = sources.flatMap((source) => parseServers(source.text))
  const streamableWithoutOAuth = servers.filter((server) => isStreamableHttp(server.transport) && !server.oauth_configured)
  return {
    schema: MCP_TOOL_POLICY_SCHEMA,
    generated_at: nowIso(),
    ok: true,
    servers,
    per_server_environment_supported: servers.some((server) => server.environment_keys.length > 0),
    streamable_http_oauth_supported: servers.some((server) => server.oauth_configured && isStreamableHttp(server.transport)),
    streamable_http_servers_detected: servers.filter((server) => isStreamableHttp(server.transport)).map((server) => server.name),
    warnings: [
      ...(servers.length ? [] : ['mcp_servers_not_configured']),
      ...streamableWithoutOAuth.map((server) => `streamable_http_oauth_not_configured:${server.name}`)
    ]
  }
}

async function runMcpRuntimeFixture(tool: McpReadOnlyRuntimeToolFixture, scheduledMode: McpReadOnlyRuntimeToolProof['scheduled_mode'], batchId: string): Promise<McpReadOnlyRuntimeToolProof> {
  const classification = classifyMcpToolForConcurrency(tool)
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, tool.durationMs || 0)))
  const ended = Date.now()
  return {
    name: classification.name,
    concurrency: classification.concurrency,
    scheduled_mode: scheduledMode,
    batch_id: batchId,
    started_at_ms: started,
    ended_at_ms: ended,
    duration_ms: ended - started
  }
}

function collectOverlapEvidence(rows: McpReadOnlyRuntimeToolProof[]): Array<{ a: string; b: string; overlap_ms: number }> {
  const overlaps: Array<{ a: string; b: string; overlap_ms: number }> = []
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]
      const b = rows[j]
      if (!a || !b) continue
      const overlap = Math.min(a.ended_at_ms, b.ended_at_ms) - Math.max(a.started_at_ms, b.started_at_ms)
      if (overlap > 0) overlaps.push({ a: a.name, b: b.name, overlap_ms: overlap })
    }
  }
  return overlaps
}

function parseServers(text: string): McpServerPolicy[] {
  const trimmed = String(text || '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const servers = parsed.mcp_servers || parsed.mcpServers || {}
      return Object.entries<any>(servers).map(([name, value]) => ({
        name,
        environment_keys: Object.keys(value?.env || value?.environment || {}),
        transport: value?.transport || value?.type || null,
        oauth_configured: isConfiguredObject(value?.oauth) || isConfiguredObject(value?.auth?.oauth)
      }))
    } catch {
      return []
    }
  }
  const servers = new Map<string, McpServerPolicy>()
  for (const section of tomlSections(text)) {
    if (!section.parts.length) continue
    const name = unquote(section.parts[0] || '')
    if (!name) continue
    const server = ensureServer(servers, name)
    const subtable = section.parts.slice(1).map((part) => unquote(part)).join('.')
    if (subtable === 'env' || subtable === 'environment') {
      server.environment_keys.push(...assignmentKeys(section.body))
      continue
    }
    if (subtable === 'oauth' || subtable === 'auth.oauth' || subtable === 'authorization') {
      server.oauth_configured = section.body.trim().length > 0 || server.oauth_configured
      continue
    }
    server.environment_keys.push(...[...section.body.matchAll(/^\s*(?:env|environment)\.([A-Za-z0-9_]+)\s*=/gm)].map((entry) => String(entry[1] || '')))
    const transport = section.body.match(/^\s*(?:transport|type)\s*=\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim()
    if (transport) server.transport = transport
    if (/^\s*(?:oauth|authorization)\s*=\s*(?:true|["'][^"']+["']|\{)/im.test(section.body)) server.oauth_configured = true
  }
  return [...servers.values()].map((server) => ({
    ...server,
    environment_keys: [...new Set(server.environment_keys)].sort()
  }))
}

function hasDestructiveSignal(value: string): boolean {
  if (DESTRUCTIVE_TOOL_RE.test(` ${value} `)) return true
  const normalized = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.:/\\-]+/g, '_')
    .toLowerCase()
  return DESTRUCTIVE_WORDS.some((word) => new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`).test(normalized))
}

function isStreamableHttp(transport: string | null): boolean {
  return /streamable.*http|http.*streamable/i.test(String(transport || ''))
}

function isConfiguredObject(value: any): boolean {
  if (value === true || typeof value === 'string') return true
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)
}

function ensureServer(servers: Map<string, McpServerPolicy>, name: string): McpServerPolicy {
  let server = servers.get(name)
  if (!server) {
    server = { name, environment_keys: [], transport: null, oauth_configured: false }
    servers.set(name, server)
  }
  return server
}

function tomlSections(text: string): Array<{ parts: string[]; body: string }> {
  const sections: Array<{ parts: string[]; body: string }> = []
  const tableRe = /^\s*\[(?:mcp_servers|mcpServers)\.([^\]]+)\]\s*$/gm
  let match: RegExpExecArray | null
  while ((match = tableRe.exec(text)) !== null) {
    const start = match.index + match[0].length
    const next = text.slice(start).search(/^\s*\[/m)
    const body = next >= 0 ? text.slice(start, start + next) : text.slice(start)
    sections.push({ parts: splitTomlPath(match[1] || ''), body })
  }
  return sections
}

function splitTomlPath(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of String(value || '')) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (char === '.' && !quote) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function assignmentKeys(body: string): string[] {
  return [...String(body || '').matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)]
    .map((entry) => String(entry[1] || ''))
    .filter((key) => !['transport', 'type', 'oauth', 'authorization'].includes(key))
}

function collectRefs(value: any, refs = new Set<string>()): string[] {
  if (!value || typeof value !== 'object') return [...refs]
  if (typeof value.$ref === 'string') refs.add(value.$ref)
  for (const child of Object.values(value)) collectRefs(child, refs)
  return [...refs].sort()
}

function safeJson(value: any): string {
  try {
    return JSON.stringify(value || {})
  } catch {
    return '{}'
  }
}

function unquote(value: string): string {
  return String(value || '').trim().replace(/^["']|["']$/g, '')
}
