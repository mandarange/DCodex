import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedGlobsFor } from '../../dist/core/release/gate-manifest.js';

test('postinstall gate routing includes packed lifecycle proof inputs', () => {
  const affected = affectedGlobsFor('postinstall:safe-side-effects');
  for (const required of [
    'src/cli/install-helpers.ts',
    'src/core/install/installed-package-smoke.ts',
    'src/scripts/installed-package-smoke-check.ts',
    'src/scripts/postinstall-safe-side-effects-check.ts',
    'test/blackbox/postinstall-safe-side-effects-packed.test.mjs',
    'test/unit/postinstall-command.test.mjs',
    'test/unit/publish-workflow-safety.test.mjs'
  ]) {
    assert.ok(affected.includes(required), `${required} must invalidate postinstall proof`);
  }
});
