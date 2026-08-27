import fs from 'node:fs/promises'
import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { ensureDir, runProcess } from '../fsx.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'

// The CollabAgentTool enum the live app-server v2 schema must carry. Codex
// 0.148–0.150 grew this set: `sendMessage` (codex queue), `followupTask` and
// `listAgents` (agents dashboard / "@" task mentions), and `interruptAgent`,
// which 0.150 REINTRODUCED as a current tool (active-turn interruption) after
// an earlier retirement — only the snake_case spelling remains legacy.
const CURRENT_COLLAB_TOOLS = [
  'spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent',
  'sendMessage', 'followupTask', 'interruptAgent', 'listAgents'
]

export async function runCodexCurrentCollabAgentToolSchemaRealProbe(input: {
  root: string
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `collab-schema-${Date.now()}`)
  await ensureDir(tempDir)
  const args = ['app-server', 'generate-json-schema', '--out', tempDir]
  const result = await runProcess(codexBin, args, {
    cwd: input.root,
    timeoutMs: Math.min(input.timeoutMs || 60_000, 60_000),
    maxOutputBytes: 256 * 1024
  }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
  const schemaPath = path.join(tempDir, 'codex_app_server_protocol.v2.schemas.json')
  const schema = await readJson(schemaPath)
  const tools = Array.isArray(schema?.definitions?.CollabAgentTool?.enum)
    ? schema.definitions.CollabAgentTool.enum.map(String)
    : []
  const currentNamesPresent = CURRENT_COLLAB_TOOLS.every((name) => tools.includes(name))
  const legacyInterruptAbsent = !tools.includes('interrupt_agent')
  const collabItemPresent = JSON.stringify(schema?.definitions?.ThreadItem || {}).includes('collabAgentToolCall')
    || JSON.stringify(schema || {}).includes('collabAgentToolCall')
  const processExitedSuccessfully = (result as any).code === 0
  const ok = processExitedSuccessfully && currentNamesPresent && legacyInterruptAbsent && collabItemPresent
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, ...args],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr),
    artifact_paths: [schemaPath],
    evidence: {
      schema_generated_by_runtime: processExitedSuccessfully,
      collab_agent_thread_item_present: collabItemPresent,
      collab_agent_tools: tools,
      expected_collab_agent_tools: CURRENT_COLLAB_TOOLS,
      current_names_present: currentNamesPresent,
      legacy_interrupt_agent_absent: legacyInterruptAbsent
    },
    blockers: ok ? [] : [
      ...(processExitedSuccessfully ? [] : ['codex_collab_agent_schema_generation_failed']),
      ...(currentNamesPresent ? [] : ['codex_collab_agent_current_tool_names_missing']),
      ...(legacyInterruptAbsent ? [] : ['codex_collab_agent_legacy_interrupt_name_present']),
      ...(collabItemPresent ? [] : ['codex_collab_agent_thread_item_missing'])
    ]
  }
}

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}
