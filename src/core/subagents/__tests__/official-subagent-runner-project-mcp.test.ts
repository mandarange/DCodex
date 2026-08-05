import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { runOfficialSubagentWorkflow } from '../official-subagent-runner.js'
import { addMcpServer, editMcpServer } from '../../mcp-config/mutation.js'
import type { CodexCliMutationOperation, CodexMcpCliPort } from '../../mcp-config/codex-cli-adapter.js'
import { runProcess } from '../../fsx.js'

class UnavailableMcpCli implements CodexMcpCliPort {
  async list() {
    return { available: false, ok: false, rows: [], public_error: 'codex_cli_not_found' }
  }

  async transform(_before: string, _operation: CodexCliMutationOperation) {
    return {
      available: false,
      ok: false,
      used: false,
      text: null,
      unsupported_reason: 'codex_cli_not_found',
      public_error: null
    }
  }

  async login() {
    return { available: false, ok: false, public_error: 'codex_cli_not_found' }
  }

  async logout() {
    return { available: false, ok: false, public_error: 'codex_cli_not_found' }
  }
}

test('standalone Naruto parent consumes the existing project MCP config and calls its read-only stdio tool', { timeout: 20_000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('executable fixture uses a POSIX shebang')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-project-mcp-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const codexHome = path.join(home, '.codex')
  const serverFile = path.join(project, 'project-read-tool.mjs')
  const fakeCodex = path.join(root, 'codex-fixture.mjs')
  const callReceipt = path.join(project, 'project-mcp-call.json')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.mkdir(path.join(project, '.codex'), { recursive: true })
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))

  await fsp.writeFile(serverFile, [
    "import readline from 'node:readline'",
    "const tools = ['read_project_marker', 'datasource_schema_context', 'datasource_query_readonly', 'spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'].map((name) => ({ name, description: `Fixture tool ${name}`, inputSchema: { type: 'object', additionalProperties: false } }))",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line)",
    "  if (message.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } }))",
    "  if (message.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }))",
    "  if (message.method === 'tools/call') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'project-mcp-ok' }], isError: false } }))",
    "})"
  ].join('\n'), { mode: 0o600 })

  await fsp.writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import readline from 'node:readline'",
    "import { spawn } from 'node:child_process'",
    "const args = process.argv.slice(2)",
    "const outputIndex = args.indexOf('--output-last-message')",
    "const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''",
    "const configFile = path.join(process.cwd(), '.codex', 'config.toml')",
    "const config = fs.readFileSync(configFile, 'utf8')",
    "const match = config.match(/\\[mcp_servers\\.(?:project_probe|\"project_probe\")\\]([\\s\\S]*?)(?=\\n\\[|$)/)",
    "if (!match) throw new Error('project_mcp_block_missing')",
    "const block = match[1]",
    "const commandLine = block.split(/\\r?\\n/).find((line) => /^command\\s*=/.test(line))",
    "const argsLine = block.split(/\\r?\\n/).find((line) => /^args\\s*=/.test(line))",
    "const command = JSON.parse(String(commandLine || '').replace(/^command\\s*=\\s*/, ''))",
    "const childArgs = argsLine ? JSON.parse(argsLine.replace(/^args\\s*=\\s*/, '')) : []",
    "const child = spawn(command, childArgs, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })",
    "const lines = readline.createInterface({ input: child.stdout })",
    "const pending = new Map()",
    "lines.on('line', (line) => { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message) } })",
    "const request = (id, method, params = {}) => new Promise((resolve, reject) => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); setTimeout(() => reject(new Error('fixture_mcp_timeout')), 3000).unref() })",
    "await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })",
    "child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\\n')",
    "const listed = await request(2, 'tools/list')",
    "if (!listed.result.tools.some((tool) => tool.name === 'read_project_marker')) throw new Error('project_mcp_tool_missing')",
    "for (const name of ['datasource_schema_context', 'datasource_query_readonly', 'spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']) if (!listed.result.tools.some((tool) => tool.name === name)) throw new Error(`project_mcp_capability_tool_missing:${name}`)",
    "const called = await request(3, 'tools/call', { name: 'read_project_marker', arguments: {} })",
    "const text = called.result.content?.[0]?.text",
    "fs.writeFileSync(path.join(process.cwd(), 'project-mcp-call.json'), JSON.stringify({ tool: 'read_project_marker', text }))",
    "if (text !== 'project-mcp-ok') throw new Error('project_mcp_tool_result_invalid')",
    "child.stdin.end()",
    "child.kill('SIGTERM')",
    "if (!outputFile) throw new Error('parent_summary_output_missing')",
    "fs.writeFileSync(outputFile, 'project MCP fixture complete')"
  ].join('\n'), { mode: 0o700 })

  const cli = new UnavailableMcpCli()
  const previousAllowed = process.env.PROJECT_MCP_ALLOWED
  process.env.PROJECT_MCP_ALLOWED = 'runtime-value-must-not-be-written'
  t.after(() => {
    if (previousAllowed === undefined) delete process.env.PROJECT_MCP_ALLOWED
    else process.env.PROJECT_MCP_ALLOWED = previousAllowed
  })
  const registration = {
    schema: 'sks.mcp-server-config.v2',
    name: 'project_probe',
    transport: 'stdio',
    command: process.execPath,
    args: [serverFile],
    env_vars: ['PROJECT_MCP_ALLOWED'],
    cwd: project,
    enabled_tools: [
      'read_project_marker',
      'datasource_schema_context',
      'datasource_query_readonly',
      'spreadsheet_create',
      'spreadsheet_inspect',
      'spreadsheet_update'
    ],
    default_tools_approval_mode: 'auto',
    required: true
  }
  const added = await addMcpServer(registration, 'project', {
    projectRoot: project,
    projectTrusted: true,
    confirmProjectMutation: true,
    cli
  })
  assert.equal(added.ok, true)
  const reapplied = await editMcpServer('project_probe', registration, 'project', {
    projectRoot: project,
    projectTrusted: true,
    confirmProjectMutation: true,
    cli
  })
  assert.equal(reapplied.ok, true)
  const config = await fsp.readFile(path.join(project, '.codex', 'config.toml'), 'utf8')
  assert.equal((config.match(/\[mcp_servers\."project_probe"\]/g) || []).length, 1)
  assert.match(config, /env_vars = \["PROJECT_MCP_ALLOWED"\]/)
  assert.doesNotMatch(config, /runtime-value-must-not-be-written/)

  const result = await runOfficialSubagentWorkflow({
    root: project,
    goal: 'Use the registered read-only project tool and report its marker.',
    prompt: 'Use the registered read-only project tool and report its marker.',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: false,
    missionId: 'M-project-mcp-fixture',
    codexBin: fakeCodex,
    runProcessImpl: async (_command, args, options) => runProcess(fakeCodex, args, options),
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      SKS_PROVIDER: '',
      SKS_USE_CODEX_LB: '',
      SKS_MODEL_PROVIDER: '',
      CODEX_MODEL_PROVIDER: '',
      OPENAI_MODEL_PROVIDER: ''
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'parent_completed')
  assert.equal(result.parent_summary, 'project MCP fixture complete')
  assert.deepEqual(JSON.parse(await fsp.readFile(callReceipt, 'utf8')), {
    tool: 'read_project_marker',
    text: 'project-mcp-ok'
  })
})
