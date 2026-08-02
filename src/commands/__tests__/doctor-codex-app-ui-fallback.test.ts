import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexAppUiDiagnosticFailure } from '../doctor.js';

test('Codex App UI diagnostic and repair exceptions never overclaim provider readiness', () => {
  for (const apply of [false, true]) {
    const fallback = buildCodexAppUiDiagnosticFailure(apply, new Error('fixture diagnostic failed'));
    assert.equal(fallback.ok, false);
    assert.equal(fallback.apply, apply);
    assert.equal(fallback.fast_selector, 'manual_action_required');
    assert.equal(fallback.provider_selector, 'manual_action_required');
    assert.notEqual(fallback.provider_selector, 'ok');
    assert.equal(fallback.host_owned_config, 'diagnostic_failed');
    assert.deepEqual(fallback.blockers, ['fixture diagnostic failed']);
  }
});
