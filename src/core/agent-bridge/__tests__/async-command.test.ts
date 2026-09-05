import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAsyncCommandArgs, redactAsyncToolOutput } from '../async-command.js';

test('async command accepts only explicit read-only remote command contracts', () => {
  assert.deepEqual(parseAsyncCommandArgs(['--prompt', 'Inspect setup']), { prompt: 'Inspect setup', tools: ['status', 'stats'] });
  assert.deepEqual(parseAsyncCommandArgs(['--prompt', 'Inspect', '--tools', 'status', '--json']), { prompt: 'Inspect', tools: ['status'] });
  for (const tools of ['doctor', 'naruto', 'agent-bridge', 'status,status', 'unknown']) {
    assert.throws(() => parseAsyncCommandArgs(['--prompt', 'Inspect', '--tools', tools]), /async_tool/);
  }
  assert.throws(() => parseAsyncCommandArgs(['--tools', 'status']), /async_prompt/);
  assert.throws(() => parseAsyncCommandArgs(['--prompt', 'Inspect', '--prompt', 'again']), /duplicate_option/);
  assert.throws(() => parseAsyncCommandArgs(['--prompt', 'Inspect', '--endpoint', 'https:\/\/other.test']), /invalid_async_option/);
});

test('async tool output redacts nested credentials without truncating real results', () => {
  const content = 'evidence'.repeat(3000);
  const result = JSON.parse(redactAsyncToolOutput(JSON.stringify({ content, nested: { api_key: 'private-value', authorization: 'private-header' } })));
  assert.equal(result.content, content);
  assert.deepEqual(result.nested, { api_key: '[redacted]', authorization: '[redacted]' });
  assert.equal(redactAsyncToolOutput(content), content);
});
