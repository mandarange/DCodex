import test from 'node:test';
import assert from 'node:assert/strict';
import { context7Tools } from '../context7-client.js';

const LEGACY_MCP_SERVER = [
  "const readline = require('node:readline');",
  "const rl = readline.createInterface({ input: process.stdin });",
  "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
  "rl.on('line', (line) => {",
  "  const request = JSON.parse(line);",
  "  if (request.method === 'server/discover') {",
  "    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });",
  "  } else if (request.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'legacy-context7-fixture', version: '1.0.0' } } });",
  "  } else if (request.method === 'tools/list') {",
  "    const second = request.params && request.params.cursor === 'page-2';",
  "    send({ jsonrpc: '2.0', id: request.id, result: second ? { tools: [{ name: 'query-docs', description: 'fixture', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'resolve-library-id', description: 'fixture', inputSchema: { type: 'object' } }], nextCursor: 'page-2' } });",
  "  }",
  "});"
].join('\n');

test('Context7 MCP client uses official auto negotiation and retains legacy stdio fallback', async () => {
  const result = await context7Tools({
    command: process.execPath,
    args: ['-e', LEGACY_MCP_SERVER],
    timeoutMs: 2_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.connection.protocol_era, 'legacy');
  assert.equal(result.connection.protocol_version, '2024-11-05');
  assert.equal(result.connection.server_info?.name, 'legacy-context7-fixture');
  assert.deepEqual(result.tool_names, ['resolve-library-id', 'query-docs']);
});
