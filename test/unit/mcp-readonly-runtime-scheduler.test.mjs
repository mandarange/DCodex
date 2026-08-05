import test from 'node:test';
import assert from 'node:assert/strict';
import { proveMcpReadOnlyRuntimeScheduler } from '../../dist/core/mcp/mcp-tool-policy.js';

test('MCP readOnly runtime scheduler records read-only overlap and serialized writes', async () => {
  const proof = await proveMcpReadOnlyRuntimeScheduler();
  assert.equal(proof.ok, true);
  assert.equal(proof.read_only_parallel, true);
  assert.equal(proof.write_serial, true);
  assert.ok(proof.overlap_evidence.length >= 1);
  assert.ok(proof.tools.filter((row) => row.scheduled_mode === 'parallel_readonly_batch').length >= 3);
  assert.ok(proof.tools.filter((row) => row.scheduled_mode === 'serial_required').every((row) => row.batch_id.startsWith('serial-')));
});
