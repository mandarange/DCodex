import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRepeatedBlocker } from '../../dist/core/loop-blocker.js';

test('repeated blocker detector stops at the current threshold', () => {
  const report = detectRepeatedBlocker([
    { reason: 'usage_limit', detail: 'continuation blocked' },
    { reason: 'usage_limit', detail: 'continuation blocked' }
  ], 2);
  assert.equal(report.stop_required, true);
  assert.equal(report.status, 'blocked');
});
