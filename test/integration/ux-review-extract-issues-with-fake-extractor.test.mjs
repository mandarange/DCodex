import test from 'node:test';
import { runReleaseGate } from '../helpers/real-execution-closure.mjs';

test('ux-review extract-issues wiring gate reaches real extractor contract', () => {
  runReleaseGate('ux-review:extract-wires-real-extractor');
});
