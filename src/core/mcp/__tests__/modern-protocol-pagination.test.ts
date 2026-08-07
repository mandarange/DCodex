import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMcpListPages, modernMcpResult } from '../modern-protocol.js';

const serverInfo = { name: 'pagination-fixture', version: '1.0.0' };

test('collectMcpListPages follows opaque cursors until the server omits nextCursor', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const tools = await collectMcpListPages<{ name: string }>('tools', async (params) => {
    requests.push(params);
    return params.cursor === 'page-2'
      ? modernMcpResult({ tools: [{ name: 'second' }] }, serverInfo)
      : modernMcpResult({ tools: [{ name: 'first' }], nextCursor: 'page-2' }, serverInfo);
  });

  assert.deepEqual(requests, [{}, { cursor: 'page-2' }]);
  assert.deepEqual(tools.map((tool) => tool.name), ['first', 'second']);
});

test('collectMcpListPages fails closed on a repeated cursor', async () => {
  await assert.rejects(
    collectMcpListPages('tools', async () => modernMcpResult({ tools: [], nextCursor: 'loop' }, serverInfo)),
    /mcp_pagination_cursor_repeated/
  );
});
