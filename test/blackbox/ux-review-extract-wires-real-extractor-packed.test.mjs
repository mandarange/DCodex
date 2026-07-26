import test from 'node:test';
import { runReleaseGate } from '../helpers/real-execution-closure.mjs';

test('packed UX-Review extract real extractor gate passes', () => {
  runReleaseGate('ux-review:extract-wires-real-extractor');
});
