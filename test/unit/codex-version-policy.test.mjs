import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexVersionPolicy,
  compareSemverLike,
  parseCodexVersionText,
  CODEX_PREFERRED_VERSION,
  CODEX_MINIMUM_SUPPORTED_VERSION
} from '../../dist/core/codex-compat/codex-version-policy.js';
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../../dist/core/codex-compat/codex-runtime-contract.js';

test('Codex version policy uses the package-tracked floor without rejecting newer runtimes', () => {
  assert.equal(parseCodexVersionText('codex-cli 0.145.0'), '0.145.0');
  assert.equal(compareSemverLike('0.145.0', '0.144.5'), 1);
  assert.equal(CODEX_PREFERRED_VERSION, CURRENT_CODEX_RUNTIME_CONTRACT.sdkVersion);
  assert.equal(CODEX_MINIMUM_SUPPORTED_VERSION, CURRENT_CODEX_RUNTIME_CONTRACT.sdkVersion);
  assert.equal(codexVersionPolicy({ available: true, version: CURRENT_CODEX_RUNTIME_CONTRACT.sdkVersion, source: 'fixture' }).status, 'ok');
  assert.equal(codexVersionPolicy({ available: true, version: '999.0.0', source: 'future-fixture' }).status, 'ok');
  const older = codexVersionPolicy({ available: true, version: '0.144.0', source: 'fixture' });
  assert.equal(older.ok, false);
  assert.equal(older.status, 'blocked_below_minimum_supported');
  assert.equal(older.update_available_hint, true);
  assert.ok(older.warnings.some((warning) => /Update Codex CLI|current supported release/i.test(warning)));
  const belowMinimum = codexVersionPolicy({ available: true, version: '0.120.0', source: 'fixture' });
  assert.equal(belowMinimum.ok, false);
  assert.equal(belowMinimum.status, 'blocked_below_minimum_supported');
  const explicit = codexVersionPolicy(
    { available: true, version: '0.144.0', source: 'fixture' },
    { requiredBaseline: CURRENT_CODEX_RUNTIME_CONTRACT.targetTag, explicitRequire: true }
  );
  assert.equal(explicit.ok, false);
  assert.equal(explicit.status, 'blocked_below_required_baseline');
});

test('Codex version policy treats missing binary as integration optional', () => {
  const report = codexVersionPolicy({ available: false, version: null, source: null });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'integration_optional');
  assert.equal(report.update_available_hint, true);
});
