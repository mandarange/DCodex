import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SERVER_INFO_META_KEY
} from '../../../mcp/modern-protocol.js';
import { MadSksSqlPlaneMcpExecutor } from '../mcp-executor.js';
import type { MadSksSqlPlaneRuntimeProfile } from '../runtime-profile.js';

test('SQL-plane executor uses MCP v2 auto negotiation and the modern stateless HTTP contract', async (t) => {
  const requests: Array<{
    method: string;
    headers: http.IncomingHttpHeaders;
    params: Record<string, any>;
  }> = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    const message = JSON.parse(await readRequest(request)) as {
      id: string | number;
      method: string;
      params?: Record<string, any>;
    };
    const params = message.params || {};
    requests.push({ method: message.method, headers: request.headers, params });
    const serverMeta = {
      [MCP_SERVER_INFO_META_KEY]: { name: 'sql-plane-fixture', version: '1.0.0' }
    };
    let result: Record<string, unknown>;
    if (message.method === 'server/discover') {
      result = {
        resultType: 'complete',
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: 'test fixture',
        ttlMs: 1_000,
        cacheScope: 'private',
        _meta: serverMeta
      };
    } else if (message.method === 'tools/list') {
      result = {
        resultType: 'complete',
        tools: [
          {
            name: 'execute_sql',
            description: 'Execute SQL',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', 'x-mcp-header': 'Sql-Mode' }
              },
              required: ['query']
            }
          },
          {
            name: 'apply_migration',
            description: 'Apply migration',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string' }, query: { type: 'string' } },
              required: ['name', 'query']
            }
          }
        ],
        ttlMs: 1_000,
        cacheScope: 'private',
        _meta: serverMeta
      };
    } else {
      result = {
        resultType: 'complete',
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { row_count: 1 },
        isError: false,
        _meta: serverMeta
      };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const previousPrimary = process.env.SUPABASE_ACCESS_TOKEN;
  const previous = process.env.SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN;
  process.env.SUPABASE_ACCESS_TOKEN = 'fixture-token';
  process.env.SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN = 'fixture-token';
  t.after(() => {
    if (previousPrimary === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = previousPrimary;
    if (previous === undefined) delete process.env.SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN;
    else process.env.SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN = previous;
  });

  const profile = {
    schema: 'sks.mad-sks-sql-plane-runtime-profile.v1',
    server_url: `http://127.0.0.1:${address.port}/mcp`
  } as MadSksSqlPlaneRuntimeProfile;
  const executor = new MadSksSqlPlaneMcpExecutor(profile, { timeoutMs: 5_000 });
  t.after(() => executor.close());

  const inventory = await executor.inventory();
  assert.equal(inventory.ok, true, inventory.error_summary || 'inventory failed');
  const execution = await executor.executeSql('select 1');
  assert.equal(execution.ok, true, execution.error_summary || 'execution failed');
  assert.equal(execution.row_count, 1);
  assert.deepEqual(requests.map((entry) => entry.method), [
    'server/discover',
    'tools/list',
    'tools/call'
  ]);
  for (const entry of requests) {
    assert.equal(entry.headers.authorization, 'Bearer fixture-token');
    assert.equal(entry.headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(entry.headers['mcp-method'], entry.method);
    assert.equal(entry.headers['mcp-session-id'], undefined);
    assert.equal(entry.params._meta?.[MCP_PROTOCOL_VERSION_META_KEY], MCP_PROTOCOL_VERSION);
    assert.deepEqual(entry.params._meta?.[MCP_CLIENT_CAPABILITIES_META_KEY], {});
  }
  const call = requests.find((entry) => entry.method === 'tools/call');
  assert.equal(call?.headers['mcp-name'], 'execute_sql');
  assert.equal(call?.headers['mcp-param-sql-mode'], 'select 1');
});

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
