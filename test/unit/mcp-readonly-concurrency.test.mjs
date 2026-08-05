import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMcpToolForConcurrency } from '../../dist/core/mcp/mcp-tool-policy.js';

test('MCP readOnlyHint is advisory and destructive tools stay serial', () => {
  const safe = classifyMcpToolForConcurrency({ name: 'search_docs', annotations: { readOnlyHint: true } });
  const destructive = classifyMcpToolForConcurrency({ name: 'delete_docs', annotations: { readOnlyHint: true } });
  assert.equal(safe.concurrency, 'candidate_parallel_readonly');
  assert.equal(destructive.concurrency, 'serial_required');
  assert.equal(safe.advisory_only, true);
});
