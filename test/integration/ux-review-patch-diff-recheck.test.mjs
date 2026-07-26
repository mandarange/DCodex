import test from 'node:test';
import { runReleaseGate } from '../helpers/real-execution-closure.mjs';

test('ux-review patch diff recheck release gate passes', () => {
  runReleaseGate('ux-review:patch-diff-recheck');
});
