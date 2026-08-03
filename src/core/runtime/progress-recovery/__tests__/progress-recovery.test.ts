import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTimeBudgetWarning,
  classifyRecoveryCause,
  confirmManualResume,
  initialProgressRecoveryState,
  issueManualResume,
  recordProgress,
  runWithProgressRecovery
} from '../progress-recovery.js';

test('progress signals survive warning-only time budgets', () => {
  const initial = initialProgressRecoveryState('a'.repeat(64));
  const progressed = recordProgress(initial, { kind: 'test', id: 'unit-suite', digest: 'b'.repeat(64), observed_at: '2026-08-02T00:00:10.000Z' });
  const warned = applyTimeBudgetWarning(progressed, { startedAtMs: 0, nowMs: 10_001, budgetMs: 10_000 });
  assert.equal(warned.status, 'running');
  assert.equal(warned.warning_time_budget_exceeded, true);
  assert.equal(warned.progress.length, 1);
});

test('only the same network cause retries twice and integrity state is preserved', async () => {
  let attempts = 0;
  const integrity = 'c'.repeat(64);
  const result = await runWithProgressRecovery({
    state: initialProgressRecoveryState(integrity),
    port: {
      run: async () => { attempts += 1; throw new Error('network_reset'); },
      classify: classifyRecoveryCause
    }
  });
  assert.equal(attempts, 3);
  assert.equal(result.state.status, 'paused');
  assert.equal(result.state.retry_count, 2);
  assert.equal(result.state.integrity_snapshot_hash, integrity);
});

test('auth, mode, account, external config and unknown causes pause immediately', async () => {
  for (const code of ['auth_expired', 'mode_mismatch', 'account_boundary', 'external_config_changed', 'surprise']) {
    let attempts = 0;
    const result = await runWithProgressRecovery({
      state: initialProgressRecoveryState('d'.repeat(64)),
      port: { run: async () => { attempts += 1; throw new Error(code); }, classify: classifyRecoveryCause }
    });
    assert.equal(attempts, 1);
    assert.equal(result.state.status, 'paused');
  }
});

test('manual resume requires a one-time matching token', () => {
  const paused = { ...initialProgressRecoveryState('e'.repeat(64)), status: 'paused' as const, pause_cause: 'auth' as const, pause_reason: 'auth_expired' };
  const issued = issueManualResume(paused);
  assert.throws(() => confirmManualResume(issued.state, 'wrong'), /resume_token_invalid/);
  const resumed = confirmManualResume(issued.state, issued.token);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.resume_token_hash, null);
});
